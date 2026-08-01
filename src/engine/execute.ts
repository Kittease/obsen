import type { EngineConstants } from "./constants";
import { errorMessage } from "./errors";
import type { Hasher } from "./hash";
import { isMergeable } from "./paths";
import type { RemotePort, Stat, StorePort, VaultPort } from "./ports";
import type { OpOf, Operation, Plan } from "./plan";
import { flushState, type FileRecord, type SyncState } from "./state";
import type { OpFailure } from "./status";
import type { Timers } from "./timers";

/**
 * The Run's execution half (spec §5.4–5.5): five sequential phases over an
 * already-computed plan.
 *
 * folder creates → moves/renames → content transfers → file deletes → emptied-folder
 * deletes. **Deletes last**, so a crash leaves extra files rather than a removed file
 * whose replacement never arrived. Only the conflict cells are still unexecutable
 * (ticket 033); they are counted, never silently dropped.
 *
 * Crash recovery rests on redo-safety rather than a journal (spec §5.5): every
 * operation here must stay correct when its state update is lost — an upload
 * re-uploads, a download converges on an equal hash, a delete becomes both-missing, a
 * move re-pairs — so a crashed Run is simply an unfinished Run that the startup FULL
 * Reconcile completes.
 */

export type ExecuteInput = {
	vault: VaultPort;
	remote: RemotePort;
	store: StorePort;
	/** Mutated in place; flushed at phase boundaries and every ~5 s during transfers. */
	state: SyncState;
	hash: Hasher;
	constants: EngineConstants;
	timers: Timers;
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
	moved: number;
	deleted: number;
	conflicts: number;
	skipped: number;
	/** Paths the re-stat guard refused to touch; the engine re-dirties them. */
	requeue: string[];
	failures: OpFailure[];
};

export async function executePlan(input: ExecuteInput): Promise<ExecutionReport> {
	const report: ExecutionReport = {
		stateChanged: false,
		uploaded: 0,
		downloaded: 0,
		identical: 0,
		moved: 0,
		deleted: 0,
		conflicts: 0,
		skipped: 0,
		requeue: [],
		failures: [],
	};
	let lastFlush = input.timers.now();
	const flush = async (): Promise<void> => {
		report.stateChanged = true;
		await flushState(input.store, input.state);
		lastFlush = input.timers.now();
	};

	// Phase 1 — folders, parents first. Sequential: a transfer whose parent folder is
	// missing fails, so this is not a place to save milliseconds.
	for (const operation of operations(input.plan, "mkdir-remote")) {
		await attempt(operation.path, report, () => input.remote.mkdir(operation.path));
	}
	for (const operation of operations(input.plan, "mkdir-local")) {
		await attempt(operation.path, report, () => input.vault.mkdir(operation.path));
	}

	// Phase 2 — moves and renames. Each op performs its port call *then* rekeys, so a
	// failed move leaves the old record and the next Run simply pairs it again.
	for (const operation of operations(input.plan, "move-folder")) {
		await attempt(operation.to, report, async () => {
			await input.remote.moveFolder(operation.from, operation.to);
			for (const file of operation.files) rekey(input.state, file.from, file.to, file.record);
			report.moved += operation.files.length;
		});
	}
	for (const operation of operations(input.plan, "move")) {
		await attempt(operation.to, report, () => move(operation, input, report));
	}
	if (report.moved > 0) await flush();

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
	if (recordUpdates > 0) await flush();

	const transfers = input.plan.operations.filter(
		(operation): operation is OpOf<"upload" | "download"> =>
			operation.kind === "upload" || operation.kind === "download",
	);
	let done = 0;
	await inParallel(transfers, input.constants.transferConcurrency, async (operation) => {
		await attempt(operation.path, report, () => transfer(operation, input, report));
		done += 1;
		input.onProgress?.({ done, total: transfers.length });
		// A long transfer phase must not hold every record hostage: flushing as it goes
		// is what keeps a crash halfway through it cheap to redo.
		if (input.timers.now() - lastFlush >= input.constants.stateFlushIntervalMs) await flush();
	});
	if (report.uploaded + report.downloaded > 0) await flush();

	// Phase 4 — file deletes, soft on both sides (spec §5.2, ticket 007).
	for (const operation of operations(input.plan, "trash-remote")) {
		await attempt(operation.path, report, async () => {
			await input.remote.trashFile(operation.uuid);
			input.state.files.delete(operation.path);
			report.deleted += 1;
		});
	}
	for (const operation of operations(input.plan, "trash-local")) {
		await attempt(operation.path, report, async () => {
			// The re-stat guard (spec §5.5): an edit that landed since classification is a
			// change no one has merged, and trashing it would destroy it outright.
			if (await changedSince(input.vault, operation.path, operation.stat)) {
				report.requeue.push(operation.path);
				return;
			}
			await input.vault.trash(operation.path);
			input.state.files.delete(operation.path);
			report.deleted += 1;
		});
	}
	if (report.deleted > 0) await flush();

	// Phase 5 — the folders those deletes emptied. No records are involved: Obsen keeps
	// none for folders, which is why an empty folder simply stops existing.
	for (const operation of operations(input.plan, "trash-folder-remote")) {
		await attempt(operation.path, report, () => input.remote.trashFolder(operation.path));
	}
	for (const operation of operations(input.plan, "trash-folder-local")) {
		await attempt(operation.path, report, () => input.vault.trashFolder(operation.path));
	}

	// What no phase could act on, straight from the plan rather than tallied twice.
	report.conflicts = input.plan.counts.conflict;
	report.skipped = input.plan.counts.skipped;
	return report;
}

/** One paired rename: catch the lagging side up, then move the record onto the new path. */
async function move(
	operation: OpOf<"move">,
	input: ExecuteInput,
	report: ExecutionReport,
): Promise<void> {
	if (operation.move?.side === "local") {
		// Something arrived at the destination since planning: renaming over it would
		// destroy it, so the pairing is abandoned and both paths go back in the queue.
		if ((await input.vault.stat(operation.to)) !== null) {
			report.requeue.push(operation.from, operation.to);
			return;
		}
		await input.vault.rename(operation.from, operation.to);
	} else if (operation.move?.side === "remote") {
		await input.remote.move(operation.move.uuid, operation.to);
	}
	rekey(input.state, operation.from, operation.to, operation.record);
	report.moved += 1;
}

function rekey(state: SyncState, from: string, to: string, record: FileRecord): void {
	state.files.delete(from);
	state.files.set(to, record);
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
	// The re-stat guard (spec §5.5). Downloads are where it matters most: the bytes were
	// in flight while the user had the file open, and the next Run merges or conflicts
	// instead of this one clobbering.
	if (await changedSince(vault, operation.path, operation.stat)) {
		report.requeue.push(operation.path);
		return;
	}
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

/** Whether the vault's copy of `path` differs from what classification saw. */
async function changedSince(
	vault: VaultPort,
	path: string,
	before: Stat | null,
): Promise<boolean> {
	const now = await vault.stat(path);
	if (now === null || before === null) return now !== before;
	return now.size !== before.size || now.mtime !== before.mtime;
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
