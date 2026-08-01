import { ancestorPaths, parentPath } from "../../src/engine/paths.ts";
import type {
	AdapterApi,
	AdapterStat,
	FileManagerApi,
	VaultApi,
	VaultEventName,
	VaultFile,
	VaultNode,
} from "../../src/obsidian/api.ts";
import { toArrayBuffer } from "../../src/obsidian/bytes.ts";
import { toBytes } from "./content.ts";

/**
 * An in-memory Obsidian, modelled on the two behaviours the `VaultPort` adapter is
 * built around and cannot get from the `obsidian` package (it ships types only, so
 * nothing there is constructible in a headless test):
 *
 * - **The Vault API cannot see hidden paths.** Anything with a dot-prefixed segment —
 *   `.obsidian/`, `.trash/`, a user's `.secret.md` — is absent from `getFiles()` and
 *   `getFileByPath()`, and mutating it fires no vault event. The `DataAdapter` sees all
 *   of it. That asymmetry is why the adapter has two halves at all.
 * - **The adapter's writes reach Obsidian's index second.** A file written through the
 *   `DataAdapter` is a file Obsidian learns about from its own watcher.
 *   {@link acknowledgeAdapterWrites} turns that acknowledgement off, reproducing the
 *   window where a just-downloaded note is on disk and not yet in `getFiles()`.
 *
 * Everything else here is the smallest filesystem that makes those two true: `files`
 * and `folders` are the disk, and `indexed` is what Obsidian happens to know about it.
 */

type Entry = { data: Uint8Array; mtime: number };
type Listener = { name: VaultEventName; callback: (file: VaultNode, oldPath?: string) => void };

export class FakeObsidian {
	private readonly files = new Map<string, Entry>();
	private readonly folders = new Set<string>();
	/** Paths Obsidian's own index holds — a subset of the disk, never a superset. */
	private readonly indexed = new Set<string>();
	private readonly listeners = new Set<Listener>();
	private mtime = 1_700_000_000_000;

	/** Soft-deleted content, by the path it had — assertions about non-destruction. */
	readonly trashed = new Map<string, Uint8Array>();

	/**
	 * Whether a `DataAdapter` mutation immediately shows up in the Vault API's index,
	 * the way a desktop file watcher makes it.
	 */
	acknowledgeAdapterWrites = true;

	/**
	 * Whether `adapter.rename` clobbers an occupied destination (POSIX `rename`) or
	 * refuses it. Obsen has to survive both, so both are testable.
	 */
	renameClobbers = true;

	readonly vault: VaultApi;
	readonly fileManager: FileManagerApi;

	constructor(readonly configDir = ".obsidian") {
		this.vault = this.buildVault();
		this.fileManager = { trashFile: (file) => this.trashNode(file.path) };
	}

	// ---- test-facing seeding and assertions ----

	/** Seeds a file the way the outside world would, folders and all. */
	seed(path: string, content: string | Uint8Array): void {
		const parent = parentPath(path);
		if (parent !== null) this.seedFolder(parent);
		this.mtime += 1_000;
		this.files.set(path, { data: toBytes(content), mtime: this.mtime });
		this.index(path);
	}

	seedFolder(path: string): void {
		for (const folder of [...ancestorPaths(path), path]) {
			this.folders.add(folder);
			this.index(folder);
		}
	}

	bytes(path: string): Uint8Array | null {
		return this.files.get(path)?.data.slice() ?? null;
	}

	/** Every path on "disk", hidden ones included — what the Vault API cannot tell you. */
	allPaths(): string[] {
		return [...this.files.keys()].sort();
	}

	hasFolder(path: string): boolean {
		return this.folders.has(path);
	}

	/** How many listeners are still registered — the unsubscribe assertion. */
	get watcherCount(): number {
		return this.listeners.size;
	}

	// ---- the Obsidian surfaces the adapter talks to ----

	private buildVault(): VaultApi {
		return {
			configDir: this.configDir,
			getFiles: () =>
				[...this.files.keys()].filter((path) => this.indexed.has(path)).map((p) => this.handle(p)),
			getFileByPath: (path) =>
				this.indexed.has(path) && this.files.has(path) ? this.handle(path) : null,
			getFolderByPath: (path) =>
				this.indexed.has(path) && this.folders.has(path) ? { path } : null,
			readBinary: (file) => {
				const entry = this.files.get(file.path);
				if (entry === undefined) return Promise.reject(new Error(`no such file ${file.path}`));
				return Promise.resolve(toArrayBuffer(entry.data));
			},
			modifyBinary: (file, data) => {
				if (!this.files.has(file.path)) {
					return Promise.reject(new Error(`no such file ${file.path}`));
				}
				this.mtime += 1_000;
				this.files.set(file.path, { data: new Uint8Array(data), mtime: this.mtime });
				this.emit("modify", { path: file.path });
				return Promise.resolve();
			},
			createFolder: (path) => {
				if (this.folders.has(path)) return Promise.reject(new Error("Folder already exists."));
				this.seedFolder(path);
				return Promise.resolve();
			},
			rename: (file, newPath) => {
				const entry = this.files.get(file.path);
				if (entry !== undefined) {
					this.files.delete(file.path);
					this.indexed.delete(file.path);
					this.files.set(newPath, entry);
					this.index(newPath);
					this.emit("rename", { path: newPath }, file.path);
					return Promise.resolve();
				}
				if (!this.folders.has(file.path)) {
					return Promise.reject(new Error(`no such file ${file.path}`));
				}
				this.moveFolder(file.path, newPath);
				this.emit("rename", { path: newPath, children: [] }, file.path);
				return Promise.resolve();
			},
			on: (name, callback) => {
				const listener: Listener = { name, callback };
				this.listeners.add(listener);
				return listener;
			},
			offref: (ref) => {
				this.listeners.delete(ref as Listener);
			},
			adapter: this.buildAdapter(),
		};
	}

	private buildAdapter(): AdapterApi {
		return {
			stat: (path) => Promise.resolve(this.statOf(path)),
			exists: (path) => Promise.resolve(this.files.has(path) || this.folders.has(path)),
			list: (path) => {
				const prefix = path === "" ? "" : `${path}/`;
				const direct = (paths: Iterable<string>): string[] =>
					[...paths].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
				return Promise.resolve({ files: direct(this.files.keys()), folders: direct(this.folders) });
			},
			readBinary: (path) => {
				const entry = this.files.get(path);
				if (entry === undefined) return Promise.reject(new Error(`no such file ${path}`));
				return Promise.resolve(toArrayBuffer(entry.data));
			},
			writeBinary: (path, data) => {
				const parent = parentPath(path);
				if (parent !== null && !this.folders.has(parent)) {
					return Promise.reject(new Error(`missing folder ${parent}`));
				}
				const existed = this.files.has(path);
				this.mtime += 1_000;
				this.files.set(path, { data: new Uint8Array(data), mtime: this.mtime });
				this.acknowledge(existed ? "modify" : "create", path);
				return Promise.resolve();
			},
			mkdir: (path) => {
				for (const folder of [...ancestorPaths(path), path]) {
					this.folders.add(folder);
					this.acknowledgeFolder(folder);
				}
				return Promise.resolve();
			},
			rename: (path, newPath) => {
				const entry = this.files.get(path);
				if (entry === undefined) return Promise.reject(new Error(`no such file ${path}`));
				const occupied = this.files.has(newPath);
				if (occupied && !this.renameClobbers) {
					return Promise.reject(new Error(`file already exists ${newPath}`));
				}
				this.files.delete(path);
				this.indexed.delete(path);
				this.files.set(newPath, entry);
				this.acknowledge("delete", path);
				this.acknowledge(occupied ? "modify" : "create", newPath);
				return Promise.resolve();
			},
			remove: (path) => {
				if (!this.files.delete(path)) return Promise.reject(new Error(`no such file ${path}`));
				this.indexed.delete(path);
				this.acknowledge("delete", path);
				return Promise.resolve();
			},
			trashLocal: (path) => this.trashNode(path),
		};
	}

	// ---- internals ----

	private handle(path: string): VaultFile {
		const entry = this.files.get(path);
		return { path, stat: { mtime: entry?.mtime ?? 0, size: entry?.data.length ?? 0 } };
	}

	private statOf(path: string): AdapterStat | null {
		const entry = this.files.get(path);
		if (entry !== undefined) return { type: "file", mtime: entry.mtime, size: entry.data.length };
		return this.folders.has(path) ? { type: "folder", mtime: 0, size: 0 } : null;
	}

	/** Obsidian indexes nothing whose path has a dot-prefixed segment. */
	private isVisible(path: string): boolean {
		return !path.split("/").some((segment) => segment.startsWith("."));
	}

	private index(path: string): void {
		if (this.isVisible(path)) this.indexed.add(path);
	}

	private moveFolder(from: string, to: string): void {
		const prefix = `${from}/`;
		for (const [path, entry] of [...this.files]) {
			if (!path.startsWith(prefix)) continue;
			this.files.delete(path);
			this.indexed.delete(path);
			const moved = `${to}/${path.slice(prefix.length)}`;
			this.files.set(moved, entry);
			this.index(moved);
		}
		for (const folder of [...this.folders]) {
			if (folder !== from && !folder.startsWith(prefix)) continue;
			this.folders.delete(folder);
			this.indexed.delete(folder);
			this.seedFolder(folder === from ? to : `${to}/${folder.slice(prefix.length)}`);
		}
	}

	/** Soft Delete, files or folders, keeping what it was given. */
	private trashNode(path: string): Promise<void> {
		const entry = this.files.get(path);
		if (entry !== undefined) {
			this.files.delete(path);
			this.indexed.delete(path);
			this.trashed.set(path, entry.data);
			this.emit("delete", { path });
			return Promise.resolve();
		}
		if (!this.folders.has(path)) return Promise.resolve();
		const prefix = `${path}/`;
		for (const [child, childEntry] of [...this.files]) {
			if (!child.startsWith(prefix)) continue;
			this.files.delete(child);
			this.indexed.delete(child);
			this.trashed.set(child, childEntry.data);
		}
		for (const folder of [...this.folders]) {
			if (folder !== path && !folder.startsWith(prefix)) continue;
			this.folders.delete(folder);
			this.indexed.delete(folder);
		}
		this.emit("delete", { path, children: [] });
		return Promise.resolve();
	}

	/** A `DataAdapter` mutation, seen by Obsidian's index only once its watcher fires. */
	private acknowledge(name: VaultEventName, path: string): void {
		if (!this.acknowledgeAdapterWrites) return;
		if (name === "delete") this.indexed.delete(path);
		else this.index(path);
		this.emit(name, { path });
	}

	private acknowledgeFolder(path: string): void {
		if (this.acknowledgeAdapterWrites) this.index(path);
	}

	/** A `TFolder` is told from a `TFile` by the `children` it carries, so folders do. */
	private emit(name: VaultEventName, node: VaultNode & { children?: [] }, oldPath?: string): void {
		if (!this.isVisible(node.path)) return;
		for (const listener of [...this.listeners]) {
			if (listener.name === name) listener.callback(node, oldPath);
		}
	}
}
