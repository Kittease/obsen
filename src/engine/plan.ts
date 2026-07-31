import type { EngineConstants } from "./constants";
import { errorMessage } from "./errors";
import type { Hasher } from "./hash";
import { ancestorPaths, isMergeable, parentPath, pathDepth } from "./paths";
import type { RemoteEntry, RemotePort, Stat, VaultPort } from "./ports";
import type { SyncScope } from "./scope";
import type { FileRecord, SyncState } from "./state";
import type { RunScope } from "./triggers";

/**
 * The Run's planning half (spec §5.1–5.2): observe both sides, classify every
 * in-scope path against its record, and produce the operation plan. **Nothing is
 * executed here** — that separation is what makes the First Link dry-run preview a
 * real preview rather than a second code path (spec §8.4).
 *
 * The decision matrix below is complete in *shape*. Deletions, rename pairing and
 * conflict resolution are later slices (tickets 032, 033), so their cells plan a
 * `pending` operation naming the slice: the plan tells the truth about what it
 * found, and the executor reports what it could not do yet instead of pretending
 * the path converged.
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

/** The slice a planned-but-not-yet-executable operation belongs to. */
export type PendingSlice = "deletes" | "renames" | "conflicts";

export type SkipReason = "unwritable-path" | "duplicate-remote-path";

export type Operation =
	| { kind: "mkdir-remote"; path: string }
	| { kind: "mkdir-local"; path: string }
	| { kind: "upload"; path: string; stat: Stat }
	| { kind: "download"; path: string; uuid: string; expectedHash: string | null }
	/** Both sides already agree: record refresh only, no transfer. */
	| { kind: "converge"; path: string; record: FileRecord }
	/** Gone from both sides, or out of scope: drop the record, touch nothing. */
	| { kind: "forget"; path: string }
	| { kind: "pending"; path: string; slice: PendingSlice; detail: string }
	| { kind: "skip"; path: string; reason: SkipReason; detail: string };

export type PlanCounts = {
	upload: number;
	download: number;
	/** Already identical, or needing only a record refresh. */
	identical: number;
	conflict: number;
	/** Operations awaiting a later slice. */
	deferred: number;
	skipped: number;
};

export type Plan = {
	scope: RunScope;
	operations: Operation[];
	counts: PlanCounts;
	/** Capped at `conflictPreviewLimit` — what the First-Link preview lists (spec §5.9). */
	conflictPaths: string[];
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
	onProgress?: (progress: PlanProgress) => void;
};

/** Thrown when the remote listing fails: the Run is `offline`, not broken. */
export class RemoteUnavailableError extends Error {
	constructor(override readonly cause: unknown) {
		super(`Obsen: the Filen listing failed — ${errorMessage(cause)}`);
		this.name = "RemoteUnavailableError";
	}
}

export async function computePlan(input: PlanInput): Promise<Plan> {
	const { vault, state, scope, run, constants, onProgress } = input;

	onProgress?.({ phase: "listing" });
	const { entries, skips } = await remoteListing(input);

	onProgress?.({ phase: "scanning" });
	// FULL Runs scan the vault once; scoped Runs stat only their paths. Scope
	// constrains the local side only — the remote listing is always complete, which
	// is what makes socket gaps cost latency rather than correctness (spec §5.1).
	const localScan = run.kind === "full" ? await localFiles(vault, scope) : null;
	const diff = diffSet({ run, scope, state, entries, localScan });

	const observations = await observe({ ...input, diff, entries, localScan });

	const operations: Operation[] = [...skips];
	for (const observation of observations) {
		const operation = decide(observation, constants, vault);
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

	return { scope: run, operations, counts: count(operations), conflictPaths: conflicts(operations, constants) };
}

/** The remote side of the diff, keyed by path, with duplicate paths surfaced. */
async function remoteListing(
	input: PlanInput,
): Promise<{ entries: Map<string, RemoteEntry>; skips: Operation[] }> {
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
	return { entries, skips };
}

async function localFiles(vault: VaultPort, scope: SyncScope): Promise<Map<string, Stat>> {
	const files = new Map<string, Stat>();
	for (const file of await vault.list()) {
		if (scope(file.path)) files.set(file.path, file.stat);
	}
	return files;
}

/**
 * Which paths this Run judges: its scope, plus every path the remote listing
 * disagrees with the state about. That expansion is free (both sides are already in
 * memory) and is why every Run, however small, catches all remote changes.
 */
function diffSet(input: {
	run: RunScope;
	scope: SyncScope;
	state: SyncState;
	entries: Map<string, RemoteEntry>;
	localScan: Map<string, Stat> | null;
}): string[] {
	const { run, scope, state, entries, localScan } = input;
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

	return [...paths].sort();
}

/** Stats, hashes where needed, and classifies every path in the diff set. */
async function observe(
	input: PlanInput & {
		diff: string[];
		entries: Map<string, RemoteEntry>;
		localScan: Map<string, Stat> | null;
	},
): Promise<Observation[]> {
	const { vault, state, diff, entries, localScan, run, hash, onProgress } = input;
	const rehash = run.kind === "full" && run.rehash === true;

	type Draft = { path: string; record: FileRecord | null; stat: Stat | null; entry: RemoteEntry | null };
	const drafts: Draft[] = [];
	for (const path of diff) {
		const stat = localScan ? (localScan.get(path) ?? null) : await vault.stat(path);
		drafts.push({
			path,
			record: state.files.get(path) ?? null,
			stat,
			entry: entries.get(path) ?? null,
		});
	}

	const needsHash = drafts.filter((draft) => wantsHash(draft, rehash));
	const observations: Observation[] = [];
	let hashed = 0;
	if (needsHash.length > 0) onProgress?.({ phase: "hashing", done: 0, total: needsHash.length });

	for (const draft of drafts) {
		let contentHash: string | null = null;
		if (wantsHash(draft, rehash)) {
			// Sequential: reads are whole-file and the progress count must be honest.
			contentHash = await hash(await vault.read(draft.path));
			hashed += 1;
			onProgress?.({ phase: "hashing", done: hashed, total: needsHash.length });
		} else if (draft.stat && draft.record) {
			// The cheap path (spec §3.2): size and mtime both unchanged, so the stored
			// hash still describes the file and no read happens at all.
			contentHash = draft.record.lastSyncedHash;
		}
		observations.push(classify({ ...draft, hash: contentHash }));
	}
	return observations;
}

/** Whether classification needs the local file's real content hash. */
function wantsHash(
	draft: { record: FileRecord | null; stat: Stat | null; entry: RemoteEntry | null },
	rehash: boolean,
): boolean {
	if (!draft.stat) return false;
	if (!draft.record) {
		// A pure local add needs no hash to plan: the upload hashes the bytes it
		// actually sends. A remote file at the same path does need one, to tell an
		// identical pair from a First-Link conflict.
		return draft.entry !== null;
	}
	if (rehash) return true;
	const unchanged =
		draft.stat.size === draft.record.size && draft.stat.mtime === draft.record.localMtime;
	return !unchanged;
}

function classify(draft: {
	path: string;
	record: FileRecord | null;
	stat: Stat | null;
	hash: string | null;
	entry: RemoteEntry | null;
}): Observation {
	const { record, stat, hash, entry } = draft;

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

	return { ...draft, local, remote };
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
			// An unknown remote hash cannot prove identity, and at First Link there is
			// no Ancestor to merge against either way: the conflict slice decides.
			return {
				kind: "pending",
				path,
				slice: "conflicts",
				detail: "both sides hold this path at First Link",
			};
		}
		if (stat) return { kind: "upload", path, stat };
		if (entry) return download(path, entry, vault);
		return null;
	}

	if (local === "missing" && remote === "missing") return { kind: "forget", path };

	if (local === "unchanged" && remote === "unchanged") {
		return stat && entry && hash !== null && needsRefresh(record, stat, entry)
			? converge(path, stat, hash, entry, constants)
			: null;
	}
	if (local === "unchanged" && remote === "modified" && entry) return download(path, entry, vault);
	if (local === "modified" && remote === "unchanged" && stat) return { kind: "upload", path, stat };
	if (local === "modified" && remote === "modified") {
		// Compare hashes before anything else: equal means both sides landed on the
		// same content, so there is nothing to merge and nothing to transfer.
		if (sameContent && stat && entry) return converge(path, stat, hash, entry, constants);
		return {
			kind: "pending",
			path,
			slice: "conflicts",
			detail: "changed on both sides since the last sync",
		};
	}

	// Everything left is a deletion cell. Soft Delete propagation and edit-beats-delete
	// restoration land together in ticket 032 — shipping half of "edit beats delete"
	// would read as working deletion support.
	const detail =
		local === "missing" && remote === "modified"
			? "deleted locally, edited remotely (edit beats delete)"
			: local === "modified" && remote === "missing"
				? "edited locally, deleted remotely (edit beats delete)"
				: local === "missing"
					? "deleted locally"
					: "deleted remotely";
	return { kind: "pending", path, slice: "deletes", detail };
}

function download(
	path: string,
	entry: RemoteEntry,
	vault: Pick<VaultPort, "isWritablePath">,
): Operation {
	// A name this platform cannot materialize is Skip-and-Surfaced, never
	// auto-renamed: the engine must not invent content changes or break wikilinks
	// (spec §5.8). The reporting surface for skips arrives with ticket 036.
	if (!vault.isWritablePath(path)) {
		return {
			kind: "skip",
			path,
			reason: "unwritable-path",
			detail: "this platform cannot create a file with this name",
		};
	}
	return { kind: "download", path, uuid: entry.uuid, expectedHash: entry.hash ?? null };
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
 * Phase 1 of execution: the folders transfers need. Remote folders are derived from
 * the listing (Obsen keeps no folder records, so an empty folder simply does not
 * exist); local ones are issued blind, because `mkdir` is recursive and idempotent
 * and a scoped Run has no local folder inventory to consult.
 */
function folderOperations(operations: Operation[], entries: Map<string, RemoteEntry>): Operation[] {
	const remoteFolders = new Set<string>();
	for (const path of entries.keys()) for (const folder of ancestorPaths(path)) remoteFolders.add(folder);

	const remoteMkdirs = new Set<string>();
	const localMkdirs = new Set<string>();
	for (const operation of operations) {
		const parent = parentPath(operation.path);
		if (parent === null) continue;
		if (operation.kind === "upload" && !remoteFolders.has(parent)) remoteMkdirs.add(parent);
		if (operation.kind === "download") localMkdirs.add(parent);
	}

	const byDepth = (a: string, b: string): number => pathDepth(a) - pathDepth(b) || a.localeCompare(b);
	return [
		...[...remoteMkdirs].sort(byDepth).map((path): Operation => ({ kind: "mkdir-remote", path })),
		...[...localMkdirs].sort(byDepth).map((path): Operation => ({ kind: "mkdir-local", path })),
	];
}

function count(operations: Operation[]): PlanCounts {
	const counts: PlanCounts = {
		upload: 0,
		download: 0,
		identical: 0,
		conflict: 0,
		deferred: 0,
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
			case "skip":
				counts.skipped += 1;
				break;
			case "pending":
				if (operation.slice === "conflicts") counts.conflict += 1;
				else counts.deferred += 1;
				break;
			default:
				break;
		}
	}
	return counts;
}

function conflicts(operations: Operation[], constants: EngineConstants): string[] {
	return operations
		.filter((operation) => operation.kind === "pending" && operation.slice === "conflicts")
		.map((operation) => operation.path)
		.slice(0, constants.conflictPreviewLimit);
}
