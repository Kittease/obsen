import { defineConfig } from "vitest/config";

/**
 * Two layers of the testing strategy (spec §9) live in this repo, and they want
 * opposite timeouts — so each gets its own project.
 *
 * - `unit` — layer 1: the inner loop, headless, seconds. A test that hangs is a
 *   bug worth failing fast on, not two minutes of CI.
 * - `gate` — layer 2, the mobile-safety gate: runs real esbuild bundles, slow by
 *   nature, and has its own npm script (`npm run gate`).
 */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["tests/unit/**/*.test.ts"],
					testTimeout: 10_000,
					hookTimeout: 10_000,
				},
			},
			{
				test: {
					name: "gate",
					include: ["tests/gate/**/*.test.ts"],
					testTimeout: 120_000,
					hookTimeout: 120_000,
				},
			},
		],
	},
});
