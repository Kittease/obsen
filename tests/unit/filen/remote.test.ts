import { beforeEach, describe, expect, it } from "vitest";

import { sha512Hex } from "../../../src/engine/hash.ts";
import { FilenRemote } from "../../../src/filen/remote.ts";
import { decodeText, toBytes } from "../../fakes/content.ts";
import { FAKE_ROOT, FakeCloud } from "../../fakes/fake-cloud.ts";

/**
 * The `RemotePort` adapter's bookkeeping (ticket 028), against a fake `sdk.cloud()`.
 *
 * The real-remote suite (`tests/remote/`) is what proves Filen behaves the way the
 * fake claims; these tests are what pin down the translation on top of it — the
 * parent-UUID index, the rename-then-move ordering, subtree rekeying — case by case
 * and in a second rather than a minute.
 */

let cloud: FakeCloud;
let remote: FilenRemote;

beforeEach(() => {
	cloud = new FakeCloud();
	remote = new FilenRemote({ cloud, rootUuid: FAKE_ROOT });
});

/** Sorted by path, so assertions read as the tree rather than as an API's ordering. */
async function listing(): Promise<{ path: string; uuid: string; size: number; hash?: string }[]> {
	const entries = await remote.listing();
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

describe("listing", () => {
	it("returns files vault-relative to the Remote Folder, never the folders themselves", async () => {
		await cloud.put("note.md", "top");
		await cloud.put("folder/deep/nested.md", "deep");
		await cloud.putDirectory("empty");

		expect((await listing()).map((entry) => entry.path)).toEqual([
			"folder/deep/nested.md",
			"note.md",
		]);
	});

	it("carries the UUID, plaintext size and Filen's SHA-512 for each file", async () => {
		const uuid = await cloud.put("note.md", "hello");

		expect(await listing()).toEqual([
			{ path: "note.md", uuid, size: 5, hash: await sha512Hex(toBytes("hello")) },
		]);
	});

	it("omits `hash` when Filen holds none — unknown is not the same as unchanged", async () => {
		const uuid = await cloud.put("note.md", "hello", { hash: null });

		expect(await listing()).toEqual([{ path: "note.md", uuid, size: 5 }]);
	});

	it("omits a hash that is not a SHA-512 digest rather than passing it off as one", async () => {
		// A foreign client's digest would never match the engine's, and a download whose
		// bytes disagree with a recorded hash fails the operation outright.
		await cloud.put("note.md", "hello", { hash: "0bad" });

		expect((await listing())[0]?.hash).toBeUndefined();
	});

	it("normalizes paths to NFC at the boundary", async () => {
		// "é" as e + combining acute: what APFS hands back, and what would otherwise
		// read as a second, different file on every Run.
		await cloud.put("café/résumé.md", "x");

		expect((await listing())[0]?.path).toBe("café/résumé.md");
	});

	it("hides names the SDK could not decrypt, and everything under them", async () => {
		await cloud.put("CANNOT_DECRYPT_NAME_abc.md", "junk");
		await cloud.put("CANNOT_DECRYPT_NAME_def/inside.md", "junk");
		await cloud.put("real.md", "keep");

		expect((await listing()).map((entry) => entry.path)).toEqual(["real.md"]);
	});

	it("re-lists rather than trusting the index: a folder deleted elsewhere stops being an upload target", async () => {
		await cloud.put("folder/note.md", "x");
		await listing();

		await cloud.trashDirectory({ uuid: cloud.uuidOfDirectory("folder")! });
		await listing();

		await expect(remote.upload("folder/other.md", toBytes("y"))).rejects.toThrow(
			"no remote folder folder",
		);
	});
});

describe("download", () => {
	it("round-trips the bytes, reassembling every chunk", async () => {
		await cloud.put("note.md", "the quick brown fox");
		const [entry] = await listing();

		expect(decodeText(await remote.download(entry!.uuid))).toBe("the quick brown fox");
	});

	it("returns nothing for an empty file instead of asking for zero chunks", async () => {
		await cloud.put("empty.md", "");
		const [entry] = await listing();

		expect(await remote.download(entry!.uuid)).toEqual(new Uint8Array(0));
		expect(cloud.calls.download).toBe(0);
	});

	it("refuses a UUID the last listing never mentioned", async () => {
		await expect(remote.download("file-404")).rejects.toThrow("not in the last remote listing");
	});
});

describe("upload", () => {
	it("mints a new UUID for changed content — the engine's remote change detector", async () => {
		await cloud.put("note.md", "before");
		const [before] = await listing();

		const after = await remote.upload("note.md", toBytes("after"));

		expect(after.uuid).not.toBe(before!.uuid);
		expect(decodeText(cloud.bytesAt("note.md")!)).toBe("after");
		expect(cloud.paths()).toEqual(["note.md"]);
	});

	it("addresses the containing folder by UUID, from the listing", async () => {
		await cloud.put("folder/other.md", "x");
		await listing();

		const { uuid } = await remote.upload("folder/note.md", toBytes("y"));

		expect(cloud.uuidAt("folder/note.md")).toBe(uuid);
	});

	it("uploads into a folder this session created, with no listing in between", async () => {
		await remote.mkdir("a/b");

		await expect(remote.upload("a/b/note.md", toBytes("y"))).resolves.toBeTruthy();
		expect(cloud.paths()).toEqual(["a/b/note.md"]);
	});

	it("refuses a folder nothing has created — the engine creates them in phase 1", async () => {
		await expect(remote.upload("missing/note.md", toBytes("y"))).rejects.toThrow(
			"no remote folder missing",
		);
	});

	it("supersedes the old UUID in the index, so a stale one is never downloadable", async () => {
		await cloud.put("note.md", "before");
		const [before] = await listing();
		await remote.upload("note.md", toBytes("after"));

		await expect(remote.download(before!.uuid)).rejects.toThrow("not in the last remote listing");
	});
});

describe("move", () => {
	it("keeps the UUID, which is what makes a remote rename free", async () => {
		const uuid = await cloud.put("note.md", "x");
		await listing();

		await remote.move(uuid, "renamed.md");

		expect(cloud.uuidAt("renamed.md")).toBe(uuid);
		expect(cloud.paths()).toEqual(["renamed.md"]);
	});

	it("moves before it renames, so a name taken in the source folder does not block it", async () => {
		// `renameFile` refuses a name already taken in the file's *current* folder.
		// Renaming first would test `from/` — where the new name happens to be taken —
		// instead of `to/`, where it is free.
		const uuid = await cloud.put("from/note.md", "x");
		await cloud.put("from/renamed.md", "an unrelated file holding the new name here");
		await cloud.putDirectory("to");
		await listing();

		await remote.move(uuid, "to/renamed.md");

		expect(cloud.paths()).toEqual(["from/renamed.md", "to/renamed.md"]);
		expect(cloud.uuidAt("to/renamed.md")).toBe(uuid);
	});

	it("refuses to rename over a file already at the destination", async () => {
		const uuid = await cloud.put("from/note.md", "x");
		const occupant = await cloud.put("to/renamed.md", "already there");
		await listing();

		await expect(remote.move(uuid, "to/renamed.md")).rejects.toThrow("already exists");
		// Whatever else happened, the file at the destination is untouched.
		expect(cloud.uuidAt("to/renamed.md")).toBe(occupant);
	});

	it("keeps Filen's metadata intact across a rename, hash included", async () => {
		// A rename re-encrypts whatever metadata it is handed. Hand it a reconstruction
		// missing the plaintext digest and every other device loses its cheap change
		// detection for that file.
		const { uuid } = await remote.upload("fresh.md", toBytes("uploaded this session"));
		const before = cloud.metadataAt("fresh.md");

		await remote.move(uuid, "fresh-renamed.md");

		expect(cloud.metadataAt("fresh-renamed.md")).toEqual({ ...before, name: "fresh-renamed.md" });
		expect(cloud.metadataAt("fresh-renamed.md")?.hash).toBe(
			await sha512Hex(toBytes("uploaded this session")),
		);
	});

	it("moves between folders without touching the name", async () => {
		const uuid = await cloud.put("from/note.md", "x");
		await cloud.putDirectory("to");
		await listing();

		await remote.move(uuid, "to/note.md");

		expect(cloud.paths()).toEqual(["to/note.md"]);
	});

	it("keeps the index in step, so the moved file downloads under its new path", async () => {
		const uuid = await cloud.put("note.md", "content");
		await listing();
		await remote.move(uuid, "folder-less-renamed.md");

		expect(decodeText(await remote.download(uuid))).toBe("content");
	});

	it("refuses a destination folder nothing has created", async () => {
		const uuid = await cloud.put("note.md", "x");
		await listing();

		await expect(remote.move(uuid, "missing/note.md")).rejects.toThrow("no remote folder missing");
	});
});

describe("trashFile", () => {
	it("soft-deletes by UUID and drops it from the index", async () => {
		const uuid = await cloud.put("note.md", "x");
		await listing();

		await remote.trashFile(uuid);

		expect(cloud.trashedFiles).toEqual([uuid]);
		expect(cloud.paths()).toEqual([]);
	});

	it("trashes a UUID the listing never held — a Sync State record may predate it", async () => {
		const uuid = await cloud.put("note.md", "x");

		await remote.trashFile(uuid);

		expect(cloud.paths()).toEqual([]);
	});
});

describe("mkdir", () => {
	it("creates every missing ancestor, parents first", async () => {
		await remote.mkdir("a/b/c");

		expect(cloud.directoryPaths()).toEqual(["a", "a/b", "a/b/c"]);
	});

	it("is idempotent, and calls the API only for what is missing", async () => {
		await remote.mkdir("a/b");
		cloud.calls.createDirectory = 0;

		await remote.mkdir("a/b");
		await remote.mkdir("a/b/c");

		expect(cloud.calls.createDirectory).toBe(1);
		expect(cloud.directoryPaths()).toEqual(["a", "a/b", "a/b/c"]);
	});

	it("adopts a folder another device created rather than duplicating it", async () => {
		const uuid = await cloud.putDirectory("shared");

		await remote.mkdir("shared/mine");

		expect(cloud.directoryPaths()).toEqual(["shared", "shared/mine"]);
		expect(cloud.uuidOfDirectory("shared")).toBe(uuid);
	});
});

describe("trashFolder", () => {
	it("soft-deletes the folder and forgets its contents", async () => {
		await cloud.put("folder/note.md", "x");
		await listing();

		await remote.trashFolder("folder");

		expect(cloud.paths()).toEqual([]);
		expect(cloud.directoryPaths()).toEqual([]);
	});

	it("is a no-op for a folder that is already gone", async () => {
		await expect(remote.trashFolder("never-existed")).resolves.toBeUndefined();
		expect(cloud.trashedDirectories).toEqual([]);
	});

	it("frees the path for a later mkdir instead of reusing the trashed UUID", async () => {
		await cloud.putDirectory("folder");
		await listing();
		await remote.trashFolder("folder");

		await remote.mkdir("folder");

		expect(cloud.directoryPaths()).toEqual(["folder"]);
	});
});

describe("moveFolder", () => {
	it("moves the whole subtree in one call", async () => {
		await cloud.put("from/deep/note.md", "x");
		await cloud.putDirectory("to");
		await listing();

		await remote.moveFolder("from", "to/from");

		expect(cloud.paths()).toEqual(["to/from/deep/note.md"]);
	});

	it("renames in place", async () => {
		await cloud.put("from/note.md", "x");
		await listing();

		await remote.moveFolder("from", "renamed");

		expect(cloud.paths()).toEqual(["renamed/note.md"]);
	});

	it("rekeys the index, so the files inside stay addressable and uploadable", async () => {
		const uuid = await cloud.put("from/note.md", "content");
		await listing();

		await remote.moveFolder("from", "renamed");

		expect(decodeText(await remote.download(uuid))).toBe("content");
		await expect(remote.upload("renamed/other.md", toBytes("y"))).resolves.toBeTruthy();
		await expect(remote.upload("from/other.md", toBytes("y"))).rejects.toThrow("no remote folder");
	});

	it("refuses a folder the last listing never mentioned", async () => {
		await expect(remote.moveFolder("nowhere", "somewhere")).rejects.toThrow(
			"not in the last remote listing",
		);
	});
});

describe("watch", () => {
	it("is a no-op until the socket lands, and unsubscribing is safe", () => {
		// Spec §7: the socket is a trigger, never a ledger. An engine that never hears
		// from it is slower to notice a remote change and no less correct.
		const unwatch = remote.watch(() => {
			throw new Error("the stub must never emit");
		});

		expect(() => {
			unwatch();
		}).not.toThrow();
	});
});

describe("faults (spec §5.7)", () => {
	/** An `APIError` as the SDK raises it: an `Error` carrying Filen's own `code`. */
	function apiError(code: string, message = code): Error & { code: string } {
		return Object.assign(new Error(message), { code });
	}

	it.each([
		["api_key_not_found", "auth"],
		["invalid_api_key", "auth"],
		["max_storage_reached", "quota"],
	])("classifies %s as %s", async (code, kind) => {
		cloud.getDirectoryTree = () => Promise.reject(apiError(code));

		await expect(remote.listing()).rejects.toMatchObject({ name: "SyncFault", kind });
	});

	it("classifies a 401 from the HTTP layer as an auth fault", async () => {
		cloud.getDirectoryTree = () =>
			Promise.reject(apiError("invalid_http_status_code", "Invalid HTTP status code: 401"));

		await expect(remote.listing()).rejects.toMatchObject({ name: "SyncFault", kind: "auth" });
	});

	it("leaves an unrecognized failure alone, so the engine reads it as transient", async () => {
		const network = new Error("socket hang up");
		cloud.getDirectoryTree = () => Promise.reject(network);

		await expect(remote.listing()).rejects.toBe(network);
	});

	it("classifies a fault raised by a write, not only by the listing", async () => {
		await cloud.putDirectory("Folder");
		await remote.listing(); // the index the upload's parent lookup reads
		cloud.uploadWebFile = () => Promise.reject(apiError("max_storage_reached"));

		await expect(remote.upload("Folder/Note.md", toBytes("text"))).rejects.toMatchObject({
			kind: "quota",
		});
	});

	it("reports a Remote Folder that no longer resolves as missing-root, not as empty", async () => {
		const orphan = new FilenRemote({ cloud, rootUuid: "folder-that-was-trashed" });

		// The distinction the engine's `frozen` state rests on: an empty listing would mean
		// "everything on Filen was deleted", and it would propagate as deletions.
		await expect(orphan.listing()).rejects.toMatchObject({
			name: "SyncFault",
			kind: "missing-root",
		});
	});

	it("reports folder_not_found from the listing as missing-root", async () => {
		cloud.getDirectoryTree = () => Promise.reject(apiError("folder_not_found"));

		await expect(remote.listing()).rejects.toMatchObject({ kind: "missing-root" });
	});
});
