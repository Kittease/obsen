import type { RunTrigger } from "./triggers";

/**
 * The Status Surface (spec §5.7) — the engine's exposed state, and the contract the
 * settings/onboarding UX presents (ticket 022). The engine owns it; every surface
 * (ribbon, status bar, settings) renders *this* rather than keeping its own idea of
 * what sync is doing.
 *
 * `offline`, `quota`, `auth-error` and `frozen` are the **Attention States**. The flows
 * that enter and recover from them arrive with the resilience slice (ticket 036), and
 * the notices and badges that act on the distinction with the status-surface UX
 * (ticket 037) — which is why only the `offline` a failed remote listing produces is
 * reachable today.
 */
export type EngineStatus = "idle" | "syncing" | "offline" | "quota" | "auth-error" | "frozen";

export type RunOutcome =
	/** Everything planned was done. */
	| "ok"
	/** Some paths were skipped, failed, or await a later slice. */
	| "partial"
	/** The remote listing itself failed — nothing was planned. */
	| "offline"
	/** The Run could not be planned for a local reason. */
	| "failed";

export type OpFailure = { path: string; message: string };

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
	conflicts: number;
	/** Planned operations belonging to a slice that is not implemented yet. */
	deferred: number;
	skipped: number;
	/** Per-operation failures: one bad file never blocks the rest of the vault. */
	failures: readonly OpFailure[];
	/** Why the Run as a whole could not proceed (`offline`, `failed`); `null` otherwise. */
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
