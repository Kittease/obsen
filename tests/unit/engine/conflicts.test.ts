import { beforeEach, describe, expect, it } from "vitest";

import { conflictStamp, CONFLICT_MANIFEST_PATH } from "../../../src/engine/conflict.ts";
import { sha512Hex } from "../../../src/engine/hash.ts";
import { encodeUtf8 } from "../../../src/engine/text.ts";
import { createWorld, type SyncWorld } from "../../helpers/sync-world.ts";

/**
 * The conflict path end to end (spec §6): Three-Way Merge where it is safe, Conflict
 * Copies where it is not, and the Conflict Manifest either way.
 *
 * The invariant every test here is really asserting is the same one: **neither version
 * is ever lost**. A merge keeps both edits, a copy keeps both files, and the manifest
 * says where the second one went.
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

function doc(...lines: string[]): string {
	return lines.join("\n");
}

const BASE = doc("# Daily", "", "- alpha", "- beta", "");

/** The name a copy of `path` gets, for the clock's current minute. */
function copyOf(path: string, device = "iPhone"): string {
	const dot = path.lastIndexOf(".");
	return `${path.slice(0, dot)} (conflict ${conflictStamp(clock.now())} ${device})${path.slice(dot)}`;
}

/** Both sides synced once, so the file has an Ancestor in the Shadow Store. */
async function linked(content = BASE): Promise<Awaited<ReturnType<SyncWorld["open"]>>> {
	await vault.put("Daily.md", content);
	const sync = await world.open({ deviceName: "iPhone" });
	await sync.syncNow("startup");
	return sync;
}

describe("Three-Way Merge (spec §6)", () => {
	it("merges concurrent edits to different parts of a note, on both sides", async () => {
		const sync = await linked();

		await vault.put("Daily.md", doc("# Daily", "", "- alpha edited here", "- beta", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha", "- beta", "- gamma", ""));
		const summary = await sync.syncNow("manual");

		const merged = doc("# Daily", "", "- alpha edited here", "- beta", "- gamma", "");
		expect(summary.merged).toBe(1);
		expect(summary.conflicts).toBe(0);
		expect(summary.outcome).toBe("ok");
		world.expectConverged({ "Daily.md": merged });
		// No copy, and nothing to announce.
		expect(vault.paths()).toEqual(["Daily.md"]);
	});

	it("records the merged content as the next Ancestor, so the next merge works too", async () => {
		const sync = await linked();

		await vault.put("Daily.md", doc("# Daily", "", "- alpha 2", "- beta", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha", "- beta", "- gamma", ""));
		await sync.syncNow("manual");

		// Second round, both sides diverging from the *merged* text.
		await vault.put("Daily.md", doc("# Daily", "", "- alpha 3", "- beta", "- gamma", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha 2", "- beta", "- gamma", "- delta", ""));
		const summary = await sync.syncNow("manual");

		expect(summary.merged).toBe(1);
		world.expectConverged({
			"Daily.md": doc("# Daily", "", "- alpha 3", "- beta", "- gamma", "- delta", ""),
		});
	});

	it("keeps the record and the Ancestor in step with what it wrote", async () => {
		const sync = await linked();

		await vault.put("Daily.md", doc("# Daily", "", "- alpha!", "- beta", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha", "- beta", "- gamma", ""));
		await sync.syncNow("manual");

		const record = sync.records.get("Daily.md")!;
		const merged = encodeUtf8(vault.text("Daily.md")!);
		expect(record.lastSyncedHash).toBe(await sha512Hex(merged));
		expect(record.remoteUuid).toBe(remote.uuidAt("Daily.md"));
		expect(record.localMtime).toBe((await vault.stat("Daily.md"))!.mtime);
		expect(store.shadow.has(record.lastSyncedHash)).toBe(true);
	});
});

describe("Conflict Copies (spec §6.1)", () => {
	it("keeps both versions when the same lines changed on both sides", async () => {
		const sync = await linked();

		await vault.put("Daily.md", doc("# Daily", "", "- alpha here", "- beta", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha there", "- beta", ""));
		const summary = await sync.syncNow("manual");

		expect(summary.conflicts).toBe(1);
		expect(summary.merged).toBe(0);
		// The local version keeps the original path; the incoming one becomes the copy.
		expect(vault.text("Daily.md")).toBe(doc("# Daily", "", "- alpha here", "- beta", ""));
		expect(vault.text(copyOf("Daily.md"))).toBe(doc("# Daily", "", "- alpha there", "- beta", ""));
		// …and both sides agree about both files, without a second Run.
		expect(remote.text("Daily.md")).toBe(vault.text("Daily.md"));
		expect(remote.text(copyOf("Daily.md"))).toBe(vault.text(copyOf("Daily.md")));
	});

	it("never merges a binary, whatever changed in it", async () => {
		await vault.put("Image.png", new Uint8Array([1, 2, 3]));
		const sync = await world.open({ deviceName: "iPhone" });
		await sync.syncNow("startup");

		await vault.put("Image.png", new Uint8Array([1, 2, 4]));
		await remote.put("Image.png", new Uint8Array([9, 9, 9]));
		const summary = await sync.syncNow("manual");

		expect(summary.conflicts).toBe(1);
		expect(summary.merged).toBe(0);
		expect(vault.paths()).toContain(copyOf("Image.png"));
	});

	it("copies rather than merges when the Ancestor was lost", async () => {
		const sync = await linked();
		store.shadow.clear(); // a wiped plugin folder, or a Re-Bootstrap

		await vault.put("Daily.md", doc("# Daily", "", "- alpha 2", "- beta", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha", "- beta", "- gamma", ""));
		const summary = await sync.syncNow("manual");

		expect(summary.conflicts).toBe(1);
		expect(vault.text(copyOf("Daily.md"))).toBe(doc("# Daily", "", "- alpha", "- beta", "- gamma", ""));
	});

	it("copies rather than merges when the Ancestor is corrupt", async () => {
		const sync = await linked();
		for (const hash of store.shadow.keys()) store.shadow.set(hash, encodeUtf8("not the ancestor"));

		await vault.put("Daily.md", doc("# Daily", "", "- alpha 2", "- beta", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha", "- beta", "- gamma", ""));
		const summary = await sync.syncNow("manual");

		expect(summary.conflicts).toBe(1);
	});

	it("names the copy after the device that received it", async () => {
		await vault.put("Daily.md", BASE);
		const sync = await world.open({ deviceName: 'Carl/Anne "iPad"' });
		await sync.syncNow("startup");

		await vault.put("Daily.md", doc("# Daily", "", "- here", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- there", ""));
		await sync.syncNow("manual");

		expect(vault.paths()).toContain(copyOf("Daily.md", 'Carl-Anne -iPad-'));
	});

	it("dodges a name that is already taken on either side", async () => {
		const sync = await linked();
		await vault.put(copyOf("Daily.md"), "an older copy the user kept");
		await remote.put(`${copyOf("Daily.md").slice(0, -3)} 2.md`, "and one only the remote has");
		await sync.syncNow("manual");

		await vault.put("Daily.md", doc("# Daily", "", "- here", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- there", ""));
		await sync.syncNow("manual");

		expect(vault.text(copyOf("Daily.md"))).toBe("an older copy the user kept");
		expect(vault.text(`${copyOf("Daily.md").slice(0, -3)} 3.md`)).toBe(
			doc("# Daily", "", "- there", ""),
		);
	});

	it("announces a copy it could not finish pushing", async () => {
		const sync = await linked();
		const upload = remote.upload.bind(remote);
		remote.upload = (path, data) =>
			path.includes("(conflict ") ? Promise.reject(new Error("nope")) : upload(path, data);

		await vault.put("Daily.md", doc("# Daily", "", "- here", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- there", ""));
		const summary = await sync.syncNow("manual");

		// The copy exists on disk, so it is counted and listed — a copy the manifest
		// never mentions would be exactly the silent conflict §6.2 exists to prevent.
		expect(summary.conflicts).toBe(1);
		expect(summary.failures).toHaveLength(1);
		expect(vault.text(copyOf("Daily.md"))).toBe(doc("# Daily", "", "- there", ""));
		expect(vault.text(CONFLICT_MANIFEST_PATH)).toContain(copyOf("Daily.md").slice(0, -3));
	});

	it("resolves every conflict in a Run, not just the first", async () => {
		await vault.put("A.md", "a1");
		await vault.put("B.md", "b1");
		const sync = await world.open({ deviceName: "iPhone" });
		await sync.syncNow("startup");

		for (const [path, mine, theirs] of [
			["A.md", "a2 here", "a2 there"],
			["B.md", "b2 here", "b2 there"],
		] as const) {
			await vault.put(path, mine);
			await remote.put(path, theirs);
		}
		const summary = await sync.syncNow("manual");

		expect(summary.conflicts).toBe(2);
		expect(vault.text(copyOf("A.md"))).toBe("a2 there");
		expect(vault.text(copyOf("B.md"))).toBe("b2 there");
	});
});

describe("First Link conflicts (spec §6.1, ticket 011)", () => {
	it("makes the remote version the copy and keeps the local one in place", async () => {
		await vault.put("Clash.md", "written here");
		await remote.put("Clash.md", "written there");

		const sync = await world.open({ deviceName: "iPhone" });
		const summary = await sync.syncNow("first-link");

		expect(summary.conflicts).toBe(1);
		expect(vault.text("Clash.md")).toBe("written here");
		expect(vault.text(copyOf("Clash.md"))).toBe("written there");
		expect(remote.text("Clash.md")).toBe("written here");
		// The manifest is the one thing still local at this point; the follow-up Run
		// pushes it like any other note the user had just written.
		await world.settle(sync);
		world.expectAgreement();
	});

	it("converges instead when the bytes turn out to be identical after all", async () => {
		await vault.put("Same.md", "identical bytes");
		await remote.put("Same.md", "identical bytes");
		remote.hashless = true; // an older client recorded no plaintext hash

		const sync = await world.open({ deviceName: "iPhone" });
		const summary = await sync.syncNow("first-link");

		// The planner could not prove they matched; downloading the bytes did.
		expect(summary.conflicts).toBe(0);
		expect(summary.identical).toBe(1);
		expect(vault.paths()).toEqual(["Same.md"]);
	});
});

describe("the Conflict Manifest (spec §6.2)", () => {
	it("appends a row per copy and syncs the manifest like any other note", async () => {
		const sync = await linked();

		await vault.put("Daily.md", doc("# Daily", "", "- here", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- there", ""));
		const summary = await sync.syncNow("manual");

		expect(summary.manifestWritten).toBe(true);
		const manifest = vault.text(CONFLICT_MANIFEST_PATH)!;
		expect(manifest).toContain("# Sync conflicts");
		expect(manifest).toContain(`| [[Daily]] | [[${copyOf("Daily.md").slice(0, -3)}]] |`);

		// The manifest is a normal note: the follow-up Run pushes it like anything else.
		await world.settle(sync);
		expect(remote.text(CONFLICT_MANIFEST_PATH)).toBe(manifest);
	});

	it("appends exactly one row per copy, across Runs", async () => {
		const sync = await linked();

		for (const round of ["2", "3"]) {
			await vault.put("Daily.md", doc("# Daily", "", `- here ${round}`, ""));
			await remote.put("Daily.md", doc("# Daily", "", `- there ${round}`, ""));
			await sync.syncNow("manual");
			await world.settle(sync);
		}

		const rows = vault
			.text(CONFLICT_MANIFEST_PATH)!
			.split("\n")
			.filter((line) => line.startsWith("| [["));
		expect(rows).toHaveLength(2);
		expect(new Set(rows).size).toBe(2);
	});

	it("recreates the manifest after the user deletes it", async () => {
		const sync = await linked();
		await vault.put("Daily.md", doc("# Daily", "", "- here", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- there", ""));
		await sync.syncNow("manual");
		await world.settle(sync);

		await vault.trash(CONFLICT_MANIFEST_PATH);
		await vault.put("Daily.md", doc("# Daily", "", "- here again", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- there again", ""));
		await sync.syncNow("manual");

		expect(vault.text(CONFLICT_MANIFEST_PATH)).toContain("# Sync conflicts");
	});

	it("resolves a conflicted manifest like any other note, losing no rows", async () => {
		const sync = await linked();
		await vault.put("Daily.md", doc("# Daily", "", "- here", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- there", ""));
		await sync.syncNow("manual");
		await world.settle(sync);

		// Two devices appending their own row to the same manifest, at the same place.
		const manifest = vault.text(CONFLICT_MANIFEST_PATH)!;
		await vault.put(CONFLICT_MANIFEST_PATH, `${manifest}| [[Here]] | [[Here copy]] |\n`);
		await remote.put(CONFLICT_MANIFEST_PATH, `${manifest}| [[There]] | [[There copy]] |\n`);
		const summary = await sync.syncNow("manual");

		// It is an ordinary Mergeable note, so it gets an ordinary Conflict Copy — and
		// at worst the rows end up split across the two files, never dropped.
		expect(summary.conflicts).toBe(1);
		const copy = vault.paths().find((path) => path.startsWith("conflicts (conflict "))!;
		expect(vault.text(copy)).toContain("| [[There]] | [[There copy]] |");
		expect(vault.text(CONFLICT_MANIFEST_PATH)).toContain("| [[Here]] | [[Here copy]] |");
		// …and the copy it just made of the manifest is itself a row in the manifest.
		expect(vault.text(CONFLICT_MANIFEST_PATH)).toContain(`| [[conflicts]] | [[${copy.slice(0, -3)}]] |`);
	});

	it("says nothing happened when no copy was created", async () => {
		const sync = await linked();

		await vault.put("Daily.md", doc("# Daily", "", "- alpha 2", "- beta", ""));
		const summary = await sync.syncNow("manual");

		expect(summary.manifestWritten).toBe(false);
		expect(vault.text(CONFLICT_MANIFEST_PATH)).toBeNull();
	});
});

describe("the Shadow Store, in a Run (spec §3.4)", () => {
	it("keeps entries for Mergeable files only", async () => {
		await vault.put("Note.md", "text");
		await vault.put("Image.png", new Uint8Array([1, 2, 3]));

		const sync = await world.open();
		await sync.syncNow("startup");

		const note = sync.records.get("Note.md")!;
		expect([...store.shadow.keys()]).toEqual([note.lastSyncedHash]);
	});

	it("records an Ancestor for a file that arrived identical on both sides", async () => {
		await vault.put("Same.md", "identical bytes");
		await remote.put("Same.md", "identical bytes");

		const sync = await world.open();
		await sync.syncNow("first-link");

		// Without this, every First-Link pairing would be a Conflict Copy waiting to
		// happen the first time the two devices diverge.
		expect(store.shadow.has(sync.records.get("Same.md")!.lastSyncedHash)).toBe(true);
	});

	it("collects the entries no record references any more", async () => {
		const sync = await linked();
		const first = sync.records.get("Daily.md")!.lastSyncedHash;

		await vault.put("Daily.md", doc("# Daily", "", "- alpha 2", "- beta", ""));
		await sync.syncNow("manual");

		const second = sync.records.get("Daily.md")!.lastSyncedHash;
		expect(second).not.toBe(first);
		expect([...store.shadow.keys()]).toEqual([second]);
	});

	it("heals a corrupt entry from the file it describes", async () => {
		const sync = await linked();
		const ancestor = sync.records.get("Daily.md")!.lastSyncedHash;
		store.shadow.set(ancestor, encodeUtf8("not the ancestor"));

		// An identical rewrite: no transfer, but the Run notices the entry is unsound
		// and rebuilds it from the file — otherwise the pair conflict-copies forever.
		await vault.put("Daily.md", BASE);
		await sync.syncNow("manual");

		await vault.put("Daily.md", doc("# Daily", "", "- alpha 2", "- beta", ""));
		await remote.put("Daily.md", doc("# Daily", "", "- alpha", "- beta", "- gamma", ""));
		const summary = await sync.syncNow("manual");

		expect(summary.merged).toBe(1);
		expect(summary.conflicts).toBe(0);
	});

	it("collects the entries a deleted file leaves behind", async () => {
		const sync = await linked();
		expect(store.shadow.size).toBe(1);

		await vault.trash("Daily.md");
		await sync.syncNow("manual");

		expect(store.shadow.size).toBe(0);
	});
});
