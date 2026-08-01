import { builtinModules } from "node:module";

import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

/**
 * `eslint-plugin-obsidianmd`'s recommended config is the machine-readable form of
 * Obsidian's directory review (spec §1.3, §10.4) — it runs from the first commit
 * so compliance never becomes a cleanup project.
 */

/** Node built-ins, with and without the `node:` prefix. */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

const MOBILE_SAFETY =
	"Obsen runs on mobile: no Node APIs. Use a web API, or put the dependency behind a port.";

/** Files that run under Node (build scripts, tests) or predate the DOM (shims). */
const nodeSideFiles = ["build/**", "tests/**", "shims/**", "*.config.ts", "*.config.mjs"];

/**
 * The recommended config enables `obsidianmd/validate-manifest`, but registers it
 * only on JS/TS globs — so without this it silently never runs. The rule reads a
 * JSON object literal, which the TypeScript parser in script mode gives it.
 */
const manifestConfig = {
	files: ["manifest.json"],
	plugins: { obsidianmd },
	languageOptions: {
		parser: tseslint.parser,
		parserOptions: { sourceType: "script" },
	},
	rules: { "obsidianmd/validate-manifest": "error" },
};

export default defineConfig([
	globalIgnores(["main.js", "prototypes/**", "docs/**"]),

	...obsidianmd.configs.recommended,

	manifestConfig,

	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { project: "./tsconfig.json" },
		},
	},

	{
		// The plugin and the engine must stay browser-safe. The bundle gate catches
		// this too, but a lint error names the file and arrives sooner.
		files: ["src/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: nodeBuiltins.map((name) => ({
						name,
						message: MOBILE_SAFETY,
					})),
				},
			],
			// `@types/node` is in scope for the build scripts and tests, which would
			// otherwise let plugin code reference Node globals and typecheck cleanly.
			// Re-declares the recommended config's `fetch` restriction, since a rule
			// declaration replaces rather than extends it.
			"no-restricted-globals": [
				"error",
				{ name: "process", message: MOBILE_SAFETY },
				{ name: "Buffer", message: MOBILE_SAFETY },
				{ name: "global", message: MOBILE_SAFETY },
				{ name: "require", message: MOBILE_SAFETY },
				{ name: "__dirname", message: MOBILE_SAFETY },
				{ name: "__filename", message: MOBILE_SAFETY },
				{ name: "fetch", message: "Use Obsidian's `requestUrl` instead of `fetch`." },
			],
		},
	},

	{
		// Obsidian's plugin rules describe plugin code. These files are not it: build
		// scripts and tests are Node programs, and the shims exist precisely to supply
		// Node-shaped modules and pre-`window` globals to the bundled Filen SDK.
		files: nodeSideFiles,
		languageOptions: { globals: { process: "readonly" } },
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/rule-custom-message": "off",
			// There is no `window` to prefer a timer from in a headless test run.
			"obsidianmd/prefer-window-timers": "off",
			"no-restricted-globals": "off",
		},
	},
]);
