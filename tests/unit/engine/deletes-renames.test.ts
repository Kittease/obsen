import { beforeEach, describe, expect, it } from "vitest";

import { ENGINE_CONSTANTS } from "../../../src/engine/constants.ts";
import { SyncEngine } from "../../../src/engine/engine.ts";
import { createWorld, crashing, REMOTE_ROOT, type SyncWorld } from "../../helpers/sync-world.ts";

/**
 * Deletions, rename pairing and the five execution phases (spec §5.2–5.5) against
 * in-memory fakes.
 *
 * The through-line of every scenario here is that nothing is destroyed: deletes are
 * soft on both sides, an edit always beats a delete, and a pairing the engine cannot
 * prove degrades to delete + create rather than guessing.
 */

let world: SyncWorld;

beforeEach(() => {
	world = createWorld();
});

/** A vault and Remote Folder already synced on these paths, plus the engine that did it. */
async function linked(files: Record<string, string>): Promise<SyncEngine> {
	for (const [path, content] of Object.entries(files)) {
		await world.vault.put(path, content);
		await world.remote.put(path, content);
	}
	const sync = await world.open();
	await sync.syncNow("startup");
	return sync;
}

describe("deletions propagate as Soft Delete (spec §5.2, ticket 007)", () => {
	it("trashes the remote file when the local one is gone", async () => {
		const sync = await linked({ "Note.md": "text", "Keep.md": "keep" });
		const uuid = world.remote.uuidAt("Note.md")!;

		await world.vault.trash("Note.md");
		const summary = await sync.syncNow("manual");

		expect(summary.outcome).toBe("ok");
		expect(summary.deleted).toBe(1);
		expect(world.remote.paths()).toEqual(["Keep.md"]);
		// Soft, never permanent: Filen's trash still holds the bytes.
		expect(world.remote.trashed.get(uuid)?.path).toBe("Note.md");
		expect(sync.records.has("Note.md")).toBe(false);
	});

	it("trashes the local file when the remote one is gone", async () => {
		const sync = await linked({ "Note.md": "text", "Keep.md": "keep" });
		const uuid = world.remote.uuidAt("Note.md")!;

		await world.remote.trashFile(uuid);
		const summary = await sync.syncNow("manual");

		expect(summary.deleted).toBe(1);
		expect(world.vault.paths()).toEqual(["Keep.md"]);
		expect(world.vault.trashed.get("Note.md")).toBeDefined();
		expect(sync.records.has("Note.md")).toBe(false);
	});

	it("drops the record when both sides already deleted it, touching neither trash", async () => {
		const sync = await linked({ "Note.md": "text" });
		const uuid = world.remote.uuidAt("Note.md")!;

		await world.vault.trash("Note.md");
		world.vault.trashed.clear();
		await world.remote.trashFile(uuid);
		world.remote.trashed.clear();
		const summary = await sync.syncNow("manual");

		expect(summary.outcome).toBe("ok");
		expect(summary.deleted).toBe(0);
		expect(sync.records.has("Note.md")).toBe(false);
		expect(world.vault.trashed.size).toBe(0);
		expect(world.remote.trashed.size).toBe(0);
	});

	it("restores a remote edit over a local delete", async () => {
		const sync = await linked({ "Note.md": "v1" });

		await world.vault.trash("Note.md");
		await world.remote.put("Note.md", "v2 — edited elsewhere");
		const summary = await sync.syncNow("manual");

		// Never destroy an edit on the say-so of stale state (spec §5.2).
		expect(summary.downloaded).toBe(1);
		expect(summary.deleted).toBe(0);
		world.expectConverged({ "Note.md": "v2 — edited elsewhere" });
	});

	it("restores a local edit over a remote delete", async () => {
		const sync = await linked({ "Note.md": "v1" });

		await world.remote.trashFile(world.remote.uuidAt("Note.md")!);
		await world.vault.put("Note.md", "v2 — edited here");
		const summary = await sync.syncNow("manual");

		expect(summary.uploaded).toBe(1);
		expect(summary.deleted).toBe(0);
		world.expectConverged({ "Note.md": "v2 — edited here" });
	});

	it("removes a folder only once it is empty, topmost emptied folder first", async () => {
		const sync = await linked({
			"Trip/Day 1.md": "one",
			"Trip/Notes/Deep.md": "deep",
			"Keep/Kept.md": "kept",
		});

		await world.remote.trashFolder("Trip");
		world.vault.trashedFolders.length = 0;
		const summary = await sync.syncNow("manual");

		expect(summary.deleted).toBe(2);
		expect(world.vault.paths()).toEqual(["Keep/Kept.md"]);
		expect(world.vault.trashed.has("Trip/Day 1.md")).toBe(true);
		expect(world.vault.trashed.has("Trip/Notes/Deep.md")).toBe(true);
		// The emptied tree goes as one recursive trash of its topmost folder — never
		// "Keep", which still holds a file, and never the vault root.
		expect(world.vault.trashedFolders).toEqual(["Trip"]);
	});

	it("keeps a folder that still holds a file the deletes did not touch", async () => {
		const sync = await linked({ "Trip/Gone.md": "gone", "Trip/Stays.md": "stays" });

		await world.remote.trashFile(world.remote.uuidAt("Trip/Gone.md")!);
		await sync.syncNow("manual");

		expect(world.vault.trashedFolders).toEqual([]);
		expect(world.vault.paths()).toEqual(["Trip/Stays.md"]);
		expect(world.vault.text("Trip/Stays.md")).toBe("stays");
	});

	/**
	 * A folder that loses its last tracked file and gains a brand-new one in the *same*
	 * Run. Phase 5 judges emptiness from a snapshot taken before execution, so a folder
	 * receiving a phase-3 transfer has to count as occupied — otherwise the recursive
	 * trash deletes the file the Run had just delivered, and the next Run propagates
	 * that loss to the other side.
	 */
	it("never trashes a local folder this Run has just downloaded into", async () => {
		const sync = await linked({ "Folder/Old.md": "old" });

		await world.remote.trashFile(world.remote.uuidAt("Folder/Old.md")!);
		await world.remote.put("Folder/New.md", "brand new note");
		const summary = await sync.syncNow("manual");

		expect(summary.deleted).toBe(1);
		expect(world.vault.trashedFolders).toEqual([]);
		world.expectConverged({ "Folder/New.md": "brand new note" });
	});

	it("never trashes a remote folder this Run has just uploaded into", async () => {
		const sync = await linked({ "Folder/Old.md": "old" });

		await world.vault.trash("Folder/Old.md");
		await world.vault.put("Folder/New.md", "brand new note");
		const summary = await sync.syncNow("manual");

		expect(summary.deleted).toBe(1);
		expect(world.remote.trashedFolders).toEqual([]);
		world.expectConverged({ "Folder/New.md": "brand new note" });
	});

	it("never reads out-of-scope remote content as a local deletion", async () => {
		await world.vault.put("Note.md", "text");
		await world.remote.put("Note.md", "text");
		// A remote file this device does not materialize at all: invisible, not missing.
		await world.remote.put("Private/Secret.md", "not for this device");
		const sync = await world.open({ scope: (path) => !path.startsWith("Private/") });

		const summary = await sync.syncNow("startup");

		expect(summary.outcome).toBe("ok");
		expect(summary.deleted).toBe(0);
		expect(world.remote.trashed.size).toBe(0);
		expect(world.remote.text("Private/Secret.md")).toBe("not for this device");
		expect(world.vault.paths()).toEqual(["Note.md"]);
	});

	it("forgets a record that left the Sync Scope instead of deleting its file", async () => {
		await world.vault.put("Secret/Note.md", "text");
		let everything = true;
		const sync = await world.open({ scope: (path) => everything || !path.startsWith("Secret/") });
		await sync.syncNow("startup");

		everything = false;
		const summary = await sync.syncNow("manual");

		expect(summary.deleted).toBe(0);
		expect(sync.records.has("Secret/Note.md")).toBe(false);
		expect(world.vault.trashed.size).toBe(0);
		expect(world.remote.trashed.size).toBe(0);
	});
});

describe("rename pairing — three tiers, one pass (spec §5.3)", () => {
	it("tier 1: follows a remote rename by UUID, transferring nothing", async () => {
		const sync = await linked({ "Old.md": "content" });
		const uuid = world.remote.uuidAt("Old.md")!;

		await world.remote.move(uuid, "New.md");
		const downloads = world.remote.calls.download;
		const summary = await sync.syncNow("manual");

		expect(summary.moved).toBe(1);
		expect(summary.uploaded + summary.downloaded).toBe(0);
		expect(world.remote.calls.download).toBe(downloads);
		expect(world.vault.trashed.size).toBe(0);
		world.expectConverged({ "New.md": "content" });
		expect(sync.records.get("New.md")?.remoteUuid).toBe(uuid);
		expect(sync.records.has("Old.md")).toBe(false);
	});

	it("tier 1: rekeys without a second local rename when the vault already moved", async () => {
		const sync = await linked({ "Old.md": "content" });
		const uuid = world.remote.uuidAt("Old.md")!;

		// The shape a crashed Run leaves behind: both sides moved, the record did not.
		await world.remote.move(uuid, "New.md");
		await world.vault.rename("Old.md", "New.md");
		const summary = await sync.syncNow("startup");

		expect(summary.moved).toBe(1);
		expect(summary.uploaded + summary.downloaded).toBe(0);
		world.expectConverged({ "New.md": "content" });
		expect(sync.records.get("New.md")?.remoteUuid).toBe(uuid);
	});

	it("tier 2: pairs a live rename from its hint and moves the remote file", async () => {
		const sync = await linked({ "Old.md": "content" });
		const uuid = world.remote.uuidAt("Old.md")!;

		await world.vault.rename("Old.md", "Archive/New.md");
		const uploads = world.remote.calls.upload;
		const summary = await world.dirtyRun(sync, ["Old.md", "Archive/New.md"], [
			{ from: "Old.md", to: "Archive/New.md" },
		]);

		expect(summary.moved).toBe(1);
		expect(world.remote.calls.upload).toBe(uploads); // moved, not re-sent
		expect(world.remote.uuidAt("Archive/New.md")).toBe(uuid);
		expect(world.remote.trashed.size).toBe(0);
		world.expectConverged({ "Archive/New.md": "content" });
	});

	it("tier 2: pairs a rename that also changed the content, then uploads it", async () => {
		const sync = await linked({ "Old.md": "v1" });
		const uuid = world.remote.uuidAt("Old.md")!;

		await world.vault.rename("Old.md", "New.md");
		await world.vault.put("New.md", "v2 — renamed and edited");
		const summary = await world.dirtyRun(sync, ["Old.md", "New.md"], [
			{ from: "Old.md", to: "New.md" },
		]);

		expect(summary.moved).toBe(1);
		expect(summary.uploaded).toBe(1);
		expect(world.remote.trashed.size).toBe(0);
		world.expectConverged({ "New.md": "v2 — renamed and edited" });
		// The move carried the file to its new path; the edit that followed is what mints
		// a fresh UUID there, exactly as a content update always does.
		expect(world.remote.uuidAt("New.md")).not.toBe(uuid);
	});

	it("tier 2: rekeys a whole folder with a single remote moveFolder", async () => {
		const sync = await linked({ "Trip/A.md": "a", "Trip/Sub/B.md": "b" });
		const uuids = {
			a: world.remote.uuidAt("Trip/A.md"),
			b: world.remote.uuidAt("Trip/Sub/B.md"),
		};

		await world.vault.mkdir("Journey/Sub");
		await world.vault.rename("Trip/A.md", "Journey/A.md");
		await world.vault.rename("Trip/Sub/B.md", "Journey/Sub/B.md");
		const uploads = world.remote.calls.upload;
		const summary = await world.dirtyRun(
			sync,
			["Journey/A.md", "Journey/Sub/B.md"],
			[{ from: "Trip", to: "Journey" }],
		);

		expect(summary.moved).toBe(2);
		expect(world.remote.calls.upload).toBe(uploads);
		expect(world.remote.uuidAt("Journey/A.md")).toBe(uuids.a);
		expect(world.remote.uuidAt("Journey/Sub/B.md")).toBe(uuids.b);
		world.expectConverged({ "Journey/A.md": "a", "Journey/Sub/B.md": "b" });
	});

	it("tier 3: pairs an offline rename by exact content hash, with no hint at all", async () => {
		const sync = await linked({ "Old.md": "unique content" });
		const uuid = world.remote.uuidAt("Old.md")!;

		// Renamed while Obsidian was closed: no event fired, so no hint exists.
		await world.vault.rename("Old.md", "New.md");
		const uploads = world.remote.calls.upload;
		const summary = await sync.syncNow("startup");

		expect(summary.moved).toBe(1);
		expect(world.remote.calls.upload).toBe(uploads);
		expect(world.remote.uuidAt("New.md")).toBe(uuid);
		world.expectConverged({ "New.md": "unique content" });
	});

	it("tier 3: degrades to delete + create when two files share the content", async () => {
		const sync = await linked({ "A.md": "same bytes", "B.md": "same bytes" });

		await world.vault.rename("A.md", "C.md");
		await world.vault.rename("B.md", "D.md");
		const summary = await sync.syncNow("startup");

		// Ambiguous in both directions, so nothing is paired — but Soft Delete makes the
		// fallback safe and both sides still converge.
		expect(summary.moved).toBe(0);
		expect(summary.uploaded).toBe(2);
		expect(summary.deleted).toBe(2);
		world.expectConverged({ "C.md": "same bytes", "D.md": "same bytes" });
		expect(world.remote.trashed.size).toBe(2);
	});

	it("degrades instead of pairing when the destination is already occupied", async () => {
		const sync = await linked({ "Old.md": "content" });

		// The vault already has something at the name the remote rename is heading for.
		await world.vault.put("New.md", "already here");
		await world.remote.move(world.remote.uuidAt("Old.md")!, "New.md");
		const summary = await sync.syncNow("manual");

		expect(summary.moved).toBe(0);
		// Nothing is destroyed: the vault's own file stands, the old one is soft-deleted,
		// and the collision is reported rather than resolved by force.
		expect(world.vault.text("New.md")).toBe("already here");
		expect(world.vault.trashed.get("Old.md")).toBeDefined();
		expect(summary.conflicts).toBe(1);
	});

	it("does not pair a hint the scan contradicts", async () => {
		const sync = await linked({ "Old.md": "content" });

		// A hint that never happened: the file is still where it was.
		const summary = await world.dirtyRun(sync, ["Old.md", "New.md"], [
			{ from: "Old.md", to: "New.md" },
		]);

		expect(summary.moved).toBe(0);
		world.expectConverged({ "Old.md": "content" });
	});
});

describe("five execution phases (spec §5.4–5.5)", () => {
	it("runs deletes after transfers, so a rename-shaped churn never loses content", async () => {
		const sync = await linked({ "Old.md": "content" });
		const order: string[] = [];
		const upload = world.remote.upload.bind(world.remote);
		const trashFile = world.remote.trashFile.bind(world.remote);
		world.remote.upload = async (path, data) => {
			order.push(`upload ${path}`);
			return upload(path, data);
		};
		world.remote.trashFile = async (uuid) => {
			order.push("trash");
			return trashFile(uuid);
		};

		// A delete-and-create the engine cannot pair (the content changed too).
		await world.vault.trash("Old.md");
		await world.vault.put("New.md", "different content");
		await sync.syncNow("startup");

		expect(order).toEqual(["upload New.md", "trash"]);
		world.expectConverged({ "New.md": "different content" });
	});

	it("skips and re-dirties a file that changed between classification and the write", async () => {
		const sync = await linked({ "Note.md": "v1" });
		await world.remote.put("Note.md", "v2 — from elsewhere");

		const download = world.remote.download.bind(world.remote);
		let typed = false;
		world.remote.download = async (uuid) => {
			const data = await download(uuid);
			if (!typed) {
				typed = true;
				// The user types into the file while the download is in flight.
				await world.vault.put("Note.md", "v2 — typed here, mid-download");
			}
			return data;
		};
		const summary = await sync.syncNow("manual");

		// The local edit survives: clobbering it would destroy a change no one has seen.
		expect(world.vault.text("Note.md")).toBe("v2 — typed here, mid-download");
		expect(summary.requeued).toBe(1);
		expect(summary.downloaded).toBe(0);
		expect(summary.outcome).toBe("partial");

		// …and the path went back into the Dirty Set, so the follow-up Run judges it for
		// real — as the conflict it now genuinely is, rather than as an overwrite.
		await world.settle(sync);
		expect(world.vault.text("Note.md")).toBe("v2 — typed here, mid-download");
		expect(world.vault.paths().filter((path) => path.includes("(conflict "))).toHaveLength(1);
	});

	it("refuses to trash a local file that was edited since classification", async () => {
		const sync = await linked({ "Note.md": "v1" });
		await world.remote.trashFile(world.remote.uuidAt("Note.md")!);

		const trash = world.vault.trash.bind(world.vault);
		let intercepted = false;
		world.vault.trash = async (path) => {
			if (!intercepted) {
				intercepted = true;
				await world.vault.put(path, "v2 — typed just now");
			}
			return trash(path);
		};
		// The edit lands before the trash op re-stats, so the guard must catch it.
		await world.vault.put("Note.md", "v2 — typed just now");
		const summary = await sync.syncNow("manual");

		expect(world.vault.text("Note.md")).toBe("v2 — typed just now");
		expect(summary.deleted).toBe(0);
	});

	it("flushes the Sync State during a long transfer phase, not only at its end", async () => {
		for (let index = 0; index < 6; index += 1) {
			await world.vault.put(`Note ${index}.md`, `content ${index}`);
		}
		const sync = await world.open();
		const upload = world.remote.upload.bind(world.remote);
		world.remote.upload = async (path, data) => {
			// Each upload costs more than the flush interval, so the cadence must fire.
			await world.clock.advance(ENGINE_CONSTANTS.stateFlushIntervalMs);
			return upload(path, data);
		};

		await sync.syncNow("startup");

		// A single phase-boundary flush would leave one write; the cadence leaves several.
		expect(world.store.writes.length).toBeGreaterThan(1);
	});

	it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
		"converges after a power cut %i operations into the Run",
		async (budget) => {
			await world.vault.put("Local add.md", "added here");
			await world.vault.put("Renamed.md", "unique bytes");
			await world.vault.put("Shared.md", "shared");
			await world.remote.put("Shared.md", "shared");
			await world.remote.put("Remote add.md", "added there");
			const first = await world.open();
			await first.syncNow("startup");

			// A world with one of everything pending: a rename, a delete each way, an edit.
			await world.vault.rename("Renamed.md", "Moved/Renamed.md");
			await world.vault.trash("Shared.md");
			await world.remote.trashFile(world.remote.uuidAt("Remote add.md")!);
			await world.vault.put("Local add.md", "edited here");

			const left = { left: budget };
			const crashed = await SyncEngine.open({
				vault: crashing(world.vault, left, ["write", "rename", "trash", "trashFolder", "mkdir"]),
				remote: crashing(world.remote, left, [
					"upload",
					"move",
					"trashFile",
					"trashFolder",
					"moveFolder",
					"mkdir",
				]),
				store: crashing(world.store, left, ["writeState"]),
				remoteRoot: REMOTE_ROOT,
				timers: world.clock,
			});
			await crashed.syncNow("startup").catch(() => undefined);

			// The power comes back: one fresh startup Reconcile has to finish the job, since
			// that is all a real restart gets before the user starts typing again.
			const restarted = await world.open();
			await restarted.syncNow("startup");

			world.expectAgreement();
			// Whatever the crash interrupted, no content was destroyed outright.
			expect(world.vault.text("Local add.md") ?? world.vault.trashed.has("Local add.md")).toBeTruthy();
		},
	);
});
