import { beforeEach, describe, expect, it } from "vitest";

import type { VaultEvent } from "../../../src/engine/ports.ts";
import { obsenLayout } from "../../../src/obsidian/layout.ts";
import { ObsidianVault } from "../../../src/obsidian/vault.ts";
import { decodeText } from "../../fakes/content.ts";
import { FakeObsidian } from "../../fakes/fake-obsidian.ts";

/**
 * The production `VaultPort`, against an Obsidian that behaves like the real one in the
 * two ways this adapter exists to handle: its Vault API is blind to hidden paths, and
 * its index learns about a `DataAdapter` write only when its own watcher fires.
 *
 * Real Obsidian answers the same questions in `tests/wdio/vault-port.e2e.ts`; these
 * tests are the ones that run in a second and can reproduce a watcher lagging on
 * demand.
 */

const LAYOUT = obsenLayout(".obsidian", { id: "obsen", dir: ".obsidian/plugins/obsen" });

let obsidian: FakeObsidian;
let port: ObsidianVault;

beforeEach(() => {
	obsidian = new FakeObsidian();
	port = new ObsidianVault({
		vault: obsidian.vault,
		fileManager: obsidian.fileManager,
		layout: LAYOUT,
		windows: false,
	});
	obsidian.seedFolder(".obsidian/plugins/obsen");
});

function paths(entries: { path: string }[]): string[] {
	return entries.map((entry) => entry.path).sort();
}

describe("scanning the vault", () => {
	it("lists ordinary notes and the config-dir files the Vault API cannot see", async () => {
		obsidian.seed("Notes/one.md", "one");
		obsidian.seed("attachments/pic.png", "png");
		obsidian.seed(".obsidian/appearance.json", "{}");
		obsidian.seed(".obsidian/plugins/dataview/data.json", "{}");

		expect(paths(await port.list())).toEqual([
			".obsidian/appearance.json",
			".obsidian/plugins/dataview/data.json",
			"Notes/one.md",
			"attachments/pic.png",
		]);
	});

	it("hides everything on the Exclusion List from both halves of the scan", async () => {
		obsidian.seed("Notes/one.md", "one");
		obsidian.seed(".DS_Store", "junk");
		obsidian.seed("Notes/.DS_Store", "junk");
		obsidian.seed(".trash/gone.md", "gone");
		obsidian.seed(".obsidian/workspace.json", "{}");
		obsidian.seed(".obsidian/plugins/obsen/data.json", "{}");
		obsidian.seed(".obsidian/plugins/obsen/sync-state.json", "{}");
		obsidian.seed(".obsidian/plugins/obsen/shadow/abc", "shadow");
		obsidian.seed(".obsidian/plugins/obsen/logs/run.log", "log");

		expect(paths(await port.list())).toEqual(["Notes/one.md"]);
	});

	it("still lists Obsen's own code, which syncs like any other plugin's", async () => {
		obsidian.seed(".obsidian/plugins/obsen/main.js", "code");
		obsidian.seed(".obsidian/plugins/obsen/manifest.json", "{}");

		expect(paths(await port.list())).toEqual([
			".obsidian/plugins/obsen/main.js",
			".obsidian/plugins/obsen/manifest.json",
		]);
	});

	it("reports the size and mtime the engine's cheap path compares", async () => {
		obsidian.seed("Notes/one.md", "12345");

		const [entry] = await port.list();

		expect(entry?.stat.size).toBe(5);
		expect(entry?.stat.mtime).toBeGreaterThan(0);
		expect(await port.stat("Notes/one.md")).toEqual(entry?.stat);
	});

	it("stats a folder and an absent path as no file at all", async () => {
		obsidian.seedFolder("Notes");

		expect(await port.stat("Notes")).toBeNull();
		expect(await port.stat("Notes/nothing.md")).toBeNull();
		expect(await port.stat(".obsidian/plugins")).toBeNull();
	});
});

describe("reading and writing", () => {
	it("round-trips bytes through both halves of the adapter", async () => {
		const data = new Uint8Array([0, 1, 2, 250, 255]);

		await port.write("Notes/one.md", data);
		await port.write(".obsidian/plugins/dataview/data.json", data);

		expect(await port.read("Notes/one.md")).toEqual(data);
		expect(await port.read(".obsidian/plugins/dataview/data.json")).toEqual(data);
	});

	it("returns the resulting stat, so the caller records it without a second trip", async () => {
		const stat = await port.write("Notes/one.md", new Uint8Array([1, 2, 3]));

		expect(stat).toEqual(await port.stat("Notes/one.md"));
		expect(stat.size).toBe(3);
	});

	it("leaves no scratch file behind, and never one inside the Sync Scope", async () => {
		await port.write("Notes/one.md", new Uint8Array([1]));
		await port.write("Notes/two.md", new Uint8Array([2]));

		expect(obsidian.allPaths()).toEqual(["Notes/one.md", "Notes/two.md"]);
	});

	it("overwrites a config-dir file through a rename that refuses the destination", async () => {
		obsidian.renameClobbers = false;
		obsidian.seed(".obsidian/snippets/a.css", "before");

		await port.write(".obsidian/snippets/a.css", new Uint8Array([9]));

		expect(await port.read(".obsidian/snippets/a.css")).toEqual(new Uint8Array([9]));
		expect(obsidian.allPaths()).toEqual([".obsidian/snippets/a.css"]);
	});

	it("edits an indexed note in place rather than replacing the file underneath it", async () => {
		// Renaming over an indexed file reads to Obsidian as a delete plus a create, and
		// it closes the editor tab the note was open in — measured in the wdio suite.
		obsidian.seed("Notes/one.md", "before");
		const events: VaultEvent[] = [];
		port.watch((event) => events.push(event));

		await port.write("Notes/one.md", new Uint8Array([9]));

		expect(events.map((event) => event.type)).toEqual(["modify"]);
		expect(await port.read("Notes/one.md")).toEqual(new Uint8Array([9]));
	});

	it("creates a note that does not exist yet atomically, through the scratch folder", async () => {
		obsidian.seedFolder("Notes");
		const events: VaultEvent[] = [];
		port.watch((event) => events.push(event));

		await port.write("Notes/new.md", new Uint8Array([9]));

		expect(events.map((event) => event.type)).toEqual(["create"]);
		expect(obsidian.allPaths()).toEqual(["Notes/new.md"]);
	});

	it("keeps a just-written note in the scan while Obsidian's watcher lags", async () => {
		obsidian.acknowledgeAdapterWrites = false;

		const stat = await port.write("Notes/downloaded.md", new Uint8Array([1, 2]));

		// The danger this guards: a note missing from the scan reads as a local deletion,
		// and the next Run would propagate a delete for a file Obsen had just created.
		expect(await port.list()).toEqual([{ path: "Notes/downloaded.md", stat }]);
		expect(await port.stat("Notes/downloaded.md")).toEqual(stat);
	});

	it("stops vouching for a lagging write once the file is genuinely gone", async () => {
		obsidian.acknowledgeAdapterWrites = false;
		await port.write("Notes/downloaded.md", new Uint8Array([1, 2]));

		await port.trash("Notes/downloaded.md");

		expect(await port.list()).toEqual([]);
	});
});

describe("moving and deleting", () => {
	it("renames within the vault and reports the moved file's stat", async () => {
		obsidian.seed("Notes/one.md", "body");

		const stat = await port.rename("Notes/one.md", "Archive/one.md");

		expect(obsidian.allPaths()).toEqual(["Archive/one.md"]);
		expect(stat).toEqual(await port.stat("Archive/one.md"));
	});

	it("renames config-dir files, which the Vault API cannot address", async () => {
		obsidian.seed(".obsidian/snippets/a.css", "css");
		obsidian.seedFolder(".obsidian/snippets");

		await port.rename(".obsidian/snippets/a.css", ".obsidian/snippets/b.css");

		expect(obsidian.bytes(".obsidian/snippets/b.css")).not.toBeNull();
	});

	it("soft-deletes rather than destroying, files and folders alike", async () => {
		obsidian.seed("Notes/one.md", "body");
		obsidian.seed("Old/two.md", "other");

		await port.trash("Notes/one.md");
		await port.trashFolder("Old");

		expect(obsidian.allPaths()).toEqual([]);
		expect(decodeText(obsidian.trashed.get("Notes/one.md")!)).toBe("body");
		expect(decodeText(obsidian.trashed.get("Old/two.md")!)).toBe("other");
	});

	it("treats deleting something already gone as done, because every op is redo-safe", async () => {
		await expect(port.trash("Notes/never.md")).resolves.toBeUndefined();
		await expect(port.trashFolder("Nowhere")).resolves.toBeUndefined();
	});

	it("creates folders recursively and idempotently, on both sides of the config dir", async () => {
		await port.mkdir("a/b/c");
		await port.mkdir("a/b/c");
		await port.mkdir(".obsidian/plugins/obsen/shadow");
		await port.mkdir(".obsidian/plugins/obsen/shadow");

		expect(obsidian.hasFolder("a/b")).toBe(true);
		expect(obsidian.hasFolder("a/b/c")).toBe(true);
		expect(obsidian.hasFolder(".obsidian/plugins/obsen/shadow")).toBe(true);
	});
});

describe("watching", () => {
	function collect(): VaultEvent[] {
		const events: VaultEvent[] = [];
		port.watch((event) => events.push(event));
		return events;
	}

	it("reports creates, edits and deletes with the stats the echo filter needs", async () => {
		const events = collect();
		obsidian.seedFolder("Notes");

		await port.write("Notes/one.md", new Uint8Array([1]));
		await port.write("Notes/one.md", new Uint8Array([1, 2]));
		await port.trash("Notes/one.md");

		expect(events.map((event) => event.type)).toEqual(["create", "modify", "delete"]);
		expect(events[0]).toMatchObject({ path: "Notes/one.md", stat: { size: 1 } });
		expect(events[1]).toMatchObject({ stat: { size: 2 } });
		expect(events[2]).toMatchObject({ stat: null });
	});

	it("says nothing about paths outside the Sync Scope", async () => {
		const events = collect();
		obsidian.seedFolder("Notes");

		await port.write("Notes/.DS_Store", new Uint8Array([1]));
		await port.write(".obsidian/plugins/obsen/sync-state.json", new Uint8Array([1]));

		expect(events).toEqual([]);
	});

	it("expands a folder rename into the file renames the pairing pass wants", async () => {
		obsidian.seed("Old/one.md", "one");
		obsidian.seed("Old/deep/two.md", "two");
		const events = collect();

		await obsidian.vault.rename({ path: "Old" }, "New");

		expect(events).toMatchObject([
			{ type: "rename", from: "Old/one.md", to: "New/one.md", stat: { size: 3 } },
			{ type: "rename", from: "Old/deep/two.md", to: "New/deep/two.md", stat: { size: 3 } },
		]);
	});

	it("reads a rename across the Exclusion List boundary from the engine's side of it", async () => {
		obsidian.seed("Notes/one.md", "one");
		obsidian.seed("Notes/Thumbs.db", "junk");
		const events = collect();

		// Out of scope: from the engine's side the file simply stopped existing…
		await obsidian.vault.rename({ path: "Notes/one.md" }, "Notes/desktop.ini");
		// …and coming back into scope is a file appearing, with nothing to pair it to.
		await obsidian.vault.rename({ path: "Notes/Thumbs.db" }, "Notes/two.md");

		expect(events).toMatchObject([
			{ type: "delete", path: "Notes/one.md", stat: null },
			{ type: "create", path: "Notes/two.md", stat: { size: 4 } },
		]);
	});

	it("stops delivering once unsubscribed, and leaves nothing registered", async () => {
		const events: VaultEvent[] = [];
		const stop = port.watch((event) => events.push(event));
		obsidian.seedFolder("Notes");

		stop();
		await port.write("Notes/one.md", new Uint8Array([1]));

		expect(events).toEqual([]);
		expect(obsidian.watcherCount).toBe(0);
	});
});

describe("names this device cannot hold", () => {
	it("refuses what Obsidian would never show, and accepts ordinary notes", () => {
		expect(port.isWritablePath("Notes/one.md")).toBe(true);
		expect(port.isWritablePath("Notes/.hidden.md")).toBe(false);
		expect(port.isWritablePath(".obsidian/plugins/obsen/main.js")).toBe(true);
	});
});
