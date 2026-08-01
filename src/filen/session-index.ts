import type { FileEncryptionVersion, FileMetadata } from "@filen/sdk";

import { baseName, parentPath } from "../engine/paths";

/**
 * What the adapter remembers between calls: **Filen addresses parents and files by
 * UUID, Obsen addresses everything by path**, and only a listing knows both.
 *
 * A download needs the file's bucket, region, key and chunk count; an upload needs
 * the UUID of its containing folder; a rename needs the file's decrypted metadata to
 * re-encrypt. None of that is derivable from a path, so a listing is where it comes
 * from — and this is where it is kept until the next one.
 *
 * A cache of the remote, never a source of truth. {@link rebuild} replaces it
 * wholesale, and a Run always lists first (spec §5.1), so the window in which it can
 * be wrong is one Run's execution phase — during which this adapter is the only
 * writer it has to keep up with.
 */

/** One file as the last listing described it — everything a later call needs to address it. */
export type IndexedFile = {
	uuid: string;
	/** Vault-relative, NFC. */
	path: string;
	metadata: FileMetadata;
	bucket: string;
	region: string;
	version: FileEncryptionVersion;
	chunks: number;
};

export class SessionIndex {
	/** UUID → file, from the last listing plus whatever this session wrote since. */
	private files = new Map<string, IndexedFile>();
	/** Vault-relative folder path → UUID; `""` is the Remote Folder itself. */
	private folders = new Map<string, string>();

	constructor(private readonly rootUuid: string) {
		this.folders.set("", rootUuid);
	}

	/** Discards everything a previous listing said. */
	rebuild(): void {
		this.files = new Map();
		this.folders = new Map([["", this.rootUuid]]);
	}

	file(uuid: string): IndexedFile | undefined {
		return this.files.get(uuid);
	}

	/** Records a file, superseding whatever used to hold its path. */
	addFile(file: IndexedFile): void {
		for (const [uuid, known] of this.files) {
			if (known.path === file.path) this.files.delete(uuid);
		}
		this.files.set(file.uuid, file);
	}

	removeFile(uuid: string): void {
		this.files.delete(uuid);
	}

	addFolder(path: string, uuid: string): void {
		this.folders.set(path, uuid);
	}

	folder(path: string): string | undefined {
		return this.folders.get(path);
	}

	/** The UUID a write into `path`'s folder must be addressed to. */
	parentUuid(path: string): string {
		const parent = parentPath(path);
		if (parent === null) return this.rootUuid;
		const uuid = this.folders.get(parent);
		if (uuid === undefined) throw new Error(`no remote folder ${parent}`);
		return uuid;
	}

	/** Moves one file's path, keeping its UUID — Filen's rename semantics. */
	moveFile(uuid: string, toPath: string, metadata: FileMetadata): void {
		const file = this.files.get(uuid);
		if (file === undefined) return;
		this.files.set(uuid, { ...file, path: toPath, metadata });
	}

	/** Forgets a folder and everything under it, as a trash does. */
	removeSubtree(path: string): void {
		const prefix = `${path}/`;
		for (const folder of this.folders.keys()) {
			if (folder === path || folder.startsWith(prefix)) this.folders.delete(folder);
		}
		for (const [uuid, file] of this.files) {
			if (file.path.startsWith(prefix)) this.files.delete(uuid);
		}
	}

	/** Re-paths a folder and everything under it, as a folder move does. */
	moveSubtree(fromPath: string, toPath: string): void {
		const prefix = `${fromPath}/`;
		const rekeyed = (path: string): string => `${toPath}${path.slice(fromPath.length)}`;

		for (const [folder, uuid] of [...this.folders]) {
			if (folder !== fromPath && !folder.startsWith(prefix)) continue;
			this.folders.delete(folder);
			this.folders.set(rekeyed(folder), uuid);
		}
		for (const [uuid, file] of this.files) {
			if (!file.path.startsWith(prefix)) continue;
			this.files.set(uuid, { ...file, path: rekeyed(file.path) });
		}
	}
}

/**
 * The metadata Filen holds for a file, as a listing row describes it.
 *
 * `name` comes from the path rather than the item, because the path is the one the
 * engine will use and the two must not drift.
 */
export function metadataOf(
	path: string,
	item: {
		size: number;
		mime: string;
		key: string;
		lastModified: number;
		creation?: number;
		hash?: string;
	},
): FileMetadata {
	return {
		name: baseName(path),
		size: item.size,
		mime: item.mime,
		key: item.key,
		lastModified: item.lastModified,
		...(item.creation === undefined ? {} : { creation: item.creation }),
		...(item.hash === undefined ? {} : { hash: item.hash }),
	};
}
