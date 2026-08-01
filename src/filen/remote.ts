import type FilenSDK from "@filen/sdk";
import type {
	CloudItem,
	CloudItemTree,
	FileEncryptionVersion,
	FileMetadata,
	FolderMetadata,
} from "@filen/sdk";

import { sha512Hex } from "../engine/hash";
import { baseName, parentPath, toNfc } from "../engine/paths";
import type { RemoteEntry, RemoteEvent, RemotePort } from "../engine/ports";
import { type IndexedFile, metadataOf, SessionIndex } from "./session-index";

/**
 * The production {@link RemotePort} (spec §1.2, §7): `@filen/sdk` on one side, the
 * engine's UUID-addressed vocabulary on the other.
 *
 * Three things this adapter owns, none of which the engine may know about:
 *
 * - **Addressing.** Filen's calls take UUIDs and decrypted metadata; the engine
 *   speaks paths. {@link SessionIndex} is the translation, rebuilt from every
 *   listing.
 * - **`cloud.uploadWebFile` is the only usable upload.** The `fs.writeFile` facade
 *   reaches for Node streams and `nodeCrypto.createHash`, which is a crash on a
 *   phone (research 014).
 * - **Filen's identity semantics**, which the engine's change detection rests on: a
 *   content upload mints a new UUID, a move or rename keeps it.
 */

/**
 * The slice of `sdk.cloud()` this adapter uses — the whole environment dependency,
 * in one place a fake can stand in for.
 */
export interface FilenCloud {
	getDirectoryTree(params: {
		uuid: string;
		skipCache?: boolean;
	}): Promise<Record<string, CloudItemTree>>;
	downloadFileToReadableStream(params: {
		uuid: string;
		bucket: string;
		region: string;
		version: FileEncryptionVersion;
		key: string;
		size: number;
		chunks: number;
	}): ReadableStream<Uint8Array>;
	uploadWebFile(params: { file: File; parent: string; name?: string }): Promise<CloudItem>;
	renameFile(params: { uuid: string; metadata: FileMetadata; name: string }): Promise<void>;
	moveFile(params: { uuid: string; to: string; metadata: FileMetadata }): Promise<void>;
	trashFile(params: { uuid: string }): Promise<void>;
	createDirectory(params: { name: string; parent: string }): Promise<string>;
	renameDirectory(params: { uuid: string; name: string }): Promise<void>;
	moveDirectory(params: { uuid: string; to: string; metadata: FolderMetadata }): Promise<void>;
	trashDirectory(params: { uuid: string }): Promise<void>;
}

/**
 * The adapter over a live SDK. Also the compile-time proof that {@link FilenCloud}
 * really is a slice of `sdk.cloud()` and not a hopeful description of one.
 */
export function createFilenRemote(sdk: FilenSDK, rootUuid: string): FilenRemote {
	return new FilenRemote({ cloud: sdk.cloud(), rootUuid });
}

/**
 * A name the SDK could not decrypt. It substitutes this placeholder rather than
 * failing, and the substitute must never reach the vault: the file's key is part of
 * the same unreadable metadata, so the bytes behind it cannot be fetched either, and
 * materializing the name would create a note whose every download fails.
 *
 * Hiding it does **not** hide a file that would otherwise sync. A file whose
 * metadata will not decrypt has already lost its real path — the tree keys it under
 * this placeholder, not under the name Obsen knows — so the Run sees the real path
 * as missing either way. That is Filen-side corruption, and no adapter can reconcile
 * it; what this filter buys is that the corruption does not also spawn a junk note.
 */
const UNDECRYPTABLE = "CANNOT_DECRYPT_NAME_";

const SHA512_HEX = /^[0-9a-f]{128}$/;

export class FilenRemote implements RemotePort {
	private readonly cloud: FilenCloud;
	/** The Remote Folder: the root every path in the engine's vocabulary is relative to. */
	private readonly rootUuid: string;
	private readonly index: SessionIndex;

	constructor(params: { cloud: FilenCloud; rootUuid: string }) {
		this.cloud = params.cloud;
		this.rootUuid = params.rootUuid;
		this.index = new SessionIndex(params.rootUuid);
	}

	/**
	 * The whole tree in one API call, decrypted — and the moment the session index is
	 * rebuilt from scratch, so a folder deleted by another device stops being an
	 * upload target here too.
	 *
	 * `skipCache` because a Run's first act is to list, and a cached listing would
	 * make the Run reason about a remote that no longer exists.
	 *
	 * Two remote names that normalize to one NFC path both come through, deliberately:
	 * spec §5.8 has the *engine* resolve that collision (`duplicate-remote-path`), and
	 * a port that quietly dropped one would take the choice away from it.
	 */
	async listing(): Promise<RemoteEntry[]> {
		const tree = await this.cloud.getDirectoryTree({ uuid: this.rootUuid, skipCache: true });
		this.index.rebuild();

		const entries: RemoteEntry[] = [];
		for (const [key, item] of Object.entries(tree)) {
			const path = vaultRelative(key);
			// The Remote Folder itself, which the index already holds as the root.
			if (path === "") continue;
			if (isUndecryptable(path)) continue;
			if (item.type === "directory") {
				this.index.addFolder(path, item.uuid);
				continue;
			}
			const file: IndexedFile = { ...item, path, metadata: metadataOf(path, item) };
			this.index.addFile(file);
			entries.push(entryOf(file));
		}
		return entries;
	}

	async download(uuid: string): Promise<Uint8Array> {
		const file = this.index.file(uuid);
		if (file === undefined) throw new Error(`${uuid} is not in the last remote listing`);
		const size = file.metadata.size;
		// The SDK's own read path short-circuits here; a zero-chunk download would
		// otherwise be a request for nothing.
		if (size <= 0) return new Uint8Array(0);

		const stream = this.cloud.downloadFileToReadableStream({
			uuid,
			bucket: file.bucket,
			region: file.region,
			version: file.version,
			key: file.metadata.key,
			size,
			chunks: file.chunks,
		});
		return await collect(stream);
	}

	/**
	 * Uploads content as a brand-new object: Filen mints a fresh UUID even when the
	 * path is occupied, which is exactly the remote change detector the engine reads
	 * (spec §3.1). The old object becomes a version of the new one on Filen's side.
	 */
	async upload(path: string, data: Uint8Array): Promise<{ uuid: string }> {
		const parent = this.index.parentUuid(path);
		const name = baseName(path);
		// `BlobPart` excludes SharedArrayBuffer-backed views, which `Uint8Array` is
		// typed as possibly being. A vault read never is, and copying the whole file to
		// prove it would double peak memory on exactly the large attachments spec §12
		// already flags.
		const part = data as Uint8Array<ArrayBuffer>;
		const file = new File([part], name, { lastModified: Date.now() });

		const item = await this.cloud.uploadWebFile({ file, parent, name });
		if (item.type !== "file") throw new Error(`Filen returned a directory for ${path}`);

		this.index.addFile({
			...item,
			path,
			// Reconstructed, not copied: the upload *response* drops two fields the SDK
			// did encrypt into the metadata — `creation` (which it sets to the File's
			// `lastModified`) and the plaintext digest. Indexing the response verbatim
			// would make a later rename re-encrypt the metadata without them, and losing
			// Filen's hash is losing every other device's cheap change detection.
			metadata: metadataOf(path, {
				...item,
				creation: item.lastModified,
				hash: await sha512Hex(data),
			}),
		});
		return { uuid: item.uuid };
	}

	/**
	 * Move first, then rename. `renameFile` refuses a name already taken **in the
	 * file's current folder**, so renaming before the move would test the wrong folder
	 * — failing on a name that is free at the destination, and passing on one that is
	 * not. `moveFile` cannot make that mistake: it never throws on a collision at all.
	 */
	async move(uuid: string, toPath: string): Promise<void> {
		const file = this.index.file(uuid);
		if (file === undefined) throw new Error(`${uuid} is not in the last remote listing`);

		const metadata: FileMetadata = { ...file.metadata };
		// Compared by path, not by UUID: an unknown destination folder must fail on the
		// lookup rather than silently skip the move.
		if (parentPath(file.path) !== parentPath(toPath)) {
			await this.cloud.moveFile({ uuid, to: this.index.parentUuid(toPath), metadata });
		}
		const name = baseName(toPath);
		if (metadata.name !== name) {
			await this.cloud.renameFile({ uuid, metadata, name });
			metadata.name = name;
		}

		this.index.moveFile(uuid, toPath, metadata);
	}

	/** Soft Delete (spec §5.2): Filen's trash, recoverable, never `deleteFile`. */
	async trashFile(uuid: string): Promise<void> {
		// Deliberately not indexed-first: the UUID may come from a Sync State record
		// older than this session's listing, and trashing it is still the right call.
		await this.cloud.trashFile({ uuid });
		this.index.removeFile(uuid);
	}

	/**
	 * Recursive and idempotent. `createDirectory` returns the existing UUID for a name
	 * that is already taken, so a folder another device created between two listings
	 * is adopted rather than duplicated.
	 */
	async mkdir(path: string): Promise<void> {
		if (path === "") return;
		let parent = this.rootUuid;
		let prefix = "";
		for (const segment of path.split("/")) {
			prefix = prefix === "" ? segment : `${prefix}/${segment}`;
			const known = this.index.folder(prefix);
			if (known !== undefined) {
				parent = known;
				continue;
			}
			parent = await this.cloud.createDirectory({ name: segment, parent });
			this.index.addFolder(prefix, parent);
		}
	}

	async trashFolder(path: string): Promise<void> {
		const uuid = this.index.folder(path);
		// Already gone — another device trashed it, or it never existed. Both are the
		// outcome this call asks for.
		if (uuid === undefined) return;
		await this.cloud.trashDirectory({ uuid });
		this.index.removeSubtree(path);
	}

	async moveFolder(fromPath: string, toPath: string): Promise<void> {
		const uuid = this.index.folder(fromPath);
		if (uuid === undefined) throw new Error(`${fromPath} is not in the last remote listing`);

		const name = baseName(toPath);
		if (parentPath(fromPath) !== parentPath(toPath)) {
			await this.cloud.moveDirectory({
				uuid,
				to: this.index.parentUuid(toPath),
				metadata: { name: baseName(fromPath) },
			});
		}
		if (baseName(fromPath) !== name) await this.cloud.renameDirectory({ uuid, name });

		this.index.moveSubtree(fromPath, toPath);
	}

	/**
	 * Stubbed until ticket 035 wires Filen's socket. Returning a no-op unsubscribe
	 * rather than throwing is the honest shape: the socket is a *trigger*, never a
	 * ledger (spec §7), so an engine that never hears from it is slower to notice a
	 * remote change and no less correct.
	 */
	watch(_onEvent: (event: RemoteEvent) => void): () => void {
		return () => {};
	}
}

/**
 * The tree keys the SDK builds are absolute POSIX paths under the folder it was
 * asked about — `"/"` for the folder itself. The engine's are vault-relative and
 * NFC (spec §5.8), and this boundary is where that becomes true.
 */
function vaultRelative(key: string): string {
	return toNfc(key.startsWith("/") ? key.slice(1) : key);
}

function isUndecryptable(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith(UNDECRYPTABLE));
}

/**
 * A listing row for the engine. `hash` is dropped unless it is a SHA-512 digest:
 * the engine reads an absent hash as *unknown* and re-derives it, but a present one
 * as authoritative, and a download whose bytes disagree with it fails the operation
 * outright (spec §3.1). Anything a foreign client wrote in another format would
 * therefore condemn the file rather than merely cost a hash.
 */
function entryOf(file: IndexedFile): RemoteEntry {
	const hash = file.metadata.hash;
	return {
		path: file.path,
		uuid: file.uuid,
		size: file.metadata.size,
		...(hash !== undefined && SHA512_HEX.test(hash) ? { hash } : {}),
	};
}

/** Drains a download stream into the single buffer the port contract promises. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined || value.byteLength === 0) continue;
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	const data = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return data;
}
