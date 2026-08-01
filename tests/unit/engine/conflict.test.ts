import { describe, expect, it } from "vitest";

import {
	appendConflictRows,
	CONFLICT_MANIFEST_PATH,
	conflictCopyPath,
	DEFAULT_DEVICE_NAME,
	sanitizeDeviceName,
} from "../../../src/engine/conflict.ts";

/**
 * Conflict Copy naming (spec §6.1) and the Conflict Manifest (spec §6.2).
 *
 * Both are v1-normative formats, and both are user-facing: the name is what someone
 * reads in their file list at 2 a.m., and the manifest is the only announcement a
 * conflict gets — there is deliberately no notice.
 */

/** Local time, so the expected stamp below is the same in every timezone. */
const AT = new Date(2026, 6, 31, 14, 2, 45).getTime();

const free = (): boolean => false;

describe("Conflict Copy names (spec §6.1)", () => {
	it("follows the convention exactly", () => {
		const copy = conflictCopyPath("Meeting notes.md", { at: AT, device: "iPhone", taken: free });

		expect(copy).toBe("Meeting notes (conflict 2026-07-31 1402 iPhone).md");
	});

	it("keeps the copy beside the original", () => {
		const copy = conflictCopyPath("Work/Q3/Plan.md", { at: AT, device: "iPhone", taken: free });

		expect(copy).toBe("Work/Q3/Plan (conflict 2026-07-31 1402 iPhone).md");
	});

	it("pads a single-digit month, day, hour and minute", () => {
		const at = new Date(2026, 0, 5, 9, 7).getTime();

		expect(conflictCopyPath("A.md", { at, device: "Mac", taken: free })).toBe(
			"A (conflict 2026-01-05 0907 Mac).md",
		);
	});

	it("handles a name with no extension, and one with several dots", () => {
		expect(conflictCopyPath("LICENSE", { at: AT, device: "Mac", taken: free })).toBe(
			"LICENSE (conflict 2026-07-31 1402 Mac)",
		);
		expect(conflictCopyPath("archive.tar.gz", { at: AT, device: "Mac", taken: free })).toBe(
			"archive.tar (conflict 2026-07-31 1402 Mac).gz",
		);
	});

	it("counts up past names that are already taken", () => {
		const existing = new Set([
			"Note (conflict 2026-07-31 1402 Mac).md",
			"Note (conflict 2026-07-31 1402 Mac) 2.md",
		]);

		const copy = conflictCopyPath("Note.md", {
			at: AT,
			device: "Mac",
			taken: (path) => existing.has(path),
		});

		expect(copy).toBe("Note (conflict 2026-07-31 1402 Mac) 3.md");
	});

	it("uses the sanitized Device Name, so the copy is filename- and wikilink-safe", () => {
		const copy = conflictCopyPath("Note.md", {
			at: AT,
			device: 'Carl/Anne "work" [mac]|#2',
			taken: free,
		});

		expect(copy).toBe("Note (conflict 2026-07-31 1402 Carl-Anne -work- -mac---2).md");
		// Everything a filename or a wikilink chokes on is gone; `/` stays a separator.
		expect(/[\\:*?"<>|#^[\]]/u.test(copy)).toBe(false);
	});
});

describe("Device Name sanitizing (spec §6.1)", () => {
	it("replaces every character that breaks a filename or a wikilink", () => {
		expect(sanitizeDeviceName('a\\b/c:d*e?f"g<h>i|j#k^l[m]n')).toBe(
			"a-b-c-d-e-f-g-h-i-j-k-l-m-n",
		);
	});

	it("trims leading and trailing dots and spaces", () => {
		expect(sanitizeDeviceName("  .Carl's iPad. ")).toBe("Carl's iPad");
	});

	it("falls back to a default when nothing survives", () => {
		expect(sanitizeDeviceName("...")).toBe(DEFAULT_DEVICE_NAME);
		expect(sanitizeDeviceName("")).toBe(DEFAULT_DEVICE_NAME);
	});
});

describe("the Conflict Manifest (spec §6.2)", () => {
	const row = {
		original: "Meeting notes.md",
		copy: "Meeting notes (conflict 2026-07-31 1402 iPhone).md",
	};

	it("lives at the vault root, where it syncs like any other note", () => {
		expect(CONFLICT_MANIFEST_PATH).toBe("conflicts.md");
	});

	it("creates the file with the header, in the spec's format", () => {
		expect(appendConflictRows(null, [row])).toBe(
			[
				"# Sync conflicts",
				"",
				"Each row links a file and the conflict copy Obsen created for it. Review, merge what you need, then delete rows (or this file) — Obsen recreates it on the next conflict.",
				"",
				"| Original | Conflict copy |",
				"| --- | --- |",
				"| [[Meeting notes]] | [[Meeting notes (conflict 2026-07-31 1402 iPhone)]] |",
				"",
			].join("\n"),
		);
	});

	it("appends to an existing table rather than starting a new one", () => {
		const first = appendConflictRows(null, [row]);

		const second = appendConflictRows(first, [{ original: "B.md", copy: "B (copy).md" }]);

		expect(second.match(/\| Original \| Conflict copy \|/gu)).toHaveLength(1);
		expect(second.split("\n").filter((line) => line.startsWith("| [["))).toHaveLength(2);
		expect(second.startsWith(first)).toBe(true);
	});

	it("recreates the header when the user deleted the file", () => {
		expect(appendConflictRows(null, [row])).toContain("# Sync conflicts");
		expect(appendConflictRows("", [row])).toContain("# Sync conflicts");
	});

	it("keeps whatever the user left behind, and gives the rows a table to live in", () => {
		const gutted = "# Sync conflicts\n\nI cleared these out.\n";

		const next = appendConflictRows(gutted, [row]);

		expect(next.startsWith(gutted)).toBe(true);
		expect(next).toContain("| --- | --- |");
		expect(next.trimEnd().endsWith("|")).toBe(true);
	});

	it("links by name, without the Markdown extension", () => {
		const next = appendConflictRows(null, [{ original: "Work/Plan.md", copy: "Work/Plan 2.md" }]);

		expect(next).toContain("| [[Work/Plan]] | [[Work/Plan 2]] |");
	});

	it("keeps a non-Markdown attachment's extension in the link", () => {
		const next = appendConflictRows(null, [{ original: "Diagram.png", copy: "Diagram 2.png" }]);

		expect(next).toContain("| [[Diagram.png]] | [[Diagram 2.png]] |");
	});

	it("falls back to code when a name cannot be a wikilink", () => {
		// `[`, `]`, `#`, `^` and `|` end a wikilink early; a broken link would be worse
		// than an honest, unclickable name.
		const next = appendConflictRows(null, [{ original: "Note [draft].md", copy: "Copy.md" }]);

		expect(next).toContain("| `Note [draft].md` | [[Copy]] |");
	});
});
