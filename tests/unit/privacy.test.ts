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

/**
 * Addresses that cannot belong to anyone: the domains RFC 2606 and RFC 6761 reserve
 * for documentation and testing. A login form needs a placeholder and a fake needs an
 * account, and neither is a personal detail — but only because the domain is reserved,
 * which is why the exemption is spelled out rather than left to "it looks fake".
 */
const RESERVED_DOMAIN = /@(?:[A-Za-z0-9.-]+\.)?example\.(?:com|net|org)$|@[A-Za-z0-9.-]*\.(?:test|example|invalid|localhost)$/i;

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

	it("still catches an address the exemptions do not cover", () => {
		// The reserved-domain exemption is the one hole in the scan below; this is the
		// proof that it is a hole and not a floor.
		for (const allowed of ["you@example.com", "a@sub.example.test", "x@thing.invalid"]) {
			expect(RESERVED_DOMAIN.test(allowed), allowed).toBe(true);
		}
		// Assembled rather than written out: an address this scan is *supposed* to catch
		// has no business being a literal in the file the scan reads.
		const address = (local: string, domain: string): string => `${local}@${domain}`;
		for (const caught of [
			address("someone", "gmail.com"),
			address("dev", "theodo.com"),
			// A domain that merely starts with `example.` is not a reserved one.
			address("a", "example.company"),
		]) {
			expect(RESERVED_DOMAIN.test(caught), caught).toBe(false);
			expect(caught.match(EMAIL)).toHaveLength(1);
		}
	});

	it("contains no email addresses outside ticket assignee lines", () => {
		const offenders: string[] = [];

		for (const { path, content } of textFiles()) {
			// docs/tickets/*.md carry the claiming user's git email in `assignee:` by
			// deliberate exception — that identity is already public in commit history.
			const isTicket = path.startsWith("docs/tickets/");
			// npm copies package authors' deprecation notices into the lockfile verbatim,
			// and some of them carry an address. Only that one field is exempt: the rest of
			// the lockfile — repository URLs above all — is still scanned.
			const isLockfile = path === "package-lock.json";
			content.split("\n").forEach((line, index) => {
				if (isTicket && line.startsWith("assignee:")) return;
				if (isLockfile && /^\s*"deprecated":/.test(line)) return;
				for (const match of line.match(EMAIL) ?? []) {
					if (RESERVED_DOMAIN.test(match)) continue;
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

/**
 * Workflows are ordinary tracked files, so the scan above already polices them for
 * emails. What it cannot see is the *shape* of the real-remote suite's credential
 * handling (spec §9 layer 4): the dedicated Filen test account must reach the suite
 * through the environment and nowhere else.
 */
const CREDENTIALS = ["FILEN_TEST_EMAIL", "FILEN_TEST_PASSWORD"] as const;

describe("the real-remote suite's test-account credentials", () => {
	const workflows = (): { path: string; content: string }[] =>
		textFiles().filter(({ path }) => path.startsWith(".github/workflows/"));

	it("actually has something to police — the scans below must not be vacuous", () => {
		expect(workflows().length).toBeGreaterThan(0);
		const mentions = textFiles()
			.filter(({ content }) => content.includes("FILEN_TEST_PASSWORD"))
			.map(({ path }) => path);
		expect(mentions).toContain("tests/remote/sandbox.ts");
		expect(mentions.filter((path) => path.startsWith(".github/workflows/"))).not.toEqual([]);
	});

	it("reaches CI only as a secret reference, never a literal or a shell argument", () => {
		const offenders: string[] = [];

		for (const { path, content } of workflows()) {
			content.split("\n").forEach((line, index) => {
				for (const name of CREDENTIALS) {
					if (!line.includes(name)) continue;
					// The single permitted form: an `env:` entry fed from a repository
					// secret. Anything else — a default, a `run:` line, an echo — is how a
					// credential ends up in a public build log.
					const asSecret = new RegExp(
						`^\\s*${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}\\s*$`,
					);
					if (!asSecret.test(line)) offenders.push(`${path}:${index + 1} ${line.trim()}`);
				}
			});
		}

		expect(offenders).toEqual([]);
	});

	it("is read from the environment with no committed fallback", () => {
		const sandbox = readFileSync(join(repoRoot, "tests", "remote", "sandbox.ts"), "utf8");

		for (const name of CREDENTIALS) expect(sandbox).toContain(`process.env["${name}"]`);
		// A baked-in default would turn "no credentials configured" from a skip into a
		// run against whatever account the default names.
		expect(sandbox).not.toMatch(/FILEN_TEST_\w+"\]\s*(\?\?|\|\|)/);
	});
});
