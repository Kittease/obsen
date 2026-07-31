import { toNfc } from "./paths";
import type { StorePort } from "./ports";

/**
 * The Sync State (spec §3.1) and its envelope guards (spec §3.3).
 *
 * Held in memory as a `Map` because the engine's hot loop is per-path lookups;
 * serialized as the spec's object-keyed document with sorted keys, so a Run that
 * changed nothing writes a byte-identical file.
 *
 * The guards all fail the same way — discard and **Re-Bootstrap** — because the
 * costs are wildly asymmetric: a wrongly trusted state file can propagate a
 * deletion, while a wrongly discarded one costs redundant hashing and at worst a
 * spurious Conflict Copy (spec §3.3, ticket 011).
 */

export const SYNC_STATE_SCHEMA_VERSION = 1;

export type FileRecord = {
	lastSyncedHash: string;
	size: number;
	localMtime: number;
	remoteUuid: string;
	mergeable: boolean;
};

export type SyncState = {
	schemaVersion: number;
	/** UUID of the linked Remote Folder — stable across remote move/rename. */
	remoteRoot: string;
	files: Map<string, FileRecord>;
};

/**
 * Why the loaded state was discarded, for the surface that has to say so
 * (ticket 037). `"missing"` is the ordinary First Link case, not a fault.
 */
export type StateResetReason =
	| "missing"
	| "unreadable"
	| "corrupt"
	| "future-schema"
	| "root-changed";

export type LoadedState = {
	state: SyncState;
	/** `null` when the stored state was adopted as-is. */
	reset: StateResetReason | null;
};

export function emptyState(remoteRoot: string): SyncState {
	return { schemaVersion: SYNC_STATE_SCHEMA_VERSION, remoteRoot, files: new Map() };
}

export function serializeState(state: SyncState): string {
	const files: Record<string, FileRecord> = {};
	for (const path of [...state.files.keys()].sort()) files[path] = state.files.get(path)!;
	return JSON.stringify({
		schemaVersion: SYNC_STATE_SCHEMA_VERSION,
		remoteRoot: state.remoteRoot,
		files,
	});
}

/** Writes the state through the port, whose `writeState` is contractually atomic. */
export async function flushState(store: StorePort, state: SyncState): Promise<void> {
	await store.writeState(serializeState(state));
}

/**
 * Reads the state for `remoteRoot`, degrading to an empty state — a Re-Bootstrap —
 * on anything it cannot fully trust.
 */
export async function loadState(store: StorePort, remoteRoot: string): Promise<LoadedState> {
	let raw: string | null;
	try {
		raw = await store.readState();
	} catch {
		return { state: emptyState(remoteRoot), reset: "unreadable" };
	}
	if (raw === null) return { state: emptyState(remoteRoot), reset: "missing" };

	const reason = parseState(raw, remoteRoot);
	return typeof reason === "string"
		? { state: emptyState(remoteRoot), reset: reason }
		: { state: reason, reset: null };
}

/** The stored state, or the reason it cannot be used. */
function parseState(raw: string, remoteRoot: string): SyncState | StateResetReason {
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		return "corrupt";
	}
	if (!isRecord(document)) return "corrupt";

	// Older versions get stepwise migrations when there is ever something to migrate
	// *from*; version 1 is the first shipped schema, so today only a downgrade — a
	// state written by a newer Obsen — can be out of range.
	if (document.schemaVersion !== SYNC_STATE_SCHEMA_VERSION) {
		return typeof document.schemaVersion === "number" &&
			document.schemaVersion > SYNC_STATE_SCHEMA_VERSION
			? "future-schema"
			: "corrupt";
	}
	if (typeof document.remoteRoot !== "string") return "corrupt";
	// Folder UUIDs survive move and rename, so a mismatch is a genuine re-link
	// rather than a reorganized drive.
	if (document.remoteRoot !== remoteRoot) return "root-changed";
	if (!isRecord(document.files)) return "corrupt";

	const files = new Map<string, FileRecord>();
	for (const [path, value] of Object.entries(document.files)) {
		const record = parseRecord(value);
		if (!record) return "corrupt";
		// Paths arrive NFC from every port (spec §5.8); persistence is the one place
		// that guarantee doesn't reach, and a decomposed key would never match again.
		files.set(toNfc(path), record);
	}

	return { schemaVersion: SYNC_STATE_SCHEMA_VERSION, remoteRoot, files };
}

function parseRecord(value: unknown): FileRecord | null {
	if (!isRecord(value)) return null;
	const { lastSyncedHash, size, localMtime, remoteUuid, mergeable } = value;
	if (typeof lastSyncedHash !== "string" || lastSyncedHash === "") return null;
	if (typeof size !== "number" || typeof localMtime !== "number") return null;
	if (typeof remoteUuid !== "string" || remoteUuid === "") return null;
	if (typeof mergeable !== "boolean") return null;
	return { lastSyncedHash, size, localMtime, remoteUuid, mergeable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
