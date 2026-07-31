import { join } from "node:path";

import { context } from "esbuild";

import { bundleOptions, repoRoot } from "./esbuild-options.ts";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

try {
	const ctx = await context(
		bundleOptions({
			entryPoint: join(repoRoot, "src", "main.ts"),
			outfile: join(repoRoot, "main.js"),
			production,
		}),
	);

	if (watch) {
		await ctx.watch();
		console.log("watching for changes…");
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
} catch (error) {
	// A Node built-in reaching the bundle lands here: the mobile-safety gate doing
	// its job (spec §1.2). esbuild has already printed such failures in full, so
	// re-printing the stack would only bury the diagnostic.
	if (error instanceof Error && "errors" in error) process.exit(1);
	throw error;
}
