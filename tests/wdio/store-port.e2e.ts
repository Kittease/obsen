import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

/**
 * The production `StorePort` in real Obsidian (spec §9, layer 3): Sync State and the
 * Shadow Store, on a real filesystem, through a real `DataAdapter`.
 *
 * What only this layer can check is that the atomic write survives contact with
 * Obsidian's own adapter — that `rename` over an occupied destination behaves, and that
 * nothing is left behind for the next scan to find.
 */

const HASH = "b".repeat(128);

describe("StorePort in real Obsidian", () => {
	let configDir: string;

	before(async () => {
		configDir = await obsidianPage.getConfigDir();
	});

	it("reads back what it wrote, repeatedly, leaving only the state file", async () => {
		const result = await browser.executeObsidian(async ({ plugins }, dir) => {
			const { store } = plugins.obsen.ports!;
			await store.writeState('{"schemaVersion":1,"files":{}}');
			await store.writeState('{"schemaVersion":1,"files":{"Notes/ま.md":1}}');
			const listed = await plugins.obsen.app.vault.adapter.list(`${dir}/plugins/obsen`);
			return { state: await store.readState(), files: listed.files };
		}, configDir);

		expect(result.state).toBe('{"schemaVersion":1,"files":{"Notes/ま.md":1}}');
		// The tmp sibling must not survive the write it served (spec §2.1 excludes it
		// precisely because it exists for milliseconds).
		expect(result.files).not.toContain(`${configDir}/plugins/obsen/sync-state.json.tmp`);
		expect(result.files).toContain(`${configDir}/plugins/obsen/sync-state.json`);
	});

	it("round-trips a Shadow entry by hash, byte for byte, and sweeps it", async () => {
		const result = await browser.executeObsidian(async ({ plugins }, hash) => {
			const { store } = plugins.obsen.ports!;
			const data = new Uint8Array([0, 1, 127, 128, 255]);
			await store.writeShadow(hash, data);
			const read = await store.readShadow(hash);
			await store.deleteShadow(hash);
			return {
				read: read === null ? null : [...read],
				afterSweep: await store.readShadow(hash),
				missing: await store.readShadow("c".repeat(128)),
			};
		}, HASH);

		expect(result.read).toEqual([0, 1, 127, 128, 255]);
		expect(result.afterSweep).toBe(null);
		// An absent Ancestor is a Conflict Copy, never an error (spec §3.4).
		expect(result.missing).toBe(null);
	});

	it("keeps its own state out of the Sync Scope", async () => {
		const paths = await browser.executeObsidian(async ({ plugins }, hash) => {
			const { store, vault } = plugins.obsen.ports!;
			await store.writeState('{"schemaVersion":1}');
			await store.writeShadow(hash, new Uint8Array([1]));
			return (await vault.list()).map((entry) => entry.path);
		}, HASH);

		expect(paths.filter((path) => path.includes("plugins/obsen/sync-state"))).toEqual([]);
		expect(paths.filter((path) => path.includes("plugins/obsen/shadow"))).toEqual([]);
	});
});
