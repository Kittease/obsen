import { beforeEach, describe, expect, it } from "vitest";

import { obsenLayout } from "../../../src/obsidian/layout.ts";
import { ObsidianStore } from "../../../src/obsidian/store.ts";
import { FakeObsidian } from "../../fakes/fake-obsidian.ts";

/**
 * The production `StorePort`: Obsen's Sync State and Shadow Store on disk.
 *
 * Nothing here may end up inside the Sync Scope — a device that synced its own
 * per-device state would have every other device overwrite its idea of what is already
 * synced — and the state document must never be readable half-written.
 */

const LAYOUT = obsenLayout(".obsidian", { id: "obsen", dir: ".obsidian/plugins/obsen" });
const HASH = "a".repeat(128);

let obsidian: FakeObsidian;
let store: ObsidianStore;

beforeEach(() => {
	obsidian = new FakeObsidian();
	obsidian.seedFolder(".obsidian/plugins/obsen");
	store = new ObsidianStore({ adapter: obsidian.vault.adapter, layout: LAYOUT });
});

describe("Sync State", () => {
	it("reads back nothing before anything has been written", async () => {
		expect(await store.readState()).toBeNull();
	});

	it("round-trips a document, unicode and all", async () => {
		const json = JSON.stringify({ schemaVersion: 1, files: { "Notes/ま.md": "ok" } });

		await store.writeState(json);

		expect(await store.readState()).toBe(json);
	});

	it("goes through the tmp sibling the spec names, and leaves it cleaned up", async () => {
		await store.writeState("{}");
		await store.writeState('{"second":true}');

		expect(obsidian.allPaths()).toEqual([".obsidian/plugins/obsen/sync-state.json"]);
		expect(await store.readState()).toBe('{"second":true}');
	});

	it("replaces the previous document even where rename refuses an occupied path", async () => {
		obsidian.renameClobbers = false;
		await store.writeState('{"first":true}');

		await store.writeState('{"second":true}');

		expect(await store.readState()).toBe('{"second":true}');
		expect(obsidian.allPaths()).toEqual([".obsidian/plugins/obsen/sync-state.json"]);
	});

	it("creates the plugin folder when the state is written before anything else", async () => {
		const empty = new FakeObsidian();
		const fresh = new ObsidianStore({ adapter: empty.vault.adapter, layout: LAYOUT });

		await fresh.writeState("{}");

		expect(await fresh.readState()).toBe("{}");
	});
});

describe("Shadow Store", () => {
	it("round-trips a blob by its hash, byte for byte", async () => {
		const data = new Uint8Array([1, 0, 255, 128, 7]);

		await store.writeShadow(HASH, data);

		expect(await store.readShadow(HASH)).toEqual(data);
		expect(obsidian.allPaths()).toEqual([`.obsidian/plugins/obsen/shadow/${HASH}`]);
	});

	it("reads an unknown hash as no Ancestor rather than an error", async () => {
		expect(await store.readShadow(HASH)).toBeNull();
	});

	it("sweeps an entry, and sweeping it twice is not a failure", async () => {
		await store.writeShadow(HASH, new Uint8Array([1]));

		await store.deleteShadow(HASH);
		await store.deleteShadow(HASH);

		expect(await store.readShadow(HASH)).toBeNull();
		expect(obsidian.allPaths()).toEqual([]);
	});

	it("refuses a name that is not a content hash, which could write outside the store", async () => {
		await expect(store.writeShadow("../data.json", new Uint8Array([1]))).rejects.toThrow(
			/not a content hash/,
		);
		await expect(store.readShadow("nested/hash")).rejects.toThrow(/not a content hash/);
	});
});
