import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildOptions } from "esbuild";

/** Repo root, resolved from this file so scripts work from any cwd. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const shim = (file: string): string => join(repoRoot, "shims", file);

/**
 * The module ids `@filen/sdk@0.4.2` pulls in that a browser cannot provide.
 * Aliasing them is what makes the SDK bundle at all; the list is coupled to
 * 0.4.2's import graph, so the gate must re-run on every SDK bump.
 * See docs/research/014-sdk-in-obsidian-feasibility.md for the per-module reasoning.
 */
export const SHIM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	os: shim("os.js"),
	path: "path-browserify",
	stream: shim("stream.js"),
	crypto: shim("empty.js"),
	https: shim("empty.js"),
	url: shim("empty.js"),
	"fs-extra": shim("empty.js"),
	"progress-stream": shim("progress-stream.js"),
	events: "events",
});

export interface BundleRequest {
	entryPoint: string;
	outfile: string;
	/** Minify and drop the source map, as for a release artifact. */
	production?: boolean;
	/** Ask esbuild for a metafile (the gate inspects it). */
	metafile?: boolean;
	/** Quiet esbuild's own reporting — the gate reads failures programmatically. */
	silent?: boolean;
}

/**
 * The one true build configuration — spec §1.2, the mobile-safety gate.
 *
 * Deliberately *unlike* the official sample scaffold: Node builtins are NOT
 * externalized, so a stray `import "fs"` anywhere in the graph (ours or a
 * dependency's) is a build error instead of a crash on a phone. Only `obsidian`
 * is external, and only because Obsidian provides it at runtime.
 *
 * Both the release build and the gate go through here so they can never drift.
 */
export function bundleOptions(request: BundleRequest): BuildOptions {
	const { entryPoint, outfile, production = false, metafile = false, silent = false } = request;
	return {
		entryPoints: [entryPoint],
		outfile,
		bundle: true,
		platform: "browser",
		format: "cjs",
		target: "es2020",
		external: ["obsidian"],
		// `dist/browser/constants.js` probes a bare `global` identifier, which throws
		// ReferenceError in a webview. Load-bearing; do not remove.
		define: { global: "globalThis" },
		alias: { ...SHIM_ALIASES },
		inject: [shim("globals.js")],
		logLevel: silent ? "silent" : "info",
		metafile,
		minify: production,
		sourcemap: production ? false : "inline",
		treeShaking: true,
	};
}
