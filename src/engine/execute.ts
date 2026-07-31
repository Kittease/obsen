import type { EngineConstants } from "./constants";
import { errorMessage } from "./errors";
import type { Hasher } from "./hash";
import { isMergeable } from "./paths";
import type { RemotePort, StorePort, VaultPort } from "./ports";
import type { Operation, Plan } from "./plan";
import { flushState, type SyncState } from "./state";
import type { OpFailure } from "./status";

/**
 * The Run's execution half (spec §5.4–5.5): five sequential phases over an
 * already-computed plan.
 *
 * folder creates → moves/renames → content transfers → file deletes → emptied-folder
 * deletes. **Deletes last**, so a crash leaves extra files rather than a removed file
 * whose replacement never arrived. Phases 2, 4 and 5 are empty until tickets 032 and
 * 033 land; their operations are counted as deferred, never silently dropped.
 *
 * Crash recovery rests on redo-safety rather than a journal (spec §5.5): every
 * operation here must stay correct when its state update is lost — an upload
 * re-uploads, a download converges on an equal hash — so a crashed Run is simply an
 * unfinished Run that the startup FULL Reconcile completes.
 */

export type ExecuteInput = {
	vault: VaultPort;
	remote: RemotePort;
	store: StorePort;
	/** Mutated in place; flushed at phase boundaries and at the end of the Run. */
	state: SyncState;
	hash: Hasher;
	constants: EngineConstants;
	plan: Plan;
	onProgress?: (progress: TransferProgress) => void;
};

export type TransferProgress = { done: number; total: number };

export type ExecutionReport = {
	/** Whether any record changed — the phase-boundary flushes already persisted it. */
	stateChanged: boolean;
	uploaded: number;
	downloaded: number;
	identical: number;
	conflicts: number;
	deferred: number;
	skipped: number;
	failures: OpFailure[];
};

type OpOf<K extends Operation["kind"]> = Extract<Operation, { kind: K }>;

export async function executePlan(input: ExecuteInput): Promise<ExecutionReport> {
	const report: ExecutionReport = {
		stateChanged: false,
		uploaded: 0,
		downloaded: 0,
		identical: 0,
		conflicts: 0,
		deferred: 0,
		skipped: 0,
		failures: [],
	};

	// Phase 1 — folders, parents first. Sequential: a transfer whose parent folder is
	// missing fails, so this is not a place to save milliseconds.
	for (const operation of operations(input.plan, "mkdir-remote")) {
		await attempt(operation.path, report, () => input.remote.mkdir(operation.path));
	}
	for (const operation of operations(input.plan, "mkdir-local")) {
		await attempt(operation.path, report, () => input.vault.mkdir(operation.path));
	}

	// Phase 2 — moves and renames: ticket 032.

	// Phase 3 — content. Record-only outcomes first: no I/O, so nothing can fail
	// halfway, and the flush that follows commits them before any transfer starts.
	let recordUpdates = 0;
	for (const operation of operations(input.plan, "converge")) {
		input.state.files.set(operation.path, operation.record);
		report.identical += 1;
		recordUpdates += 1;
	}
	for (const operation of operations(input.plan, "forget")) {
		if (input.state.files.delete(operation.path)) recordUpdates += 1;
	}
	if (recordUpdates > 0) {
		report.stateChanged = true;
		await flushState(input.store, input.state);
	}

	const transfers = input.plan.operations.filter(
		(operation): operation is OpOf<"upload" | "download"> =>
			operation.kind === "upload" || operation.kind === "download",
	);
	let done = 0;
	await inParallel(transfers, input.constants.transferConcurrency, async (operation) => {
		await attempt(operation.path, report, () => transfer(operation, input, report));
		done += 1;
		input.onProgress?.({ done, total: transfers.length });
	});
	// The ~5 s flush cadence *during* transfers arrives with ticket 032, alongside the
	// crash-interruption tests that give it teeth; a phase-boundary flush is enough
	// while every operation in a Run is individually redo-safe.
	if (report.uploaded + report.downloaded > 0) {
		report.stateChanged = true;
		await flushState(input.store, input.state);
	}

	// Phase 4 — file deletes (Soft Delete) — and phase 5 — emptied folders: ticket 032.

	// What no phase could act on, straight from the plan rather than tallied twice.
	report.conflicts = input.plan.counts.conflict;
	report.deferred = input.plan.counts.deferred;
	report.skipped = input.plan.counts.skipped;
	return report;
}

async function transfer(
	operation: OpOf<"upload" | "download">,
	input: ExecuteInput,
	report: ExecutionReport,
): Promise<void> {
	const { vault, remote, state, hash, constants } = input;

	if (operation.kind === "upload") {
		const data = await vault.read(operation.path);
		const contentHash = await hash(data);
		const { uuid } = await remote.upload(operation.path, data);
		state.files.set(operation.path, {
			lastSyncedHash: contentHash,
			size: data.length,
			// Deliberately the stat taken *before* the read: if the file changed while
			// we were reading it, that older mtime makes the next Run re-hash instead of
			// trusting the record. A fresher stat could hide a real edit.
			localMtime: operation.stat.mtime,
			remoteUuid: uuid,
			mergeable: isMergeable(operation.path, constants),
		});
		report.uploaded += 1;
		return;
	}

	const data = await remote.download(operation.uuid);
	const contentHash = await hash(data);
	if (operation.expectedHash !== null && operation.expectedHash !== contentHash) {
		// Filen recorded a different plaintext hash for these bytes: something is wrong
		// with the transfer, and writing them would launder the damage into the vault.
		throw new Error("downloaded content does not match the hash Filen recorded");
	}
	// The re-stat guard that keeps a locally-modified file from being clobbered here is
	// ticket 032's, alongside the deletion cells it belongs beside.
	const stat = await vault.write(operation.path, data);
	state.files.set(operation.path, {
		lastSyncedHash: contentHash,
		size: data.length,
		localMtime: stat.mtime,
		remoteUuid: operation.uuid,
		mergeable: isMergeable(operation.path, constants),
	});
	report.downloaded += 1;
}

function operations<K extends Operation["kind"]>(plan: Plan, kind: K): OpOf<K>[] {
	return plan.operations.filter((operation): operation is OpOf<K> => operation.kind === kind);
}

/**
 * Runs one operation, keeping a single bad file from blocking the vault (spec §5.7).
 * Retries and requeueing into the pending scope arrive with ticket 036; until then a
 * failure is reported and the path waits for the next FULL Reconcile — startup or
 * Foreground-Resume — since nothing re-dirties it.
 */
async function attempt(
	path: string,
	report: ExecutionReport,
	operation: () => Promise<void>,
): Promise<void> {
	try {
		await operation();
	} catch (error) {
		report.failures.push({ path, message: errorMessage(error) });
	}
}

/** Bounded-concurrency map; the operations are independent, so order is irrelevant. */
async function inParallel<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (let index = next++; index < items.length; index = next++) {
			await worker(items[index]!);
		}
	});
	await Promise.all(lanes);
}
