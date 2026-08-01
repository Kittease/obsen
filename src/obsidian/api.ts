/**
 * The slice of Obsidian this plugin uses, described structurally.
 *
 * Two reasons it is written out rather than imported:
 *
 * - **The `obsidian` package ships types and no runtime.** Nothing in it is
 *   constructible, so a headless test cannot build a `TFile` — and `instanceof TFile`
 *   cannot run either, which is why a folder is told from a file by the `children` a
 *   `TFolder` carries.
 * - **A slice is a contract.** `createObsidianPorts` assigns the real `app.vault` and
 *   `app.fileManager` to these types, and that assignment is the compile-time proof
 *   that this really is a subset of Obsidian's API rather than a hopeful description
 *   of one — the same trick `createFilenRemote` plays on the Filen SDK.
 */

/** What the adapters need of a `TFile`; Obsidian's `TFile` satisfies it structurally. */
export type VaultFile = { path: string; stat: { mtime: number; size: number } };

/** What they need of any node in the tree — a `TAbstractFile` is only ever this much. */
export type VaultNode = { path: string };

/** Obsidian's `EventRef` is an opaque handle, and that is all this needs it to be. */
export type VaultEventRef = object;

export type VaultEventName = "create" | "modify" | "delete" | "rename";

export type AdapterStat = { type: "file" | "folder"; mtime: number; size: number };

/** The `DataAdapter` slice: raw vault-relative I/O that sees hidden paths. */
export interface AdapterApi {
	stat(path: string): Promise<AdapterStat | null>;
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	mkdir(path: string): Promise<void>;
	rename(path: string, newPath: string): Promise<void>;
	remove(path: string): Promise<void>;
	trashLocal(path: string): Promise<void>;
}

/** The `Vault` slice: the indexed half of the vault. */
export interface VaultApi {
	readonly configDir: string;
	getFiles(): VaultFile[];
	getFileByPath(path: string): VaultFile | null;
	getFolderByPath(path: string): VaultNode | null;
	readBinary(file: VaultFile): Promise<ArrayBuffer>;
	modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void>;
	createFolder(path: string): Promise<unknown>;
	rename(file: VaultNode, newPath: string): Promise<void>;
	on(name: VaultEventName, callback: (file: VaultNode, oldPath?: string) => void): VaultEventRef;
	offref(ref: VaultEventRef): void;
	readonly adapter: AdapterApi;
}

/** `FileManager.trashFile` — the one deletion call that honours the user's preference. */
export interface FileManagerApi {
	trashFile(file: VaultNode): Promise<void>;
}
