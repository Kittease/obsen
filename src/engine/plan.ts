import type { EngineConstants } from "./constants";
import { errorMessage } from "./errors";
import type { Hasher } from "./hash";
import { ancestorPaths, isMergeable, parentPath, pathDepth } from "./paths";
import type { RemoteEntry, RemotePort, Stat, VaultPort } from "./ports";
import {
	hasContentRenameSources,
	pairByContent,
	pairByIdentity,
	type FolderPairing,
	type MoveAction,
	type Pairing,
	type RenameTier,
	type RenameWorld,
} from "./rename";
import type { SyncScope } from "./scope";
import type { FileRecord, SyncState } from "./state";
import type { SkipReason } from "./status";
import type { RenameHint, RunScope } from "./triggers";

/**
 * The Run's planning half (spec §5.1–5.3): observe both sides, pair renames, classify
 * every in-scope path against its record, and produce the operation plan. **Nothing is
 * executed here** — that separation is what makes the First Link dry-run preview a
 * real preview rather than a second code path (spec §8.4).
 *
 * The conflict cells plan a `conflict` operation rather than deciding between a merge
 * and a Conflict Copy: that choice needs the Ancestor and both sides' bytes, which is
 * the executor's business (spec §6). The planner's job is to say *which* paths cannot
 * converge on their own — which is exactly what the First-Link preview lists.
 */

/** How one side compares to the record. `added` only occurs where no record exists. */
export type SideChange = "unchanged" | "modified" | "added" | "missing";

/** What a path looks like on both sides, plus the record it is judged against. */
export type Observation = {
	path: string;
	record: FileRecord | null;
	stat: Stat | null;
	/** Local content hash — present whenever classification needed one. */
	hash: string | null;
	entry: RemoteEntry | null;
	local: SideChange;
	remote: SideChange;
};

export type Operation =
	| { kind: "mkdir-remote"; path: string }
	| { kind: "mkdir-local"; path: string }
	/** A paired rename: the record moves, and at most one side has to catch up. */
	| { kind: "move"; from: string; to: string; record: FileRecord; move: MoveAction | null; tier: RenameTier }
	/** One remote `moveFolder`, rekeying every record it carries. */
	| ({ kind: "move-folder" } & FolderPairing)
	| { kind: "upload"; path: string; stat: Stat }
	/** `stat` is the local file as classification saw it — the re-stat guard's baseline. */
	| { kind: "download"; path: string; uuid: string; expectedHash: string | null; stat: Stat | null }
	/** Both sides already agree: record refresh only, no transfer. */
	| { kind: "converge"; path: string; record: FileRecord }
	/** Gone from both sides, or out of scope: drop the record, touch nothing. */
	| { kind: "forget"; path: string }
	| { kind: "trash-remote"; path: string; uuid: string }
	| { kind: "trash-local"; path: string; stat: Stat }
	| { kind: "trash-folder-remote"; path: string }
	| { kind: "trash-folder-local"; path: string }
	/**
	 * Both sides hold content the other has not seen (spec §6). Whether that ends as a
	 * Three-Way Merge or a Conflict Copy is decided during execution, with the Ancestor
	 * and both versions in hand.
	 */
	| {
			kind: "conflict";
			path: string;
			/** `null` at First Link — no record means no Ancestor, so no merge is possible. */
			record: FileRecord | null;
			stat: Stat;
			/** The local content hash classification computed, when it needed one. */
			hash: string | null;
			entry: RemoteEntry;
	  }
	| { kind: "skip"; path: string; reason: SkipReason; detail: string };

export type PlanCounts = {
	upload: number;
	download: number;
	/** Already identical, or needing only a record refresh. */
	identical: number;
	/** Paired renames — records that move rather than transfer. */
	moved: number;
	/** Soft Deletes, files only; the folders that follow are bookkeeping. */
	deleted: number;
	/**
	 * Paths neither side can converge alone. Each becomes a Three-Way Merge or a
	 * Conflict Copy at execution — the planner deliberately does not guess which, so
	 * this is the *upper bound* on copies, and at First Link (no Ancestors) it is exact.
	 */
	conflict: number;
	/**
	 * Skip-and-Surfaces this plan already knows about. Counted here for the First-Link
	 * dry-run preview (spec §8.4, ticket 031), which reports the plan and never the Run; a
	 * Run reports `RunSummary.skips`, which carries these plus the ones only an attempt
	 * can discover.
	 */
	skipped: number;
};

export type Plan = {
	scope: RunScope;
	operations: Operation[];
	counts: PlanCounts;
	/** Capped at `conflictPreviewLimit` — what the First-Link preview lists (spec §5.9). */
	conflictPaths: string[];
	/**
	 * Every path the remote listing held, scope or no scope. Conflict Copy naming needs
	 * it: a name free in the vault but taken on Filen would upload straight over a file
	 * this device has never seen.
	 */
	remotePaths: ReadonlySet<string>;
};

export type PlanProgress =
	| { phase: "listing" }
	| { phase: "scanning" }
	| { phase: "hashing"; done: number; total: number };

export type PlanInput = {
	vault: VaultPort;
	remote: RemotePort;
	state: SyncState;
	scope: SyncScope;
	run: RunScope;
	hash: Hasher;
	constants: EngineConstants;
	/** Rename Hints from this Run's Dirty Set, consumed by tier 2 of the pairing pass. */
	hints?: readonly RenameHint[];
	onProgress?: (progress: PlanProgress) => void;
	/**
	 * Asked at every point the planner is about to spend I/O; a `true` abandons the plan
	 * with a {@link PlanCancelledError}. This is the free Cancel of the First-Link scan
	 * (spec §8.4 step 2), and it is free precisely because planning writes nothing: an
	 * abandoned plan leaves both sides exactly as it found them.
	 *
	 * Ordinary Runs pass nothing — a Run the user cannot see has no Cancel to offer.
	 */
	cancelled?: () => boolean;
};

/** Thrown when the remote listing fails: the Run is `offline`, not broken. */
export class RemoteUnavailableError extends Error {
	constructor(override readonly cause: unknown) {
		super(`Obsen: the Filen listing failed — ${errorMessage(cause)}`);
		this.name = "RemoteUnavailableError";
	}
}

/** Thrown out of {@link computePlan} when {@link PlanInput.cancelled} says to stop. */
export class PlanCancelledError extends Error {
	constructor() {
		super("Obsen: the dry run was cancelled");
		this.name = "PlanCancelledError";
	}
}

/** @throws {PlanCancelledError} */
function checkpoint(cancelled: (() => boolean) | undefined): void {
	if (cancelled?.() === true) throw new PlanCancelledError();
}

/** Narrows {@link Operation} to one of its kinds; shared with the executor. */
export type OpOf<K extends Operation["kind"]> = Extract<Operation, { kind: K }>;

/** A path as the Run currently sees it, before classification. */
type Draft = {
	path: string;
	record: FileRecord | null;
	stat: Stat | null;
	entry: RemoteEntry | null;
	/**
	 * Where the local bytes actually live right now. A pairing can move a record onto a
	 * path the vault does not hold *yet* — until phase 2 performs the rename, reading the
	 * file means reading its old path.
	 */
	readPath: string;
};

export async function computePlan(input: PlanInput): Promise<Plan> {
	const { vault, state, scope, run, constants, onProgress, cancelled } = input;

	checkpoint(cancelled);
	onProgress?.({ phase: "listing" });
	const { entries, remotePaths, skips } = await remoteListing(input);

	checkpoint(cancelled);
	onProgress?.({ phase: "scanning" });
	// FULL Runs scan the vault once; scoped Runs stat only their paths. Scope
	// constrains the local side only — the remote listing is always complete, which
	// is what makes socket gaps cost latency rather than correctness (spec §5.1).
	const scan = run.kind === "full" ? await vault.list() : null;
	const localScan = scan ? scoped(scan, scope) : null;

	const { drafts, renames } = await observe({ ...input, entries, localScan, scan });

	const operations: Operation[] = [...skips, ...renames];
	for (const draft of [...drafts.values()].sort(byPath)) {
		const operation = decide(draft.observation, constants, vault);
		if (operation) operations.push(operation);
	}
	// A path that left the Sync Scope loses its record as bookkeeping — never as a
	// deletion signal (spec §2). Only a FULL Run sees the whole state, so only a FULL
	// Run may sweep.
	if (run.kind === "full") {
		for (const path of state.files.keys()) {
			if (!scope(path)) operations.push({ kind: "forget", path });
		}
	}
	operations.push(...folderOperations(operations, entries));
	operations.push(...folderTrashes(operations, remotePaths, scan));

	return {
		scope: run,
		operations,
		counts: count(operations),
		conflictPaths: conflicts(operations, constants),
		remotePaths: new Set(remotePaths),
	};
}

/** The remote side of the diff, keyed by path, with duplicate paths surfaced. */
async function remoteListing(
	input: PlanInput,
): Promise<{ entries: Map<string, RemoteEntry>; remotePaths: string[]; skips: Operation[] }> {
	let listing: RemoteEntry[];
	try {
		listing = await input.remote.listing();
	} catch (error) {
		throw new RemoteUnavailableError(error);
	}

	const entries = new Map<string, RemoteEntry>();
	const skips: Operation[] = [];
	for (const entry of listing) {
		if (!input.scope(entry.path)) continue;
		const known = entries.get(entry.path);
		if (!known) {
			entries.set(entry.path, entry);
			continue;
		}
		// Two files at one path should be impossible, but if Filen ever shows it the
		// engine syncs the one it already knows and Skip-and-Surfaces the other
		// (spec §5.8) — picking by UUID order alone could discard the tracked file and
		// then "download" its stranger over the top. UUID order only breaks ties
		// between two equally unknown entries, so the choice stays deterministic.
		const tracked = input.state.files.get(entry.path)?.remoteUuid;
		const keepIncoming =
			tracked === entry.uuid || (tracked !== known.uuid && entry.uuid < known.uuid);
		const [kept, dropped] = keepIncoming ? [entry, known] : [known, entry];
		entries.set(entry.path, kept);
		skips.push({
			kind: "skip",
			path: entry.path,
			reason: "duplicate-remote-path",
			// The path itself does sync — what is skipped is this second file at it.
			detail: `a second remote file (${dropped.uuid}) holds this path`,
		});
	}
	skips.push(...resolveCaseCollisions(entries, input.state));
	// Every path Filen holds, scope or no scope: emptied-folder detection must not read
	// out-of-scope content as absent and trash the folder around it.
	return { entries, remotePaths: listing.map((entry) => entry.path), skips };
}

/**
 * Two remote paths that differ only in case (spec §5.8).
 *
 * The engine compares case-sensitively — a case-sensitive vault holds `Note.md` and
 * `note.md` side by side quite happily — but every mobile platform and the two desktop
 * defaults do not, and materializing the second would silently overwrite the first. So
 * the collision is resolved *here*, by dropping the loser from the diff rather than by
 * renaming it: renaming would break wikilinks, and inventing a name is never the engine's
 * call.
 *
 * Which one wins: **the one a record already tracks** — it is already synced, and dropping
 * it would read as "gone from the remote" and propagate a delete. Where none is tracked,
 * the lexicographically first one, by code unit, so two devices independently reach the
 * same answer. Both survive on Filen; what is skipped is one side of the pair *here*, and
 * the skip says which.
 *
 * Spec §5.8 says "the known/lexicographically-first path", singular, and one tracked path
 * is the ordinary case. Two can be tracked, though — a genuinely case-sensitive vault
 * synced both — and there both are kept: this vault demonstrably holds them, so the
 * collision is not one, and skipping either would delete a file to solve a problem that
 * does not exist here.
 */
function resolveCaseCollisions(
	entries: Map<string, RemoteEntry>,
	state: SyncState,
): Operation[] {
	const folded = new Map<string, string[]>();
	for (const path of entries.keys()) {
		const fold = path.toLowerCase();
		const group = folded.get(fold);
		if (group) group.push(path);
		else folded.set(fold, [path]);
	}

	const skips: Operation[] = [];
	// Sorted, so the report reads the same on two devices whose listings arrived in
	// different orders.
	for (const [, group] of [...folded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (group.length < 2) continue;
		const tracked = group.filter((path) => state.files.has(path));
		const kept = tracked.length > 0 ? tracked : [group.reduce((a, b) => (a < b ? a : b))];
		for (const path of group.sort()) {
			if (kept.includes(path)) continue;
			entries.delete(path);
			skips.push({
				kind: "skip",
				path,
				reason: "case-collision",
				detail: `${kept.join(", ")} differs from this path only in case, and syncs instead`,
			});
		}
	}
	return skips;
}

function scoped(files: { path: string; stat: Stat }[], scope: SyncScope): Map<string, Stat> {
	const inScope = new Map<string, Stat>();
	for (const file of files) if (scope(file.path)) inScope.set(file.path, file.stat);
	return inScope;
}

/**
 * Which paths this Run judges: its scope, plus every path the remote listing
 * disagrees with the state about, plus both ends of every Rename Hint. The remote
 * expansion is free (both sides are already in memory) and is why every Run, however
 * small, catches all remote changes.
 */
function diffSet(input: {
	run: RunScope;
	scope: SyncScope;
	state: SyncState;
	entries: Map<string, RemoteEntry>;
	localScan: Map<string, Stat> | null;
	hints: readonly RenameHint[];
}): string[] {
	const { run, scope, state, entries, localScan, hints } = input;
	const paths = new Set<string>();

	if (run.kind === "full") {
		for (const path of state.files.keys()) if (scope(path)) paths.add(path);
		for (const path of localScan?.keys() ?? []) paths.add(path);
		for (const path of entries.keys()) paths.add(path);
	} else {
		for (const path of run.paths) if (scope(path)) paths.add(path);
	}

	for (const [path, entry] of entries) {
		const record = state.files.get(path);
		if (!record || record.remoteUuid !== entry.uuid) paths.add(path);
	}
	for (const path of state.files.keys()) {
		if (scope(path) && !entries.has(path)) paths.add(path);
	}
	// A hint is only evidence if the Run looks at both of its ends. For a folder hint
	// that means every record underneath it and the path each one claims to have moved to.
	for (const hint of hints) {
		for (const path of [hint.from, hint.to]) if (scope(path)) paths.add(path);
		const prefix = `${hint.from}/`;
		for (const path of state.files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const moved = `${hint.to}/${path.slice(prefix.length)}`;
			if (scope(path)) paths.add(path);
			if (scope(moved)) paths.add(moved);
		}
	}

	return [...paths].sort();
}

/**
 * Stats, pairs renames, hashes where needed, and classifies every path in the diff set.
 *
 * The order matters: tiers 1 and 2 need no content at all, so they run first and can
 * remove paths from the set before anything is read. Only tier 3 costs reads, and only
 * when a vanished file leaves something for it to look for.
 */
async function observe(
	input: PlanInput & {
		entries: Map<string, RemoteEntry>;
		localScan: Map<string, Stat> | null;
		scan: { path: string; stat: Stat }[] | null;
	},
): Promise<{ drafts: Map<string, Draft & { observation: Observation }>; renames: Operation[] }> {
	const { vault, state, entries, localScan, run, scope, hash, onProgress } = input;
	const hints = input.hints ?? [];
	const rehash = run.kind === "full" && run.rehash === true;

	const drafts = new Map<string, Draft>();
	for (const path of diffSet({ run, scope, state, entries, localScan, hints })) {
		const stat = localScan ? (localScan.get(path) ?? null) : await vault.stat(path);
		drafts.set(path, {
			path,
			record: state.files.get(path) ?? null,
			stat,
			entry: entries.get(path) ?? null,
			readPath: path,
		});
	}

	const identity = pairByIdentity(world(drafts, entries, scope), hints);
	rekeyDrafts(drafts, identity.files);

	// Hashing does not change what the pairing pass sees, so tier 3 judges the same world
	// the "is tier 3 worth reading files for?" question was answered against.
	const paired = world(drafts, entries, scope);
	const hashes = new Map<string, string>();
	const tierThree = hasContentRenameSources(paired);
	const needsHash = [...drafts.values()].filter((draft) => wantsHash(draft, rehash, tierThree));
	if (needsHash.length > 0) onProgress?.({ phase: "hashing", done: 0, total: needsHash.length });
	let hashed = 0;
	for (const draft of needsHash) {
		// Asked between files rather than during one: hashing a vault is the long half of a
		// dry run, and one file's read is short enough that finishing it costs nothing.
		checkpoint(input.cancelled);
		// Sequential: reads are whole-file and the progress count must be honest.
		hashes.set(draft.path, await hash(await vault.read(draft.readPath)));
		hashed += 1;
		onProgress?.({ phase: "hashing", done: hashed, total: needsHash.length });
	}

	const content = pairByContent(paired, hashes);
	rekeyDrafts(drafts, content);

	const classified = new Map<string, Draft & { observation: Observation }>();
	for (const draft of drafts.values()) {
		// The cheap path (spec §3.2): with size and mtime both unchanged the stored hash
		// still describes the file, so no read happened at all.
		const contentHash =
			hashes.get(draft.path) ?? (draft.stat && draft.record ? draft.record.lastSyncedHash : null);
		classified.set(draft.path, { ...draft, observation: classify(draft, contentHash) });
	}
	return { drafts: classified, renames: moveOperations(identity.folders, [...identity.files, ...content]) };
}

function world(
	drafts: ReadonlyMap<string, Draft>,
	entries: Map<string, RemoteEntry>,
	scope: SyncScope,
): RenameWorld {
	const records = new Map<string, FileRecord>();
	const stats = new Map<string, Stat | null>();
	for (const draft of drafts.values()) {
		if (draft.record) records.set(draft.path, draft.record);
		stats.set(draft.path, draft.stat);
	}
	return { records, stats, entries, scope };
}

/**
 * Folds each pairing into the draft it lands on: the record moves to `to`, and so does
 * whichever side's observation was still filed under `from`. Classification then judges
 * one path holding one file, and a rename that also changed content falls out as an
 * ordinary upload.
 */
function rekeyDrafts(drafts: Map<string, Draft>, pairings: readonly Pairing[]): void {
	for (const pairing of pairings) {
		const from = drafts.get(pairing.from);
		const to = drafts.get(pairing.to);
		drafts.delete(pairing.from);
		const stat = to?.stat ?? from?.stat ?? null;
		drafts.set(pairing.to, {
			path: pairing.to,
			record: pairing.record,
			stat,
			entry: to?.entry ?? from?.entry ?? null,
			// Until phase 2 performs the local rename, the bytes are still at the old path.
			readPath: to?.stat ? pairing.to : from?.stat ? pairing.from : pairing.to,
		});
	}
}

function moveOperations(
	folders: readonly FolderPairing[],
	files: readonly Pairing[],
): Operation[] {
	const operations: Operation[] = folders.map((folder) => ({
		kind: "move-folder",
		from: folder.from,
		to: folder.to,
		files: folder.files,
	}));
	for (const pairing of files) {
		// A record a folder move already carries must not be rekeyed twice: the folder op
		// owns both the single remote call and the records it lands on.
		if (pairing.folder !== null) continue;
		operations.push({
			kind: "move",
			from: pairing.from,
			to: pairing.to,
			record: pairing.record,
			move: pairing.move,
			tier: pairing.tier,
		});
	}
	return operations;
}

/** Whether classification needs the local file's real content hash. */
function wantsHash(draft: Draft, rehash: boolean, tierThree: boolean): boolean {
	if (!draft.stat) return false;
	if (!draft.record) {
		// A pure local add needs no hash to plan: the upload hashes the bytes it
		// actually sends. It does need one to tell an identical pair from a First-Link
		// conflict — or to stand as a candidate destination for an offline rename.
		return draft.entry !== null || tierThree;
	}
	if (rehash) return true;
	const unchanged =
		draft.stat.size === draft.record.size && draft.stat.mtime === draft.record.localMtime;
	return !unchanged;
}

function classify(draft: Draft, hash: string | null): Observation {
	const { path, record, stat, entry } = draft;

	let local: SideChange;
	if (!stat) local = "missing";
	else if (!record) local = "added";
	else local = hash === record.lastSyncedHash ? "unchanged" : "modified";

	let remote: SideChange;
	if (!entry) remote = "missing";
	else if (!record) remote = "added";
	else if (entry.uuid === record.remoteUuid) remote = "unchanged";
	// A content update mints a new UUID, but so does a same-content re-upload from
	// another client; an equal hash proves the second case.
	else if (entry.hash !== undefined && entry.hash === record.lastSyncedHash) remote = "unchanged";
	else remote = "modified";

	return { path, record, stat, hash, entry, local, remote };
}

/**
 * The decision matrix (spec §5.2). No-record rows reproduce the First-Link rules
 * exactly, which is why First Link needs no bootstrap module: it is a FULL Reconcile
 * with empty state, and with no records no delete can fire.
 */
function decide(
	observation: Observation,
	constants: EngineConstants,
	vault: Pick<VaultPort, "isWritablePath">,
): Operation | null {
	const { path, record, stat, hash, entry, local, remote } = observation;
	const sameContent = hash !== null && entry?.hash !== undefined && entry.hash === hash;

	if (!record) {
		if (stat && entry) {
			// Identical content on both sides pairs silently (ticket 011).
			if (sameContent) return converge(path, stat, hash, entry, constants);
			// An unknown remote hash cannot prove identity, and with no record there is
			// no Ancestor to merge against: the copy is planned, and execution — which
			// fetches the bytes anyway — still converges the pair if they match after all.
			return { kind: "conflict", path, record: null, stat, hash, entry };
		}
		if (stat) return { kind: "upload", path, stat };
		if (entry) return download(path, entry, stat, vault);
		return null;
	}

	if (local === "missing" && remote === "missing") return { kind: "forget", path };

	if (local === "unchanged" && remote === "unchanged") {
		return stat && entry && hash !== null && needsRefresh(record, stat, entry)
			? converge(path, stat, hash, entry, constants)
			: null;
	}
	if (local === "unchanged" && remote === "modified" && entry) return download(path, entry, stat, vault);
	if (local === "modified" && remote === "unchanged" && stat) return { kind: "upload", path, stat };
	if (local === "modified" && remote === "modified") {
		// Both sides being modified means both sides have content, but the matrix must
		// never fall through to a delete on a classification it does not recognize.
		if (!stat || !entry) return null;
		// Compare hashes before anything else: equal means both sides landed on the
		// same content, so there is nothing to merge and nothing to transfer.
		if (sameContent) return converge(path, stat, hash, entry, constants);
		return { kind: "conflict", path, record, stat, hash, entry };
	}

	// Edit beats delete (spec §5.2, ticket 007): the surviving edit is restored to the
	// side that deleted it, because stale state must never destroy a change no one has
	// merged yet.
	if (local === "missing" && remote === "modified" && entry) return download(path, entry, stat, vault);
	if (local === "modified" && remote === "missing" && stat) return { kind: "upload", path, stat };

	// What is left is a genuine deletion on one side, propagated as a Soft Delete.
	if (local === "missing") return { kind: "trash-remote", path, uuid: entry?.uuid ?? record.remoteUuid };
	return stat ? { kind: "trash-local", path, stat } : null;
}

function download(
	path: string,
	entry: RemoteEntry,
	stat: Stat | null,
	vault: Pick<VaultPort, "isWritablePath">,
): Operation {
	// A name this platform cannot materialize is Skip-and-Surfaced, never
	// auto-renamed: the engine must not invent content changes or break wikilinks
	// (spec §5.8). The reason travels to `RunSummary.skips` for the user to act on.
	if (!vault.isWritablePath(path)) {
		return {
			kind: "skip",
			path,
			reason: "unwritable-path",
			detail: "this platform cannot create a file with this name",
		};
	}
	return { kind: "download", path, uuid: entry.uuid, expectedHash: entry.hash ?? null, stat };
}

function converge(
	path: string,
	stat: Stat,
	hash: string,
	entry: RemoteEntry,
	constants: EngineConstants,
): Operation {
	return {
		kind: "converge",
		path,
		record: {
			lastSyncedHash: hash,
			size: stat.size,
			localMtime: stat.mtime,
			remoteUuid: entry.uuid,
			mergeable: isMergeable(path, constants),
		},
	};
}

/** Whether an otherwise-unchanged path still needs its record rewritten. */
function needsRefresh(record: FileRecord, stat: Stat, entry: RemoteEntry): boolean {
	return (
		stat.size !== record.size ||
		stat.mtime !== record.localMtime ||
		entry.uuid !== record.remoteUuid
	);
}

/**
 * Phase 1 of execution: the folders transfers and moves need. Remote folders are
 * derived from the listing (Obsen keeps no folder records, so an empty folder simply
 * does not exist); local ones are issued blind, because `mkdir` is recursive and
 * idempotent and a scoped Run has no local folder inventory to consult.
 */
function folderOperations(operations: Operation[], entries: Map<string, RemoteEntry>): Operation[] {
	const remoteFolders = new Set<string>();
	for (const path of entries.keys()) for (const folder of ancestorPaths(path)) remoteFolders.add(folder);

	const remoteMkdirs = new Set<string>();
	const localMkdirs = new Set<string>();
	const needRemote = (path: string): void => {
		const parent = parentPath(path);
		if (parent !== null && !remoteFolders.has(parent)) remoteMkdirs.add(parent);
	};
	const needLocal = (path: string): void => {
		const parent = parentPath(path);
		if (parent !== null) localMkdirs.add(parent);
	};

	for (const operation of operations) {
		if (operation.kind === "upload") needRemote(operation.path);
		else if (operation.kind === "download") needLocal(operation.path);
		else if (operation.kind === "move-folder") needRemote(operation.to);
		else if (operation.kind === "move" && operation.move?.side === "remote") needRemote(operation.to);
		else if (operation.kind === "move" && operation.move?.side === "local") needLocal(operation.to);
	}

	const byDepth = (a: string, b: string): number => pathDepth(a) - pathDepth(b) || a.localeCompare(b);
	return [
		...[...remoteMkdirs].sort(byDepth).map((path): Operation => ({ kind: "mkdir-remote", path })),
		...[...localMkdirs].sort(byDepth).map((path): Operation => ({ kind: "mkdir-local", path })),
	];
}

/**
 * Phase 5: the folders this Run's deletes emptied. Computed from the *unfiltered* view
 * of each side — a folder still holding content the Sync Scope hides is not empty, and
 * trashing it around that content would be the one destructive thing Obsen must never do.
 *
 * A file merely moved out of a folder does not empty it for this purpose: an empty
 * folder costs nothing and never syncs, so only a deletion is worth acting on.
 */
function folderTrashes(
	operations: readonly Operation[],
	remotePaths: readonly string[],
	scan: { path: string; stat: Stat }[] | null,
): Operation[] {
	const trashed = (kind: "trash-remote" | "trash-local"): string[] =>
		operations
			.filter((operation): operation is OpOf<typeof kind> => operation.kind === kind)
			.map((operation) => operation.path);

	const remote = emptiedFolders(trashed("trash-remote"), [
		...remotePaths,
		...creations(operations, "remote"),
	]);
	// Without a full local scan there is no inventory to prove a folder is empty; the
	// next FULL Reconcile — startup or Foreground-Resume — cleans up.
	const local = scan
		? emptiedFolders(trashed("trash-local"), [
				...scan.map((file) => file.path),
				...creations(operations, "local"),
			])
		: [];
	return [
		...remote.map((path): Operation => ({ kind: "trash-folder-remote", path })),
		...local.map((path): Operation => ({ kind: "trash-folder-local", path })),
	];
}

/**
 * Where this plan will put a file on one side. Counted as inventory, because the
 * emptiness test runs against a snapshot taken *before* execution: a folder losing its
 * last old file while phase 3 lands a new one in it is not empty, and phase 5's
 * recursive trash would otherwise delete the file phase 3 had just transferred.
 */
function creations(operations: readonly Operation[], side: "local" | "remote"): string[] {
	const paths: string[] = [];
	for (const operation of operations) {
		if (operation.kind === "upload" && side === "remote") paths.push(operation.path);
		else if (operation.kind === "download" && side === "local") paths.push(operation.path);
		else if (operation.kind === "move" && operation.move?.side === side) paths.push(operation.to);
		else if (operation.kind === "move-folder" && side === "remote") {
			for (const file of operation.files) paths.push(file.to);
		}
	}
	return paths;
}

function emptiedFolders(trashed: readonly string[], all: readonly string[]): string[] {
	if (trashed.length === 0) return [];
	const gone = new Set(trashed);
	const survivors = all.filter((path) => !gone.has(path));
	const candidates = new Set<string>();
	for (const path of trashed) for (const folder of ancestorPaths(path)) candidates.add(folder);

	const emptied = [...candidates].filter(
		(folder) => !survivors.some((path) => path.startsWith(`${folder}/`)),
	);
	// `trashFolder` is recursive, so only the topmost emptied folder of a chain is
	// issued; the deepest-first ordering is what keeps siblings deterministic.
	return emptied
		.filter((folder) => !emptied.some((other) => folder.startsWith(`${other}/`)))
		.sort((a, b) => pathDepth(b) - pathDepth(a) || a.localeCompare(b));
}

function byPath(a: { path: string }, b: { path: string }): number {
	return a.path.localeCompare(b.path);
}

function count(operations: readonly Operation[]): PlanCounts {
	const counts: PlanCounts = {
		upload: 0,
		download: 0,
		identical: 0,
		moved: 0,
		deleted: 0,
		conflict: 0,
		skipped: 0,
	};
	for (const operation of operations) {
		switch (operation.kind) {
			case "upload":
				counts.upload += 1;
				break;
			case "download":
				counts.download += 1;
				break;
			case "converge":
				counts.identical += 1;
				break;
			case "move":
				counts.moved += 1;
				break;
			case "move-folder":
				counts.moved += operation.files.length;
				break;
			case "trash-remote":
			case "trash-local":
				counts.deleted += 1;
				break;
			case "skip":
				counts.skipped += 1;
				break;
			case "conflict":
				counts.conflict += 1;
				break;
			default:
				break;
		}
	}
	return counts;
}

function conflicts(operations: readonly Operation[], constants: EngineConstants): string[] {
	return operations
		.filter((operation) => operation.kind === "conflict")
		.map((operation) => operation.path)
		.slice(0, constants.conflictPreviewLimit);
}
