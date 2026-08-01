import { beforeEach, describe, expect, it } from "vitest";

import { ENGINE_CONSTANTS } from "../../../src/engine/constants.ts";
import { sha512Hex } from "../../../src/engine/hash.ts";
import { serializeState, type SyncState } from "../../../src/engine/state.ts";
import { createWorld, REMOTE_ROOT as ROOT, type SyncWorld } from "../../helpers/sync-world.ts";

/**
 * The Run, end to end (spec §5.1–5.2) against in-memory fakes: layer 1 of the
 * testing strategy. Adds, edits and the shape of the Run itself live here; deletions,
 * renames and the phases are in `deletes-renames.test.ts`, conflicts in ticket 033.
 */

let world: SyncWorld;
let vault: SyncWorld["vault"];
let remote: SyncWorld["remote"];
let store: SyncWorld["store"];
let clock: SyncWorld["clock"];

beforeEach(() => {
	world = createWorld();
	({ vault, remote, store, clock } = world);
});

/** Blocks the next remote listing, so a Run can be held open while requests pile up. */
function gateListing(): { release: () => void } {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const real = remote.listing.bind(remote);
	let calls = 0;
	remote.listing = async () => {
		if (++calls === 1) await gate;
		return real();
	};
	return { release: () => release() };
}

describe("adds and edits converge (spec §5.2)", () => {
	it("converges divergent adds and edits in one Run, and the next Run is a no-op", async () => {
		// A shared file, edited remotely since the last sync…
		await vault.put("Shared.md", "shared v1");
		await remote.put("Shared.md", "shared v1");
		// …plus one-sided adds on each side, one of them in a folder the other lacks.
		await vault.put("Local/Only local.md", "local only");
		await remote.put("Remote/Only remote.md", "remote only");

		const sync = await world.open();
		const first = await sync.syncNow("startup");

		expect(first.outcome).toBe("ok");
		// Shared.md pairs identically; each one-sided add moves in its own direction.
		expect(first.identical).toBe(1);
		expect(first.uploaded).toBe(1);
		expect(first.downloaded).toBe(1);
		world.expectConverged({
			"Shared.md": "shared v1",
			"Local/Only local.md": "local only",
			"Remote/Only remote.md": "remote only",
		});

		const uploads = remote.calls.upload;
		const downloads = remote.calls.download;
		const second = await sync.syncNow("manual");

		expect(second.outcome).toBe("ok");
		expect(second.uploaded + second.downloaded).toBe(0);
		expect(remote.calls.upload).toBe(uploads);
		expect(remote.calls.download).toBe(downloads);
	});

	it("pushes a local edit and pulls a remote edit made since the last sync", async () => {
		await vault.put("Local edit.md", "v1");
		await vault.put("Remote edit.md", "v1");
		const sync = await world.open();
		await sync.syncNow("startup");

		await vault.put("Local edit.md", "v2 — typed here");
		await remote.put("Remote edit.md", "v2 — typed elsewhere");
		const summary = await sync.syncNow("manual");

		expect(summary.uploaded).toBe(1);
		expect(summary.downloaded).toBe(1);
		world.expectConverged({
			"Local edit.md": "v2 — typed here",
			"Remote edit.md": "v2 — typed elsewhere",
		});
	});

	it("converges silently when both sides changed to the same content", async () => {
		await vault.put("Note.md", "v1");
		await remote.put("Note.md", "v1");
		const sync = await world.open();
		await sync.syncNow("startup");

		await vault.put("Note.md", "same new text");
		await remote.put("Note.md", "same new text");
		const summary = await sync.syncNow("manual");

		// Equal hashes are compared before anything else, so there is nothing to merge
		// and nothing to transfer — just a record refresh.
		expect(summary.conflicts).toBe(0);
		expect(summary.uploaded + summary.downloaded).toBe(0);
		expect(summary.identical).toBe(1);
		expect(sync.records.get("Note.md")?.remoteUuid).toBe(remote.uuidAt("Note.md"));
	});

	it("records what it synced, including the Mergeable flag", async () => {
		await vault.put("Note.md", "text");
		await vault.put("Image.png", new Uint8Array([1, 2, 3]));
		const sync = await world.open();
		await sync.syncNow("startup");

		const note = sync.records.get("Note.md");
		expect(note?.mergeable).toBe(true);
		expect(note?.lastSyncedHash).toBe(await sha512Hex(new TextEncoder().encode("text")));
		expect(note?.remoteUuid).toBe(remote.uuidAt("Note.md"));
		expect(sync.records.get("Image.png")?.mergeable).toBe(false);
	});

	it("catches a remote change even when the Run's scope never mentioned it", async () => {
		await vault.put("Watched.md", "v1");
		await vault.put("Elsewhere.md", "v1");
		const sync = await world.open();
		await sync.syncNow("startup");

		await remote.put("Elsewhere.md", "changed by another device");
		// A scoped Run for an unrelated path: remote-delta scope expansion (spec §5.1
		// step 3) still notices, which is why a missed socket event costs only latency.
		await vault.put("Watched.md", "v2");
		const summary = await world.dirtyRun(sync, ["Watched.md"]);

		expect(summary.uploaded).toBe(1);
		expect(summary.downloaded).toBe(1);
		expect(vault.text("Elsewhere.md")).toBe("changed by another device");
	});

	it("refuses to write a download whose bytes contradict the recorded hash", async () => {
		const uuid = await remote.put("Tampered.md", "honest");
		// Same UUID, different bytes: only a corrupt or malicious transfer looks like this.
		await remote.move(uuid, "Tampered.md");
		const listing = await remote.listing();
		expect(listing[0]?.hash).toBeDefined();
		remote.download = () => Promise.resolve(new TextEncoder().encode("swapped"));

		const summary = await (await world.open()).syncNow("startup");

		expect(summary.outcome).toBe("partial");
		expect(summary.failures[0]?.path).toBe("Tampered.md");
		expect(vault.paths()).toEqual([]);
	});
});

describe("First Link — a FULL Reconcile with empty state (spec §5.2, ticket 011)", () => {
	it("uploads everything when the Remote Folder is empty", async () => {
		await vault.put("A.md", "a");
		await vault.put("Notes/B.md", "b");

		const summary = await (await world.open()).syncNow("first-link");

		expect(summary.uploaded).toBe(2);
		world.expectConverged({ "A.md": "a", "Notes/B.md": "b" });
	});

	it("downloads everything into an empty vault", async () => {
		await remote.put("A.md", "a");
		await remote.put("Notes/B.md", "b");

		const summary = await (await world.open()).syncNow("first-link");

		expect(summary.downloaded).toBe(2);
		world.expectConverged({ "A.md": "a", "Notes/B.md": "b" });
	});

	it("pairs hash-identical files silently, without transferring anything", async () => {
		await vault.put("Same.md", "identical bytes");
		await remote.put("Same.md", "identical bytes");

		const sync = await world.open();
		const summary = await sync.syncNow("first-link");

		expect(summary.identical).toBe(1);
		expect(remote.calls.upload).toBe(1); // the seeding put, and nothing since
		expect(remote.calls.download).toBe(0);
		expect(sync.records.get("Same.md")?.remoteUuid).toBe(remote.uuidAt("Same.md"));
	});

	it("defers same-path-different-content to the conflict slice, destroying nothing", async () => {
		await vault.put("Clash.md", "written here");
		await remote.put("Clash.md", "written there");

		const sync = await world.open();
		const summary = await sync.syncNow("first-link");

		// Ticket 033 turns this into a Conflict Copy; until then the honest outcome is
		// "planned, not executed" — never a silent overwrite.
		expect(summary.conflicts).toBe(1);
		expect(summary.outcome).toBe("partial");
		expect(vault.text("Clash.md")).toBe("written here");
		expect(remote.text("Clash.md")).toBe("written there");
		expect(sync.records.has("Clash.md")).toBe(false);
	});

	it("cannot delete anything, because there are no records to delete from", async () => {
		await vault.put("Only local.md", "a");
		await remote.put("Only remote.md", "b");

		await (await world.open()).syncNow("first-link");

		expect(vault.trashed.size).toBe(0);
		expect(remote.trashed.size).toBe(0);
	});

	it("treats an unknown remote hash as unproven rather than identical", async () => {
		await vault.put("Same.md", "identical bytes");
		await remote.put("Same.md", "identical bytes");
		remote.hashless = true; // an older Filen client recorded no plaintext hash

		const summary = await (await world.open()).syncNow("first-link");

		expect(summary.identical).toBe(0);
		expect(summary.conflicts).toBe(1);
	});
});

describe("plan-only entry point (spec §8.4)", () => {
	it("returns counts and conflict paths without touching either side", async () => {
		await vault.put("Up.md", "up");
		await vault.put("Same.md", "same");
		await remote.put("Same.md", "same");
		await remote.put("Down.md", "down");
		await vault.put("Clash.md", "here");
		await remote.put("Clash.md", "there");

		const sync = await world.open();
		const before = {
			vault: vault.paths(),
			remote: remote.paths(),
			writes: store.writes.length,
			vaultWrites: vault.calls.write,
		};
		const plan = await sync.plan();

		expect(plan.counts.upload).toBe(1);
		expect(plan.counts.download).toBe(1);
		expect(plan.counts.identical).toBe(1);
		expect(plan.counts.conflict).toBe(1);
		expect(plan.conflictPaths).toEqual(["Clash.md"]);
		// Nothing moved, nothing was written, no record exists yet.
		expect(vault.paths()).toEqual(before.vault);
		expect(remote.paths()).toEqual(before.remote);
		expect(store.writes.length).toBe(before.writes);
		expect(sync.records.size).toBe(0);
		expect(vault.calls.write).toBe(before.vaultWrites);
	});

	it("reports scan progress so the First Link modal can show it", async () => {
		await vault.put("Same.md", "same");
		await remote.put("Same.md", "same");

		const phases: string[] = [];
		await (await world.open()).plan({ onProgress: (progress) => phases.push(progress.phase) });

		expect(phases).toContain("listing");
		expect(phases).toContain("scanning");
		expect(phases).toContain("hashing");
	});

	it("executes an approved plan as an ordinary Run", async () => {
		await vault.put("Up.md", "up");
		await remote.put("Down.md", "down");

		const sync = await world.open();
		const plan = await sync.plan();
		const summary = await sync.runApprovedPlan(plan);

		expect(summary.triggers).toEqual(["first-link"]);
		expect(summary.uploaded).toBe(1);
		expect(summary.downloaded).toBe(1);
		world.expectConverged({ "Up.md": "up", "Down.md": "down" });
	});

	it("re-plans instead of executing an approved plan that other work joined", async () => {
		await vault.put("Up.md", "up");
		const sync = await world.open();
		const plan = await sync.plan();

		// Hold one Run open, so the confirmation and a vault event land in the same
		// pending scope: the preview no longer describes the world, and the Run that
		// serves it must plan again rather than trust it.
		const gate = gateListing();
		const blocker = sync.markDirty(["Unrelated.md"]);
		await clock.advance(ENGINE_CONSTANTS.eventDebounceMs);

		const confirmed = sync.runApprovedPlan(plan);
		await vault.put("Late.md", "late");
		void sync.markDirty(["Late.md"]);
		gate.release();
		await blocker;
		const summary = await confirmed;

		expect(summary.triggers).toEqual(["first-link", "vault-event"]);
		expect(summary.uploaded).toBe(2);
		expect(remote.paths()).toEqual(["Late.md", "Up.md"]);
	});
});

describe("change detection (spec §3.2)", () => {
	it("skips hashing when size and mtime are both unchanged", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		await sync.syncNow("startup");

		const reads = vault.calls.read;
		await sync.syncNow("manual");

		// The cheap path means a quiet vault costs stats, not reads.
		expect(vault.calls.read).toBe(reads);
	});

	it("hashes on a stat mismatch and stays quiet when the content is unchanged", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		await sync.syncNow("startup");
		const uuid = remote.uuidAt("Note.md");

		await vault.put("Note.md", "text"); // identical rewrite: new mtime, same bytes
		const reads = vault.calls.read;
		const summary = await sync.syncNow("manual");

		expect(vault.calls.read).toBe(reads + 1); // hashed, because the stat moved
		expect(summary.uploaded).toBe(0); // …and found nothing to send
		expect(summary.identical).toBe(1);
		expect(remote.uuidAt("Note.md")).toBe(uuid);
		// The refreshed stat is what stops the next Run from hashing it again.
		expect(sync.records.get("Note.md")?.localMtime).toBe((await vault.stat("Note.md"))?.mtime);
	});

	it("re-hashes everything on Verify and repair", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		await sync.syncNow("startup");

		const reads = vault.calls.read;
		await sync.verifyAndRepair();

		expect(vault.calls.read).toBe(reads + 1);
	});

	it("notices a same-content re-upload from another client by UUID alone", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		await sync.syncNow("startup");
		const before = sync.records.get("Note.md")?.remoteUuid;

		await remote.put("Note.md", "text"); // new UUID, identical bytes
		const summary = await sync.syncNow("manual");

		expect(summary.downloaded).toBe(0);
		expect(summary.identical).toBe(1);
		expect(sync.records.get("Note.md")?.remoteUuid).not.toBe(before);
		expect(sync.records.get("Note.md")?.remoteUuid).toBe(remote.uuidAt("Note.md"));
	});
});

describe("Sync State persistence (spec §3)", () => {
	it("writes the state through the port as one complete document", async () => {
		await vault.put("A.md", "a");
		await remote.put("B.md", "b");

		const sync = await world.open();
		await sync.syncNow("startup");

		expect(store.writes.length).toBeGreaterThan(0);
		const document = JSON.parse(store.state!) as { files: Record<string, unknown> };
		expect(Object.keys(document.files).sort()).toEqual(["A.md", "B.md"]);
	});

	it("writes nothing when a Run finds nothing to do", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		await sync.syncNow("startup");

		const writes = store.writes.length;
		await sync.syncNow("manual");

		// A quiet vault must not rewrite the state file on every Run: on mobile that is
		// pointless I/O inside the config folder.
		expect(store.writes.length).toBe(writes);
	});

	it("replaces a discarded state document even when the Run changes nothing", async () => {
		const sync = await world.open({ state: "{ truncated" });

		await sync.syncNow("startup");

		// Otherwise the unusable file survives and every startup re-bootstraps again.
		expect(store.state).not.toBe("{ truncated");
		expect(JSON.parse(store.state!)).toMatchObject({ schemaVersion: 1, remoteRoot: ROOT });
	});

	it("re-bootstraps from corrupt state without losing data", async () => {
		await vault.put("Shared.md", "shared");
		await remote.put("Shared.md", "shared");
		await remote.put("Only remote.md", "remote");

		const sync = await world.open({ state: "{ truncated" });
		expect(sync.stateReset).toBe("corrupt");
		const summary = await sync.syncNow("startup");

		// First-Link rules again: nothing deleted, the identical pair recognized.
		expect(summary.identical).toBe(1);
		expect(summary.downloaded).toBe(1);
		expect(vault.trashed.size).toBe(0);
		world.expectConverged({ "Shared.md": "shared", "Only remote.md": "remote" });
	});

	it("re-bootstraps when the vault was re-linked to a different folder", async () => {
		await vault.put("Note.md", "text");
		const stale: SyncState = {
			schemaVersion: 1,
			remoteRoot: "a-different-folder",
			files: new Map([
				[
					"Note.md",
					{
						lastSyncedHash: "0".repeat(128),
						size: 1,
						localMtime: 1,
						remoteUuid: "gone",
						mergeable: true,
					},
				],
			]),
		};

		const sync = await world.open({ state: serializeState(stale) });

		expect(sync.stateReset).toBe("root-changed");
		const summary = await sync.syncNow("startup");
		// Had the stale record been trusted, "Note.md" would have looked deleted remotely.
		expect(summary.uploaded).toBe(1);
		expect(vault.trashed.size).toBe(0);
	});
});

describe("scope, skips and failures", () => {
	it("keeps out-of-scope paths invisible instead of missing", async () => {
		await vault.put(".obsidian/workspace.json", "churn");
		await vault.put("Note.md", "text");
		await remote.put("Note.md", "text");
		const sync = await world.open({ scope: (path) => !path.startsWith(".obsidian/") });

		const summary = await sync.syncNow("startup");

		expect(summary.outcome).toBe("ok");
		expect(remote.paths()).toEqual(["Note.md"]);
		expect(vault.text(".obsidian/workspace.json")).toBe("churn");
		expect(sync.records.has(".obsidian/workspace.json")).toBe(false);
	});

	it("drops records for paths that left the scope, without deleting anything", async () => {
		await vault.put("Secret/Note.md", "text");
		let inScope = true;
		const sync = await world.open({ scope: (path) => inScope || !path.startsWith("Secret/") });
		await sync.syncNow("startup");
		expect(sync.records.has("Secret/Note.md")).toBe(true);

		inScope = false;
		const summary = await sync.syncNow("manual");

		expect(sync.records.has("Secret/Note.md")).toBe(false);
		expect(vault.trashed.size).toBe(0);
		expect(remote.trashed.size).toBe(0);
		expect(summary.outcome).toBe("ok");
	});

	it("skips a name this platform cannot materialize, never renaming it", async () => {
		await remote.put("Bad: name.md", "text");
		await remote.put("Fine.md", "text");
		vault.unwritable = (path) => path.includes(":");

		const summary = await (await world.open()).syncNow("startup");

		expect(summary.skipped).toBe(1);
		expect(summary.downloaded).toBe(1);
		expect(vault.paths()).toEqual(["Fine.md"]);
	});

	it.each([
		["before", true],
		["after", false],
	])(
		"keeps the remote file it already tracks when a stranger shares its path (%s it)",
		async (_position, strangerFirst) => {
			await vault.put("Note.md", "text");
			const sync = await world.open();
			await sync.syncNow("startup");
			const tracked = remote.uuidAt("Note.md");

			const real = remote.listing.bind(remote);
			// Two files at one path, the stranger's UUID sorting first: choosing by UUID
			// order alone would discard the tracked file and download this over the top.
			const stranger = { path: "Note.md", uuid: "aaa-stranger", size: 8, hash: "f".repeat(128) };
			remote.listing = async () => {
				const entries = await real();
				return strangerFirst ? [stranger, ...entries] : [...entries, stranger];
			};

			const summary = await sync.syncNow("manual");

			expect(summary.downloaded).toBe(0);
			expect(summary.skipped).toBe(1);
			expect(summary.outcome).toBe("partial");
			// Nothing was even attempted against the stranger: keeping it would classify
			// the path as remotely modified and try to fetch a file the engine never saw.
			expect(summary.failures).toEqual([]);
			expect(sync.records.get("Note.md")?.remoteUuid).toBe(tracked);
			expect(vault.text("Note.md")).toBe("text");
		},
	);

	it("reports a failed listing as offline and leaves both sides alone", async () => {
		await vault.put("Note.md", "text");
		remote.listingError = new Error("network is unreachable");

		const sync = await world.open();
		const summary = await sync.syncNow("startup");

		expect(summary.outcome).toBe("offline");
		expect(sync.currentStatus).toBe("offline");
		expect(remote.paths()).toEqual([]);
	});

	it("lets one failing file through without blocking the others", async () => {
		await vault.put("Good.md", "good");
		await vault.put("Bad.md", "bad");
		const realUpload = remote.upload.bind(remote);
		remote.upload = (path, data) =>
			path === "Bad.md" ? Promise.reject(new Error("nope")) : realUpload(path, data);

		const summary = await (await world.open()).syncNow("startup");

		expect(summary.outcome).toBe("partial");
		expect(summary.uploaded).toBe(1);
		expect(summary.failures.map((failure) => failure.path)).toEqual(["Bad.md"]);
		expect(remote.paths()).toEqual(["Good.md"]);
	});

	it("moves the status surface through syncing and back to idle", async () => {
		await vault.put("Note.md", "text");
		const sync = await world.open();
		const seen: string[] = [];
		sync.subscribe((status) => seen.push(status));

		await sync.syncNow("startup");

		expect(seen).toEqual(["syncing", "idle"]);
		expect(sync.lastRun?.triggers).toEqual(["startup"]);
		expect(sync.lastRun?.scope).toBe("full");
	});
});

describe("the conflict slice is visible, not silent", () => {
	it("reports a both-modified path as a conflict instead of picking a winner", async () => {
		await vault.put("Note.md", "v1");
		await remote.put("Note.md", "v1");
		const sync = await world.open();
		await sync.syncNow("startup");

		await vault.put("Note.md", "v2 — here");
		await remote.put("Note.md", "v2 — there");
		const summary = await sync.syncNow("manual");

		// Ticket 033 merges or makes a Conflict Copy; until then the honest outcome is
		// "planned, not executed" — never last-writer-wins.
		expect(summary.conflicts).toBe(1);
		expect(summary.outcome).toBe("partial");
		expect(vault.text("Note.md")).toBe("v2 — here");
		expect(remote.text("Note.md")).toBe("v2 — there");
	});
});

describe("scoped Runs", () => {
	it("stats only the paths in scope", async () => {
		await vault.put("A.md", "a");
		await vault.put("B.md", "b");
		const sync = await world.open();
		await sync.syncNow("startup");

		vault.calls.list = 0;
		await vault.put("A.md", "a2");
		const summary = await world.dirtyRun(sync, ["A.md"]);

		expect(vault.calls.list).toBe(0); // no full scan for a scoped Run
		expect(summary.scope).toBe("paths");
		expect(summary.uploaded).toBe(1);
		expect(remote.text("A.md")).toBe("a2");
	});

	it("ignores an out-of-scope path handed to it by an event", async () => {
		const sync = await world.open({ scope: (path) => !path.endsWith(".tmp") });
		await vault.put("Draft.tmp", "scratch");

		const summary = await world.dirtyRun(sync, ["Draft.tmp"]);

		expect(summary.uploaded).toBe(0);
		expect(remote.paths()).toEqual([]);
	});
});
