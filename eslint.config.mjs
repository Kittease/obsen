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
const nodeSideFiles = [
	"build/**",
	"tests/**",
	"shims/**",
	"*.config.ts",
	"*.config.mjs",
	"wdio.conf.ts",
];

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
			// Both projects: layer 3's specs live in their own so that WebdriverIO's and
			// Mocha's globals stay out of the vitest suites.
			parserOptions: { project: ["./tsconfig.json", "./tests/wdio/tsconfig.json"] },
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
		// Obsidian 1.13's declarative settings API (`getSettingDefinitions`) describes a
		// *list of settings*, and Obsen's tab is not one: it is a state machine (spec
		// §8.2) whose controls — login form, folder picker, recovery actions — mostly do
		// not exist in most of its states, so declaring them would advertise controls
		// that are not there. It is also above the 1.11.4 floor the plugin supports.
		files: ["src/ui/**/*.ts"],
		rules: { "obsidianmd/settings-tab/prefer-setting-definitions": "off" },
	},

	{
		// Layer 3 renders the settings tab the way Obsidian does: by calling `display()`.
		// 1.13 deprecates it in favour of the declarative API the tab cannot use (above),
		// so the deprecation notice is noise on exactly the call the test is about.
		files: ["tests/wdio/**/*.e2e.ts"],
		rules: { "@typescript-eslint/no-deprecated": "off" },
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
			// TypeScript resolves identifiers better than this rule does, and it cannot
			// see ambient namespaces at all — `WebdriverIO.Config` reads as undefined.
			"no-undef": "off",
		},
	},
]);
