import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build, type Metafile } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bundleOptions, repoRoot, SHIM_ALIASES } from "../../build/esbuild-options.ts";
import { evaluateBundle, stubApp, type StubPlugin } from "../helpers/browser-sandbox.ts";

/**
 * Layer 2 of the testing strategy (spec §9): the mobile-safety gate.
 *
 * `manifest.json` claims `isDesktopOnly: false`; this suite is what makes the
 * claim true. A Node builtin reaching the bundle — from our code or from a
 * dependency — must be a build error, not a crash on someone's phone.
 */

const scratch = mkdtempSync(join(tmpdir(), "obsen-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Built into the scratch directory rather than the repo root, so running the gate
// never clobbers a `npm run dev` watch artifact someone is testing in Obsidian.
const mainJs = join(scratch, "main.js");

/** Bundles an ad-hoc entry point with the production configuration. */
async function bundleSource(name: string, source: string): Promise<string> {
	const entryPoint = join(scratch, `${name}.ts`);
	const outfile = join(scratch, `${name}.js`);
	writeFileSync(entryPoint, source);
	await build(bundleOptions({ entryPoint, outfile, production: true, silent: true }));
	return outfile;
}

describe("Node builtins are build errors", () => {
	it.each([
		["fs", 'import "fs";'],
		["node:fs", 'import "node:fs";'],
		["child_process", 'import { exec } from "child_process";\nexport const run = exec;'],
		["net", 'import "net";'],
	])("rejects a bundle importing %s", async (builtin, source) => {
		await expect(bundleSource(`leak-${builtin.replace(":", "-")}`, source)).rejects.toThrow(
			/Could not resolve/,
		);
	});

	it("rejects a leak that arrives through a dependency, not just a direct import", async () => {
		// Nothing is externalized, so a builtin reached transitively resolves — and
		// fails — exactly like a first-party one. This is the case that would
		// otherwise ship a plugin that crashes only on phones.
		writeFileSync(
			join(scratch, "transitive-dep.ts"),
			'import { readFileSync } from "fs";\nexport const read = readFileSync;\n',
		);
		await expect(
			bundleSource(
				"leak-transitive",
				'import { read } from "./transitive-dep.ts";\nexport const used = read;\n',
			),
		).rejects.toThrow(/Could not resolve "fs"/);
	});

	it("names the offending import in the failure, so the fix is obvious", async () => {
		await expect(bundleSource("leak-submodule", 'import "fs/promises";')).rejects.toThrow(
			/fs\/promises/,
		);
	});

	it("still resolves every module id the Filen SDK needs shimmed", async () => {
		// Aliased rather than rejected — the whole reason @filen/sdk bundles at all.
		// Driven off SHIM_ALIASES so a new or broken alias fails here rather than at
		// plugin load. Named imports, since an unused bare import is tree-shaken away.
		const ids = Object.keys(SHIM_ALIASES);
		const source = [
			...ids.map((id, index) => `import shim${index} from ${JSON.stringify(id)};`),
			`export const shimmed = [${ids.map((_, index) => `shim${index}`).join(", ")}].length;`,
		].join("\n");
		await expect(bundleSource("shimmed", source)).resolves.toBeTruthy();
	});
});

describe("the production bundle", () => {
	let metafile: Metafile;

	beforeAll(async () => {
		// Builds the real shipped artifact, so every assertion below is about the
		// file a user would install.
		const result = await build(
			bundleOptions({
				entryPoint: join(repoRoot, "src", "main.ts"),
				outfile: mainJs,
				production: true,
				metafile: true,
				silent: true,
			}),
		);
		expect(result.errors).toEqual([]);
		if (!result.metafile) throw new Error("esbuild returned no metafile");
		metafile = result.metafile;
	});

	it("produces a main.js with the SDK inside it", () => {
		// ~1.2 MB minified per the ticket-014 measurements; a bundle that lost the SDK
		// would be orders of magnitude smaller.
		expect(statSync(mainJs).size).toBeGreaterThan(500_000);
	});

	it("takes @filen/sdk from its browser build, never dist/node", () => {
		const sdkInputs = Object.keys(metafile.inputs).filter((path) => path.includes("@filen/sdk"));
		expect(sdkInputs.length).toBeGreaterThan(0);
		expect(sdkInputs.filter((path) => !path.includes("dist/browser/"))).toEqual([]);
	});

	it("leaves `obsidian` external and requires nothing else at load", async () => {
		const { requires } = await evaluateBundle(mainJs);
		// By module id, not by call: esbuild emits one `require` per module that imports
		// `obsidian`, and how many of ours do is not a property worth asserting.
		expect([...new Set(requires)]).toEqual(["obsidian"]);
	});

	it("evaluates with no Node globals present and exports a plugin class", async () => {
		const { exports } = await evaluateBundle(mainJs);
		expect(typeof exports.default).toBe("function");
	});

	it("constructs its ports and a FilenSDK during onload, in the webview realm", async () => {
		// Ticket 026's headline acceptance criterion, checked where a phone would
		// break: no process, no Buffer, no bare `global`.
		const { exports } = await evaluateBundle(mainJs);
		const PluginClass = exports.default as new (app: unknown, manifest: unknown) => StubPlugin;
		const plugin = new PluginClass(stubApp(), { id: "obsen", version: "0.0.0-test" });

		await plugin.onload?.();
		expect(plugin.filen).toBeTruthy();
		expect(plugin.ports).toBeTruthy();

		await plugin.onunload?.();
		expect(plugin.filen).toBeNull();
		expect(plugin.ports).toBeNull();
	});

	it("carries a Sync Engine that works with only webview globals", async () => {
		// The ports reach `main.ts`, but nothing constructs a `SyncEngine` until the
		// triggers are wired (ticket 034) — so the gate bundles it directly rather than
		// waiting to discover on a phone that WebCrypto hashing was the one thing missing.
		const probe = await bundleSource(
			"engine-probe",
			[
				`import { sha512Hex, SyncEngine } from ${JSON.stringify(join(repoRoot, "src/engine/index.ts"))};`,
				"export const engineClass = typeof SyncEngine;",
				"export const digest = sha512Hex(new TextEncoder().encode('obsen'));",
			].join("\n"),
		);
		const { exports, requires } = await evaluateBundle(probe);

		expect(requires).toEqual([]); // a pure-TS engine needs nothing at load
		expect(exports.engineClass).toBe("function");
		// Cross-checked against Node's implementation, which also proves the hex
		// encoding: this digest is the Shadow Store key and the rename-pairing key.
		expect(await exports.digest).toBe(createHash("sha512").update("obsen").digest("hex"));
	});

	it("carries the Filen RemotePort adapter, which is where the SDK is actually used", async () => {
		// Same reason as the engine probe: the adapter is not reachable from `main.ts`
		// until the settings tab can link a folder (tickets 030–031), and "the file that
		// touches @filen/sdk is browser-safe" is exactly the claim worth checking early.
		const probe = await bundleSource(
			"remote-adapter-probe",
			[
				`import { createFilenRemote } from ${JSON.stringify(join(repoRoot, "src/filen/remote.ts"))};`,
				"export const factory = typeof createFilenRemote;",
			].join("\n"),
		);
		const { exports, requires } = await evaluateBundle(probe);

		expect(requires).toEqual([]);
		expect(exports.factory).toBe("function");
	});

	it("has the SDK agree at runtime that it is in a browser", async () => {
		// The build picks @filen/sdk's browser path; `environment` is computed at
		// *runtime* from the globals present. Both must say browser, or the SDK will
		// take Node code paths on a phone.
		const probe = await bundleSource(
			"sdk-environment-probe",
			[
				`import { sdkEnvironment } from ${JSON.stringify(join(repoRoot, "src/filen/sdk.ts"))};`,
				"export const environment = sdkEnvironment();",
			].join("\n"),
		);
		const { exports } = await evaluateBundle(probe);
		expect(exports.environment).toBe("browser");
	});
});
