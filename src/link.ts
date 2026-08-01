import { SyncEngine } from "./engine/engine";
import type { Plan } from "./engine/plan";
import type { RemotePort, StorePort, VaultPort } from "./engine/ports";
import type { SyncScope } from "./engine/scope";
import type { RunSummary } from "./engine/status";
import type { Timers } from "./engine/timers";
import type { VaultLink } from "./obsidian/data";

/**
 * The link between this vault and a Remote Folder (spec §8.3–8.4), and the only owner
 * of the Sync Engine's lifetime.
 *
 * Three transitions, one per thing a user can do: **stage** a candidate folder so the
 * First-Link dry run has something to plan against, **commit** the plan they approved,
 * and **unlink**. Everything else — the picker, the four modals, the settings states —
 * is presentation on top of these.
 *
 * Two properties are load-bearing:
 *
 * - **A link is a UUID.** The stored path is display-only, so a Remote Folder renamed
 *   or moved on Filen stays the same link (spec §8.3).
 * - **Staging writes nothing.** An engine bound to a candidate folder reads the Sync
 *   State and plans; only a Run writes, and only `commit` starts one. That is what
 *   makes step 2's Cancel free.
 *
 * Deliberately free of `obsidian` and `@filen/sdk` imports: what a link *is* has
 * nothing to do with either, and keeping it that way is what lets the whole flow be
 * tested headlessly (spec §9 layer 1) instead of inside a real Obsidian.
 */

/** The `StorePort` plus the one operation only Unlink needs. */
export type LinkStore = StorePort & {
	/** Drops the Sync State and the Shadow Store; both are recreatable (spec §8.3). */
	reset(): Promise<void>;
};

/** Where the link is persisted — `data.json`, in production (spec §8.1). */
export type LinkPersistence = {
	read(): VaultLink | null;
	write(link: VaultLink | null): Promise<void>;
};

export type LinkOptions = {
	vault: VaultPort;
	store: LinkStore;
	timers: Timers;
	/** The Exclusion List predicate; defaults to everything, as the engine's does. */
	scope?: SyncScope;
	deviceName?: string;
	/** Builds the `RemotePort` for a Remote Folder — the Filen half, injected. */
	remoteFor: (folderUuid: string) => RemotePort;
	data: LinkPersistence;
};

export class Link {
	private readonly options: LinkOptions;
	private readonly listeners = new Set<() => void>();
	/**
	 * The live engine, or the candidate one a dry run is planning against. There is only
	 * ever the one: a vault syncs with a single Remote Folder, and the candidate becomes
	 * the live engine the moment it is committed.
	 */
	private current: { folder: VaultLink; engine: SyncEngine } | null = null;

	constructor(options: LinkOptions) {
		this.options = options;
	}

	/** The linked Remote Folder, or `null`. Read through, never cached. */
	get folder(): VaultLink | null {
		return this.options.data.read();
	}

	get linked(): boolean {
		return this.folder !== null;
	}

	/** The engine, once there is one — the handle the triggers and the status surface use. */
	get engine(): SyncEngine | null {
		return this.current?.engine ?? null;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Opens the engine for a link that survived a restart. Called once the workspace is
	 * ready; a vault with no link gets nothing, which is also what a first run looks like.
	 *
	 * Deliberately does not sync: the startup Reconcile is a *trigger* (spec §4), wired
	 * in ticket 034, and running one from here would sync a vault before any surface
	 * could say it was happening.
	 */
	async start(): Promise<SyncEngine | null> {
		const folder = this.folder;
		if (folder === null || this.current !== null) return this.engine;
		this.current = { folder, engine: await this.open(folder) };
		return this.current.engine;
	}

	/**
	 * An engine bound to a candidate folder, for the dry run (spec §8.4 steps 2–3).
	 * Nothing is persisted and nothing is written on either side until {@link commit}.
	 *
	 * Staging the same folder twice answers with the same engine, so re-opening the
	 * preview does not re-read the Sync State underneath a plan already in flight.
	 */
	async stage(folder: VaultLink): Promise<SyncEngine> {
		// A vault syncs with one Remote Folder: re-linking means unlinking first, and
		// staging over a live engine would strand it mid-Run.
		if (this.linked) throw new Error("Obsen: this vault is already linked");
		if (this.current?.folder.folderUuid === folder.folderUuid) return this.current.engine;
		this.discard();
		const engine = await this.open(folder);
		this.current = { folder, engine };
		return engine;
	}

	/** Abandons a candidate that was never committed — Cancel, at any step of the flow. */
	discard(): void {
		// Guarded, because "abandon the candidate" must never mean "stop the live engine":
		// once a link is committed there is no candidate left to abandon.
		if (!this.linked) this.stop();
	}

	/**
	 * Confirms the First Link: the link is stored, and the plan the user just approved
	 * runs as an ordinary non-blocking Run (spec §8.4 step 4).
	 *
	 * The link is written *before* the Run rather than after it: a Run that crashes
	 * half-way leaves a linked vault whose next Reconcile finishes the job, while an
	 * unlinked vault holding half a sync would have no way back to it.
	 */
	async commit(plan: Plan): Promise<RunSummary> {
		const staged = this.current;
		if (staged === null) throw new Error("Obsen: no Remote Folder is staged to link");
		await this.options.data.write(staged.folder);
		this.announce();
		return await staged.engine.runApprovedPlan(plan);
	}

	/**
	 * Unlink (spec §8.3): the link, the Sync State and the Shadow Store go; not one file
	 * on either side is touched. All three are recreatable — re-linking the same folder
	 * re-bootstraps from what is actually there.
	 *
	 * The order matters. The engine stops first, so nothing it had queued can re-persist
	 * the state that is about to be deleted; the link is dropped next, because that is
	 * the decision the user made and it must not be left half-made; the store is swept
	 * last, and a failure there costs a few recreatable files rather than the unlink.
	 */
	async unlink(): Promise<void> {
		this.current?.engine.stop();
		this.current = null;
		await this.options.data.write(null);
		this.announce();
		try {
			await this.options.store.reset();
		} catch (error) {
			// Leftovers are garbage, not state: the next link re-bootstraps regardless, and
			// telling the user their unlink failed would be worse than untrue.
			console.error("Obsen: could not clear the sync state after unlinking", error);
		}
	}

	/** Stops sync without touching the link — the plugin's unload path. */
	stop(): void {
		this.current?.engine.stop();
		this.current = null;
	}

	private open(folder: VaultLink): Promise<SyncEngine> {
		const { vault, store, timers, scope, deviceName, remoteFor } = this.options;
		return SyncEngine.open({
			vault,
			store,
			timers,
			remote: remoteFor(folder.folderUuid),
			remoteRoot: folder.folderUuid,
			...(scope ? { scope } : {}),
			...(deviceName === undefined ? {} : { deviceName }),
		});
	}

	private announce(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
