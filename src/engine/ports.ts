/**
 * The three ports that isolate the Sync Engine from its environment (spec §1.1).
 *
 * These signatures are **normative** — they were finalized on ticket 021 and the
 * spec reproduces them verbatim. The doc comments here add the contracts an
 * adapter author needs and the engine is entitled to assume; where a contract is
 * not in the signature, it is stated below and must hold for every adapter
 * (production or fake).
 *
 * Universal contracts:
 *
 * - **Paths are vault-relative and NFC-normalized at the boundary** (spec §5.8).
 *   Every path a port returns is NFC; every path the engine passes in is NFC.
 *   That is what kills the APFS-NFD phantom-change loop.
 * - **Ports are the only place environment types appear.** Nothing in
 *   `src/engine/` may import `obsidian` or `@filen/sdk`; adapters do that.
 */

export type Stat = { size: number; mtime: number };

export type VaultEvent =
	| { type: "create" | "modify" | "delete"; path: string; stat: Stat | null }
	| { type: "rename"; from: string; to: string; stat: Stat };

export interface VaultPort {
	/** Full scan of in-scope files (never folders), NFC paths. */
	list(): Promise<{ path: string; stat: Stat }[]>;
	/** `null` when the path holds no file — absent, or a folder. */
	stat(path: string): Promise<Stat | null>;
	read(path: string): Promise<Uint8Array>;
	/**
	 * Creates or replaces a file, returning the resulting stat so the caller can record
	 * it without a second round trip. Parent folders must already exist — see
	 * {@link mkdir}.
	 *
	 * **Atomic (tmp + rename) when the file is new**, so a reader never sees half of
	 * one. Replacing an *existing* file is the adapter's choice of write, and the
	 * Obsidian one deliberately is not atomic: renaming over a file Obsidian has indexed
	 * closes the editor tab it is open in (measured on ticket 029, asserted in
	 * `tests/wdio/vault-port.e2e.ts`), which would shut the user's note whenever a
	 * remote edit landed. An overwrite there is as exposed to a torn write as any note
	 * the user types — and a torn file is repaired by the next Run's re-hash, which is
	 * why the engine may not assume otherwise.
	 */
	write(path: string, data: Uint8Array): Promise<Stat>;
	rename(from: string, to: string): Promise<Stat>;
	/** Soft Delete: Obsidian's configured trash, never permanent removal. */
	trash(path: string): Promise<void>;
	/** Recursive and idempotent — creating an existing folder is a no-op, not an error. */
	mkdir(path: string): Promise<void>;
	trashFolder(path: string): Promise<void>;
	/** Whether this platform can materialize the name (spec §5.8 Skip-and-Surface). */
	isWritablePath(path: string): boolean;
	/** Registers a watcher; returns its unregister function. */
	watch(onEvent: (e: VaultEvent) => void): () => void;
}

/** `hash` is the sha512 hex of the plaintext content; absent means *unknown*, never *unchanged*. */
export type RemoteEntry = { path: string; uuid: string; size: number; hash?: string };

export type RemoteEvent =
	| { type: "change"; path: string } // port resolved UUID→path
	| { type: "unresolved" }; // engine escalates scope to FULL

export interface RemotePort {
	/**
	 * Full recursive tree of **files** under the Remote Folder, one call, decrypted,
	 * NFC. Folders are absent by design: no folder records exist anywhere in Obsen
	 * (spec §3.1), so folder existence derives from file paths — and empty folders
	 * do not sync.
	 */
	listing(): Promise<RemoteEntry[]>;
	download(uuid: string): Promise<Uint8Array>;
	/** A content update mints a **new** UUID (spec §3.1) — that is the remote change detector. */
	upload(path: string, data: Uint8Array): Promise<{ uuid: string }>;
	/** Move/rename preserves the UUID, which is what free remote-rename detection rests on. */
	move(uuid: string, toPath: string): Promise<void>;
	/** Soft Delete: Filen trash. */
	trashFile(uuid: string): Promise<void>;
	/** Recursive and idempotent, like {@link VaultPort.mkdir}. */
	mkdir(path: string): Promise<void>;
	trashFolder(path: string): Promise<void>;
	moveFolder(fromPath: string, toPath: string): Promise<void>;
	/** Socket subscription; the port owns decryption and UUID→path resolution. */
	watch(onEvent: (e: RemoteEvent) => void): () => void;
}

/** Obsen's own persistence: `sync-state.json` + `shadow/` (spec §3). */
export interface StorePort {
	readState(): Promise<string | null>;
	/** ATOMIC (tmp + rename): a torn write must never be readable as state. */
	writeState(json: string): Promise<void>;
	readShadow(hash: string): Promise<Uint8Array | null>;
	writeShadow(hash: string, data: Uint8Array): Promise<void>;
	deleteShadow(hash: string): Promise<void>;
}
