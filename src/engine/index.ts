/**
 * The Sync Engine's public surface: what the adapters and the plugin shell import once
 * they exist (tickets 028–031), and the entry point the mobile-safety gate bundles to
 * prove the engine runs with only webview globals. Everything here is pure
 * TypeScript — no `obsidian`, no `@filen/sdk`.
 *
 * Tests import the individual modules instead, so a test names the unit it exercises.
 */

// The three the shell needs: the note it opens after a Conflict (spec §6.2), and the
// Device Name rules the settings field has to apply before storing one (spec §8.7).
export { CONFLICT_MANIFEST_PATH, DEFAULT_DEVICE_NAME, sanitizeDeviceName } from "./conflict";
export { ENGINE_CONSTANTS, engineConstants, type EngineConstants } from "./constants";
export { SyncEngine, type SyncEngineOptions } from "./engine";
export { type ExecutionReport, type TransferProgress } from "./execute";
export { sha512Hex, type Hasher } from "./hash";
export { ancestorPaths, fileExtension, isMergeable, parentPath, pathDepth, toNfc } from "./paths";
export {
	computePlan,
	RemoteUnavailableError,
	type Observation,
	type Operation,
	type Plan,
	type PlanCounts,
	type PlanProgress,
	type SideChange,
	type SkipReason,
} from "./plan";
// Only the types an `Operation` is made of — the pairing pass itself is a planner
// internal, and the modules that need it import it directly.
export type { FolderPairing, MoveAction, Pairing, RenameTier } from "./rename";
export type {
	RemoteEntry,
	RemoteEvent,
	RemotePort,
	Stat,
	StorePort,
	VaultEvent,
	VaultPort,
} from "./ports";
export { EVERYTHING, type SyncScope } from "./scope";
export {
	emptyState,
	SYNC_STATE_SCHEMA_VERSION,
	type FileRecord,
	type StateResetReason,
	type SyncState,
} from "./state";
export {
	type EngineStatus,
	type OpFailure,
	type RunOutcome,
	type RunSummary,
} from "./status";
export type { Timers } from "./timers";
export {
	FULL_SCOPE,
	mergeScopes,
	pathScope,
	type RenameHint,
	type RunScope,
	type RunTrigger,
} from "./triggers";
