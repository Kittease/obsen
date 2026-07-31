import { describe, expect, it } from "vitest";

import { engineConstants } from "../../../src/engine/constants.ts";
import { RunScheduler, type DirtySet } from "../../../src/engine/scheduler.ts";
import { FULL_SCOPE, pathScope } from "../../../src/engine/triggers.ts";
import { FakeClock } from "../../fakes/fake-clock.ts";

/**
 * Spec §4: single path, single flight. At most one Run executes; everything that
 * arrives meanwhile merges into a pending scope that becomes the *next* Run — the
 * fix for the interleaved-runs race the ticket-019 spike hit on a real phone.
 */

const CONSTANTS = engineConstants();

/** A scheduler whose runner records the scope it was handed and resolves on demand. */
function harness(options: { blocking?: boolean } = {}) {
	const clock = new FakeClock();
	const runs: DirtySet[] = [];
	let release: (() => void) | null = null;

	const scheduler = new RunScheduler<number>({
		timers: clock,
		constants: CONSTANTS,
		run: async (dirty) => {
			runs.push(dirty);
			if (options.blocking) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return runs.length;
		},
	});

	return {
		clock,
		runs,
		scheduler,
		/** Lets the currently blocked run finish, then settles what it kicked off. */
		finishRun: async (): Promise<void> => {
			const resolve = release;
			release = null;
			resolve?.();
			await clock.advance(0);
		},
		/** Releases blocked runs until the scheduler has nothing left to do. */
		drain: async (): Promise<void> => {
			while (scheduler.isRunning || scheduler.hasPending) {
				const resolve = release;
				release = null;
				resolve?.();
				await clock.advance(CONSTANTS.eventMaxWaitMs);
			}
		},
	};
}

describe("admission", () => {
	it("runs a FULL request immediately", async () => {
		const { scheduler, runs, clock } = harness();

		const summary = scheduler.request({ trigger: "startup", scope: FULL_SCOPE });
		await clock.advance(0);

		expect(runs).toHaveLength(1);
		expect(runs[0]?.scope.kind).toBe("full");
		expect(await summary).toBe(1);
	});

	it("debounces path requests, and re-arming does not postpone past the max wait", async () => {
		const { scheduler, runs, clock } = harness();

		// Continuous typing: a fresh event every 1.5 s, forever.
		for (let event = 0; event < 20; event += 1) {
			void scheduler.request({
				trigger: "vault-event",
				scope: pathScope([`note-${event}.md`]),
			});
			await clock.advance(1_500);
		}

		// Without the 15 s cap the trailing debounce would still be waiting.
		expect(runs.length).toBeGreaterThanOrEqual(1);
		expect(runs[0]?.scope.kind).toBe("paths");
	});

	it("holds a path request for the debounce window, then runs once", async () => {
		const { scheduler, runs, clock } = harness();

		void scheduler.request({ trigger: "vault-event", scope: pathScope(["a.md"]) });
		void scheduler.request({ trigger: "vault-event", scope: pathScope(["b.md"]) });
		await clock.advance(CONSTANTS.eventDebounceMs - 1);
		expect(runs).toHaveLength(0);

		await clock.advance(1);

		expect(runs).toHaveLength(1);
		const scope = runs[0]?.scope;
		expect(scope?.kind === "paths" && [...scope.paths].sort()).toEqual(["a.md", "b.md"]);
	});

	it("lets a FULL request cut through a pending debounce, absorbing its paths", async () => {
		const { scheduler, runs, clock } = harness();

		void scheduler.request({ trigger: "vault-event", scope: pathScope(["a.md"]) });
		void scheduler.request({ trigger: "manual", scope: FULL_SCOPE });
		await clock.advance(0);

		expect(runs).toHaveLength(1);
		expect(runs[0]?.scope.kind).toBe("full");
		expect(runs[0]?.triggers).toEqual(["vault-event", "manual"]);
		// The absorbed debounce must not fire a second, redundant Run.
		await clock.advance(CONSTANTS.eventMaxWaitMs);
		expect(runs).toHaveLength(1);
	});
});

describe("single flight", () => {
	it("never overlaps runs and carries mid-run requests into the next one", async () => {
		const { scheduler, runs, clock, finishRun, drain } = harness({ blocking: true });

		const first = scheduler.request({ trigger: "startup", scope: FULL_SCOPE });
		await clock.advance(0);
		expect(runs).toHaveLength(1);

		// Everything below arrives while the first Run is still executing.
		const second = scheduler.request({ trigger: "vault-event", scope: pathScope(["a.md"]) });
		const third = scheduler.request({ trigger: "remote-event", scope: pathScope(["b.md"]) });
		await clock.advance(CONSTANTS.eventMaxWaitMs);
		expect(runs).toHaveLength(1);

		await finishRun();

		expect(runs).toHaveLength(2);
		const scope = runs[1]?.scope;
		expect(scope?.kind === "paths" && [...scope.paths].sort()).toEqual(["a.md", "b.md"]);
		expect(runs[1]?.triggers).toEqual(["vault-event", "remote-event"]);
		expect(await first).toBe(1);

		await drain();
		// Both mid-run requests were served by the same follow-up Run.
		expect(await second).toBe(2);
		expect(await third).toBe(2);
		expect(runs).toHaveLength(2);
	});

	it("coalesces a burst of FULL requests into one follow-up", async () => {
		const { scheduler, runs, clock, finishRun } = harness({ blocking: true });

		void scheduler.request({ trigger: "startup", scope: FULL_SCOPE });
		await clock.advance(0);
		for (let request = 0; request < 5; request += 1) {
			void scheduler.request({ trigger: "foreground-resume", scope: FULL_SCOPE });
		}

		await finishRun();

		expect(runs).toHaveLength(2);
		expect(runs[1]?.scope.kind).toBe("full");
	});

	it("keeps a rehash request sticky when it merges with an ordinary FULL", async () => {
		const { scheduler, runs, clock } = harness();

		void scheduler.request({ trigger: "verify-repair", scope: { kind: "full", rehash: true } });
		void scheduler.request({ trigger: "manual", scope: FULL_SCOPE });
		await clock.advance(0);

		const scope = runs[0]?.scope;
		expect(scope?.kind === "full" && scope.rehash).toBe(true);
	});
});

describe("bookkeeping", () => {
	it("carries Rename Hints through, deduplicated", async () => {
		const { scheduler, runs, clock } = harness();

		void scheduler.request({
			trigger: "vault-event",
			scope: pathScope(["new.md"]),
			hints: [{ from: "old.md", to: "new.md" }],
		});
		void scheduler.request({
			trigger: "vault-event",
			scope: pathScope(["new.md"]),
			hints: [{ from: "old.md", to: "new.md" }],
		});
		await clock.advance(CONSTANTS.eventDebounceMs);

		expect(runs[0]?.hints).toEqual([{ from: "old.md", to: "new.md" }]);
	});

	it("reports idle only when nothing is running or pending", async () => {
		const { scheduler, clock, finishRun } = harness({ blocking: true });

		void scheduler.request({ trigger: "startup", scope: FULL_SCOPE });
		await clock.advance(0);

		let settled = false;
		void scheduler.idle().then(() => {
			settled = true;
		});
		await clock.advance(0);
		expect(settled).toBe(false);

		await finishRun();
		expect(settled).toBe(true);
	});

	it("surfaces a failing run to its requester without wedging the scheduler", async () => {
		const clock = new FakeClock();
		let attempt = 0;
		const scheduler = new RunScheduler<string>({
			timers: clock,
			constants: CONSTANTS,
			run: () => {
				attempt += 1;
				return attempt === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok");
			},
		});

		const failing = scheduler.request({ trigger: "startup", scope: FULL_SCOPE });
		await clock.advance(0);
		await expect(failing).rejects.toThrow("boom");

		const recovered = scheduler.request({ trigger: "manual", scope: FULL_SCOPE });
		await clock.advance(0);
		expect(await recovered).toBe("ok");
	});

	it("resolves idle only once a Run that dispose could not cancel has finished", async () => {
		const { scheduler, clock, finishRun } = harness({ blocking: true });

		void scheduler.request({ trigger: "startup", scope: FULL_SCOPE });
		await clock.advance(0);
		let settled = false;
		void scheduler.idle().then(() => {
			settled = true;
		});

		scheduler.dispose();
		await clock.advance(0);

		// The plugin's unload path needs to know when the vault is quiet; claiming idle
		// while a Run is still writing would be a lie.
		expect(settled).toBe(false);

		await finishRun();
		expect(settled).toBe(true);
	});

	it("stops scheduling once disposed", async () => {
		const { scheduler, runs, clock } = harness();

		void scheduler.request({ trigger: "vault-event", scope: pathScope(["a.md"]) });
		scheduler.dispose();
		await clock.advance(CONSTANTS.eventMaxWaitMs);

		expect(runs).toHaveLength(0);
		expect(clock.armed).toBe(0);
	});
});
