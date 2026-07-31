import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

/**
 * Runs a bundle in a realm that looks like a mobile webview: the globals a
 * webview provides, and *none* of Node's. No `process`, no `Buffer`, no bare
 * `global`, no `require` except the `obsidian` Obsidian itself provides.
 *
 * This is what catches load-time mobile crashes on a desktop machine — the
 * `typeof global.IS_EXPO_REACT_NATIVE` ReferenceError found during the ticket-014
 * research is exactly the class of bug that only shows up here.
 *
 * The `obsidian` stub is deliberately the smallest thing the bundle can load
 * against; real-Obsidian integration is ticket 029's wdio harness, not this.
 */

export interface SandboxRun {
	/** `module.exports` of the evaluated bundle. */
	exports: Record<string, unknown>;
	/** Every module id the bundle asked for at load time, in order. */
	requires: string[];
}

export interface StubPlugin {
	onload?: () => unknown;
	onunload?: () => unknown;
	[key: string]: unknown;
}

function createObsidianStub(): Record<string, unknown> {
	class Plugin {
		constructor(
			public app: unknown,
			public manifest: unknown,
		) {}
	}
	return { Plugin };
}

/** The globals a webview has. Anything Node-only is deliberately absent. */
function webviewGlobals(): Record<string, unknown> {
	const location = { href: "app://obsidian.md/", protocol: "app:", host: "obsidian.md" };
	return {
		console,
		crypto: webcrypto,
		TextEncoder,
		TextDecoder,
		URL,
		URLSearchParams,
		atob,
		btoa,
		Blob,
		File,
		FormData,
		Headers,
		Request,
		Response,
		fetch,
		AbortController,
		AbortSignal,
		Event,
		EventTarget,
		MessageChannel,
		ReadableStream,
		WritableStream,
		TransformStream,
		CompressionStream,
		DecompressionStream,
		WebSocket,
		XMLHttpRequest: class {},
		performance,
		structuredClone,
		queueMicrotask,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		navigator: { userAgent: "obsen-gate", onLine: true },
		location,
		document: {
			addEventListener: () => {},
			removeEventListener: () => {},
			visibilityState: "visible",
			createElement: () => ({
				setAttribute: () => {},
				...location,
				search: "",
				hash: "",
				pathname: "/",
				port: "",
			}),
		},
	};
}

export async function evaluateBundle(file: string): Promise<SandboxRun> {
	const code = await readFile(file, "utf8");
	const requires: string[] = [];
	const obsidian = createObsidianStub();
	const moduleObject = { exports: {} as Record<string, unknown> };

	const sandbox: Record<string, unknown> = {
		...webviewGlobals(),
		module: moduleObject,
		exports: moduleObject.exports,
		require: (id: string): unknown => {
			requires.push(id);
			if (id === "obsidian") return obsidian;
			throw new Error(
				`the bundle required "${id}" at runtime — a mobile-safe bundle must be self-contained`,
			);
		},
	};
	sandbox.window = sandbox;
	sandbox.self = sandbox;

	const context = createContext(sandbox);
	runInContext(code, context, { filename: file });

	return { exports: moduleObject.exports, requires };
}
