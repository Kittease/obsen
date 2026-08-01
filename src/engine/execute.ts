import {
	appendConflictRows,
	CONFLICT_MANIFEST_PATH,
	conflictCopyPath,
	type ConflictRow,
} from "./conflict";
import type { EngineConstants } from "./constants";
import { errorMessage } from "./errors";
import type { Hasher } from "./hash";
import { mergeText } from "./merge";
import { isMergeable } from "./paths";
import type { RemotePort, Stat, StorePort, VaultPort } from "./ports";
import type { OpOf, Operation, Plan } from "./plan";
import type { ShadowStore } from "./shadow";
import { flushState, type FileRecord, type SyncState } from "./state";
import type { OpFailure } from "./status";
import { decodeUtf8, encodeUtf8 } from "./text";
import type { Timers } from "./timers";

/**
 * The Run's execution half (spec §5.4–5.6): five sequential phases over an
 * already-computed plan.
 *
 * folder creates → moves/renames → content transfers → file deletes → emptied-folder
 * deletes. **Deletes last**, so a crash leaves extra files rather than a removed file
 * whose replacement never arrived. Conflicts resolve inside the transfer phase: a
 * Three-Way Merge where the Ancestor allows it, a Conflict Copy where it does not, and
 * either way both versions survive.
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
	/** Where Ancestors come from, and where this Run records the ones it creates. */
	shadow: ShadowStore;
	/** Mutated in place; flushed at phase boundaries and every ~5 s during transfers. */
	state: SyncState;
	hash: Hasher;
	constants: EngineConstants;
	timers: Timers;
	/** Names the Conflict Copies this device creates (spec §6.1). */
	deviceName: string;
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
	/** Three-Way Merges that came out clean and were written to both sides. */
	merged: number;
	/** Conflict Copies created — the number of rows this Run added to the manifest. */
	conflicts: number;
	/** Whether those rows actually reached `conflicts.md`; the shell opens it if so. */
	manifestWritten: boolean;
	skipped: number;
	/** Paths the re-stat guard refused to touch; the engine re-dirties them. */
	requeue: string[];
	/** Files this Run wrote locally that still have to be pushed — the manifest. */
	followUp: string[];
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
		merged: 0,
		conflicts: 0,
		manifestWritten: false,
		skipped: 0,
		requeue: [],
		followUp: [],
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

	// Phase 3 — content. A pair that converged with no transfer still needs its Ancestor
	// on record, or the first time those two devices diverge there is nothing to merge
	// against. It is the one read-shaped thing here, so it runs at transfer concurrency:
	// a First Link converges thousands of files at once.
	const converged = operations(input.plan, "converge");
	await inParallel(
		converged.filter((operation) => operation.record.mergeable),
		input.constants.transferConcurrency,
		(operation) => rememberConverged(operation, input),
	);

	// Then the record-only outcomes: nothing can fail halfway, and the flush that
	// follows commits them before any transfer starts.
	let recordUpdates = 0;
	for (const operation of converged) {
		input.state.files.set(operation.path, operation.record);
		report.identical += 1;
		recordUpdates += 1;
	}
	for (const operation of operations(input.plan, "forget")) {
		if (input.state.files.delete(operation.path)) recordUpdates += 1;
	}
	if (recordUpdates > 0) await flush();

	const transfers = input.plan.operations.filter(
		(operation): operation is OpOf<"upload" | "download" | "conflict"> =>
			operation.kind === "upload" ||
			operation.kind === "download" ||
			operation.kind === "conflict",
	);
	const copies = new ConflictCopies(input);
	// Every outcome the batch can produce writes a record, so this tally is also the
	// answer to "is there anything to flush?" — including a Conflict that turned out to
	// be a convergence, which moves no bytes but very much moves a record.
	const recorded = (): number =>
		report.uploaded + report.downloaded + report.merged + report.conflicts + report.identical;
	const recordedBefore = recorded();
	let done = 0;
	await inParallel(transfers, input.constants.transferConcurrency, async (operation) => {
		await attempt(operation.path, report, () =>
			operation.kind === "conflict"
				? resolve(operation, input, report, copies)
				: transfer(operation, input, report),
		);
		done += 1;
		input.onProgress?.({ done, total: transfers.length });
		// A long transfer phase must not hold every record hostage: flushing as it goes
		// is what keeps a crash halfway through it cheap to redo.
		if (input.timers.now() - lastFlush >= input.constants.stateFlushIntervalMs) await flush();
	});
	// The manifest is written once, after every copy this Run makes is on disk — so a
	// conflict on `conflicts.md` itself resolves first and its rows land on the winner.
	await attempt(CONFLICT_MANIFEST_PATH, report, () => copies.writeManifest(report));
	if (recorded() > recordedBefore) await flush();

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

	// Skips are decided at planning time, so they come straight from the plan.
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
	const { vault, remote, hash } = input;

	if (operation.kind === "upload") {
		const data = await vault.read(operation.path);
		const contentHash = await hash(data);
		const { uuid } = await remote.upload(operation.path, data);
		await commit(input, operation.path, {
			data,
			hash: contentHash,
			// Deliberately the stat taken *before* the read: if the file changed while
			// we were reading it, that older mtime makes the next Run re-hash instead of
			// trusting the record. A fresher stat could hide a real edit.
			mtime: operation.stat.mtime,
			uuid,
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
	await commit(input, operation.path, {
		data,
		hash: contentHash,
		mtime: stat.mtime,
		uuid: operation.uuid,
	});
	report.downloaded += 1;
}

/**
 * Resolves one Conflict (spec §6): a clean Three-Way Merge where the Ancestor and both
 * versions allow it, a Conflict Copy where they do not. Never last-writer-wins, and
 * never a prompt — by the time this returns, both versions exist on both sides.
 */
async function resolve(
	operation: OpOf<"conflict">,
	input: ExecuteInput,
	report: ExecutionReport,
	copies: ConflictCopies,
): Promise<void> {
	const { vault, remote, hash, constants } = input;
	const { path, entry } = operation;
	const mergeable = isMergeable(path, constants);

	const incoming = await remote.download(entry.uuid);
	const incomingHash = await hash(incoming);
	if (entry.hash !== undefined && entry.hash !== incomingHash) {
		throw new Error("downloaded content does not match the hash Filen recorded");
	}
	// The re-stat guard (spec §5.5): a file edited since classification is a version
	// nobody has looked at, and resolving against the stale one would bury it.
	if (await changedSince(vault, path, operation.stat)) {
		report.requeue.push(path);
		return;
	}
	const mine = await vault.read(path);
	const mineHash = await hash(mine);

	if (mineHash === incomingHash) {
		// The planner could not prove the two sides matched — an older Filen client
		// records no plaintext hash — but the bytes it had to fetch anyway just did.
		await commit(input, path, {
			data: mine,
			hash: mineHash,
			mtime: operation.stat.mtime,
			uuid: entry.uuid,
		});
		report.identical += 1;
		return;
	}

	const merged = mergeable ? await threeWayMerge(operation, input, mine, incoming) : null;
	if (merged !== null) {
		const mergedHash = await hash(merged);
		const stat = await vault.write(path, merged);
		const { uuid } = await remote.upload(path, merged);
		await commit(input, path, { data: merged, hash: mergedHash, mtime: stat.mtime, uuid });
		report.merged += 1;
		return;
	}

	// No safe merge: the incoming version becomes the Conflict Copy and the local one
	// keeps the original path (spec §6.1). The copy is written *first*, so a failure
	// half way through can only ever leave an extra file behind.
	const copyPath = await copies.reserve(path);
	if (!vault.isWritablePath(copyPath)) {
		throw new Error(`this platform cannot create the Conflict Copy name ${copyPath}`);
	}
	const copyStat = await vault.write(copyPath, incoming);
	// Counted and listed the moment the copy exists on disk, before anything that could
	// still fail: a copy the manifest never mentions would be exactly the silent
	// conflict spec §6.2 exists to prevent.
	copies.record(path, copyPath);
	report.conflicts += 1;

	const copy = await remote.upload(copyPath, incoming);
	await commit(input, copyPath, {
		data: incoming,
		hash: incomingHash,
		mtime: copyStat.mtime,
		uuid: copy.uuid,
	});

	const { uuid } = await remote.upload(path, mine);
	await commit(input, path, {
		data: mine,
		hash: mineHash,
		mtime: operation.stat.mtime,
		uuid,
	});
}

/** The merged bytes, or `null` for every reason a merge must not be attempted. */
async function threeWayMerge(
	operation: OpOf<"conflict">,
	input: ExecuteInput,
	mine: Uint8Array,
	incoming: Uint8Array,
): Promise<Uint8Array | null> {
	// No record means no Ancestor (First Link, Re-Bootstrap): a Conflict Copy is the
	// only honest answer, since there is nothing to tell the two versions apart against.
	if (!operation.record?.mergeable) return null;
	const ancestor = await input.shadow.read(operation.record.lastSyncedHash);
	if (ancestor === null) return null;

	const base = decodeUtf8(ancestor);
	const local = decodeUtf8(mine);
	const remote = decodeUtf8(incoming);
	// A `.md` file holding something that is not UTF-8 is not text, whatever it is
	// called, and line-wise merging would corrupt it.
	if (base === null || local === null || remote === null) return null;

	const merged = mergeText(base, local, remote);
	return merged.clean ? encodeUtf8(merged.text) : null;
}

/**
 * Files the Conflict Copies of one Run, and writes their rows into the manifest.
 *
 * Naming has to dodge every path either side already holds *and* the copies this Run
 * has already promised: a name free in the vault but taken on Filen would upload
 * straight over a file this device has never seen.
 */
class ConflictCopies {
	private readonly reserved = new Set<string>();
	private readonly rows: ConflictRow[] = [];

	constructor(private readonly input: ExecuteInput) {}

	async reserve(path: string): Promise<string> {
		const name = (): string =>
			conflictCopyPath(path, {
				at: this.input.timers.now(),
				device: this.input.deviceName,
				taken: (candidate) =>
					this.reserved.has(candidate) || this.input.plan.remotePaths.has(candidate),
			});
		let candidate = name();
		// The vault has no listing here — a scoped Run never scanned it — so local
		// collisions are probed one name at a time.
		while ((await this.input.vault.stat(candidate)) !== null) {
			this.reserved.add(candidate);
			candidate = name();
		}
		this.reserved.add(candidate);
		return candidate;
	}

	record(original: string, copy: string): void {
		this.rows.push({ original, copy });
	}

	/**
	 * Appends this Run's rows to `conflicts.md`, creating it with the header when it is
	 * missing — the user may delete it or clear it at any time, and Obsen brings it back
	 * rather than arguing (spec §6.2).
	 */
	async writeManifest(report: ExecutionReport): Promise<void> {
		if (this.rows.length === 0) return;
		const { vault } = this.input;

		let existing: string | null = null;
		if ((await vault.stat(CONFLICT_MANIFEST_PATH)) !== null) {
			existing = decodeUtf8(await vault.read(CONFLICT_MANIFEST_PATH));
			// Obsen only ever writes UTF-8 here. Something else did, and replacing it
			// would destroy it — the copies themselves are already safely on disk.
			if (existing === null) throw new Error("conflicts.md is not a text file");
		}

		// Sorted, not in completion order: phase 3 runs four at a time, so appending as
		// they land would make the same Run write different files on different devices —
		// and this file syncs, where an arbitrary order is one more thing to merge.
		const rows = [...this.rows].sort(
			(a, b) => a.original.localeCompare(b.original) || a.copy.localeCompare(b.copy),
		);
		await vault.write(CONFLICT_MANIFEST_PATH, encodeUtf8(appendConflictRows(existing, rows)));
		report.manifestWritten = true;
		// A local write like any other: the next Run pushes it.
		report.followUp.push(CONFLICT_MANIFEST_PATH);
	}
}

/** One synced file, as the side that just moved its bytes knows it. */
type Synced = { data: Uint8Array; hash: string; mtime: number; uuid: string };

/**
 * Records a file both sides now agree on: **Ancestor first, then the record naming its
 * hash** — spec §3.4's write-ordering invariant, in the one place every outcome of a
 * transfer or a Conflict passes through. A crash between the two leaves an orphan blob;
 * the other order would leave a record pointing at an Ancestor that was never stored.
 */
async function commit(input: ExecuteInput, path: string, synced: Synced): Promise<void> {
	const mergeable = isMergeable(path, input.constants);
	if (mergeable) await remember(input, synced.hash, synced.data);
	input.state.files.set(path, {
		lastSyncedHash: synced.hash,
		size: synced.data.length,
		localMtime: synced.mtime,
		remoteUuid: synced.uuid,
		mergeable,
	});
}

/**
 * Files content as the Ancestor for the next divergence — Mergeable content only
 * (spec §3.4).
 *
 * Best effort by design: a missing Ancestor costs a future Conflict Copy, never
 * content, so a Shadow Store that cannot be written must not fail the transfer that
 * has already happened.
 */
async function remember(input: ExecuteInput, contentHash: string, data: Uint8Array): Promise<void> {
	try {
		await input.shadow.write(contentHash, data);
	} catch {
		// Ancestors are an optimization; the next conflict simply becomes a copy.
	}
}

/**
 * The Ancestor for a pair that converged with no transfer, read back from the vault —
 * but only when the Shadow Store does not already hold a *sound* entry, so a corrupt
 * one is healed here rather than conflict-copying forever.
 */
async function rememberConverged(operation: OpOf<"converge">, input: ExecuteInput): Promise<void> {
	const { lastSyncedHash } = operation.record;
	try {
		if ((await input.shadow.read(lastSyncedHash)) !== null) return;
		const data = await input.vault.read(operation.path);
		// Store only what the record actually claims: a file edited since classification
		// would otherwise be filed under content it no longer holds.
		if ((await input.hash(data)) === lastSyncedHash) await remember(input, lastSyncedHash, data);
	} catch {
		// Same bargain as {@link remember}.
	}
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
