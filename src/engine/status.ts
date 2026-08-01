import type { RunTrigger } from "./triggers";

/**
 * The Status Surface (spec §5.7) — the engine's exposed state, and the contract the
 * settings/onboarding UX presents (ticket 022). The engine owns it; every surface
 * (ribbon, status bar, settings) renders *this* rather than keeping its own idea of
 * what sync is doing.
 *
 * `offline`, `quota`, `auth-error` and `frozen` are the **Attention States**, and every
 * one of them is derived from the Run that just ended rather than latched: a Run that
 * lists, uploads and finishes clean *is* the recovery. The one exception is
 * `auth-error`, which survives across Runs because only a re-login can clear it —
 * `SyncEngine.credentialsRestored()`. The notices and badges that act on the distinction
 * are the status-surface UX's (ticket 037).
 */
export type EngineStatus = "idle" | "syncing" | "offline" | "quota" | "auth-error" | "frozen";

/** The four states of {@link EngineStatus} that need the user to know something. */
export type AttentionState = "offline" | "quota" | "auth-error" | "frozen";

export type RunOutcome =
	/** Everything planned was done — Conflicts included; a resolved Conflict is work done. */
	| "ok"
	/** Some paths were skipped, failed, or have to be redone by the next Run. */
	| "partial"
	/** The remote listing itself failed — nothing was planned. */
	| "offline"
	/**
	 * The Run never started: sync is in an Attention State only the user can clear, so
	 * running would have meant hammering a remote that has already said no.
	 */
	| "blocked"
	/** The Run could not be planned for a local reason. */
	| "failed";

export type OpFailure = { path: string; message: string };

/** Why a path was Skip-and-Surfaced (spec §5.8). */
export type SkipReason =
	/** The local platform cannot materialize the name — Windows-reserved, `:`, `|`, … */
	| "unwritable-path"
	/** Two remote files hold one path; the tracked one syncs and the other is reported. */
	| "duplicate-remote-path"
	/** Two remote paths differ only in case, which most vaults cannot hold at once. */
	| "case-collision"
	/** The remote refused the operation permanently. */
	| "remote-rejected";

/**
 * One Skip-and-Surface, as the Recent-activity list shows it. A skip is never retried
 * and never auto-renamed (spec §5.8) — reporting it *is* the resolution, which is why
 * it carries a sentence a user can act on rather than a code.
 */
export type SkipRecord = { path: string; reason: SkipReason; detail: string };

/** Per-run summary: what the Recent-activity list and the last-run line are made of. */
export type RunSummary = {
	/** Every trigger that coalesced into this Run, in arrival order. */
	triggers: RunTrigger[];
	scope: "full" | "paths";
	startedAt: number;
	durationMs: number;
	outcome: RunOutcome;
	uploaded: number;
	downloaded: number;
	/** Paths that needed no transfer: already identical, or only a record refresh. */
	identical: number;
	/** Paired renames: records that moved instead of transferring. */
	moved: number;
	/** Soft Deletes propagated, files only. */
	deleted: number;
	/** Three-Way Merges that came out clean — both edits kept, no copy needed. */
	merged: number;
	/** Conflict Copies created, one per row added to `conflicts.md`. */
	conflicts: number;
	/**
	 * Whether this Run's rows actually reached `conflicts.md`. What the shell acts on is
	 * `conflicts > 0` — spec §6.2 keys the open on a copy having been created, and the
	 * open *is* the announcement — but a Run that made copies and could not write the
	 * manifest has something to say in Recent activity rather than a file worth opening.
	 */
	manifestWritten: boolean;
	/**
	 * Paths this Run handed to the next one: what the re-stat guard refused to touch,
	 * and what a fault outlived its retries on. Not a failure count — work outstanding.
	 */
	requeued: number;
	/** Skip-and-Surfaces, with the reason each one needs to be acted on (spec §5.8). */
	skips: readonly SkipRecord[];
	/** Per-operation failures: one bad file never blocks the rest of the vault. */
	failures: readonly OpFailure[];
	/**
	 * The Attention State this Run ended in, or `null` for one that needs nothing. Kept on
	 * the record rather than read off the live status, because the Recent-activity list
	 * (spec §8.7) shows past Runs, and "offline" and "frozen" are the same `outcome` with
	 * very different things to tell the user.
	 */
	attention: AttentionState | null;
	/**
	 * Why the Run as a whole could not proceed (`offline`, `blocked`, `failed`); `null`
	 * otherwise.
	 */
	error: string | null;
};

/** One source of truth for status, with a subscription for the surfaces that draw it. */
export class StatusSurface {
	private current: EngineStatus = "idle";
	private latest: RunSummary | null = null;
	private readonly listeners = new Set<(status: EngineStatus) => void>();

	get status(): EngineStatus {
		return this.current;
	}

	get lastRun(): RunSummary | null {
		return this.latest;
	}

	set(status: EngineStatus): void {
		if (this.current === status) return;
		this.current = status;
		for (const listener of this.listeners) listener(status);
	}

	record(summary: RunSummary): void {
		this.latest = summary;
	}

	subscribe(listener: (status: EngineStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
