import type FilenSDK from "@filen/sdk";
import type { CloudItem } from "@filen/sdk";

import { isUndecryptableName } from "./undecryptable";

/**
 * The Filen tree the folder picker browses (spec §8.3).
 *
 * Deliberately **not** part of the `RemotePort`. The port's whole vocabulary is
 * relative to a Remote Folder that has already been chosen; this surface exists to
 * choose one, so it addresses folders by UUID from the account root and knows nothing
 * about paths, hashes or sync. Keeping them apart is also what lets the picker run
 * before a vault is linked at all.
 *
 * Folders only, and no recursion: the modal lists one level at a time, which is the
 * one shape that stays usable on a phone and on a drive with thousands of files.
 */

/** One row in the picker: what it shows, and what a link would store. */
export type RemoteFolder = { uuid: string; name: string };

export interface FolderTree {
	/** Where browsing starts — the account root, selectable behind a warning. */
	readonly root: RemoteFolder;
	children(uuid: string): Promise<RemoteFolder[]>;
	/** "New folder" at the current level; adopts an existing folder of the same name. */
	create(parentUuid: string, name: string): Promise<RemoteFolder>;
}

/**
 * The slice of `sdk.cloud()` a folder tree uses — the whole environment dependency, in
 * one place a fake can stand in for.
 */
export interface FilenDirectories {
	listDirectory(params: { uuid: string; onlyDirectories?: boolean }): Promise<CloudItem[]>;
	createDirectory(params: { name: string; parent: string }): Promise<string>;
}

/**
 * A folder tree over a live SDK, rooted at the account's base folder. Also the
 * compile-time proof that {@link FilenDirectories} is a slice of `sdk.cloud()`.
 *
 * @throws when the SDK is not authenticated — `baseFolderUUID` is only known after a
 * login, and the picker is only reachable from the logged-in settings state.
 */
export function createFilenFolders(sdk: FilenSDK): FilenFolders {
	const rootUuid = sdk.config.baseFolderUUID;
	if (rootUuid === undefined || rootUuid === "") {
		throw new Error("Obsen: the Filen client has no root folder — it is not logged in");
	}
	return new FilenFolders({ cloud: sdk.cloud(), rootUuid });
}

/** What the root row is called; Filen has no name for it, and "/" reads as nothing. */
const ROOT_NAME = "Filen";

export class FilenFolders implements FolderTree {
	private readonly cloud: FilenDirectories;
	readonly root: RemoteFolder;

	constructor(params: { cloud: FilenDirectories; rootUuid: string }) {
		this.cloud = params.cloud;
		this.root = { uuid: params.rootUuid, name: ROOT_NAME };
	}

	/**
	 * The folders directly inside one, sorted the way a reader scans a list rather than
	 * the way an API happens to return them.
	 *
	 * `onlyDirectories` is asked of Filen rather than filtered here, so a drive folder
	 * holding ten thousand photos costs a small response instead of a large one — but the
	 * type filter stays anyway, because the flag is an optimization and the guarantee has
	 * to come from Obsen.
	 */
	async children(uuid: string): Promise<RemoteFolder[]> {
		const items = await this.cloud.listDirectory({ uuid, onlyDirectories: true });
		return items
			.filter((item) => item.type === "directory" && !isUndecryptableName(item.name))
			.map((item) => ({ uuid: item.uuid, name: item.name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Creates a folder, or adopts the one already there: `createDirectory` returns the
	 * existing UUID for a name that is taken, which is the behaviour the picker wants —
	 * "New folder" typed twice should land on one folder, not on `Vault (1)`.
	 */
	async create(parentUuid: string, name: string): Promise<RemoteFolder> {
		const trimmed = name.trim();
		if (trimmed === "") throw new Error("Obsen: a folder name cannot be empty");
		const uuid = await this.cloud.createDirectory({ name: trimmed, parent: parentUuid });
		return { uuid, name: trimmed };
	}
}
