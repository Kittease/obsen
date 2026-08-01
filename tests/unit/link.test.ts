import { beforeEach, describe, expect, it } from "vitest";

import type { RemotePort } from "../../src/engine/ports.ts";
import { Link } from "../../src/link.ts";
import type { VaultLink } from "../../src/obsidian/data.ts";
import { createWorld, type SyncWorld } from "../helpers/sync-world.ts";

/**
 * Linking a vault to a Remote Folder, headlessly (spec §8.3–8.4).
 *
 * The `Link` is what the settings tab and the First-Link modals drive: it owns the
 * persisted link, the engine's lifetime, and the three transitions a user can cause —
 * stage a candidate folder for a dry run, commit it, unlink. Everything here is the
 * flow *without* its modals, which is what makes the modals thin enough to leave to the
 * wdio layer.
 */

const FOLDER: VaultLink = { folderUuid: "folder-uuid", path: "Notes/Vault" };

let world: SyncWorld;
let vault: SyncWorld["vault"];
let remote: SyncWorld["remote"];
let store: SyncWorld["store"];
let stored: VaultLink | null;
/** Every folder UUID a `RemotePort` was built for, in order. */
let builtFor: string[];
let link: Link;

beforeEach(() => {
	world = createWorld();
	({ vault, remote, store } = world);
	stored = null;
	builtFor = [];
	link = new Link({
		vault,
		store,
		timers: world.clock,
		remoteFor: (folderUuid): RemotePort => {
			builtFor.push(folderUuid);
			return remote;
		},
		data: {
			read: () => stored,
			write: (value) => {
				stored = value;
				return Promise.resolve();
			},
		},
	});
});

describe("an unlinked vault", () => {
	it("has no folder and no engine, and starting up creates neither", async () => {
		expect(link.linked).toBe(false);
		expect(link.folder).toBe(null);

		await link.start();

		expect(link.engine).toBe(null);
		expect(builtFor).toEqual([]);
	});

	it("opens an engine for a link that survived a restart, and syncs nothing by itself", async () => {
		stored = FOLDER;
		await vault.put("Note.md", "local");

		await link.start();

		expect(link.linked).toBe(true);
		expect(link.engine).not.toBe(null);
		// Bound by UUID: the stored path is display-only, and a folder renamed on Filen
		// since the link was made must not change which folder this is.
		expect(builtFor).toEqual([FOLDER.folderUuid]);
		// Starting up is not syncing — the startup Reconcile is the trigger slice's
		// (ticket 034), and a Run here would sync a vault before the user saw a status.
		expect(remote.paths()).toEqual([]);
	});
});

describe("the First Link dry run (spec §8.4)", () => {
	it("plans against the candidate folder without linking anything", async () => {
		await vault.put("Note.md", "local");
		await remote.put("Remote.md", "remote");

		const engine = await link.stage(FOLDER);
		const plan = await engine.plan();

		expect(plan.counts).toMatchObject({ upload: 1, download: 1 });
		// Staging is not linking: nothing is persisted until the user confirms.
		expect(stored).toBe(null);
		expect(link.linked).toBe(false);
		expect(vault.paths()).toEqual(["Note.md"]);
		expect(remote.paths()).toEqual(["Remote.md"]);
		expect(store.state).toBe(null);
	});

	it("abandons the candidate on Cancel, leaving nothing behind", async () => {
		await link.stage(FOLDER);

		link.discard();

		expect(link.engine).toBe(null);
		expect(stored).toBe(null);
		expect(store.state).toBe(null);
	});

	it("drops the previous candidate when a different folder is staged", async () => {
		const first = await link.stage(FOLDER);
		const second = await link.stage({ folderUuid: "other-uuid", path: "Elsewhere" });

		expect(second).not.toBe(first);
		expect(link.engine).toBe(second);
		expect(builtFor).toEqual(["folder-uuid", "other-uuid"]);
	});

	it("re-uses the candidate when the same folder is staged again", async () => {
		const first = await link.stage(FOLDER);

		expect(await link.stage(FOLDER)).toBe(first);
		expect(builtFor).toEqual([FOLDER.folderUuid]);
	});

	it("stores the link and executes the approved plan on confirmation", async () => {
		await vault.put("Note.md", "local");
		await remote.put("Remote.md", "remote");
		const engine = await link.stage(FOLDER);
		const plan = await engine.plan();

		const summary = await link.commit(plan);
		await world.settle(engine);

		expect(summary.outcome).toBe("ok");
		expect(summary.uploaded).toBe(1);
		expect(summary.downloaded).toBe(1);
		expect(stored).toEqual(FOLDER);
		expect(link.linked).toBe(true);
		expect(link.engine).toBe(engine);
		world.expectConverged({ "Note.md": "local", "Remote.md": "remote" });
	});

	it("refuses to commit a plan nothing was staged for", async () => {
		const engine = await link.stage(FOLDER);
		const plan = await engine.plan();
		link.discard();

		await expect(link.commit(plan)).rejects.toThrow(/staged/i);
		expect(stored).toBe(null);
	});
});

describe("Unlink (spec §8.3)", () => {
	/** A linked vault that has synced once — a link with state and shadow behind it. */
	async function linkedAndSynced(): Promise<void> {
		await vault.put("Note.md", "local");
		await remote.put("Remote.md", "remote");
		const engine = await link.stage(FOLDER);
		await link.commit(await engine.plan());
		await world.settle(engine);
	}

	it("drops the link, the Sync State and the Shadow Store, and no files at all", async () => {
		await linkedAndSynced();
		expect(store.state).not.toBe(null);
		expect(store.shadow.size).toBeGreaterThan(0);

		await link.unlink();

		expect(link.linked).toBe(false);
		expect(link.folder).toBe(null);
		expect(link.engine).toBe(null);
		expect(store.state).toBe(null);
		expect(store.shadow.size).toBe(0);
		// Both sides keep everything: unlinking is forgetting, never deleting.
		world.expectConverged({ "Note.md": "local", "Remote.md": "remote" });
		expect(vault.trashed.size).toBe(0);
		expect(remote.trashed.size).toBe(0);
	});

	it("stops the engine, so nothing it had queued can write state afterwards", async () => {
		await linkedAndSynced();
		const engine = link.engine!;

		await link.unlink();

		await expect(engine.syncNow("manual")).rejects.toThrow(/stopped/i);
		expect(store.state).toBe(null);
	});

	it("re-bootstraps rather than resumes when the same folder is linked again", async () => {
		await linkedAndSynced();
		await link.unlink();

		const engine = await link.stage(FOLDER);

		// No records survived, so the whole vault is reconciled from scratch — the
		// re-bootstrap ticket 031 promises after an Unlink.
		expect(engine.records.size).toBe(0);
		expect(engine.stateReset).toBe("missing");
		const plan = await engine.plan();
		expect(plan.counts.identical).toBe(2);
	});

	it("is safe on a vault that was never linked", async () => {
		await link.unlink();

		expect(link.linked).toBe(false);
		expect(store.state).toBe(null);
	});
});

describe("what the surfaces watch", () => {
	it("tells subscribers when a link appears and when it goes", async () => {
		const seen: (string | null)[] = [];
		link.subscribe(() => seen.push(link.folder?.path ?? null));

		const engine = await link.stage(FOLDER);
		await link.commit(await engine.plan());
		await world.settle(engine);
		await link.unlink();

		expect(seen).toEqual(["Notes/Vault", null]);
	});

	it("stops the engine when the plugin unloads, without touching the link", async () => {
		stored = FOLDER;
		await link.start();

		link.stop();

		expect(link.engine).toBe(null);
		expect(stored).toEqual(FOLDER);
	});
});
