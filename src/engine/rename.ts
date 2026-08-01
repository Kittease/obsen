import type { RemoteEntry, Stat } from "./ports";
import type { SyncScope } from "./scope";
import type { FileRecord } from "./state";
import type { RenameHint } from "./triggers";

/**
 * Rename pairing — three tiers, one pass (spec §5.3).
 *
 * Runs between classification's raw observations and the decision matrix, and does one
 * thing: decide that the record at `from` is really the file now at `to`. Everything
 * downstream then treats it as an ordinary path, which is why "rename + edit" needs no
 * cell of its own — it is a pairing followed by an upload.
 *
 * **Anything ambiguous degrades to delete + create.** A wrong pairing silently moves a
 * user's file somewhere they did not put it; the fallback costs a transfer and leaves
 * both versions reachable, because deletes are soft on both sides. That asymmetry is
 * why every tier below bails on the first thing it cannot prove, and why there is no
 * case-folded matching.
 */

/** Which side still has to catch up once a pairing is made. */
export type MoveAction =
	/** The Remote Folder already holds it at `to`; the vault must rename. */
	| { side: "local" }
	/** The vault already holds it at `to`; the Remote Folder must move. */
	| { side: "remote"; uuid: string };

export type RenameTier =
	/** Same UUID at a new remote path — remote renames are free. */
	| "remote-uuid"
	/** A live Obsidian `rename` event, validated against the scan. */
	| "rename-hint"
	/** A folder `rename` event: one remote `moveFolder`, many records rekeyed. */
	| "folder-hint"
	/** Offline rename: exact `lastSyncedHash` equality, unique 1:1 both ways. */
	| "content-hash";

export type Pairing = {
	from: string;
	to: string;
	record: FileRecord;
	tier: RenameTier;
	/** `null` when both sides already hold it at `to` — a redo, so only the record moves. */
	move: MoveAction | null;
	/** The folder move carrying this record, when one does; its `from` path. */
	folder: string | null;
};

/** One remote `moveFolder`, plus every record it rekeys. */
export type FolderPairing = { from: string; to: string; files: Pairing[] };

export type Renames = { files: Pairing[]; folders: FolderPairing[] };

/**
 * What the pass judges against: the records this Run is using, the local stats it
 * observed, and the remote listing. `stats` distinguishes *observed and absent*
 * (`null`) from *never looked at* (missing key) — a scoped Run knows about neither
 * every path nor the absence of one.
 */
export type RenameWorld = {
	records: ReadonlyMap<string, FileRecord>;
	stats: ReadonlyMap<string, Stat | null>;
	entries: ReadonlyMap<string, RemoteEntry>;
	scope: SyncScope;
};

/** Tiers 1 and 2 — identity evidence only, so no file has to be read. */
export function pairByIdentity(world: RenameWorld, hints: readonly RenameHint[]): Renames {
	const taken = new Set<string>();
	const files = remoteRenames(world, taken);
	const folders = folderRenames(world, hints, taken);
	for (const folder of folders) files.push(...folder.files);
	files.push(...hintedRenames(world, hints, taken));
	return { files, folders };
}

/**
 * Tier 3 — the offline rename, where no event survived to tell us. Runs on a world the
 * earlier tiers have already been applied to, so a path they consumed is simply not a
 * candidate here.
 */
export function pairByContent(
	world: RenameWorld,
	hashes: ReadonlyMap<string, string>,
): Pairing[] {
	const sources = contentRenameSources(world);
	if (sources.size === 0) return [];

	// A local file with no record and no remote counterpart: either an add or the
	// destination half.
	const destinations = new Map<string, string[]>();
	for (const [path, stat] of world.stats) {
		if (stat === null || world.records.has(path) || world.entries.has(path)) continue;
		const hash = hashes.get(path);
		if (hash !== undefined) push(destinations, hash, path);
	}

	const pairings: Pairing[] = [];
	for (const [hash, from] of sources) {
		const to = destinations.get(hash);
		// Unique in *both* directions or not at all: two files sharing their bytes carry
		// no evidence about which became which.
		if (from.length !== 1 || to?.length !== 1) continue;
		const record = world.records.get(from[0]!)!;
		pairings.push({
			from: from[0]!,
			to: to[0]!,
			record,
			tier: "content-hash",
			move: { side: "remote", uuid: record.remoteUuid },
			folder: null,
		});
	}
	return pairings;
}

/**
 * Records whose file vanished locally while the remote copy stayed exactly as recorded,
 * bucketed by content hash: each is either a deletion or the source half of an offline
 * rename, and only tier 3 can tell which.
 *
 * Exported as a predicate because the planner needs to know whether tier 3 has anything
 * to look for *before* deciding to hash local adds it would otherwise never read.
 */
export function hasContentRenameSources(world: RenameWorld): boolean {
	return contentRenameSources(world).size > 0;
}

function contentRenameSources(world: RenameWorld): Map<string, string[]> {
	const sources = new Map<string, string[]>();
	for (const [path, record] of world.records) {
		if (!world.scope(path)) continue;
		if (world.stats.get(path) !== null) continue;
		if (world.entries.get(path)?.uuid !== record.remoteUuid) continue;
		push(sources, record.lastSyncedHash, path);
	}
	return sources;
}

/**
 * Tier 1 — a remote file kept its UUID at a new path. Free evidence: Filen preserves
 * the UUID across move and rename, and mints a new one on every content update.
 */
function remoteRenames(world: RenameWorld, taken: Set<string>): Pairing[] {
	// Records whose remote file is no longer where the record says it is.
	const orphaned = new Map<string, string[]>();
	for (const [path, record] of world.records) {
		if (!world.scope(path) || world.entries.has(path)) continue;
		push(orphaned, record.remoteUuid, path);
	}
	if (orphaned.size === 0) return [];

	const pairings: Pairing[] = [];
	for (const [to, entry] of world.entries) {
		if (taken.has(to)) continue;
		// A record already at this path means the entry never moved, or that the path is
		// tracking a different file — either way there is nothing to pair.
		if (world.records.has(to)) continue;
		const sources = orphaned.get(entry.uuid);
		if (sources?.length !== 1) continue;
		const from = sources[0]!;
		if (from === to || taken.has(from)) continue;

		const move = localCatchUp(world, from, to);
		if (move === undefined) continue; // the destination is occupied — degrade
		taken.add(from);
		taken.add(to);
		pairings.push({ from, to, record: world.records.get(from)!, tier: "remote-uuid", move, folder: null });
	}
	return pairings;
}

/**
 * What the vault owes a remote rename: a rename of its own, nothing (a redo, or the
 * file is gone locally), or `undefined` when the destination is already occupied and
 * the pairing must be abandoned.
 */
function localCatchUp(
	world: RenameWorld,
	from: string,
	to: string,
): MoveAction | null | undefined {
	const source = world.stats.get(from) ?? null;
	const destination = world.stats.get(to) ?? null;
	if (source === null) return null; // already moved, or deleted locally
	if (destination !== null) return undefined;
	return { side: "local" };
}

/** Tier 2 for a folder `rename` event: all-or-nothing, one remote `moveFolder`. */
function folderRenames(
	world: RenameWorld,
	hints: readonly RenameHint[],
	taken: Set<string>,
): FolderPairing[] {
	const folders: FolderPairing[] = [];
	for (const hint of hints) {
		// A hint naming a tracked file is a file rename; only a hint that names no record
		// but *prefixes* several can be a folder.
		if (world.records.has(hint.from)) continue;
		const prefix = `${hint.from}/`;
		const sources = [...world.records.keys()].filter(
			(path) => path.startsWith(prefix) && world.scope(path),
		);
		if (sources.length === 0) continue;

		const files: Pairing[] = [];
		const valid = sources.every((from) => {
			const to = `${hint.to}/${from.slice(prefix.length)}`;
			if (!world.scope(to) || taken.has(from) || taken.has(to)) return false;
			// The vault must already show the move, and nothing may be in the way.
			if (world.stats.get(from) !== null || !world.stats.get(to)) return false;
			if (world.records.has(to) || world.entries.has(to)) return false;
			const record = world.records.get(from)!;
			// The remote half must still be exactly what the record describes, or moving
			// the folder would drag someone else's newer file along with it.
			if (world.entries.get(from)?.uuid !== record.remoteUuid) return false;
			files.push({ from, to, record, tier: "folder-hint", move: null, folder: hint.from });
			return true;
		});
		if (!valid) continue;

		for (const file of files) {
			taken.add(file.from);
			taken.add(file.to);
		}
		folders.push({ from: hint.from, to: hint.to, files });
	}
	return folders;
}

/** Tier 2 for a file `rename` event — the hint is a claim, the scan is the evidence. */
function hintedRenames(
	world: RenameWorld,
	hints: readonly RenameHint[],
	taken: Set<string>,
): Pairing[] {
	const pairings: Pairing[] = [];
	for (const { from, to } of hints) {
		if (taken.has(from) || taken.has(to)) continue;
		if (!world.scope(from) || !world.scope(to)) continue;
		const record = world.records.get(from);
		if (!record || world.records.has(to)) continue;
		// Validated against the scan: the file really left `from` and really arrived at
		// `to`. A hint for a rename that was undone before the Run proves nothing.
		if (world.stats.get(from) !== null || !world.stats.get(to)) continue;

		const move = remoteCatchUp(world, from, to, record);
		if (move === undefined) continue;
		taken.add(from);
		taken.add(to);
		pairings.push({ from, to, record, tier: "rename-hint", move, folder: null });
	}
	return pairings;
}

/** The mirror of {@link localCatchUp}: what the Remote Folder owes a local rename. */
function remoteCatchUp(
	world: RenameWorld,
	from: string,
	to: string,
	record: FileRecord,
): MoveAction | null | undefined {
	const destination = world.entries.get(to);
	// Already there with our UUID: a redo of a Run that crashed after the move.
	if (destination) return destination.uuid === record.remoteUuid ? null : undefined;
	// Anything but the file we recorded — a foreign edit, or a remote delete — and the
	// matrix should judge both paths on their own merits instead.
	return world.entries.get(from)?.uuid === record.remoteUuid
		? { side: "remote", uuid: record.remoteUuid }
		: undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const bucket = map.get(key);
	if (bucket) bucket.push(value);
	else map.set(key, [value]);
}
