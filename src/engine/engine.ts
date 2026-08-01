import { DEFAULT_DEVICE_NAME } from "./conflict";
import { engineConstants, type EngineConstants } from "./constants";
import { executePlan, type ExecutionReport } from "./execute";
import { sha512Hex, type Hasher } from "./hash";
import { attentionFor, errorMessage, faultKind } from "./errors";
import { computePlan, RemoteUnavailableError, type Plan, type PlanProgress } from "./plan";
import type { RemotePort, StorePort, VaultPort } from "./ports";
import { RunScheduler, type DirtySet } from "./scheduler";
import { EVERYTHING, type SyncScope } from "./scope";
import { referencedHashes, ShadowStore } from "./shadow";
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

/**
 * The triggers entitled to cut through an offline backoff.
 *
 * Spec §5.7 names two — "Foreground-Resume and manual sync cut through". `verify-repair`
 * and `first-link` are added here because they are the same kind of caller: a person who
 * just pressed something and is watching for it to happen. What must *not* be on this list
 * is a vault or socket event, since a burst of those is exactly what the ladder absorbs.
 * `startup` is absent because it cannot apply — the engine is built after it.
 */
const CUTS_THROUGH: readonly RunTrigger[] = [
	"foreground-resume",
	"manual",
	"verify-repair",
	"first-link",
];

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
	/** Names this device's Conflict Copies (spec §6.1, §8.7); the shell owns the default. */
	deviceName?: string;
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
	private readonly shadow: ShadowStore;
	private state: SyncState;
	/** A plan the user already approved (First Link), used by the next `first-link` Run. */
	private approved: Plan | null = null;
	/** Set while the stored document still differs from this state — after a Re-Bootstrap. */
	private unpersisted: boolean;
	/**
	 * The auth freeze (spec §5.7): the message of the fault that caused it, and the only
	 * Attention State that survives a Run, because only a re-login can lift it.
	 */
	private authFailure: string | null = null;
	/** How many consecutive Runs have ended with work the remote would not take. */
	private backoffStep = 0;

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
		this.shadow = new ShadowStore(options.store, this.hash);
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
	plan(
		options: {
			scope?: RunScope;
			hints?: readonly RenameHint[];
			onProgress?: (progress: PlanProgress) => void;
		} = {},
	): Promise<Plan> {
		return computePlan({
			vault: this.options.vault,
			remote: this.options.remote,
			state: this.state,
			scope: this.scope,
			run: options.scope ?? FULL_SCOPE,
			hash: this.hash,
			constants: this.constants,
			...(options.hints ? { hints: options.hints } : {}),
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		});
	}

	/** Requests a FULL Run and resolves with its summary. */
	syncNow(trigger: RunTrigger = "manual"): Promise<RunSummary> {
		return this.request(trigger, FULL_SCOPE);
	}

	/** FULL Run that bypasses the change-detection cheap path ("Verify and repair", spec §3.2). */
	verifyAndRepair(): Promise<RunSummary> {
		return this.request("verify-repair", { kind: "full", rehash: true });
	}

	/** Marks paths dirty — the only thing a vault or socket event does (spec §4). */
	markDirty(
		paths: Iterable<string>,
		trigger: RunTrigger = "vault-event",
		hints?: readonly RenameHint[],
	): Promise<RunSummary> {
		return this.request(trigger, pathScope(paths), hints);
	}

	/** Escalates to a FULL Run — a socket event the port could not resolve to a path. */
	markUnresolved(trigger: RunTrigger = "remote-event"): Promise<RunSummary> {
		return this.request(trigger, FULL_SCOPE);
	}

	/**
	 * Lifts the `auth-error` freeze after a successful re-login (spec §5.7, §8.2) and
	 * reconciles from scratch.
	 *
	 * A FULL Run rather than the paths the frozen Run left behind: the credentials were
	 * wrong for as long as the freeze lasted, so what happened on either side in the
	 * meantime is unknown, and only a Reconcile can answer it. Safe to call when nothing
	 * is frozen — that is just a manual sync.
	 */
	credentialsRestored(): Promise<RunSummary> {
		this.authFailure = null;
		this.backoffStep = 0;
		return this.syncNow("manual");
	}

	private request(
		trigger: RunTrigger,
		scope: RunScope,
		hints?: readonly RenameHint[],
	): Promise<RunSummary> {
		return this.scheduler.request({
			trigger,
			scope,
			cutThrough: CUTS_THROUGH.includes(trigger),
			...(hints ? { hints } : {}),
		});
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

	/**
	 * Whether a Run is executing or waiting to — the synchronous counterpart of
	 * {@link idle}, for callers that have to answer "is there still work?" now rather
	 * than await it. One Run can queue the next: resolving a Conflict writes the
	 * manifest, and that write has to sync.
	 */
	get busy(): boolean {
		return this.scheduler.isRunning || this.scheduler.hasPending;
	}

	/**
	 * Whether pending work is waiting out an offline backoff rung rather than running
	 * (spec §5.7) — the difference between "syncing" and "will try again shortly", which
	 * is a thing the status surface has to be able to say.
	 */
	get backingOff(): boolean {
		return this.scheduler.held;
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
			moved: 0,
			deleted: 0,
			merged: 0,
			conflicts: 0,
			manifestWritten: false,
			requeued: 0,
			skips: [],
			failures: [],
			attention: null,
			error: null,
			...totals,
		});

		// The auth freeze is the one state a Run cannot clear: the credentials are still
		// wrong, so listing again would spend a round trip proving it (spec §5.7). Nothing
		// is requeued — `credentialsRestored` comes back with a FULL Reconcile, which
		// subsumes whatever this Run was asked to do.
		if (this.authFailure !== null) {
			return this.finish(
				summarize("blocked", { attention: "auth-error", error: this.authFailure }),
			);
		}

		const approved = this.takeApprovedPlan(dirty);
		this.status.set("syncing");

		let plan: Plan;
		try {
			plan = approved ?? (await this.plan({ scope: dirty.scope, hints: dirty.hints }));
		} catch (error) {
			// Anything but a failed listing is a local fault, and reporting it as offline
			// would send the user chasing their network.
			if (!(error instanceof RemoteUnavailableError)) {
				this.settle("idle");
				return this.finish(summarize("failed", { error: errorMessage(error) }));
			}
			const message = errorMessage(error);
			const attention = attentionFor(faultKind(error.cause));
			if (attention === "auth-error") {
				this.authFailure = message;
				this.settle(attention);
				return this.finish(summarize("blocked", { attention, error: message }));
			}
			// Offline, or a Remote Folder that would not resolve. Either way nothing was
			// planned, so nothing can be deleted — which is exactly why an unresolvable root
			// is `frozen` and never "everything was deleted there" (spec §5.7). The outcome is
			// the same story in both cases — the remote could not be read — so which one it was
			// travels on `attention`.
			const unread = attention ?? "offline";
			this.settle(unread);
			this.retryLater(dirty);
			return this.finish(summarize("offline", { attention: unread, error: message }));
		}

		// Everything the Shadow Store held for this state before the Run; whatever no
		// record names by the end of it is garbage (spec §3.4).
		const ancestorsBefore = referencedHashes(this.state);
		let report: ExecutionReport;
		try {
			report = await executePlan({
				vault: this.options.vault,
				remote: this.options.remote,
				store: this.options.store,
				shadow: this.shadow,
				state: this.state,
				hash: this.hash,
				constants: this.constants,
				timers: this.timers,
				deviceName: this.options.deviceName ?? DEFAULT_DEVICE_NAME,
				plan,
			});
		} catch (error) {
			// Only a failing state flush reaches here — per-operation faults are caught
			// inside the phases. The in-memory state may now be ahead of the stored one, so
			// the next Run has to re-persist it; every operation is redo-safe either way.
			this.unpersisted = true;
			this.settle("idle");
			return this.finish(summarize("failed", { error: errorMessage(error) }));
		}
		// `executePlan` flushes at its phase boundaries, so a Run that changed records has
		// already persisted them; this covers the Re-Bootstrap that changed none.
		if (this.unpersisted && !report.stateChanged) {
			await flushState(this.options.store, this.state);
		}
		this.unpersisted = false;
		// Mark and sweep, after the records that keep an Ancestor alive are final.
		await this.shadow.sweep(referencedHashes(this.state), ancestorsBefore);

		// A fault that stopped the Run part-way says what state to show; a `quota` that only
		// stopped its uploads says so too, since downloads and deletes kept flowing.
		if (report.abort?.attention === "auth-error") this.authFailure = report.abort.message;
		const attention = report.abort?.attention ?? (report.quotaBlocked ? "quota" : null);
		this.settle(attention ?? "idle");

		// An auth freeze queues nothing and ticks nothing: `credentialsRestored` comes back
		// with a FULL Reconcile, which subsumes every path this Run did not finish.
		if (this.authFailure === null) {
			// A path the re-stat guard skipped is not a failure — it is work the next Run has
			// to do, so it goes straight back into the Dirty Set (spec §5.5). The manifest a
			// conflict just wrote rides along: it is an ordinary local write that has to sync.
			// Deferred paths join them, but behind a backoff rung: they failed against a remote
			// that would only fail again two seconds later.
			const next = [...report.requeue, ...report.followUp, ...report.deferred];
			if (next.length > 0) void this.request("vault-event", pathScope(next));
			if (report.deferred.length > 0) this.holdOff();
			else this.backoffStep = 0;
		}

		// A resolved Conflict is work completed, not work outstanding: `partial` is for
		// paths this Run could not finish.
		const clean =
			report.failures.length === 0 &&
			report.skips.length === 0 &&
			report.requeue.length === 0 &&
			report.deferred.length === 0;
		return this.finish(
			summarize(clean ? "ok" : "partial", {
				uploaded: report.uploaded,
				downloaded: report.downloaded,
				identical: report.identical,
				moved: report.moved,
				deleted: report.deleted,
				merged: report.merged,
				conflicts: report.conflicts,
				manifestWritten: report.manifestWritten,
				requeued: report.requeue.length + report.deferred.length,
				skips: report.skips,
				failures: report.failures,
				attention,
				...(report.abort ? { error: report.abort.message } : {}),
			}),
		);
	}

	/**
	 * The Status Surface after a Run (spec §5.7). Derived, not latched: a Run that lists,
	 * transfers and finishes clean *is* the recovery from `offline` and from `quota`. Only
	 * the auth freeze outlives its Run, because only a re-login can lift it.
	 */
	private settle(status: EngineStatus): void {
		this.status.set(this.authFailure !== null ? "auth-error" : status);
	}

	/** Puts a Run that could not be planned back, to be tried again down the ladder. */
	private retryLater(dirty: DirtySet): void {
		this.scheduler.requeue(dirty);
		this.holdOff();
	}

	/**
	 * Arms the next rung of the offline backoff — 10 s → 30 s → 1 m → cap 5 m (spec §5.9).
	 *
	 * Spec §5.7 puts the boundary precisely: the ladder "ticks only while failed work is
	 * pending — not the rejected periodic poll". Both callers have just requeued some, which
	 * is why this is a retry rather than the interval §4 turned down: an idle, healthy Obsen
	 * arms nothing at all.
	 */
	private holdOff(): void {
		const ladder = this.constants.offlineBackoffMs;
		const rung = ladder[Math.min(this.backoffStep, ladder.length - 1)] ?? 0;
		this.backoffStep += 1;
		this.scheduler.holdFor(rung);
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
