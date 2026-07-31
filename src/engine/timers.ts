/**
 * The injected clock (spec §1.1). Debounce, max-wait and backoff are all real
 * durations in production and instant in tests — headless tests must never sleep, or
 * the inner loop stops being an inner loop.
 *
 * Interface only, by design: the engine is pure TypeScript and must not know whether
 * it is running in an Obsidian webview or a vitest worker. The production
 * implementation lives beside the plugin shell in `src/platform/timers.ts`, and tests
 * pass a fake clock.
 */
export interface Timers {
	now(): number;
	/** Schedules `handler`; returns a cancel function that is safe to call twice. */
	after(ms: number, handler: () => void): () => void;
}
