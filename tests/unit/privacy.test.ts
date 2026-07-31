import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "../../build/esbuild-options.ts";

/**
 * This repo is public from day one (CLAUDE.md). Personal details, credentials and
 * test-account particulars must never land in it — a rule worth enforcing rather
 * than remembering.
 */

/** Tracked files plus new-but-not-ignored ones, so a fresh file is covered before it is committed. */
function repoFiles(): string[] {
	const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return output.split("\n").filter(Boolean);
}

const MAX_SCANNED_BYTES = 2_000_000;

function textFiles(): { path: string; content: string }[] {
	return repoFiles().flatMap((path) => {
		const absolute = join(repoRoot, path);
		let size: number;
		try {
			size = statSync(absolute).size;
		} catch {
			return []; // raced deletion; nothing to inspect
		}
		if (size > MAX_SCANNED_BYTES) return [];
		const content = readFileSync(absolute, "latin1");
		if (content.includes("\0")) return []; // binary
		return [{ path, content }];
	});
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

describe("no personal details in the repo", () => {
	it("actually reads the repo — the scan below must not be vacuous", () => {
		const scanned = textFiles();
		expect(scanned.length).toBeGreaterThan(30);
		// Positive control: the detector finds the one place emails are allowed.
		const assignees = scanned.filter(
			({ path, content }) =>
				path.startsWith("docs/tickets/") && /^assignee:.*@/m.test(content),
		);
		expect(assignees.length).toBeGreaterThan(0);
	});

	it("contains no email addresses outside ticket assignee lines", () => {
		const offenders: string[] = [];

		for (const { path, content } of textFiles()) {
			// docs/tickets/*.md carry the claiming user's git email in `assignee:` by
			// deliberate exception — that identity is already public in commit history.
			const isTicket = path.startsWith("docs/tickets/");
			content.split("\n").forEach((line, index) => {
				if (isTicket && line.startsWith("assignee:")) return;
				for (const match of line.match(EMAIL) ?? []) {
					offenders.push(`${path}:${index + 1} ${match}`);
				}
			});
		}

		expect(offenders).toEqual([]);
	});

	it("commits no environment or credential files", () => {
		const secretish = repoFiles().filter((path) =>
			/(^|\/)\.env($|\.)|\.pem$|\.p12$|(^|\/)credentials?\.json$/i.test(path),
		);
		expect(secretish).toEqual([]);
	});
});

describe("CI", () => {
	it("is covered by the scan above", () => {
		// Workflows are ordinary tracked files, so the checks above already police
		// them. The real-remote suite's test-account credentials (spec §9 layer 4)
		// arrive with ticket 028; guarding their shape before then would be a test
		// that cannot fail.
		const workflows = textFiles().filter(({ path }) => path.startsWith(".github/workflows/"));
		expect(workflows.length).toBeGreaterThan(0);
	});
});
