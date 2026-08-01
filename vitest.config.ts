import { defineConfig } from "vitest/config";

/**
 * Three layers of the testing strategy (spec §9) live in this repo, and they want
 * opposite timeouts — so each gets its own project.
 *
 * - `unit` — layer 1: the inner loop, headless, seconds. A test that hangs is a
 *   bug worth failing fast on, not two minutes of CI.
 * - `gate` — layer 2, the mobile-safety gate: runs real esbuild bundles, slow by
 *   nature, and has its own npm script (`npm run gate`).
 * - `remote` — layer 4, the real-remote Filen suite: network-bound, mutating one
 *   shared account, and skipped outright when its credentials are absent. Its own
 *   npm script (`npm run test:remote`), never part of `npm test`.
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
			{
				test: {
					name: "remote",
					include: ["tests/remote/**/*.test.ts"],
					// The SDK reads its environment from the globals present, once, at import.
					setupFiles: ["tests/remote/webview-globals.ts"],
					// One process, one file at a time, no concurrency: every test in this
					// project shares one Filen account, and two of them racing would be two
					// runs fighting over the same trash.
					pool: "forks",
					poolOptions: { forks: { singleFork: true } },
					sequence: { concurrent: false },
					// Generous, because these are real uploads over a real network.
					testTimeout: 120_000,
					hookTimeout: 300_000,
				},
			},
		],
	},
});
