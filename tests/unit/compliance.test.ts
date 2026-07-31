import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "../../build/esbuild-options.ts";

/**
 * Spec §10 turned into assertions: identity, license, and the disclosures
 * Obsidian's developer policies require. These are the rules a directory review
 * checks by hand, so they are worth failing a build over.
 */

const read = (relativePath: string): string =>
	readFileSync(join(repoRoot, relativePath), "utf8");
const readJson = (relativePath: string): Record<string, unknown> =>
	JSON.parse(read(relativePath)) as Record<string, unknown>;

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const license = read("LICENSE");
const readme = read("README.md");

describe("manifest.json — identity (spec §10.1)", () => {
	it("uses the agreed id, name and description", () => {
		expect(manifest.id).toBe("obsen");
		expect(manifest.name).toBe("Obsen");
		// Spec §10.1's string, re-punctuated as two sentences: the directory-review
		// rule `obsidianmd/validate-manifest` accepts only `[A-Za-z0-9\s.,!?'"-]`, so
		// the spec's em dash (and a colon) fail it. Every constraint §10.1 actually
		// states — action verb, ≤250 chars, final period — still holds.
		expect(manifest.description).toBe(
			"Sync your vault with a Filen folder. End-to-end encrypted, two-way, on desktop and mobile.",
		);
	});

	it("obeys the directory's naming rules", () => {
		const id = manifest.id as string;
		expect(id).not.toMatch(/obsidian/i);
		expect(id).not.toMatch(/plugin$/);
		expect(manifest.name).not.toMatch(/obsidian/i);
	});

	it("keeps the description within 250 characters and ends it with a period", () => {
		const description = manifest.description as string;
		expect(description.length).toBeLessThanOrEqual(250);
		expect(description.endsWith(".")).toBe(true);
	});

	it("ships as mobile-capable with the SecretStorage version floor", () => {
		expect(manifest.isDesktopOnly).toBe(false);
		expect(manifest.minAppVersion).toBe("1.11.4");
	});

	it("declares no fundingUrl", () => {
		expect(manifest).not.toHaveProperty("fundingUrl");
	});

	it("names an author without embedding an email address", () => {
		expect(manifest.author).toBeTruthy();
		expect(JSON.stringify(manifest)).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
	});
});

describe("versions.json (spec §10.4)", () => {
	it("maps the manifest version to its minimum app version", () => {
		const version = manifest.version as string;
		expect(versions[version]).toBe(manifest.minAppVersion);
	});

	it("never claims support below the SecretStorage floor", () => {
		// A later release may legitimately raise its floor; none may go below 1.11.4,
		// where SecretStorage arrived (spec §8.1).
		const FLOOR = [1, 11, 4];
		const isBelowFloor = (version: string): boolean => {
			const parts = version.split(".").map(Number);
			for (const [index, floor] of FLOOR.entries()) {
				const part = parts[index] ?? 0;
				if (part !== floor) return part < floor;
			}
			return false;
		};

		expect(isBelowFloor("1.10.9")).toBe(true); // the comparison itself works
		for (const minAppVersion of Object.values(versions)) {
			expect(isBelowFloor(minAppVersion as string), `${String(minAppVersion)} is below 1.11.4`).toBe(
				false,
			);
		}
	});

	it("uses bare x.y.z versions with no `v` prefix", () => {
		for (const version of Object.keys(versions)) {
			expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
		}
	});
});

describe("license (spec §10.2)", () => {
	it("ships the verbatim AGPL-3.0 text at the repo root", () => {
		expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
		expect(license).toContain("Version 3, 19 November 2007");
		expect(license).toContain("13. Remote Network Interaction");
		expect(license.length).toBeGreaterThan(30_000);
	});

	it("declares AGPL-3.0-only in package.json", () => {
		expect(packageJson.license).toBe("AGPL-3.0-only");
	});

	it("says nothing about a license in the manifest — no such field exists", () => {
		expect(manifest).not.toHaveProperty("license");
	});

	it("attributes the bundled @filen/sdk in the README", () => {
		expect(readme).toMatch(/AGPL-3\.0-only/);
		expect(readme).toMatch(/@filen\/sdk/);
		expect(readme).toMatch(/filen-sdk-ts/);
	});
});

describe("README disclosures (spec §10.3)", () => {
	it.each([
		["the API gateway", /gateway\.filen\.io/],
		["the ingest host", /ingest\.filen\.io/],
		["the egest host", /egest\.filen\.io/],
		["the socket host", /socket\.filen\.io/],
		["that a Filen account is required", /account is required/i],
		["the free-vs-paid storage boundary", /free tier/i],
		["where credentials live", /SecretStorage/],
		["the residual credential risk", /not documented as encrypted at rest/i],
		["the dual-engine caveat", /one sync engine per folder per device/i],
		["no telemetry", /no telemetry/i],
	])("discloses %s", (_what, pattern) => {
		expect(readme).toMatch(pattern);
	});

	it("keeps the network disclosure honest about other servers", () => {
		expect(readme).toMatch(/no other server/i);
	});
});

describe("version consistency", () => {
	it("keeps package.json and manifest.json on the same version", () => {
		expect(packageJson.version).toBe(manifest.version);
	});
});
