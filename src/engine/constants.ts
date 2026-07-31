/**
 * Spec §5.9 — "one table, all normative" — as one object.
 *
 * Every knob the engine has lives here so the spec table and the code can be read
 * against each other. Values are engine constants, not settings: nothing in the UI
 * changes them. Tests override them by passing a partial (injected timers make the
 * time-based ones instant).
 */
export type EngineConstants = {
	/** Trailing debounce for vault/socket events. */
	eventDebounceMs: number;
	/** Cap on that debounce, so continuous typing can't starve pushes. */
	eventMaxWaitMs: number;
	transferConcurrency: number;
	/** Attempts per transient per-op failure, including the first. */
	transientAttempts: number;
	/** Delays between those attempts. */
	transientDelaysMs: readonly number[];
	/** Offline backoff ladder; the last value is the cap. */
	offlineBackoffMs: readonly number[];
	/** TTL of the remote half of the Own-Writes Filter. */
	ownWriteUuidTtlMs: number;
	/** Mergeable extensions — the Three-Way Merge allowlist (spec §3.4). */
	mergeableExtensions: readonly string[];
	/** State flush cadence during the transfer phase. */
	stateFlushIntervalMs: number;
	/** Conflict paths listed in the First-Link preview. */
	conflictPreviewLimit: number;
};

export const ENGINE_CONSTANTS: EngineConstants = {
	eventDebounceMs: 2_000,
	eventMaxWaitMs: 15_000,
	transferConcurrency: 4,
	transientAttempts: 3,
	transientDelaysMs: [1_000, 5_000],
	offlineBackoffMs: [10_000, 30_000, 60_000, 300_000],
	ownWriteUuidTtlMs: 60_000,
	mergeableExtensions: [".md", ".txt"],
	stateFlushIntervalMs: 5_000,
	conflictPreviewLimit: 10,
};

/** Fills a partial override in, so callers may pass only the constants they care about. */
export function engineConstants(overrides?: Partial<EngineConstants>): EngineConstants {
	return { ...ENGINE_CONSTANTS, ...overrides };
}
