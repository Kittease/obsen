import { describe, expect, it } from "vitest";

import { createExclusionList } from "../../../src/obsidian/exclusions.ts";
import { obsenLayout } from "../../../src/obsidian/layout.ts";

/**
 * The Exclusion List (spec §2.1) as a Sync Scope predicate.
 *
 * Two failure modes are worth more than the table itself. Excluding too much loses a
 * file silently — nobody notices a note that never left the device. Excluding too
 * little is worse: `workspace.json` churns on every pane click, and Obsen's own state
 * files describe *this* device, so syncing either one means two devices overwriting
 * each other's local truth forever.
 */

const LAYOUT = obsenLayout(".obsidian", { id: "obsen", dir: ".obsidian/plugins/obsen" });
const { inScope } = createExclusionList(LAYOUT);

describe("what syncs", () => {
	it.each([
		"Notes/Daily/2026-08-01.md",
		"attachments/diagram.png",
		"README.md",
		// The point of syncing `.obsidian/`: settings and plugins follow the user.
		".obsidian/appearance.json",
		".obsidian/community-plugins.json",
		".obsidian/snippets/custom.css",
		".obsidian/themes/Minimal/theme.css",
		// Another plugin's settings — that is what "my plugins follow me" means.
		".obsidian/plugins/dataview/data.json",
		// Obsen's own *code*, like any other plugin's.
		".obsidian/plugins/obsen/main.js",
		".obsidian/plugins/obsen/manifest.json",
		".obsidian/plugins/obsen/styles.css",
	])("keeps %s", (path) => {
		expect(inScope(path)).toBe(true);
	});
});

describe("what never leaves the device", () => {
	it.each([
		[".obsidian/workspace.json", "churns on every pane interaction"],
		[".obsidian/workspace-mobile.json", "the mobile counterpart"],
		[".obsidian/workspace", "the legacy name"],
		[".obsidian/plugins/obsen/data.json", "Obsen's own settings are device-local"],
		[".obsidian/plugins/obsen/sync-state.json", "Sync State is per-device"],
		[".obsidian/plugins/obsen/sync-state.json.tmp", "and so is its atomic-write sibling"],
		[".obsidian/plugins/obsen/shadow/abc123", "the Shadow Store is per-device"],
		[".obsidian/plugins/obsen/logs/2026-08-01.log", "the rolling log is per-device"],
		[".obsidian/plugins/obsen/tmp/7.tmp", "an in-flight atomic write"],
		[".trash/deleted-note.md", "soft-deleted content must not resurrect via sync"],
		[".DS_Store", "OS junk"],
		["Notes/.DS_Store", "OS junk in any directory"],
		["Thumbs.db", "OS junk"],
		["attachments/desktop.ini", "OS junk"],
	])("drops %s — %s", (path) => {
		expect(inScope(path)).toBe(false);
	});
});

describe("boundaries", () => {
	it("follows a custom configDir rather than a hardcoded .obsidian", () => {
		const { inScope: custom } = createExclusionList(
			obsenLayout(".config", { id: "obsen", dir: ".config/plugins/obsen" }),
		);

		expect(custom(".config/workspace.json")).toBe(false);
		expect(custom(".config/plugins/obsen/sync-state.json")).toBe(false);
		// The default location, but not *this* vault's config dir: ordinary content.
		expect(custom(".obsidian/workspace.json")).toBe(true);
	});

	it("follows the installed plugin folder, which BRAT may not call obsen", () => {
		const { inScope: beta } = createExclusionList(
			obsenLayout(".obsidian", { id: "obsen", dir: ".obsidian/plugins/obsen-beta" }),
		);

		expect(beta(".obsidian/plugins/obsen-beta/sync-state.json")).toBe(false);
		// A *different* plugin that happens to be named obsen — not ours to exclude.
		expect(beta(".obsidian/plugins/obsen/sync-state.json")).toBe(true);
	});

	it("falls back to the manifest id when Obsidian reports no folder", () => {
		const layout = obsenLayout(".obsidian", { id: "obsen" });

		expect(layout.pluginDir).toBe(".obsidian/plugins/obsen");
	});

	it("excludes a folder's contents without excluding its prefix-sharing neighbours", () => {
		expect(inScope(".obsidian/plugins/obsen/shadow-notes/a.md")).toBe(true);
		expect(inScope(".obsidian/plugins/obsen-extra/shadow/a")).toBe(true);
		expect(inScope(".trashcan/a.md")).toBe(true);
	});

	it("matches OS junk by whole name, not by suffix", () => {
		expect(inScope("Notes/not-a-.DS_Store")).toBe(true);
		expect(inScope("Notes/Thumbs.db.md")).toBe(true);
	});
});

describe("folders a scan should not descend into", () => {
	const { folderInScope } = createExclusionList(LAYOUT);

	it.each([".obsidian/plugins/obsen/shadow", ".obsidian/plugins/obsen/logs"])(
		"prunes %s, where every entry is per-device anyway",
		(folder) => {
			expect(folderInScope(folder)).toBe(false);
			expect(folderInScope(`${folder}/nested`)).toBe(false);
		},
	);

	it.each([".obsidian", ".obsidian/plugins", ".obsidian/plugins/obsen", "Notes"])(
		"descends into %s",
		(folder) => {
			expect(folderInScope(folder)).toBe(true);
		},
	);
});
