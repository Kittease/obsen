import { ancestorPaths, parentPath } from "../../src/engine/paths.ts";
import type { Stat, VaultEvent, VaultPort } from "../../src/engine/ports.ts";
import { decodeText, toBytes } from "./content.ts";

/**
 * In-memory {@link VaultPort}: layer 1 of the testing strategy (spec §9).
 *
 * Modelled on the behaviours the engine actually depends on rather than on a
 * filesystem — files only (folders exist as names), stats that move on every write,
 * a trash that keeps what it is given, and watch events that carry stats so the
 * Own-Writes Filter has something to match against.
 *
 * Every mutation emits an event, including the engine's own writes. That is exactly
 * what production looks like, and it keeps the fake honest for the trigger-wiring
 * slice (ticket 034) that has to filter those echoes.
 */
export class FakeVault implements VaultPort {
	private readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
	private readonly folders = new Set<string>();
	private readonly watchers = new Set<(event: VaultEvent) => void>();
	private mtime: number;

	/** Soft-deleted files, by the path they had — assertions about non-destruction. */
	readonly trashed = new Map<string, Uint8Array>();

	/** Call counts, so tests can prove the change-detection cheap path skipped a read. */
	readonly calls = { list: 0, stat: 0, read: 0, write: 0 };

	/** Paths this "platform" cannot materialize (spec §5.8). */
	unwritable: (path: string) => boolean = () => false;

	constructor(startMtime = 1_700_000_000_000) {
		this.mtime = startMtime;
	}

	/** Seeds or edits a file the way a *user* would — folders and all. */
	async put(path: string, content: string | Uint8Array): Promise<Stat> {
		const parent = parentPath(path);
		if (parent !== null) await this.mkdir(parent);
		return this.write(path, toBytes(content));
	}

	text(path: string): string | null {
		const file = this.files.get(path);
		return file ? decodeText(file.data) : null;
	}

	paths(): string[] {
		return [...this.files.keys()].sort();
	}

	emit(event: VaultEvent): void {
		for (const watcher of this.watchers) watcher(event);
	}

	list(): Promise<{ path: string; stat: Stat }[]> {
		this.calls.list += 1;
		return Promise.resolve(
			[...this.files.entries()].map(([path, file]) => ({
				path,
				stat: { size: file.data.length, mtime: file.mtime },
			})),
		);
	}

	stat(path: string): Promise<Stat | null> {
		this.calls.stat += 1;
		const file = this.files.get(path);
		return Promise.resolve(file ? { size: file.data.length, mtime: file.mtime } : null);
	}

	read(path: string): Promise<Uint8Array> {
		this.calls.read += 1;
		const file = this.files.get(path);
		if (!file) return Promise.reject(new Error(`FakeVault: no such file ${path}`));
		return Promise.resolve(file.data.slice());
	}

	write(path: string, data: Uint8Array): Promise<Stat> {
		this.calls.write += 1;
		const parent = parentPath(path);
		if (parent !== null && !this.folders.has(parent)) {
			// The port contract says parents exist before a write; failing loudly here is
			// what makes the planner's folder phase testable.
			return Promise.reject(new Error(`FakeVault: missing folder ${parent}`));
		}
		const existed = this.files.has(path);
		this.mtime += 1_000;
		this.files.set(path, { data: data.slice(), mtime: this.mtime });
		const stat = { size: data.length, mtime: this.mtime };
		this.emit({ type: existed ? "modify" : "create", path, stat });
		return Promise.resolve(stat);
	}

	rename(from: string, to: string): Promise<Stat> {
		const file = this.files.get(from);
		if (!file) return Promise.reject(new Error(`FakeVault: no such file ${from}`));
		this.files.delete(from);
		this.files.set(to, file);
		const stat = { size: file.data.length, mtime: file.mtime };
		this.emit({ type: "rename", from, to, stat });
		return Promise.resolve(stat);
	}

	trash(path: string): Promise<void> {
		const file = this.files.get(path);
		if (!file) return Promise.reject(new Error(`FakeVault: no such file ${path}`));
		this.files.delete(path);
		this.trashed.set(path, file.data);
		this.emit({ type: "delete", path, stat: null });
		return Promise.resolve();
	}

	mkdir(path: string): Promise<void> {
		for (const folder of [...ancestorPaths(path), path]) this.folders.add(folder);
		return Promise.resolve();
	}

	trashFolder(path: string): Promise<void> {
		const prefix = `${path}/`;
		for (const [filePath, file] of this.files) {
			if (!filePath.startsWith(prefix)) continue;
			this.files.delete(filePath);
			this.trashed.set(filePath, file.data);
		}
		for (const folder of this.folders) {
			if (folder === path || folder.startsWith(prefix)) this.folders.delete(folder);
		}
		return Promise.resolve();
	}

	isWritablePath(path: string): boolean {
		return !this.unwritable(path);
	}

	watch(onEvent: (event: VaultEvent) => void): () => void {
		this.watchers.add(onEvent);
		return () => this.watchers.delete(onEvent);
	}
}