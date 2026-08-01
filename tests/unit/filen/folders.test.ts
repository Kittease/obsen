import { beforeEach, describe, expect, it } from "vitest";

import { FilenFolders } from "../../../src/filen/folders.ts";
import { FAKE_ROOT, FakeCloud } from "../../fakes/fake-cloud.ts";

/**
 * The folder tree behind the picker (spec §8.3), against a fake `sdk.cloud()`.
 *
 * This surface is deliberately *not* the `RemotePort`: the picker browses the whole
 * Filen drive to choose a Remote Folder, and the port exists only once one has been
 * chosen. What is worth pinning down is what the modal renders — folders only, sorted
 * the way a person reads them, and nothing whose name Filen could not decrypt.
 */

let cloud: FakeCloud;
let folders: FilenFolders;

beforeEach(() => {
	cloud = new FakeCloud();
	folders = new FilenFolders({ cloud, rootUuid: FAKE_ROOT });
});

describe("browsing", () => {
	it("starts at the account root", () => {
		expect(folders.root).toEqual({ uuid: FAKE_ROOT, name: "Filen" });
	});

	it("lists child folders and never files", async () => {
		await cloud.putDirectory("Notes");
		await cloud.put("top-level.md", "a file at the root");

		expect(await folders.children(FAKE_ROOT)).toEqual([
			{ uuid: cloud.uuidOfDirectory("Notes"), name: "Notes" },
		]);
	});

	it("descends into a folder by UUID", async () => {
		await cloud.putDirectory("Notes/Vault");
		const notes = cloud.uuidOfDirectory("Notes")!;

		expect(await folders.children(notes)).toEqual([
			{ uuid: cloud.uuidOfDirectory("Notes/Vault"), name: "Vault" },
		]);
	});

	it("sorts by name the way a reader expects, not by case or by API order", async () => {
		for (const name of ["zebra", "Apple", "banana"]) await cloud.putDirectory(name);

		expect((await folders.children(FAKE_ROOT)).map((folder) => folder.name)).toEqual([
			"Apple",
			"banana",
			"zebra",
		]);
	});

	it("hides a folder whose name Filen could not decrypt", async () => {
		// The SDK substitutes this placeholder rather than failing. Offering it as a link
		// target would link the vault to a folder Obsen can never read the contents of.
		await cloud.putDirectory("CANNOT_DECRYPT_NAME_abc123");
		await cloud.putDirectory("Notes");

		expect((await folders.children(FAKE_ROOT)).map((folder) => folder.name)).toEqual(["Notes"]);
	});
});

describe("creating", () => {
	it("creates a folder at the current level and answers with it", async () => {
		const created = await folders.create(FAKE_ROOT, "New vault");

		expect(created.name).toBe("New vault");
		expect(cloud.uuidOfDirectory("New vault")).toBe(created.uuid);
		expect(await folders.children(FAKE_ROOT)).toEqual([created]);
	});

	it("adopts an existing folder of the same name rather than duplicating it", async () => {
		await cloud.putDirectory("Notes");

		const created = await folders.create(FAKE_ROOT, "Notes");

		expect(created.uuid).toBe(cloud.uuidOfDirectory("Notes"));
		expect(await folders.children(FAKE_ROOT)).toHaveLength(1);
	});

	it("refuses a name that is only whitespace, without asking Filen", async () => {
		await expect(folders.create(FAKE_ROOT, "   ")).rejects.toThrow(/name/i);
		expect(cloud.calls.createDirectory).toBe(0);
	});

	it("trims the name, so a stray space does not become part of the folder", async () => {
		const created = await folders.create(FAKE_ROOT, "  Vault  ");

		expect(created.name).toBe("Vault");
	});
});
