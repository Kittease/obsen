import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FilenFolders } from "../../src/filen/folders.ts";
import { RemoteSandbox, testCredentials } from "./sandbox.ts";

/**
 * Layer 4 of the testing strategy (spec §9) for the folder picker's tree (spec §8.3).
 *
 * `cloud.listDirectory` is a Filen surface no other suite touches — the `RemotePort`
 * lists whole subtrees instead — so this is the only place that says whether it works
 * at all: whether it decrypts folder names, whether `onlyDirectories` really excludes
 * files, and whether a folder created through it is visible on the next listing.
 *
 * Browsing is rooted at the run's own sandbox folder rather than at the account root,
 * so the test reads the same handful of folders it created and nothing else on the
 * account.
 *
 * Skipped without `FILEN_TEST_EMAIL` / `FILEN_TEST_PASSWORD`. Read
 * `tests/remote/sandbox.ts` before pointing it at an account.
 */

const credentials = testCredentials();

describe.skipIf(credentials === null)("the folder tree against a real Filen account", () => {
	let sandbox: RemoteSandbox;
	let folders: FilenFolders;

	beforeAll(async () => {
		sandbox = await RemoteSandbox.open(credentials!, Date.now());
		folders = new FilenFolders({ cloud: sandbox.sdk.cloud(), rootUuid: sandbox.rootUuid });
	}, 120_000);

	afterAll(async () => {
		await sandbox?.close();
	}, 120_000);

	it("lists an untouched folder as empty", async () => {
		expect(await folders.children(sandbox.rootUuid)).toEqual([]);
	});

	it("creates a folder, decrypts its name back, and descends into it", async () => {
		const notes = await folders.create(sandbox.rootUuid, "Notes");

		expect(await folders.children(sandbox.rootUuid)).toEqual([notes]);
		expect(notes.name).toBe("Notes");

		const nested = await folders.create(notes.uuid, "Vault");

		expect(await folders.children(notes.uuid)).toEqual([nested]);
		// And the nested folder is not confused for a child of the root it sits under.
		expect(await folders.children(sandbox.rootUuid)).toEqual([notes]);
	});

	it("adopts an existing folder of the same name rather than duplicating it", async () => {
		const first = await folders.create(sandbox.rootUuid, "Twice");
		const second = await folders.create(sandbox.rootUuid, "Twice");

		expect(second.uuid).toBe(first.uuid);
	});

	it("shows folders and never files", async () => {
		const uploads = await folders.create(sandbox.rootUuid, "Uploads");
		await sandbox.sdk.cloud().uploadWebFile({
			file: new File([new Uint8Array([1, 2, 3])], "note.md"),
			parent: uploads.uuid,
			name: "note.md",
		});

		expect(await folders.children(uploads.uuid)).toEqual([]);
	});
});
