import { sha512Hex } from "../../src/engine/hash.ts";
import { ancestorPaths, parentPath } from "../../src/engine/paths.ts";
import type { RemoteEntry, RemoteEvent, RemotePort } from "../../src/engine/ports.ts";
import { decodeText, toBytes } from "./content.ts";

/**
 * In-memory {@link RemotePort} with Filen's identity semantics, which are the ones
 * the engine reasons about:
 *
 * - a content upload mints a **new** UUID, so a changed file is detectable by UUID
 *   alone (spec §3.1);
 * - a move or rename **keeps** the UUID, which is what makes remote renames free;
 * - the listing carries the plaintext SHA-512 the real API stores — unless
 *   {@link hashless} is set, standing in for the older clients that record none.
 */
export class FakeRemote implements RemotePort {
	private readonly files = new Map<string, { uuid: string; data: Uint8Array; hash: string }>();
	private readonly folders = new Set<string>();
	private readonly watchers = new Set<(event: RemoteEvent) => void>();
	private uuids = 0;

	/** Trashed files by UUID — Soft Delete keeps what it is given. */
	readonly trashed = new Map<string, { path: string; data: Uint8Array }>();

	/** Folders trashed, in the order they were, so phase 5's ordering is observable. */
	readonly trashedFolders: string[] = [];

	readonly calls = { listing: 0, download: 0, upload: 0 };

	/** When set, listing entries omit `hash`: *unknown*, never *unchanged*. */
	hashless = false;

	/** When set, `listing()` rejects with it — the engine must read that as `offline`. */
	listingError: Error | null = null;

	/** Seeds or replaces a file the way *another device* would — folders and all. */
	async put(path: string, content: string | Uint8Array): Promise<string> {
		const parent = parentPath(path);
		if (parent !== null) await this.mkdir(parent);
		const { uuid } = await this.upload(path, toBytes(content));
		return uuid;
	}

	text(path: string): string | null {
		const file = this.files.get(path);
		return file ? decodeText(file.data) : null;
	}

	paths(): string[] {
		return [...this.files.keys()].sort();
	}

	uuidAt(path: string): string | null {
		return this.files.get(path)?.uuid ?? null;
	}

	emit(event: RemoteEvent): void {
		for (const watcher of this.watchers) watcher(event);
	}

	async listing(): Promise<RemoteEntry[]> {
		this.calls.listing += 1;
		if (this.listingError) throw this.listingError;
		return [...this.files.entries()].map(([path, file]) => ({
			path,
			uuid: file.uuid,
			size: file.data.length,
			...(this.hashless ? {} : { hash: file.hash }),
		}));
	}

	download(uuid: string): Promise<Uint8Array> {
		this.calls.download += 1;
		for (const file of this.files.values()) {
			if (file.uuid === uuid) return Promise.resolve(file.data.slice());
		}
		return Promise.reject(new Error(`FakeRemote: no such file ${uuid}`));
	}

	async upload(path: string, data: Uint8Array): Promise<{ uuid: string }> {
		this.calls.upload += 1;
		const parent = parentPath(path);
		if (parent !== null && !this.folders.has(parent)) {
			throw new Error(`FakeRemote: missing folder ${parent}`);
		}
		const uuid = `file-${++this.uuids}`;
		this.files.set(path, { uuid, data: data.slice(), hash: await sha512Hex(data) });
		return { uuid };
	}

	move(uuid: string, toPath: string): Promise<void> {
		for (const [path, file] of this.files) {
			if (file.uuid !== uuid) continue;
			this.files.delete(path);
			this.files.set(toPath, file);
			return Promise.resolve();
		}
		return Promise.reject(new Error(`FakeRemote: no such file ${uuid}`));
	}

	trashFile(uuid: string): Promise<void> {
		for (const [path, file] of this.files) {
			if (file.uuid !== uuid) continue;
			this.files.delete(path);
			this.trashed.set(uuid, { path, data: file.data });
			return Promise.resolve();
		}
		return Promise.reject(new Error(`FakeRemote: no such file ${uuid}`));
	}

	mkdir(path: string): Promise<void> {
		for (const folder of [...ancestorPaths(path), path]) this.folders.add(folder);
		return Promise.resolve();
	}

	trashFolder(path: string): Promise<void> {
		this.trashedFolders.push(path);
		const prefix = `${path}/`;
		for (const [filePath, file] of this.files) {
			if (!filePath.startsWith(prefix)) continue;
			this.files.delete(filePath);
			this.trashed.set(file.uuid, { path: filePath, data: file.data });
		}
		for (const folder of this.folders) {
			if (folder === path || folder.startsWith(prefix)) this.folders.delete(folder);
		}
		return Promise.resolve();
	}

	moveFolder(fromPath: string, toPath: string): Promise<void> {
		const prefix = `${fromPath}/`;
		for (const [path, file] of [...this.files]) {
			if (!path.startsWith(prefix)) continue;
			this.files.delete(path);
			this.files.set(`${toPath}/${path.slice(prefix.length)}`, file);
		}
		return Promise.resolve();
	}

	watch(onEvent: (event: RemoteEvent) => void): () => void {
		this.watchers.add(onEvent);
		return () => this.watchers.delete(onEvent);
	}
}