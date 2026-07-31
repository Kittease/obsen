/**
 * Run vocabulary: what asked for a Run, and over which paths (spec §4).
 *
 * Every trigger does exactly one thing — mark paths dirty and request a Run. There
 * is no live-sync fast path, so this is the whole trigger surface.
 */

export type RunTrigger =
	/** `onLayoutReady` — the correctness backstop. */
	| "startup"
	/** `visibilitychange` → visible, or desktop window focus. */
	| "foreground-resume"
	/** A vault `create`/`modify`/`delete`/`rename` event. */
	| "vault-event"
	/** A Filen socket event — trigger, never ledger. */
	| "remote-event"
	/** Ribbon icon or the "Sync now" command. */
	| "manual"
	/** The First Link confirmation, executing an already-computed plan. */
	| "first-link"
	/** "Verify and repair": FULL, bypassing the change-detection cheap path. */
	| "verify-repair";

// A follow-up Run needs no trigger of its own: the requests that arrived mid-Run
// carry their own triggers into it.

export type RunScope =
	/** FULL — the whole vault. `rehash` bypasses the §3.2 cheap path. */
	| { kind: "full"; rehash?: boolean }
	| { kind: "paths"; paths: ReadonlySet<string> };

/** An old→new pair from a live vault `rename` event, consumed by the pairing pass. */
export type RenameHint = { from: string; to: string };

export const FULL_SCOPE: RunScope = { kind: "full" };

export function pathScope(paths: Iterable<string>): RunScope {
	return { kind: "paths", paths: new Set(paths) };
}

/**
 * Union of two scopes — how requests coalesce into the pending scope. FULL absorbs
 * everything, and a rehash request stays sticky until it has been served.
 */
export function mergeScopes(left: RunScope, right: RunScope): RunScope {
	if (left.kind === "full" || right.kind === "full") {
		const rehash =
			(left.kind === "full" && left.rehash === true) ||
			(right.kind === "full" && right.rehash === true);
		return rehash ? { kind: "full", rehash: true } : FULL_SCOPE;
	}
	return { kind: "paths", paths: new Set([...left.paths, ...right.paths]) };
}
