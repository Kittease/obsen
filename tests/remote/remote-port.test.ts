import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha512Hex } from "../../src/engine/hash.ts";
import { createFilenRemote, type FilenRemote } from "../../src/filen/remote.ts";
import type { RemoteEntry } from "../../src/engine/ports.ts";
import { RemoteSandbox, testCredentials } from "./sandbox.ts";

/**
 * Layer 4 of the testing strategy (spec §9): the `RemotePort` adapter against a real
 * Filen account, in a sandbox folder of its own.
 *
 * What only this layer can answer is whether **Filen's identity semantics are what
 * the engine's change detection assumes** (spec §3.1): a content update mints a new
 * UUID, a move or a rename keeps it, and the plaintext SHA-512 Filen records is the
 * same digest Obsen computes. Every other layer takes those on faith — the fakes are
 * *written* to behave that way — so if Filen ever changes, this suite is the only
 * thing that will say so.
 *
 * Skipped without `FILEN_TEST_EMAIL` / `FILEN_TEST_PASSWORD`, which is what makes it
 * safe on fork PRs. Read `tests/remote/sandbox.ts` before pointing it at an account.
 */

const credentials = testCredentials();

/** ~1.5 MiB: past the SDK's 1 MiB chunk, so reassembly is actually exercised. */
const MULTI_CHUNK_BYTES = 1_500_000;

describe.skipIf(credentials === null)("RemotePort against a real Filen account", () => {
	let sandbox: RemoteSandbox;
	let remote: FilenRemote;

	beforeAll(async () => {
		sandbox = await RemoteSandbox.open(credentials!, Date.now());
		remote = createFilenRemote(sandbox.sdk, sandbox.rootUuid);
	}, 120_000);

	afterAll(async () => {
		await sandbox?.close();
	}, 120_000);

	/** The entry for one path in a fresh listing, or `undefined`. */
	async function entryAt(path: string): Promise<RemoteEntry | undefined> {
		return (await remote.listing()).find((entry) => entry.path === path);
	}

	it("lists an untouched Remote Folder as empty", async () => {
		expect(await remote.listing()).toEqual([]);
	});

	it("round-trips a multi-chunk binary file byte-identically", async () => {
		const data = randomBytes(MULTI_CHUNK_BYTES);
		const digest = await sha512Hex(data);

		const { uuid } = await remote.upload("binary.bin", data);
		const entry = await entryAt("binary.bin");

		// The uploaded UUID is the one a later listing reports — the premise behind
		// recording `remoteUuid` at all.
		expect(entry).toEqual({ path: "binary.bin", uuid, size: data.byteLength, hash: digest });
		expect(await sha512Hex(await remote.download(uuid))).toBe(digest);
	});

	it("round-trips an empty file", async () => {
		const { uuid } = await remote.upload("empty.md", new Uint8Array(0));

		expect(await entryAt("empty.md")).toMatchObject({ uuid, size: 0 });
		expect(await remote.download(uuid)).toEqual(new Uint8Array(0));
	});

	it("mints a new UUID for updated content — the remote change detector", async () => {
		const first = await remote.upload("changing.md", encode("one"));
		const second = await remote.upload("changing.md", encode("two"));

		expect(second.uuid).not.toBe(first.uuid);
		const entry = await entryAt("changing.md");
		expect(entry?.uuid).toBe(second.uuid);
		expect(entry?.hash).toBe(await sha512Hex(encode("two")));
		// Superseded, not duplicated: one path, one file.
		expect((await remote.listing()).filter((row) => row.path === "changing.md")).toHaveLength(1);
	});

	it("keeps the UUID across a rename — what makes remote-rename detection free", async () => {
		const { uuid } = await remote.upload("before-rename.md", encode("stable"));
		await remote.listing();

		await remote.move(uuid, "after-rename.md");

		expect(await entryAt("after-rename.md")).toMatchObject({ uuid });
		expect(await entryAt("before-rename.md")).toBeUndefined();
	});

	it("keeps the UUID across a move into another folder", async () => {
		await remote.mkdir("moved-into");
		const { uuid } = await remote.upload("before-move.md", encode("stable"));
		await remote.listing();

		await remote.move(uuid, "moved-into/after-move.md");

		expect(await entryAt("moved-into/after-move.md")).toMatchObject({ uuid });
		expect(await sha512Hex(await remote.download(uuid))).toBe(await sha512Hex(encode("stable")));
	});

	it("creates folders recursively and idempotently, and uploads into them", async () => {
		await remote.mkdir("deep/nested/folder");
		await remote.mkdir("deep/nested/folder"); // must not throw, must not duplicate
		await remote.upload("deep/nested/folder/note.md", encode("nested"));

		expect(await entryAt("deep/nested/folder/note.md")).toBeDefined();
		// A duplicated folder would show up as a second path with the same name.
		const nested = (await remote.listing()).filter((entry) => entry.path.startsWith("deep/"));
		expect(nested).toHaveLength(1);
	});

	it("moves a whole folder in one call, subtree intact", async () => {
		await remote.mkdir("folder-move/inner");
		await remote.upload("folder-move/inner/note.md", encode("carried"));
		await remote.mkdir("folder-move-target");
		await remote.listing();

		await remote.moveFolder("folder-move", "folder-move-target/folder-move");

		expect(await entryAt("folder-move-target/folder-move/inner/note.md")).toBeDefined();
		expect(await entryAt("folder-move/inner/note.md")).toBeUndefined();
	});

	it("soft-deletes a file to Filen's trash", async () => {
		const { uuid } = await remote.upload("doomed.md", encode("bye"));
		await remote.listing();

		await remote.trashFile(uuid);

		expect(await entryAt("doomed.md")).toBeUndefined();
		// Soft: recoverable from the trash, never `deleteFile`.
		const trashed = await sandbox.sdk.cloud().listTrash();
		expect(trashed.map((item) => item.uuid)).toContain(uuid);
	});

	it("soft-deletes a folder and everything under it", async () => {
		await remote.mkdir("doomed-folder/inner");
		await remote.upload("doomed-folder/inner/note.md", encode("bye"));
		await remote.listing();

		await remote.trashFolder("doomed-folder");

		expect(await entryAt("doomed-folder/inner/note.md")).toBeUndefined();
	});

	it("returns NFC paths even for a name Filen stores decomposed", async () => {
		// APFS hands Obsidian NFD; without normalization here the same note reads as two
		// different files on every Run (spec §5.8).
		const decomposed = "café-nfd.md";
		await sandbox.sdk.cloud().uploadWebFile({
			file: new File([encode("é") as Uint8Array<ArrayBuffer>], decomposed),
			parent: sandbox.rootUuid,
			name: decomposed,
		});

		const paths = (await remote.listing()).map((entry) => entry.path);
		expect(paths).toContain(decomposed.normalize("NFC"));
		expect(paths).not.toContain(decomposed);
	});

	it("sweeps a crashed run's leftovers and spares the live one", async () => {
		const stale = await sandbox.seedStaleRun(Date.now() - 7 * 60 * 60 * 1000);
		expect(await sandbox.runFolders()).toContain(stale);

		await sandbox.sweep(Date.now());

		const remaining = await sandbox.runFolders();
		expect(remaining).not.toContain(stale);
		expect(remaining).toContain(sandbox.name);
	});
});

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Incompressible content, so a byte-identical round trip means what it says. */
function randomBytes(length: number): Uint8Array {
	const data = new Uint8Array(length);
	// `getRandomValues` caps at 64 KiB per call.
	for (let offset = 0; offset < length; offset += 65_536) {
		crypto.getRandomValues(data.subarray(offset, Math.min(offset + 65_536, length)));
	}
	return data;
}
