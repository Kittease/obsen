import { describe, expect, it } from "vitest";

import { DEFAULT_DATA, readObsenData } from "../../../src/obsidian/data.ts";

/**
 * `data.json` is a file inside the vault's config folder: hand-editable, vault-backup
 * visible, and occasionally written by a different version of Obsen. Reading it must
 * never be a way for the plugin to fail to load.
 */

describe("readObsenData", () => {
	it("reads a stored link", () => {
		expect(readObsenData({ link: { folderUuid: "folder-uuid", path: "Notes/Vault" } })).toEqual({
			link: { folderUuid: "folder-uuid", path: "Notes/Vault" },
		});
	});

	it("reads a link with no path as one at the Filen root — the UUID is the link", () => {
		expect(readObsenData({ link: { folderUuid: "folder-uuid" } })).toEqual({
			link: { folderUuid: "folder-uuid", path: "" },
		});
	});

	it.each([
		["a first run", null],
		["an empty file", {}],
		["a hand-edited scalar", "not settings"],
		["a link that is not an object", { link: "folder-uuid" }],
		["a link with no UUID", { link: { displayPath: "Notes" } }],
		["a link with an empty UUID", { link: { folderUuid: "" } }],
	])("falls back to the defaults for %s", (_case, raw) => {
		// An unlinked vault re-links in two clicks; refusing to load would take the
		// settings tab — the only way to re-link — down with it.
		expect(readObsenData(raw)).toEqual(DEFAULT_DATA);
	});

	it("keeps nothing it was not asked to keep", () => {
		// Everything credential-shaped belongs in SecretStorage (spec §8.1), and a field
		// this file does not know about is one nothing here can promise anything about.
		const data = readObsenData({ link: { folderUuid: "u", path: "" }, apiKey: "leaked", extra: 1 });

		expect(Object.keys(data)).toEqual(["link"]);
		expect(JSON.stringify(data)).not.toContain("leaked");
	});

	it("hands back a fresh object, so the defaults cannot be mutated in place", () => {
		const data = readObsenData(null);
		data.link = { folderUuid: "u", path: "" };

		expect(DEFAULT_DATA.link).toBe(null);
	});
});
