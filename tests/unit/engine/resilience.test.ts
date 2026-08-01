import { beforeEach, describe, expect, it } from "vitest";

import { ENGINE_CONSTANTS } from "../../../src/engine/constants.ts";
import { SyncFault } from "../../../src/engine/errors.ts";
import { createWorld, type SyncWorld } from "../../helpers/sync-world.ts";

/**
 * Engine resilience (spec §5.7–5.9): what a Run does when the world pushes back.
 *
 * Every delay here is a real duration the engine asked the injected clock for, so the
 * ladders are asserted in milliseconds rather than in "it eventually retried" — which
 * is the only way to tell a 10 s → 5 m backoff from a busy loop.
 */

let world: SyncWorld;
let vault: SyncWorld["vault"];
let remote: SyncWorld["remote"];
let clock: SyncWorld["clock"];

beforeEach(() => {
	world = createWorld();
	({ vault, remote, clock } = world);
});

/** Elapsed milliseconds between each recorded moment and the first. */
function sinceFirst(moments: readonly number[]): number[] {
	return moments.map((at) => at - (moments[0] ?? 0));
}

/** The gap before each moment after the first — the ladder, as the engine walked it. */
function gaps(moments: readonly number[]): number[] {
	return moments.slice(1).map((at, index) => at - (moments[index] ?? 0));
}

/**
 * Records when each remote listing was attempted, which is what makes a backoff ladder
 * observable: the Run itself costs no time on a clock that only a test moves.
 */
function watchListings(): number[] {
	const listing = remote.listing.bind(remote);
	const at: number[] = [];
	remote.listing = () => {
		at.push(clock.now());
		return listing();
	};
	return at;
}

/** Lets `count` armed timers fire, one at a time — `count` rungs of a backoff. */
async function waitOutRungs(count: number): Promise<void> {
	for (let rung = 0; rung < count; rung += 1) await clock.advanceToNext();
}

describe("offline backoff (spec §5.7, §5.9)", () => {
	it("walks the ladder 10 s → 30 s → 1 m → 5 m and stays at the cap", async () => {
		await vault.put("Note.md", "text");
		const listings = watchListings();
		remote.listingError = new Error("network is unreachable");

		const sync = await world.open();
		const first = await sync.syncNow("startup");
		await waitOutRungs(5);

		expect(first.outcome).toBe("offline");
		expect(first.attention).toBe("offline");
		expect(sync.currentStatus).toBe("offline");
		expect(gaps(listings)).toEqual([10_000, 30_000, 60_000, 300_000, 300_000]);
		// Nothing was planned, so nothing was touched on either side.
		expect(remote.paths()).toEqual([]);
		expect(vault.paths()).toEqual(["Note.md"]);
	});

	it("does not reset the ladder for events that arrive while it is waiting", async () => {
		await vault.put("Note.md", "text");
		const listings = watchListings();
		remote.listingError = new Error("network is unreachable");

		const sync = await world.open();
		await sync.syncNow("startup");
		// Five seconds into the first rung, the user keeps typing. Coalescing is welcome;
		// restarting the ladder on every keystroke is what would keep sync hammering.
		await clock.advance(5_000);
		void sync.markDirty(["Note.md"]);
		await clock.advance(1_000);
		void sync.markDirty(["Note.md"]);
		await waitOutRungs(1);

		expect(gaps(listings)).toEqual([10_000]);
	});

	it("cuts through the backoff for a manual sync, and resets it on success", async () => {
		await vault.put("Note.md", "text");
		const listings = watchListings();
		remote.listingError = new Error("network is unreachable");

		const sync = await world.open();
		await sync.syncNow("startup");
		expect(sync.backingOff).toBe(true);

		// "Check again": no clock movement at all, so the Run can only have started because
		// the request lifted the hold.
		remote.listingError = null;
		const recovered = await sync.syncNow("manual");

		expect(recovered.outcome).toBe("ok");
		expect(recovered.attention).toBeNull();
		expect(sync.currentStatus).toBe("idle");
		expect(gaps(listings)).toEqual([0]);
		expect(remote.text("Note.md")).toBe("text");
		// Success resets: nothing is pending, so nothing is ticking (spec §5.7).
		expect(sync.backingOff).toBe(false);
		expect(sync.busy).toBe(false);
		expect(clock.armed).toBe(0);

		// And the ladder starts from the bottom rung the next time it is needed.
		remote.listingError = new Error("gone again");
		await sync.syncNow("manual");
		await waitOutRungs(1);

		expect(gaps(listings.slice(1))).toEqual([0, 10_000]);
	});

	it("stops ticking once a Run finds nothing left to do", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		await sync.syncNow("startup");
		await world.settle(sync);

		expect(clock.armed).toBe(0);
		expect(sync.busy).toBe(false);
	});
});

describe("attention states (spec §5.7)", () => {
	it("blocks uploads on a full account while downloads and deletes keep flowing", async () => {
		await vault.put("Shared.md", "shared");
		const sync = await world.open();
		await sync.syncNow("startup");

		await vault.trash("Shared.md");
		await vault.put("Outgoing.md", "written here");
		await remote.put("Incoming.md", "written there");
		const upload = remote.upload.bind(remote);
		let attempts = 0;
		remote.upload = () => {
			attempts += 1;
			return Promise.reject(new SyncFault("quota", "storage limit reached"));
		};

		const summary = await sync.syncNow("manual");

		expect(sync.currentStatus).toBe("quota");
		expect(summary.attention).toBe("quota");
		expect(summary.outcome).toBe("partial");
		expect(summary.uploaded).toBe(0);
		expect(summary.downloaded).toBe(1);
		expect(summary.deleted).toBe(1);
		// Asked once, then believed: a second upload would only be told the same thing,
		// and neither a retry nor the other pending push is worth the round trip.
		expect(attempts).toBe(1);
		expect(vault.text("Incoming.md")).toBe("written there");
		expect(remote.paths()).toEqual(["Incoming.md"]);
		expect(summary.requeued).toBe(1);

		// Room is made: the same pending path goes up, and the status clears itself.
		remote.upload = upload;
		const recovered = await sync.syncNow("manual");

		expect(recovered.uploaded).toBe(1);
		expect(sync.currentStatus).toBe("idle");
		expect(remote.text("Outgoing.md")).toBe("written here");
	});

	it("freezes on an auth fault and does not touch the remote again until re-login", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		remote.upload = () => Promise.reject(new SyncFault("auth", "the API key was rejected"));

		const frozen = await sync.syncNow("startup");

		expect(sync.currentStatus).toBe("auth-error");
		expect(frozen.outcome).toBe("partial");
		expect(frozen.attention).toBe("auth-error");
		expect(frozen.error).toContain("the API key was rejected");
		// Nothing is pending and nothing is ticking: only a re-login can change the answer.
		expect(sync.busy).toBe(false);
		expect(clock.armed).toBe(0);

		const listings = remote.calls.listing;
		const blocked = await sync.syncNow("manual");

		expect(blocked.outcome).toBe("blocked");
		expect(blocked.attention).toBe("auth-error");
		expect(blocked.error).toContain("the API key was rejected");
		expect(remote.calls.listing).toBe(listings);
		expect(sync.currentStatus).toBe("auth-error");
	});

	it("reconciles from scratch once the credentials are restored", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		const upload = remote.upload.bind(remote);
		remote.upload = () => Promise.reject(new SyncFault("auth", "signed out"));
		await sync.syncNow("startup");

		remote.upload = upload;
		const recovered = await sync.credentialsRestored();

		expect(recovered.outcome).toBe("ok");
		expect(recovered.scope).toBe("full");
		expect(sync.currentStatus).toBe("idle");
		expect(remote.text("Note.md")).toBe("text");
	});

	it("freezes rather than deleting when the Remote Folder cannot be resolved", async () => {
		await vault.put("Kept.md", "text");
		await vault.put("Also kept.md", "more text");
		const sync = await world.open();
		await sync.syncNow("startup");
		expect(sync.records.size).toBe(2);

		// The folder the vault is linked to is gone. Read as a listing, that is "everything
		// was deleted there" — which is exactly the conclusion §5.7 forbids.
		remote.listingError = new SyncFault("missing-root", "the Remote Folder is not there");
		const summary = await sync.syncNow("foreground-resume");

		expect(sync.currentStatus).toBe("frozen");
		// The run record has to say `frozen` rather than just "offline": §8.7's activity list
		// shows past Runs, and "your folder is gone" is not "your network is down".
		expect(summary.attention).toBe("frozen");
		expect(summary.outcome).toBe("offline");
		expect(summary.deleted).toBe(0);
		expect(vault.trashed.size).toBe(0);
		expect(vault.paths()).toEqual(["Also kept.md", "Kept.md"]);
		expect(sync.records.size).toBe(2);

		// And it recovers the way the UX offers — "Check again", no folder recreation.
		remote.listingError = null;
		expect((await sync.syncNow("manual")).outcome).toBe("ok");
		expect(sync.currentStatus).toBe("idle");
	});
});

describe("Skip-and-Surface (spec §5.8)", () => {
	it("skips a Windows-reserved name and reports it, rather than renaming it", async () => {
		await remote.put("Notes/nul.md", "reserved on Windows");
		await remote.put("Notes/Fine.md", "ordinary");
		vault.unwritable = (path) => /(^|\/)(nul|con|prn|aux)(\.|$)/i.test(path);

		const summary = await (await world.open()).syncNow("startup");

		expect(summary.skips).toEqual([
			{
				path: "Notes/nul.md",
				reason: "unwritable-path",
				detail: "this platform cannot create a file with this name",
			},
		]);
		expect(summary.outcome).toBe("partial");
		// Not renamed, not retried, and the rest of the folder still synced.
		expect(vault.paths()).toEqual(["Notes/Fine.md"]);
		expect(remote.paths()).toEqual(["Notes/Fine.md", "Notes/nul.md"]);
	});

	it("syncs the lexicographically first of two remote paths that differ only in case", async () => {
		await remote.put("Note.md", "capital");
		await remote.put("note.md", "lowercase");

		const summary = await (await world.open()).syncNow("startup");

		expect(summary.skips).toEqual([
			{
				path: "note.md",
				reason: "case-collision",
				detail: "Note.md differs from this path only in case, and syncs instead",
			},
		]);
		expect(vault.paths()).toEqual(["Note.md"]);
		expect(vault.text("Note.md")).toBe("capital");
		// The loser is untouched on Filen — skipping is a local decision, not a deletion.
		expect(remote.text("note.md")).toBe("lowercase");
	});

	it("keeps syncing the colliding path it already tracks, and never deletes it", async () => {
		await vault.put("note.md", "the one this device has always had");
		const sync = await world.open();
		await sync.syncNow("startup");

		// Another client adds a path that only differs in case. Choosing by name alone would
		// drop the tracked file from the diff, and a missing remote file means "deleted".
		await remote.put("Note.md", "a stranger");
		const summary = await sync.syncNow("manual");

		expect(summary.skips.map((skip) => skip.path)).toEqual(["Note.md"]);
		expect(summary.deleted).toBe(0);
		expect(vault.paths()).toEqual(["note.md"]);
		expect(vault.text("note.md")).toBe("the one this device has always had");
		expect(sync.records.has("note.md")).toBe(true);
	});
});

describe("transient per-op retries (spec §5.7)", () => {
	it("retries a failing upload three times, one second then five, then hands it on", async () => {
		await vault.put("Flaky.md", "text");
		const attempts: number[] = [];
		remote.upload = () => {
			attempts.push(clock.now());
			return Promise.reject(new SyncFault("transient", "socket hang up"));
		};

		const sync = await world.open();
		const summary = await world.pump(sync.syncNow("startup"));

		expect(attempts).toHaveLength(ENGINE_CONSTANTS.transientAttempts);
		expect(sinceFirst(attempts)).toEqual([0, 1_000, 6_000]);
		expect(summary.outcome).toBe("partial");
		expect(summary.failures.map((failure) => failure.path)).toEqual(["Flaky.md"]);
		// Handed to the next Run rather than forgotten: nothing else would re-dirty it.
		expect(summary.requeued).toBe(1);
	});

	it("succeeds without complaint when the failure clears inside the retry budget", async () => {
		await vault.put("Flaky.md", "text");
		const upload = remote.upload.bind(remote);
		let attempts = 0;
		remote.upload = (path, data) =>
			++attempts < 3 ? Promise.reject(new SyncFault("transient", "502")) : upload(path, data);

		const summary = await world.pump((await world.open()).syncNow("startup"));

		expect(summary.outcome).toBe("ok");
		expect(summary.uploaded).toBe(1);
		expect(summary.requeued).toBe(0);
		expect(remote.text("Flaky.md")).toBe("text");
	});

	it("treats an unclassified failure as transient, because a retry is the safe default", async () => {
		await vault.put("Flaky.md", "text");
		let attempts = 0;
		remote.upload = () => {
			attempts += 1;
			return Promise.reject(new Error("something the adapter did not name"));
		};

		await world.pump((await world.open()).syncNow("startup"));

		expect(attempts).toBe(ENGINE_CONSTANTS.transientAttempts);
	});

	it("finishes the rest of the Run around a persistently failing file", async () => {
		await vault.put("Bad.md", "bad");
		await vault.put("Good.md", "good");
		await remote.put("Incoming.md", "incoming");
		const upload = remote.upload.bind(remote);
		remote.upload = (path, data) =>
			path === "Bad.md"
				? Promise.reject(new SyncFault("transient", "nope"))
				: upload(path, data);

		const sync = await world.open();
		const summary = await world.pump(sync.syncNow("startup"));

		expect(summary.uploaded).toBe(1);
		expect(summary.downloaded).toBe(1);
		expect(summary.requeued).toBe(1);
		expect(remote.paths()).toEqual(["Good.md", "Incoming.md"]);
		expect(vault.paths()).toEqual(["Bad.md", "Good.md", "Incoming.md"]);
		// One bad file never blocks the vault, and it is not dropped either: the retry
		// waits out a backoff rung rather than spinning on the 2 s event debounce.
		expect(sync.busy).toBe(true);
		expect(sync.backingOff).toBe(true);
	});

	it("does not retry an operation the remote refuses outright — it skips and surfaces it", async () => {
		await vault.put("Rejected.md", "text");
		let attempts = 0;
		remote.upload = () => {
			attempts += 1;
			return Promise.reject(new SyncFault("rejected", "Filen will not take this name"));
		};

		const summary = await world.pump((await world.open()).syncNow("startup"));

		expect(attempts).toBe(1);
		expect(summary.skips).toEqual([
			{
				path: "Rejected.md",
				reason: "remote-rejected",
				detail: "Filen will not take this name",
			},
		]);
		expect(summary.failures).toEqual([]);
		// A skip is never retried (spec §5.7), so nothing is pending on its account.
		expect(summary.requeued).toBe(0);
	});
});
