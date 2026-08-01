import type { EngineConstants } from "./constants";
import type { Timers } from "./timers";
import { mergeScopes, type RenameHint, type RunScope, type RunTrigger } from "./triggers";

/**
 * The single-flight scheduler (spec §4).
 *
 * At most one Run executes. A request carries a scope; requests arriving mid-Run
 * merge into a pending scope (union, FULL absorbs) that becomes the *next* Run —
 * the executing plan is never mutated, which is the fix for the interleaved-runs
 * race the ticket-019 spike hit on a real phone.
 *
 * Admission is derived from the scope rather than from the trigger: FULL means "a
 * correctness backstop is asking", so it runs immediately, while path scopes — only
 * ever vault and socket events — take the 2 s trailing debounce with a 15 s
 * max-wait cap so continuous typing cannot starve pushes.
 *
 * Generic over the Run's result so it stays free of engine types; the engine
 * instantiates it with its run summary.
 */

export type RunRequest = {
	trigger: RunTrigger;
	scope: RunScope;
	hints?: readonly RenameHint[];
	/**
	 * Lifts an offline backoff instead of waiting it out (spec §5.7). The caller decides:
	 * the ladder is there to absorb event bursts, so only a correctness backstop or an
	 * explicit user action is entitled to skip it.
	 */
	cutThrough?: boolean;
};

/**
 * The **Dirty Set** (CONTEXT.md): the pending scope awaiting the next Run — paths
 * marked by triggers plus their Rename Hints. The Run snapshots and clears it
 * (spec §5.1 step 1), so what the runner receives is a set that is no longer pending.
 */
export type DirtySet = {
	/**
	 * Every trigger that merged in, in arrival order and each named once — coalescing is
	 * real, so one label would lie, and a Run requeued down the backoff ladder would
	 * otherwise repeat itself for as long as the remote stayed down.
	 */
	triggers: RunTrigger[];
	scope: RunScope;
	hints: RenameHint[];
};

export type SchedulerOptions<R> = {
	/** Executes one Run. May reject; the rejection reaches that Run's requesters. */
	run: (dirty: DirtySet) => Promise<R>;
	timers: Timers;
	constants: EngineConstants;
};

type Deferred<R> = {
	promise: Promise<R>;
	resolve: (value: R) => void;
	reject: (error: unknown) => void;
};

export class RunScheduler<R> {
	private dirty: (DirtySet & { waiters: Deferred<R>[] }) | null = null;
	/** Whether the pending scope may start now — set by FULL requests and by an expired debounce. */
	private due = false;
	private cancelDebounce: (() => void) | null = null;
	private debounceDeadline: number | null = null;
	/** The armed offline backoff, if any — see {@link holdFor}. */
	private cancelHold: (() => void) | null = null;
	private running: Promise<void> | null = null;
	private idleWaiters: (() => void)[] = [];
	private disposed = false;

	constructor(private readonly options: SchedulerOptions<R>) {}

	/** Whether a Run is executing right now. */
	get isRunning(): boolean {
		return this.running !== null;
	}

	/** Whether work is waiting for a Run — a Dirty Set, debounced or admissible. */
	get hasPending(): boolean {
		return this.dirty !== null;
	}

	/**
	 * Marks a scope dirty and asks for a Run; resolves with the summary of the Run
	 * that serves this request. Fire-and-forget callers may ignore the promise: a
	 * rejection is pre-handled internally, so it never surfaces as an unhandled one.
	 */
	request(request: RunRequest): Promise<R> {
		const waiter = deferred<R>();
		if (this.disposed) {
			waiter.reject(new Error("Obsen: sync engine stopped"));
			return waiter.promise;
		}

		this.enqueue({ triggers: [request.trigger], ...request }, waiter);

		if (request.scope.kind === "full") {
			// A FULL request cuts through any waiting debounce and absorbs its paths.
			this.clearDebounce();
			this.due = true;
		} else if (!this.due) {
			this.armDebounce();
		}
		if (request.cutThrough === true) this.release();

		this.tryStart();
		return waiter.promise;
	}

	/**
	 * Puts a Run's own Dirty Set back — the offline retry (spec §5.7). No waiter: the Run
	 * that produced it has already reported its outcome to everyone who asked, and this is
	 * the engine deciding the work is still owed rather than a new caller asking for it.
	 */
	requeue(dirty: DirtySet): void {
		if (this.disposed) return;
		this.enqueue(dirty, null);
		// Already admitted once, so it does not queue behind a fresh debounce; what holds
		// it now is the backoff.
		this.due = true;
	}

	/** Whether a backoff is holding the next Run off. */
	get held(): boolean {
		return this.cancelHold !== null;
	}

	/**
	 * Holds the next Run off for `ms` (spec §5.7). Requests keep coalescing into the Dirty
	 * Set meanwhile and do **not** re-arm it — absorbing a burst without restarting the
	 * ladder is the whole point — so only {@link release} and the next expiry end it.
	 */
	holdFor(ms: number): void {
		if (this.disposed) return;
		this.release();
		this.cancelHold = this.options.timers.after(ms, () => {
			this.cancelHold = null;
			this.tryStart();
		});
	}

	/** Lifts a hold now: what a cut-through request does. Safe when nothing is held. */
	release(): void {
		this.cancelHold?.();
		this.cancelHold = null;
	}

	/** Resolves when no Run is executing and nothing is pending. */
	idle(): Promise<void> {
		if (this.isSettled()) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	/**
	 * Cancels timers and fails anything still pending; requests after this are refused.
	 * A Run already executing is not cancellable — it finishes, and `idle()` still
	 * resolves when it does rather than the moment this is called.
	 */
	dispose(): void {
		this.disposed = true;
		this.clearDebounce();
		this.release();
		const dirty = this.dirty;
		this.dirty = null;
		this.due = false;
		for (const waiter of dirty?.waiters ?? []) {
			waiter.reject(new Error("Obsen: sync engine stopped"));
		}
		this.notifyIdle();
	}

	/** Merges one request into the pending Dirty Set: union of scopes, hints and triggers. */
	private enqueue(
		request: { triggers: readonly RunTrigger[]; scope: RunScope; hints?: readonly RenameHint[] },
		waiter: Deferred<R> | null,
	): void {
		const dirty = this.dirty ?? { triggers: [], scope: request.scope, hints: [], waiters: [] };
		dirty.scope = this.dirty ? mergeScopes(dirty.scope, request.scope) : request.scope;
		for (const trigger of request.triggers) {
			if (!dirty.triggers.includes(trigger)) dirty.triggers.push(trigger);
		}
		for (const hint of request.hints ?? []) {
			const known = dirty.hints.some((h) => h.from === hint.from && h.to === hint.to);
			if (!known) dirty.hints.push({ ...hint });
		}
		if (waiter) dirty.waiters.push(waiter);
		this.dirty = dirty;
	}

	private armDebounce(): void {
		const { eventDebounceMs, eventMaxWaitMs } = this.options.constants;
		const now = this.options.timers.now();
		// The cap is set by the *first* event of the burst, so re-arming the trailing
		// debounce can postpone the Run only up to it.
		this.debounceDeadline ??= now + eventMaxWaitMs;
		const wait = Math.max(0, Math.min(eventDebounceMs, this.debounceDeadline - now));

		this.cancelDebounce?.();
		this.cancelDebounce = this.options.timers.after(wait, () => {
			this.cancelDebounce = null;
			this.debounceDeadline = null;
			this.due = true;
			this.tryStart();
		});
	}

	private clearDebounce(): void {
		this.cancelDebounce?.();
		this.cancelDebounce = null;
		this.debounceDeadline = null;
	}

	private tryStart(): void {
		if (this.disposed || this.running || !this.dirty || !this.due || this.held) return;

		// Snapshot-and-clear (spec §5.1 step 1): anything arriving from here on is the
		// next Run's problem, never a mutation of the plan this one is about to compute.
		const dirty = this.dirty;
		this.dirty = null;
		this.due = false;
		this.clearDebounce();

		const snapshot: DirtySet = {
			triggers: dirty.triggers,
			scope: dirty.scope,
			hints: dirty.hints,
		};
		// The Run is marked finished *before* its requesters are told, so a caller that
		// awaits a summary and then asks whether anything is still running gets the answer
		// that summary implies. The assignment lands first either way: the function below
		// only reaches its own body's tail after an `await`.
		this.running = (async () => {
			let result: R;
			try {
				result = await this.options.run(snapshot);
			} catch (error) {
				this.running = null;
				for (const waiter of dirty.waiters) waiter.reject(error);
				this.tryStart();
				this.notifyIdle();
				return;
			}
			this.running = null;
			for (const waiter of dirty.waiters) waiter.resolve(result);
			// Whatever arrived during the Run becomes the follow-up Run.
			this.tryStart();
			this.notifyIdle();
		})();
	}

	private isSettled(): boolean {
		return this.running === null && this.dirty === null;
	}

	private notifyIdle(): void {
		if (!this.isSettled()) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

function deferred<R>(): Deferred<R> {
	let resolve!: (value: R) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<R>((resolveFn, rejectFn) => {
		resolve = resolveFn;
		reject = rejectFn;
	});
	// Pre-handled so a caller that ignores the promise cannot produce an unhandled
	// rejection; an awaiting caller still sees the error.
	void promise.catch(() => undefined);
	return { promise, resolve, reject };
}
