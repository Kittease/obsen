import { describe, expect, it } from "vitest";

import { createWritablePathCheck } from "../../../src/obsidian/writable.ts";

/**
 * `VaultPort.isWritablePath` (spec §5.8): whether this device can actually hold the
 * name. A `false` here becomes a Skip-and-Surface — reported, never retried, and
 * **never auto-renamed**, because inventing a name would break every wikilink pointing
 * at it.
 *
 * "Platform" means Obsidian as much as the filesystem. A dot-prefixed name is
 * perfectly legal on APFS and completely invisible to Obsidian's Vault API, which is
 * the worse of the two failures: the file would download, vanish from the next local
 * scan, and read as a local deletion to propagate back.
 */

const posix = createWritablePathCheck({ configDir: ".obsidian", windows: false });
const windows = createWritablePathCheck({ configDir: ".obsidian", windows: true });

describe("everywhere", () => {
	it.each([
		"Notes/Daily/2026-08-01.md",
		"attachments/a diagram (final).png",
		"Ünïcode/ま.md",
		"Notes/a.b.c.md",
	])("accepts %s", (path) => {
		expect(posix(path)).toBe(true);
		expect(windows(path)).toBe(true);
	});

	it.each([
		["Notes/a\nb.md", "a control character"],
		["Notes/a\u0000b.md", "a NUL byte"],
		["Notes//a.md", "an empty segment"],
		["", "the empty path"],
	])("refuses %s — %s", (path) => {
		expect(posix(path)).toBe(false);
		expect(windows(path)).toBe(false);
	});

	it.each([
		["Notes\\a.md", "a backslash Obsidian would turn into a separator"],
		["/Notes/a.md", "a leading slash"],
		["Notes/a.md/", "a trailing slash"],
		["Notes/./a.md", "a same-directory segment"],
		["Notes/../a.md", "a parent-directory segment"],
	])("refuses %s — %s, rather than rewriting it", (path) => {
		// Spec §1.3 asks for `normalizePath()` on remote-derived paths, and §5.8 forbids
		// auto-renaming. Refusing the name is the only way to obey both.
		expect(posix(path)).toBe(false);
		expect(windows(path)).toBe(false);
	});
});

describe("names Obsidian itself will not show", () => {
	it.each([".hidden/note.md", "Notes/.secret.md", ".note.md"])(
		"refuses the dot-prefixed %s",
		(path) => {
			expect(posix(path)).toBe(false);
		},
	);

	it("allows dot-prefixed names inside the config dir, which is all of them", () => {
		expect(posix(".obsidian/appearance.json")).toBe(true);
		expect(posix(".obsidian/plugins/obsen/main.js")).toBe(true);
		expect(posix(".obsidian/snippets/.keep")).toBe(true);
	});

	it("does not mistake a look-alike sibling for the config dir", () => {
		expect(posix(".obsidian-backup/appearance.json")).toBe(false);
	});
});

describe("Windows only", () => {
	it.each(["Notes/a:b.md", "Notes/a|b.md", "Notes/a?.md", "Notes/a*.md", 'Notes/a"b.md'])(
		"refuses %s on Windows and keeps it elsewhere",
		(path) => {
			expect(windows(path)).toBe(false);
			expect(posix(path)).toBe(true);
		},
	);

	it.each(["Notes/a.md.", "Notes/a.md ", "Notes./a.md", "Notes /a.md"])(
		"refuses the trailing dot or space in %s",
		(path) => {
			expect(windows(path)).toBe(false);
			expect(posix(path)).toBe(true);
		},
	);

	it.each(["CON.md", "Notes/con", "com1.txt", "LPT9.md", "NUL", "aux.md"])(
		"refuses the reserved device name %s",
		(path) => {
			expect(windows(path)).toBe(false);
			expect(posix(path)).toBe(true);
		},
	);

	it("only refuses the reserved name itself, not names containing it", () => {
		expect(windows("CONSOLE.md")).toBe(true);
		expect(windows("Notes/my-aux.md")).toBe(true);
		expect(windows("com10.txt")).toBe(true);
	});
});
