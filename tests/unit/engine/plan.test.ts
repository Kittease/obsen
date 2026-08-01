import { beforeEach, describe, expect, it } from "vitest";

import { PlanCancelledError } from "../../../src/engine/plan.ts";
import { createWorld, type SyncWorld } from "../../helpers/sync-world.ts";

/**
 * The plan-only entry point (spec §8.4): the planner runs, nothing executes.
 *
 * It is the same code a real Run plans with — which is what makes the First-Link
 * preview a preview rather than a second algorithm — so what is worth pinning down
 * here is only what the *dry run* adds: the counts the preview reads, the promise that
 * neither side is touched, and the free Cancel from step 2 of the flow.
 */

let world: SyncWorld;
let vault: SyncWorld["vault"];
let remote: SyncWorld["remote"];
let store: SyncWorld["store"];

beforeEach(() => {
	world = createWorld();
	({ vault, remote, store } = world);
});

describe("the dry run reports without acting (spec §8.4 step 3)", () => {
	it("counts uploads, downloads, identical pairs and conflicts, and changes nothing", async () => {
		await vault.put("Both.md", "same on both sides");
		await remote.put("Both.md", "same on both sides");
		await vault.put("Local only.md", "mine");
		await remote.put("Remote only.md", "theirs");
		// No record and different content on both sides: a First-Link conflict, which has
		// no Ancestor to merge against and therefore becomes a Conflict Copy.
		await vault.put("Clash.md", "local version");
		await remote.put("Clash.md", "remote version");

		const sync = await world.open();
		// Seeding the fakes writes to them, so what the dry run must not do is measured
		// from here rather than from zero.
		const before = { written: vault.calls.write, uploaded: remote.calls.upload };
		const plan = await sync.plan();

		expect(plan.counts).toMatchObject({
			upload: 1,
			download: 1,
			identical: 1,
			conflict: 1,
			deleted: 0,
		});
		expect(plan.conflictPaths).toEqual(["Clash.md"]);
		// Nothing was written on either side, and no Sync State was persisted: the whole
		// point of the step is that a user can back out of it (ticket 031's criterion).
		expect(vault.paths()).toEqual(["Both.md", "Clash.md", "Local only.md"]);
		expect(remote.paths()).toEqual(["Both.md", "Clash.md", "Remote only.md"]);
		expect(vault.calls.write).toBe(before.written);
		expect(remote.calls.upload).toBe(before.uploaded);
		expect(store.state).toBe(null);
	});

	it("reports progress through listing, scanning and hashing", async () => {
		await vault.put("One.md", "one");
		await vault.put("Two.md", "two");
		await remote.put("One.md", "one remotely");
		await remote.put("Two.md", "two remotely");

		const sync = await world.open();
		const seen: string[] = [];
		await sync.plan({
			onProgress: (progress) =>
				seen.push(
					progress.phase === "hashing"
						? `hashing ${progress.done}/${progress.total}`
						: progress.phase,
				),
		});

		// The phases the scan modal renders as sentences (spec §8.4 step 2).
		expect(seen[0]).toBe("listing");
		expect(seen).toContain("scanning");
		expect(seen).toContain("hashing 0/2");
		expect(seen.at(-1)).toBe("hashing 2/2");
	});
});

describe("Cancel during a dry run is free (spec §8.4 step 2)", () => {
	it("stops hashing at the next file and leaves both sides untouched", async () => {
		for (const name of ["A.md", "B.md", "C.md", "D.md"]) {
			await vault.put(name, `local ${name}`);
			await remote.put(name, `remote ${name}`);
		}

		const sync = await world.open();
		const before = { written: vault.calls.write, uploaded: remote.calls.upload };
		let hashed = 0;
		const dryRun = sync.plan({
			onProgress: (progress) => {
				if (progress.phase === "hashing") hashed = progress.done;
			},
			cancelled: () => hashed >= 2,
		});

		await expect(dryRun).rejects.toBeInstanceOf(PlanCancelledError);
		// Cancelled *early*: the remaining files were never read, which is what makes the
		// Cancel free rather than cosmetic.
		expect(vault.calls.read).toBe(2);
		expect(vault.calls.write).toBe(before.written);
		expect(remote.calls.upload).toBe(before.uploaded);
		expect(store.state).toBe(null);
	});

	it("stops before the vault is even scanned when the answer is already no", async () => {
		await vault.put("A.md", "local");
		await remote.put("A.md", "remote");

		const sync = await world.open();

		await expect(sync.plan({ cancelled: () => true })).rejects.toBeInstanceOf(PlanCancelledError);
		expect(vault.calls.list).toBe(0);
	});

	it("leaves ordinary Runs unaffected — nothing cancels them", async () => {
		await vault.put("A.md", "local");

		const sync = await world.open();
		const summary = await sync.syncNow("manual");

		expect(summary.outcome).toBe("ok");
		expect(summary.uploaded).toBe(1);
	});
});
