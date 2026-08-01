import { ancestorPaths, toNfc } from "../engine/paths";
import type { Stat, VaultEvent, VaultPort } from "../engine/ports";
import type { SyncScope } from "../engine/scope";
import type { AdapterApi, FileManagerApi, VaultApi, VaultEventRef, VaultFile, VaultNode } from "./api";
import { fileStat, writeThenRename } from "./atomic";
import { toArrayBuffer } from "./bytes";
import { createExclusionList } from "./exclusions";
import { isConfigPath, type ObsenLayout } from "./layout";
import { createWritablePathCheck, type WritablePathCheck } from "./writable";

/**
 * The production {@link VaultPort} (spec §1.1): Obsidian's vault on one side, the
 * engine's flat NFC-path vocabulary on the other.
 *
 * The shape of this adapter is dictated by one fact about Obsidian: **its Vault API
 * indexes nothing hidden**. `.obsidian/` is hidden, and `.obsidian/` is exactly what
 * spec §2 says must sync so that settings and plugins follow the user. So the adapter
 * has two halves, and {@link isConfigPath} chooses between them per call:
 *
 * - **Vault API** for ordinary content, because it suffices and because it keeps
 *   Obsidian's own index — the thing that draws the file explorer and resolves
 *   wikilinks — correct as Obsen mutates the vault. Deletions go through
 *   `FileManager.trashFile()`, which honours the user's trash preference (spec §1.3).
 * - **`DataAdapter`** for the config dir, which the Vault API cannot reach at all, and
 *   for creating a file atomically, which it cannot do.
 *
 * Three things the engine is entitled to know, all three established against real
 * Obsidian in `tests/wdio/vault-port.e2e.ts` rather than assumed:
 *
 * - **Config-dir changes fire no vault events.** Obsidian does not watch `.obsidian/`
 *   on a plugin's behalf, so another plugin's settings change is picked up by the next
 *   full Run (startup, Foreground-Resume, manual) rather than live. The startup
 *   Reconcile is the backstop spec §4 exists for.
 * - **An adapter write reaches Obsidian's index a beat later** (~260 ms, measured),
 *   once its watcher fires. {@link ObsidianVault.list} covers that window explicitly
 *   rather than letting a just-downloaded note read as a local deletion.
 * - **Names are never rewritten.** Obsidian's `normalizePath()` is deliberately *not*
 *   applied to the paths the engine passes in: it rewrites `\\` to `/` and strips
 *   segments, which would silently turn one remote file into a different local one —
 *   exactly what spec §5.8 forbids ("never auto-renamed"). A name Obsidian's own
 *   normalization would mangle is refused by {@link ObsidianVault.isWritablePath} and
 *   Skip-and-Surfaced instead. Paths this adapter *constructs* are another matter, and
 *   it builds them from `Vault#configDir` alone.
 */

export type ObsidianVaultOptions = {
	vault: VaultApi;
	fileManager: FileManagerApi;
	layout: ObsenLayout;
	/** Windows name rules, from `Platform.isWin` in production (spec §5.8). */
	windows: boolean;
};

export class ObsidianVault implements VaultPort {
	private readonly vault: VaultApi;
	private readonly adapter: AdapterApi;
	private readonly fileManager: FileManagerApi;
	private readonly layout: ObsenLayout;
	private readonly inScope: SyncScope;
	private readonly folderInScope: (path: string) => boolean;
	private readonly writable: WritablePathCheck;

	/**
	 * Paths written through the `DataAdapter` that Obsidian's index has not confirmed
	 * yet, spelled the way they were written rather than normalized — these are used to
	 * `stat` the filesystem, which on Linux will not find a name spelled differently.
	 *
	 * Obsidian's own watcher picks these up quickly (~260 ms, measured on desktop in
	 * `tests/wdio/vault-port.e2e.ts`), but a Run downloads and re-scans faster than that.
	 * Without this set, a note written moments ago would be missing from the next
	 * `list()`, the decision matrix would read that as a local deletion, and Obsen would
	 * propagate a delete for a file it had just created. Entries clear themselves the
	 * first time a `list()` finds Obsidian has caught up.
	 */
	private readonly unacknowledged = new Set<string>();

	/** Serial for scratch names; one Obsen per vault, so a counter is unique enough. */
	private tmpSerial = 0;
	private tmpFolderReady: Promise<void> | null = null;

	constructor(options: ObsidianVaultOptions) {
		this.vault = options.vault;
		this.adapter = options.vault.adapter;
		this.fileManager = options.fileManager;
		this.layout = options.layout;
		const exclusions = createExclusionList(options.layout);
		this.inScope = exclusions.inScope;
		this.folderInScope = exclusions.folderInScope;
		this.writable = createWritablePathCheck({
			configDir: options.layout.configDir,
			windows: options.windows,
		});
	}

	/**
	 * Obsidian's index for ordinary content — already in memory, so a full scan costs an
	 * array walk — plus a directory walk of the config dir, which the index does not
	 * hold, pruned at the folders the Exclusion List has already ruled out.
	 */
	async list(): Promise<{ path: string; stat: Stat }[]> {
		const entries: { path: string; stat: Stat }[] = [];

		for (const file of this.vault.getFiles()) {
			const path = toNfc(file.path);
			// Obsidian has caught up with this one; it needs no vouching for any more.
			// Both spellings, because the set holds the path as it was written and this is
			// its normalized form — on APFS those are routinely not the same string.
			this.unacknowledged.delete(path);
			this.unacknowledged.delete(file.path);
			if (!this.inScope(path)) continue;
			entries.push({ path, stat: statOf(file) });
		}

		for (const onDisk of [...this.unacknowledged]) {
			const stat = fileStat(await this.adapter.stat(onDisk));
			// Gone from disk too: the write was undone, and there is nothing to vouch for.
			if (stat === null) {
				this.unacknowledged.delete(onDisk);
				continue;
			}
			const path = toNfc(onDisk);
			if (this.inScope(path)) entries.push({ path, stat });
		}

		await this.walkConfig(this.layout.configDir, entries);
		return entries;
	}

	async stat(path: string): Promise<Stat | null> {
		const file = this.isConfig(path) ? null : this.vault.getFileByPath(path);
		if (file !== null) return statOf(file);
		// Absent from Obsidian's index means one of two things — genuinely gone, or
		// written through the adapter and not noticed yet (measured at ~260 ms on
		// desktop). The filesystem is the tiebreaker, and it is also the only answer
		// available for the config dir, which the index never holds.
		return fileStat(await this.adapter.stat(path));
	}

	async read(path: string): Promise<Uint8Array> {
		const file = this.isConfig(path) ? null : this.vault.getFileByPath(path);
		const buffer =
			file === null ? await this.adapter.readBinary(path) : await this.vault.readBinary(file);
		return new Uint8Array(buffer);
	}

	/**
	 * Atomic where atomicity is free, and Obsidian's own write path where it is not.
	 *
	 * The port contract asks for tmp + rename (spec §1.1), and that is what a **new**
	 * file gets, along with everything in the config dir: the bytes land in a scratch
	 * file under Obsen's own folder and are renamed into place, so no reader ever sees
	 * half a file.
	 *
	 * Renaming over a file Obsidian has **indexed** is a different story, and the wdio
	 * suite is what established it: Obsidian's watcher reads the replacement as a delete
	 * followed by a create, and **closes the editor tab the file was open in**. For a
	 * sync plugin that is not a cosmetic defect — it would shut the note out from under
	 * the user on every remote edit that arrived while they were reading it. So an
	 * overwrite goes through `Vault.modifyBinary`, which is the same call Obsidian's own
	 * editor saves through: the tab survives, the index stays correct, and the file is
	 * exactly as exposed to a torn write as every note the user types. A torn note is
	 * repaired by the next Run's re-hash; a closed tab is not repaired by anything.
	 */
	async write(path: string, data: Uint8Array): Promise<Stat> {
		const indexed = this.isConfig(path) ? null : this.vault.getFileByPath(path);
		if (indexed !== null) {
			await this.vault.modifyBinary(indexed, toArrayBuffer(data));
		} else {
			await writeThenRename({
				adapter: this.adapter,
				scratch: await this.scratchPath(),
				destination: path,
				data,
			});
			// Only content the Vault API indexes can go missing from `list()`; the config
			// dir is walked with the adapter either way.
			if (!this.isConfig(path)) this.unacknowledged.add(path);
		}

		return this.statAfter(path, "written");
	}

	/**
	 * Deliberately `Vault.rename` and not `FileManager.renameFile`: the latter rewrites
	 * every wikilink pointing at the file, which would be Obsen inventing content changes
	 * to push back to Filen. A sync moves the file and nothing else (spec §5.8).
	 */
	async rename(from: string, to: string): Promise<Stat> {
		const file = this.isConfig(from) ? null : this.vault.getFileByPath(from);
		if (file === null) await this.adapter.rename(from, to);
		else await this.vault.rename(file, to);

		this.unacknowledged.delete(from);
		if (file === null && !this.isConfig(to)) this.unacknowledged.add(to);

		return this.statAfter(to, "renamed");
	}

	/**
	 * Soft Delete (spec §5.2). Tolerating an already-absent path is what makes the
	 * operation redo-safe, which is the whole of the engine's crash recovery (spec §5.5).
	 */
	async trash(path: string): Promise<void> {
		this.unacknowledged.delete(path);
		const file = this.isConfig(path) ? null : this.vault.getFileByPath(path);
		if (file !== null) return await this.fileManager.trashFile(file);
		if (await this.adapter.exists(path)) await this.adapter.trashLocal(path);
	}

	/** Recursive and idempotent, one segment at a time — `createFolder` refuses a repeat. */
	async mkdir(path: string): Promise<void> {
		if (path === "") return;
		for (const folder of [...ancestorPaths(path), path]) {
			if (this.isConfig(folder)) {
				if (!(await this.adapter.exists(folder))) await this.adapter.mkdir(folder);
				continue;
			}
			if (this.vault.getFolderByPath(folder) !== null) continue;
			// Another plugin — or Obsidian's own watcher — may have won the race; the folder
			// existing is the outcome this call asks for either way.
			await this.vault.createFolder(folder).catch(async (error: unknown) => {
				if (!(await this.adapter.exists(folder))) throw error;
			});
		}
	}

	async trashFolder(path: string): Promise<void> {
		const folder = this.isConfig(path) ? null : this.vault.getFolderByPath(path);
		if (folder !== null) return await this.fileManager.trashFile(folder);
		if (await this.adapter.exists(path)) await this.adapter.trashLocal(path);
	}

	isWritablePath(path: string): boolean {
		return this.writable(path);
	}

	/**
	 * Vault events, narrowed to the engine's vocabulary: in-scope **files** only, each
	 * carrying the stat the Own-Writes Filter matches against.
	 *
	 * Two translations happen here. A folder rename arrives as one event and leaves as
	 * one `rename` per file inside it, because the engine's universe is files and its
	 * rename pairing wants the pairs. A rename that crosses the Exclusion List boundary
	 * is reported as what it is from the engine's side of that boundary: a file
	 * appearing, or a file going away.
	 *
	 * Registration must happen inside `workspace.onLayoutReady` — Obsidian replays
	 * `create` for every existing file while a vault loads, and in `onload` that reads as
	 * a vault-wide creation storm (spec §1.3). That is the caller's to get right; the
	 * shell wires it when the triggers arrive (ticket 034).
	 */
	watch(onEvent: (event: VaultEvent) => void): () => void {
		const refs: VaultEventRef[] = [];

		const emitCreateOrModify = (type: "create" | "modify", node: VaultNode): void => {
			const file = this.vault.getFileByPath(node.path);
			if (file === null) return; // a folder, or already gone again
			const path = toNfc(file.path);
			if (this.inScope(path)) onEvent({ type, path, stat: statOf(file) });
		};

		refs.push(this.vault.on("create", (node) => emitCreateOrModify("create", node)));
		refs.push(this.vault.on("modify", (node) => emitCreateOrModify("modify", node)));

		refs.push(
			this.vault.on("delete", (node) => {
				// Obsidian fires one `delete` per file inside a deleted folder *before* the
				// folder's own (verified in the wdio suite), so the files are already
				// accounted for and the folder event is the one thing to drop — the engine's
				// universe is files, and no record anywhere is keyed by a folder (spec §3.1).
				if ("children" in node) return;
				const path = toNfc(node.path);
				if (this.inScope(path)) onEvent({ type: "delete", path, stat: null });
			}),
		);

		refs.push(
			this.vault.on("rename", (node, oldPath) => {
				if (oldPath === undefined) return;
				const pairs =
					"children" in node
						? this.filesUnder(node.path).map((file) => ({
								from: `${toNfc(oldPath)}/${toNfc(file.path).slice(node.path.length + 1)}`,
								file,
							}))
						: [{ from: toNfc(oldPath), file: this.vault.getFileByPath(node.path) }];

				for (const { from, file } of pairs) {
					if (file === null) continue;
					const to = toNfc(file.path);
					const stat = statOf(file);
					if (this.inScope(from) && this.inScope(to)) onEvent({ type: "rename", from, to, stat });
					else if (this.inScope(from)) onEvent({ type: "delete", path: from, stat: null });
					else if (this.inScope(to)) onEvent({ type: "create", path: to, stat });
				}
			}),
		);

		return () => {
			for (const ref of refs) this.vault.offref(ref);
		};
	}

	// ---- internals ----

	private isConfig(path: string): boolean {
		return isConfigPath(this.layout.configDir, path);
	}

	private filesUnder(folder: string): VaultFile[] {
		const prefix = `${folder}/`;
		return this.vault.getFiles().filter((file) => file.path.startsWith(prefix));
	}

	/** The config dir, which the Vault API does not index, one directory at a time. */
	private async walkConfig(folder: string, into: { path: string; stat: Stat }[]): Promise<void> {
		if (!this.folderInScope(folder)) return;
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await this.adapter.list(folder);
		} catch {
			// A config dir that cannot be listed is not a vault whose files were deleted.
			// Reporting nothing for this subtree is the only safe reading (spec §5.7).
			return;
		}
		for (const file of listed.files) {
			const path = toNfc(file);
			if (!this.inScope(path)) continue;
			const stat = fileStat(await this.adapter.stat(file));
			if (stat !== null) into.push({ path, stat });
		}
		for (const child of listed.folders) await this.walkConfig(child, into);
	}

	/** The stat an op has to hand back, or the failure of an op that did not happen. */
	private async statAfter(path: string, verb: string): Promise<Stat> {
		const stat = fileStat(await this.adapter.stat(path));
		if (stat === null) throw new Error(`${path} vanished immediately after being ${verb}`);
		return stat;
	}

	private async scratchPath(): Promise<string> {
		this.tmpFolderReady ??= this.adapter.mkdir(this.layout.tmpDir).catch(() => undefined);
		await this.tmpFolderReady;
		this.tmpSerial += 1;
		return `${this.layout.tmpDir}/${this.tmpSerial}.tmp`;
	}
}

function statOf(file: VaultFile): Stat {
	return { size: file.stat.size, mtime: file.stat.mtime };
}
