import { describe, expect, it } from "vitest";

import { mergeText } from "../../../src/engine/merge.ts";

/**
 * The Three-Way Merge (spec §6): local and remote against their Ancestor.
 *
 * The bar is not "merges as much as possible" — it is **never merges two edits that
 * touch the same thing**. A merge that should have been a Conflict Copy silently
 * rewrites someone's note; a Conflict Copy that should have been a merge costs the
 * user one file to look at.
 */

/** Reads better than embedded `\n`s for the multi-line cases below. */
function doc(...lines: string[]): string {
	return lines.join("\n");
}

const BASE = doc("# Title", "", "alpha", "beta", "gamma", "");

describe("clean merges", () => {
	it("takes the only side that changed", () => {
		expect(mergeText(BASE, BASE, doc("# Title", "", "alpha", "beta", "delta", ""))).toEqual({
			clean: true,
			text: doc("# Title", "", "alpha", "beta", "delta", ""),
		});
		expect(mergeText(BASE, doc("# Renamed", "", "alpha", "beta", "gamma", ""), BASE)).toEqual({
			clean: true,
			text: doc("# Renamed", "", "alpha", "beta", "gamma", ""),
		});
	});

	it("combines edits to different lines", () => {
		const local = doc("# Title", "", "ALPHA", "beta", "gamma", "");
		const remote = doc("# Title", "", "alpha", "beta", "GAMMA", "");

		expect(mergeText(BASE, local, remote)).toEqual({
			clean: true,
			text: doc("# Title", "", "ALPHA", "beta", "GAMMA", ""),
		});
	});

	it("combines an insertion with an edit elsewhere", () => {
		const local = doc("# Title", "", "alpha", "beta", "beta and a half", "gamma", "");
		const remote = doc("# Title (2026)", "", "alpha", "beta", "gamma", "");

		expect(mergeText(BASE, local, remote)).toEqual({
			clean: true,
			text: doc("# Title (2026)", "", "alpha", "beta", "beta and a half", "gamma", ""),
		});
	});

	it("keeps a deletion on one side and an edit on another line", () => {
		const local = doc("# Title", "", "alpha", "gamma", ""); // dropped "beta"
		const remote = doc("# Title", "", "ALPHA", "beta", "gamma", "");

		expect(mergeText(BASE, local, remote)).toEqual({
			clean: true,
			text: doc("# Title", "", "ALPHA", "gamma", ""),
		});
	});

	it("collapses the same edit made on both devices into one", () => {
		const both = doc("# Title", "", "alpha", "beta", "gamma", "delta", "");

		expect(mergeText(BASE, both, both)).toEqual({ clean: true, text: both });
	});

	it("appends two different lines at the end of the same note", () => {
		// The everyday daily-note case: each device adds its own bullet.
		const local = doc("# Title", "", "alpha", "beta", "gamma", "from the phone", "");
		const remote = doc("# Title", "", "alpha", "beta", "gamma", "", "from the laptop");

		const merged = mergeText(BASE, local, remote);

		expect(merged.clean).toBe(true);
		if (!merged.clean) return;
		expect(merged.text).toContain("from the phone");
		expect(merged.text).toContain("from the laptop");
	});

	it("preserves bytes exactly — CRLF, trailing newlines and all", () => {
		const base = "one\r\ntwo\r\n";
		const local = "ONE\r\ntwo\r\n";
		const remote = "one\r\ntwo\r\nthree\r\n";

		expect(mergeText(base, local, remote)).toEqual({ clean: true, text: "ONE\r\ntwo\r\nthree\r\n" });
	});

	it("merges nothing into nothing", () => {
		expect(mergeText("", "", "")).toEqual({ clean: true, text: "" });
	});
});

describe("conflicts", () => {
	it("refuses two different edits to the same line", () => {
		const local = doc("# Title", "", "alpha here", "beta", "gamma", "");
		const remote = doc("# Title", "", "alpha there", "beta", "gamma", "");

		expect(mergeText(BASE, local, remote)).toEqual({ clean: false, reason: "overlapping-edits" });
	});

	it("refuses an edit that overlaps a deletion", () => {
		const local = doc("# Title", "", "alpha", "gamma", ""); // "beta" deleted
		const remote = doc("# Title", "", "alpha", "beta rewritten", "gamma", "");

		expect(mergeText(BASE, local, remote).clean).toBe(false);
	});

	it("refuses two different insertions at the same point", () => {
		const local = doc("# Title", "", "alpha", "phone note", "beta", "gamma", "");
		const remote = doc("# Title", "", "alpha", "laptop note", "beta", "gamma", "");

		expect(mergeText(BASE, local, remote).clean).toBe(false);
	});

	it("refuses when one side rewrote the whole file", () => {
		const local = doc("# Title", "", "alpha", "beta", "gamma", "delta", "");
		const remote = "completely different";

		expect(mergeText(BASE, local, remote).clean).toBe(false);
	});

	it("gives up rather than grind on two wholesale rewrites of a huge file", () => {
		const base = Array.from({ length: 4_000 }, (_, line) => `base ${line}`).join("\n");
		const local = Array.from({ length: 4_000 }, (_, line) => `local ${line}`).join("\n");
		const remote = Array.from({ length: 4_000 }, (_, line) => `remote ${line}`).join("\n");

		// Bounded work, and the answer is the safe one: a Conflict Copy, not a wrong merge.
		expect(mergeText(base, local, remote)).toEqual({ clean: false, reason: "too-large" });
	});
});
