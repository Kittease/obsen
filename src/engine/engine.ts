import { engineConstants, type EngineConstants } from "./constants";
import { executePlan } from "./execute";
import { sha512Hex, type Hasher } from "./hash";
import { errorMessage } from "./errors";
import { computePlan, RemoteUnavailableError, type Plan, type PlanProgress } from "./plan";
import type { RemotePort, StorePort, VaultPort } from "./ports";
import { RunScheduler, type DirtySet } from "./scheduler";
import { EVERYTHING, type SyncScope } from "./scope";
import {
	flushState,
	loadState,
	type FileRecord,
	type StateResetReason,
	type SyncState,
} from "./state";
import { StatusSurface, type EngineStatus, type RunOutcome, type RunSummary } from "./status";
import type { Timers } from "./timers";
import { FULL_SCOPE, pathScope, type RenameHint, type RunScope, type RunTrigger } from "./triggers";

/**
 * The Sync Engine (spec §4–5): triggers in, converged vault out.
 *
 * Pure TypeScript — nothing under `src/engine/` imports `obsidian` or `@filen/sdk`,
 * which is what lets the whole thing run headless against in-memory fakes.
 *
 * Every trigger does the same two things: mark paths dirty and request a Run. The
 * scheduler guarantees one Run at a time; the planner and executor do the work. There
 * is no separate first-link path — First Link is a FULL Reconcile with empty state.
 */

export type SyncEngineOptions = {
	vault: VaultPort;
	remote: RemotePort;
	store: StorePort;
	/** UUID of the linked Remote Folder; a mismatch against stored state re-bootstraps. */
	remoteRoot: string;
	/** Defaults to everything; production passes the Exclusion List predicate (ticket 029). */
	scope?: SyncScope;
	/** The injected clock; production passes `windowTimers` from `src/platform/timers.ts`. */
	timers: Timers;
	hash?: Hasher;
	constants?: Partial<EngineConstants>;
};

export class SyncEngine {
	private readonly status = new StatusSurface();
	private readonly scheduler: RunScheduler<RunSummary>;
	private readonly constants: EngineConstants;
	private readonly timers: Timers;
	private readonly hash: Hasher;
	private readonly scope: SyncScope;
	private state: SyncState;
	/** A plan the user already approved (First Link), used by the next `first-link` Run. */
	private approved: Plan | null = null;
	/** Set while the stored document still differs from this state — after a Re-Bootstrap. */
	private unpersisted: boolean;

	private constructor(
		private readonly options: SyncEngineOptions,
		state: SyncState,
		/** Why stored state was discarded, if it was — a Re-Bootstrap the UX may want to explain. */
		readonly stateReset: StateResetReason | null,
	) {
		this.state = state;
		// A discarded state file must be replaced on disk even by a Run with nothing to
		// do, or the unusable document survives and every startup re-bootstraps again.
		this.unpersisted = stateReset !== null;
		this.constants = engineConstants(options.constants);
		this.timers = options.timers;
		this.hash = options.hash ?? sha512Hex;
		this.scope = options.scope ?? EVERYTHING;
		this.scheduler = new RunScheduler<RunSummary>({
			timers: this.timers,
			constants: this.constants,
			run: (dirty) => this.execute(dirty),
		});
	}

	/** Loads the Sync State and returns an engine ready to run. */
	static async open(options: SyncEngineOptions): Promise<SyncEngine> {
		const loaded = await loadState(options.store, options.remoteRoot);
		return new SyncEngine(options, loaded.state, loaded.reset);
	}

	get currentStatus(): EngineStatus {
		return this.status.status;
	}

	get lastRun(): RunSummary | null {
		return this.status.lastRun;
	}

	/** Read-only view of the Sync State, for the troubleshooting surface and tests. */
	get records(): ReadonlyMap<string, FileRecord> {
		return this.state.files;
	}

	subscribe(listener: (status: EngineStatus) => void): () => void {
		return this.status.subscribe(listener);
	}

	/**
	 * The plan-only entry point (spec §8.4): the planner runs, nothing executes.
	 * Feeds the First Link dry-run preview, and is the same code a real Run plans with.
	 */
	plan(options: { scope?: RunScope; onProgress?: (progress: PlanProgress) => void } = {}): Promise<Plan> {
		return computePlan({
			vault: this.options.vault,
			remote: this.options.remote,
			state: this.state,
			scope: this.scope,
			run: options.scope ?? FULL_SCOPE,
			hash: this.hash,
			constants: this.constants,
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		});
	}

	/** Requests a FULL Run and resolves with its summary. */
	syncNow(trigger: RunTrigger = "manual"): Promise<RunSummary> {
		return this.scheduler.request({ trigger, scope: FULL_SCOPE });
	}

	/** FULL Run that bypasses the change-detection cheap path ("Verify and repair", spec §3.2). */
	verifyAndRepair(): Promise<RunSummary> {
		return this.scheduler.request({
			trigger: "verify-repair",
			scope: { kind: "full", rehash: true },
		});
	}

	/** Marks paths dirty — the only thing a vault or socket event does (spec §4). */
	markDirty(
		paths: Iterable<string>,
		trigger: RunTrigger = "vault-event",
		hints?: readonly RenameHint[],
	): Promise<RunSummary> {
		return this.scheduler.request({
			trigger,
			scope: pathScope(paths),
			...(hints ? { hints } : {}),
		});
	}

	/** Escalates to a FULL Run — a socket event the port could not resolve to a path. */
	markUnresolved(trigger: RunTrigger = "remote-event"): Promise<RunSummary> {
		return this.scheduler.request({ trigger, scope: FULL_SCOPE });
	}

	/**
	 * Executes a plan the user already approved, as an ordinary non-blocking Run
	 * (spec §8.4 step 4). If anything else coalesces into the same Run, the approved
	 * plan is dropped and the Run re-plans — a stale plan is never executed alongside
	 * changes it did not see.
	 */
	runApprovedPlan(plan: Plan): Promise<RunSummary> {
		this.approved = plan;
		return this.scheduler.request({ trigger: "first-link", scope: plan.scope });
	}

	/** Resolves when no Run is executing and nothing is pending. */
	idle(): Promise<void> {
		return this.scheduler.idle();
	}

	/** Stops scheduling; pending requests are failed. Called from the plugin's unload path. */
	stop(): void {
		this.scheduler.dispose();
	}

	private async execute(dirty: DirtySet): Promise<RunSummary> {
		const startedAt = this.timers.now();
		const approved = this.takeApprovedPlan(dirty);
		this.status.set("syncing");

		const summarize = (
			outcome: RunOutcome,
			totals: Partial<RunSummary> = {},
		): RunSummary => ({
			triggers: dirty.triggers,
			scope: dirty.scope.kind,
			startedAt,
			durationMs: this.timers.now() - startedAt,
			outcome,
			uploaded: 0,
			downloaded: 0,
			identical: 0,
			conflicts: 0,
			deferred: 0,
			skipped: 0,
			failures: [],
			error: null,
			...totals,
		});

		let plan: Plan;
		try {
			plan = approved ?? (await this.plan({ scope: dirty.scope }));
		} catch (error) {
			// A failed listing is `offline`; the backoff ladder and the rest of the error
			// taxonomy are ticket 036's. Anything else is a local fault, and reporting it
			// as offline would send the user chasing their network.
			const offline = error instanceof RemoteUnavailableError;
			this.status.set(offline ? "offline" : "idle");
			return this.finish(
				summarize(offline ? "offline" : "failed", { error: errorMessage(error) }),
			);
		}

		const report = await executePlan({
			vault: this.options.vault,
			remote: this.options.remote,
			store: this.options.store,
			state: this.state,
			hash: this.hash,
			constants: this.constants,
			plan,
		});
		// `executePlan` flushes at its phase boundaries, so a Run that changed records has
		// already persisted them; this covers the Re-Bootstrap that changed none.
		if (this.unpersisted && !report.stateChanged) {
			await flushState(this.options.store, this.state);
		}
		this.unpersisted = false;
		this.status.set("idle");

		const clean =
			report.failures.length === 0 &&
			report.skipped === 0 &&
			report.deferred === 0 &&
			report.conflicts === 0;
		return this.finish(
			summarize(clean ? "ok" : "partial", {
				uploaded: report.uploaded,
				downloaded: report.downloaded,
				identical: report.identical,
				conflicts: report.conflicts,
				deferred: report.deferred,
				skipped: report.skipped,
				failures: report.failures,
			}),
		);
	}

	/**
	 * The approved plan is only honoured for a Run that is *exactly* the First Link
	 * confirmation; coalescing means something changed since the preview was computed.
	 */
	private takeApprovedPlan(dirty: DirtySet): Plan | null {
		const approved = this.approved;
		this.approved = null;
		const soleTrigger = dirty.triggers.length === 1 && dirty.triggers[0] === "first-link";
		return approved && soleTrigger ? approved : null;
	}

	private finish(summary: RunSummary): RunSummary {
		this.status.record(summary);
		return summary;
	}
}
