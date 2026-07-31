import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// tests/unit — layer 1 of the testing strategy (spec §9): headless, seconds.
		// tests/gate — layer 2, the mobile-safety gate: runs real esbuild bundles, so
		// it is slower and gets its own npm script (`npm run gate`).
		include: ["tests/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
