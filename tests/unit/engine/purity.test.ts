import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "../../../build/esbuild-options.ts";

/**
 * Spec §1.1: the Sync Engine is pure TypeScript with **zero** imports from
 * `obsidian` or `@filen/sdk`. That is not a stylistic preference — it is what lets
 * the engine be tested headless against fakes, and what keeps every environment
 * dependency behind the three ports.
 *
 * The bundle gate would eventually catch a Node builtin here; nothing but this test
 * catches an `obsidian` import, because `obsidian` is a legitimate external for the
 * plugin shell right next door.
 */

const ENGINE = join(repoRoot, "src", "engine");

const FORBIDDEN = ["obsidian", "@filen/sdk"];

/** `import`/`export … from "x"`, plus dynamic `import("x")` and `require("x")`. */
const MODULE_SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

function engineFiles(): string[] {
	return readdirSync(ENGINE, { recursive: true, encoding: "utf8" }).filter((name) =>
		name.endsWith(".ts"),
	);
}

describe("the engine's imports", () => {
	it("actually reads the engine — the scan below must not be vacuous", () => {
		const files = engineFiles();
		expect(files.length).toBeGreaterThan(5);
		expect(files).toContain("engine.ts");
		expect(files).toContain("ports.ts");
	});

	it.each(FORBIDDEN)("imports nothing from %s", (forbidden) => {
		const offenders: string[] = [];

		for (const file of engineFiles()) {
			const source = readFileSync(join(ENGINE, file), "utf8");
			for (const [, specifier] of source.matchAll(MODULE_SPECIFIER)) {
				if (specifier === forbidden || specifier?.startsWith(`${forbidden}/`)) {
					offenders.push(`${file} → ${specifier}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it("imports only its own siblings — no reach into the plugin shell either", () => {
		const outsiders: string[] = [];

		for (const file of engineFiles()) {
			const source = readFileSync(join(ENGINE, file), "utf8");
			for (const [, specifier] of source.matchAll(MODULE_SPECIFIER)) {
				if (specifier === undefined) continue;
				const internal = specifier.startsWith("./") && !specifier.slice(2).includes("/");
				if (!internal) outsiders.push(`${file} → ${specifier}`);
			}
		}

		// The engine has no dependencies at all: not `obsidian`, not the SDK, not even
		// a helper from `src/`. Everything it needs arrives through a port.
		expect(outsiders).toEqual([]);
	});
});
