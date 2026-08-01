import { resolve } from "node:path";

import { parseObsidianVersions } from "wdio-obsidian-service";

/**
 * Layer 3 of the testing strategy (spec §9): the plugin, installed and running inside
 * a real, sandboxed Obsidian.
 *
 * The fakes below layer 1 are honest about the *contracts* the Obsidian adapters must
 * satisfy; nothing but Obsidian can say whether Obsidian satisfies them. This is where
 * "an adapter write is picked up by Obsidian's index", "`.obsidian/` is invisible to
 * the Vault API" and "a folder rename arrives as one event" stop being research notes
 * and become assertions.
 *
 * Running it:
 *
 * - `npm run build` first — the plugin is installed from the repo root (`plugins: [
 *   "." ]`), so `main.js` has to exist and be current.
 * - `npm run test:wdio` locally. On macOS that opens real Obsidian windows; it runs
 *   unattended, it is just not invisible. Obsidian is Electron, so there is no headless
 *   mode: on Linux (CI included) it needs `Xvfb` **and a window manager** — the CI job
 *   in `.github/workflows/ci.yml` is the reference recipe.
 * - `OBSIDIAN_VERSIONS="1.11.4 latest"` overrides the matrix for a one-off run.
 */

/** Downloads land here rather than in `$HOME`, so CI can cache one directory. */
const cacheDir = resolve(import.meta.dirname, ".obsidian-cache");
process.env.OBSIDIAN_CACHE ??= cacheDir;

const inCi = process.env.CI !== undefined && process.env.CI !== "";

/**
 * `earliest` is `minAppVersion` from `manifest.json` — the oldest Obsidian a user can
 * install Obsen on, and the one whose API surface is most likely to disagree with the
 * types. Both versions run locally too: the whole matrix is a minute once the downloads
 * are cached, and a difference found on a laptop is cheaper than one found in CI.
 * `OBSIDIAN_VERSIONS=latest` narrows it for a fast iteration loop.
 */
const requested = process.env.OBSIDIAN_VERSIONS ?? "earliest latest";
const versions = await parseObsidianVersions(requested, { cacheDir });

if (inCi) {
	// So a CI log says which Obsidian a failure happened under, without digging.
	console.log(`obsidian versions: ${versions.map((pair) => pair.join("/")).join(", ")}`);
}

const vault = "./tests/wdio/fixtures/vault";

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./tests/wdio/**/*.e2e.ts"],
	services: ["obsidian"],
	reporters: ["obsidian"],

	// Every capability is one Obsidian process; more than a couple at once turns a
	// laptop into a space heater without finishing sooner.
	maxInstances: 2,
	logLevel: "warn",
	// Booting Obsidian and copying a vault dwarfs anything the assertions do.
	mochaOpts: { ui: "bdd", timeout: 120_000 },
	waitforTimeout: 10_000,

	capabilities: versions.flatMap(([appVersion, installerVersion]) =>
		// `emulateMobile` flips Obsidian's *UI-mode* flags (`Platform.isMobile`) and
		// nothing else: it proves the mobile UI paths run, and deliberately proves nothing
		// about Node-API absence (that is the layer-2 bundle gate) or about Capacitor and
		// WebKit (layers 5–6). Running the port suite under it is still worth it — the
		// adapter reads `Platform` and branches on it.
		[false, true].map((emulateMobile) => ({
			browserName: "obsidian",
			browserVersion: appVersion,
			"wdio:obsidianOptions": {
				installerVersion,
				plugins: ["."],
				vault,
				emulateMobile,
			},
		})),
	),
};
