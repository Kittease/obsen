import type { CloudItem, CloudItemTree, FileMetadata, FolderMetadata } from "@filen/sdk";

import { sha512Hex } from "../../src/engine/hash.ts";
import { baseName, parentPath } from "../../src/engine/paths.ts";
import type { FilenCloud } from "../../src/filen/remote.ts";
import { toBytes } from "./content.ts";

/**
 * In-memory `sdk.cloud()` with Filen's semantics, for testing the `RemotePort`
 * adapter headlessly (spec §9 layer 1). The real-remote suite is what proves these
 * semantics are Filen's; this fake is what makes the adapter's *bookkeeping* —
 * the parent-UUID index, move-then-rename ordering, subtree rekeying — cheap to
 * pin down case by case.
 *
 * The semantics it copies, because the adapter depends on each:
 *
 * - an upload mints a **new** UUID and supersedes any file of the same name in the
 *   same folder; a move or rename **keeps** the UUID;
 * - `createDirectory` returns the **existing** UUID for a name already taken;
 * - `renameFile`/`renameDirectory` refuse a name already taken **in the item's
 *   current folder** — the source folder, not the destination — while `moveFile`/
 *   `moveDirectory` never refuse at all. That asymmetry is why the adapter moves
 *   before it renames, so it is modelled rather than tidied away;
 * - `renameFile` re-encrypts whatever metadata it is handed, so a caller that
 *   reconstructs the metadata badly silently rewrites it;
 * - the upload *response* omits the plaintext hash and `creation` that the same call
 *   just encrypted into the metadata — the trap that makes the point above bite;
 * - a download is addressed by UUID *plus* the bucket/region/key/chunk parameters
 *   from the listing — get one wrong and the real API returns garbage, so here it
 *   throws.
 */

type FakeDirectory = { uuid: string; name: string; parent: string };

type FakeFile = {
	uuid: string;
	name: string;
	parent: string;
	data: Uint8Array;
	metadata: FileMetadata;
	bucket: string;
	region: string;
	version: 2;
	chunks: number;
};

export const FAKE_ROOT = "root-uuid";

/** Fixed, so nothing in a test depends on when it ran. */
const SEEDED_AT = 1_700_000_000_000;

export class FakeCloud implements FilenCloud {
	private readonly directories = new Map<string, FakeDirectory>();
	private readonly files = new Map<string, FakeFile>();
	private ids = 0;

	readonly calls = { listing: 0, download: 0, upload: 0, createDirectory: 0 };
	readonly trashedFiles: string[] = [];
	readonly trashedDirectories: string[] = [];

	/** Seeds a file the way another device would, creating its folders on the way. */
	async put(
		path: string,
		content: string | Uint8Array = "",
		options: { hash?: string | null } = {},
	): Promise<string> {
		const data = toBytes(content);
		const parent = await this.makeDirectories(parentPath(path) ?? "");
		const hash = options.hash === undefined ? await sha512Hex(data) : options.hash;
		return this.store(baseName(path), parent, data, hash, SEEDED_AT).uuid;
	}

	/** Seeds an empty folder — the case no file path implies. */
	async putDirectory(path: string): Promise<string> {
		return await this.makeDirectories(path);
	}

	/** Every live file path, relative to the Remote Folder, sorted. */
	paths(): string[] {
		return [...this.files.values()].map((file) => this.pathOf(file)).sort();
	}

	uuidAt(path: string): string | null {
		for (const file of this.files.values()) if (this.pathOf(file) === path) return file.uuid;
		return null;
	}

	bytesAt(path: string): Uint8Array | null {
		for (const file of this.files.values()) if (this.pathOf(file) === path) return file.data;
		return null;
	}

	/** The metadata Filen holds for a path — what a rename re-encrypts, right or wrong. */
	metadataAt(path: string): FileMetadata | null {
		for (const file of this.files.values()) if (this.pathOf(file) === path) return file.metadata;
		return null;
	}

	directoryPaths(): string[] {
		return [...this.directories.values()].map((directory) => this.pathOf(directory)).sort();
	}

	uuidOfDirectory(path: string): string | null {
		for (const directory of this.directories.values()) {
			if (this.pathOf(directory) === path) return directory.uuid;
		}
		return null;
	}

	async getDirectoryTree(params: {
		uuid: string;
		skipCache?: boolean;
	}): Promise<Record<string, CloudItemTree>> {
		this.calls.listing += 1;
		const tree: Record<string, CloudItemTree> = {};
		const paths = new Map<string, string>([[params.uuid, "/"]]);

		// Parents before children, exactly as the API's flat folder list resolves.
		let pending = [...this.directories.values()];
		for (let progress = true; progress && pending.length > 0; ) {
			progress = false;
			const unresolved: FakeDirectory[] = [];
			for (const directory of pending) {
				const parent = paths.get(directory.parent);
				if (parent === undefined) {
					unresolved.push(directory);
					continue;
				}
				progress = true;
				const path = join(parent, directory.name);
				paths.set(directory.uuid, path);
				tree[path] = directoryItem(directory.uuid, directory.name, directory.parent);
			}
			pending = unresolved;
		}

		for (const file of this.files.values()) {
			const parent = paths.get(file.parent);
			if (parent === undefined) continue; // outside the requested subtree
			tree[join(parent, file.name)] = { type: "file", ...fileFields(file) };
		}

		tree["/"] = directoryItem(params.uuid, "root", "base");
		return tree;
	}

	downloadFileToReadableStream(params: {
		uuid: string;
		bucket: string;
		region: string;
		version: number;
		key: string;
		size: number;
		chunks: number;
	}): ReadableStream<Uint8Array> {
		this.calls.download += 1;
		const file = this.expectFile(params.uuid);
		for (const [field, expected] of [
			["bucket", file.bucket],
			["region", file.region],
			["key", file.metadata.key],
			["version", file.version],
			["size", file.metadata.size],
			["chunks", file.chunks],
		] as const) {
			if (params[field] !== expected) {
				throw new Error(`FakeCloud: wrong ${field} for ${params.uuid}`);
			}
		}

		// Split, so a reader that keeps only the last chunk fails here rather than on
		// the first file big enough to arrive in pieces.
		const half = Math.floor(file.data.byteLength / 2);
		const parts = [file.data.subarray(0, half), file.data.subarray(half)];
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of parts) controller.enqueue(part);
				controller.close();
			},
		});
	}

	async uploadWebFile(params: { file: File; parent: string; name?: string }): Promise<CloudItem> {
		this.calls.upload += 1;
		this.expectParent(params.parent);
		const name = params.name ?? params.file.name;
		const data = new Uint8Array(await params.file.arrayBuffer());
		const file = this.store(
			name,
			params.parent,
			data,
			await sha512Hex(data),
			params.file.lastModified,
		);

		const { hash: _hash, creation: _creation, ...returned } = fileFields(file);
		// The response the real SDK builds by hand: no `hash`, no `creation`, even
		// though it encrypted both into the metadata a moment ago.
		return { type: "file", ...returned, rm: `rm-${file.uuid}` };
	}

	async renameFile(params: { uuid: string; metadata: FileMetadata; name: string }): Promise<void> {
		const file = this.expectFile(params.uuid);
		// Against the file's *current* folder — the trap the adapter has to move around.
		if (this.findChild(params.name, file.parent, params.uuid) !== null) {
			throw new Error("A file with the same name already exists in this directory.");
		}
		file.name = params.name;
		// The real call re-encrypts `{...metadata, name}`, so the caller's metadata is
		// what survives — including a stale key, size or missing hash.
		file.metadata = { ...params.metadata, name: params.name };
	}

	async moveFile(params: { uuid: string; to: string; metadata: FileMetadata }): Promise<void> {
		const file = this.expectFile(params.uuid);
		this.expectParent(params.to);
		// No collision check that throws: the real `moveFile` only trashes a colliding
		// file when asked to overwrite, and otherwise moves regardless.
		file.parent = params.to;
	}

	async trashFile(params: { uuid: string }): Promise<void> {
		this.trashedFiles.push(params.uuid);
		this.files.delete(params.uuid);
	}

	async createDirectory(params: { name: string; parent: string }): Promise<string> {
		this.calls.createDirectory += 1;
		this.expectParent(params.parent);
		const existing = this.findDirectory(params.name, params.parent);
		if (existing !== null) return existing;
		const uuid = `dir-${++this.ids}`;
		this.directories.set(uuid, { uuid, name: params.name, parent: params.parent });
		return uuid;
	}

	async renameDirectory(params: { uuid: string; name: string }): Promise<void> {
		const directory = this.expectDirectory(params.uuid);
		const existing = this.findDirectory(params.name, directory.parent);
		if (existing !== null && existing !== params.uuid) {
			throw new Error("A directory with the same name already exists in this directory.");
		}
		directory.name = params.name;
	}

	async moveDirectory(params: {
		uuid: string;
		to: string;
		metadata: FolderMetadata;
	}): Promise<void> {
		const directory = this.expectDirectory(params.uuid);
		this.expectParent(params.to);
		directory.parent = params.to;
	}

	async trashDirectory(params: { uuid: string }): Promise<void> {
		this.trashedDirectories.push(params.uuid);
		const doomed = new Set([params.uuid]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const directory of this.directories.values()) {
				if (doomed.has(directory.parent) && !doomed.has(directory.uuid)) {
					doomed.add(directory.uuid);
					grew = true;
				}
			}
		}
		for (const uuid of doomed) this.directories.delete(uuid);
		for (const [uuid, file] of this.files) if (doomed.has(file.parent)) this.files.delete(uuid);
	}

	/** Files content the way an upload does: a fresh UUID, superseding a same-named sibling. */
	private store(
		name: string,
		parent: string,
		data: Uint8Array,
		hash: string | null,
		lastModified: number,
	): FakeFile {
		const uuid = `file-${++this.ids}`;
		const superseded = this.findChild(name, parent, uuid);
		if (superseded !== null) this.files.delete(superseded);

		const file: FakeFile = {
			uuid,
			name,
			parent,
			data,
			metadata: {
				name,
				size: data.byteLength,
				mime: "text/markdown",
				key: `key-${uuid}`,
				lastModified,
				creation: lastModified,
				...(hash === null ? {} : { hash }),
			},
			bucket: `bucket-${uuid}`,
			region: "eu-central-1",
			version: 2,
			chunks: 1,
		};
		this.files.set(uuid, file);
		return file;
	}

	private async makeDirectories(path: string): Promise<string> {
		let parent = FAKE_ROOT;
		if (path === "") return parent;
		for (const segment of path.split("/")) {
			parent = await this.createDirectory({ name: segment, parent });
		}
		return parent;
	}

	private findChild(name: string, parent: string, except: string): string | null {
		for (const file of this.files.values()) {
			if (file.parent === parent && file.name === name && file.uuid !== except) return file.uuid;
		}
		return null;
	}

	private findDirectory(name: string, parent: string): string | null {
		for (const directory of this.directories.values()) {
			if (directory.parent === parent && directory.name === name) return directory.uuid;
		}
		return null;
	}

	private pathOf(item: { name: string; parent: string }): string {
		const segments = [item.name];
		for (
			let parent = this.directories.get(item.parent);
			parent !== undefined;
			parent = this.directories.get(parent.parent)
		) {
			segments.unshift(parent.name);
		}
		return segments.join("/");
	}

	private expectFile(uuid: string): FakeFile {
		const file = this.files.get(uuid);
		if (!file) throw new Error(`FakeCloud: no file ${uuid}`);
		return file;
	}

	private expectDirectory(uuid: string): FakeDirectory {
		const directory = this.directories.get(uuid);
		if (!directory) throw new Error(`FakeCloud: no directory ${uuid}`);
		return directory;
	}

	private expectParent(uuid: string): void {
		if (uuid !== FAKE_ROOT && !this.directories.has(uuid)) {
			throw new Error(`FakeCloud: no such parent ${uuid}`);
		}
	}
}

function join(parent: string, name: string): string {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

/** The file fields both a tree row and an upload response are built from. */
function fileFields(file: FakeFile): Omit<CloudItemTree & { type: "file" }, "type"> {
	return {
		uuid: file.uuid,
		name: file.name,
		parent: file.parent,
		size: file.metadata.size,
		mime: file.metadata.mime,
		key: file.metadata.key,
		lastModified: file.metadata.lastModified,
		...(file.metadata.creation === undefined ? {} : { creation: file.metadata.creation }),
		...(file.metadata.hash === undefined ? {} : { hash: file.metadata.hash }),
		bucket: file.bucket,
		region: file.region,
		version: file.version,
		chunks: file.chunks,
		timestamp: SEEDED_AT,
		favorited: false,
	};
}

function directoryItem(uuid: string, name: string, parent: string): CloudItemTree {
	return {
		type: "directory",
		uuid,
		name,
		parent,
		size: 0,
		timestamp: SEEDED_AT,
		lastModified: SEEDED_AT,
		favorited: false,
		color: null,
	};
}
