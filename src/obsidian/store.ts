import type { StorePort } from "../engine/ports";
import { encodeUtf8 } from "../engine/text";
import type { ObsenLayout } from "./layout";
import type { AdapterApi } from "./api";
import { writeThenRename } from "./atomic";
import { toArrayBuffer } from "./bytes";

/**
 * The production {@link StorePort} (spec §3): Obsen's own two files-on-disk, the Sync
 * State and the Shadow Store, under the plugin's folder.
 *
 * All of it goes through the `DataAdapter` — not because the Vault API would be nicer,
 * but because it cannot reach here at all: everything under `<configDir>/` is hidden,
 * and Obsidian indexes nothing hidden. Both are excluded from the Sync Scope (spec
 * §2.1), so this is state that describes *this device* and never travels.
 *
 * The two writes are deliberately different:
 *
 * - **Sync State is atomic** (tmp + rename). A half-written state document that still
 *   parsed would be an engine reasoning about a vault that never existed; one that did
 *   not parse would discard the state and force a Re-Bootstrap. Neither is acceptable
 *   for a file rewritten every few seconds during a transfer phase.
 * - **Shadow entries are written in place.** `ShadowStore` re-hashes every entry it
 *   reads and treats a mismatch as *no Ancestor*, so a torn blob costs one Conflict
 *   Copy and never wrong content — and buying atomicity for a per-file write on every
 *   synced note would double the filesystem traffic of a Run on a phone to insure
 *   against something already insured.
 */
export class ObsidianStore implements StorePort {
	private readonly adapter: AdapterApi;
	private readonly layout: ObsenLayout;
	private shadowFolderReady: Promise<void> | null = null;

	constructor(params: { adapter: AdapterApi; layout: ObsenLayout }) {
		this.adapter = params.adapter;
		this.layout = params.layout;
	}

	/** `null` for "no state" — first run, or a state file this device lost. */
	async readState(): Promise<string | null> {
		if (!(await this.adapter.exists(this.layout.stateFile))) return null;
		const bytes = await this.adapter.readBinary(this.layout.stateFile);
		return new TextDecoder().decode(bytes);
	}

	async writeState(json: string): Promise<void> {
		await this.ensureFolder(this.layout.pluginDir);
		// Its scratch file is the `.tmp` sibling spec §2.1 names, rather than the vault
		// adapter's scratch folder: the state file may be written before that folder
		// exists, and the Exclusion List already carves this one name out.
		await writeThenRename({
			adapter: this.adapter,
			scratch: this.layout.stateTmpFile,
			destination: this.layout.stateFile,
			data: encodeUtf8(json),
		});
	}

	async readShadow(hash: string): Promise<Uint8Array | null> {
		const path = this.shadowPath(hash);
		if (!(await this.adapter.exists(path))) return null;
		return new Uint8Array(await this.adapter.readBinary(path));
	}

	async writeShadow(hash: string, data: Uint8Array): Promise<void> {
		await this.ensureFolder(this.layout.shadowDir);
		await this.adapter.writeBinary(this.shadowPath(hash), toArrayBuffer(data));
	}

	/** Idempotent: the mark-and-sweep may name an entry a previous sweep already took. */
	async deleteShadow(hash: string): Promise<void> {
		const path = this.shadowPath(hash);
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
	}

	/**
	 * Content-addressed, one flat folder. The hash is a SHA-512 hex digest the engine
	 * produced, so it is 128 characters of `[0-9a-f]` and needs no escaping — but that is
	 * checked rather than assumed, because a name that reached here with a `/` in it
	 * would write outside the store.
	 */
	private shadowPath(hash: string): string {
		if (!/^[0-9a-f]{128}$/.test(hash)) throw new Error(`not a content hash: ${hash}`);
		return `${this.layout.shadowDir}/${hash}`;
	}

	private async ensureFolder(path: string): Promise<void> {
		if (path === this.layout.shadowDir) {
			this.shadowFolderReady ??= this.adapter.mkdir(path).catch(() => undefined);
			return await this.shadowFolderReady;
		}
		if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
	}
}
