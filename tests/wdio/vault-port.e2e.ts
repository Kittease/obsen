import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

/**
 * The production `VaultPort`, driven inside a real, sandboxed Obsidian (spec §9,
 * layer 3).
 *
 * The unit suite proves the adapter honours its contracts against an Obsidian *modelled*
 * on the two behaviours it is built around. Only this suite can say whether the model is
 * right: that `.obsidian/` really is invisible to the Vault API, that a file written
 * through the `DataAdapter` really does reach `getFiles()`, and that a folder rename
 * really does arrive as one event.
 *
 * Everything runs through `executeObsidian`, which stringifies the callback and runs it
 * inside Obsidian — so nothing here can close over a local, and everything returned has
 * to survive JSON.
 */

/** The same name, composed and decomposed — what an APFS vault hands back. */
const NFC_NAME = "Notes/caf\u00e9.md";
const NFD_NAME = "Notes/cafe\u0301.md";

describe("VaultPort in real Obsidian", () => {
	let configDir: string;

	before(async () => {
		configDir = await obsidianPage.getConfigDir();
	});

	beforeEach(async () => {
		await obsidianPage.resetVault();
	});

	it("loads the plugin and builds its ports", async () => {
		const loaded = await browser.executeObsidian(({ plugins }) => ({
			hasPorts: plugins.obsen.ports !== null,
			pluginDir: plugins.obsen.ports?.layout.pluginDir ?? null,
			layoutReady: plugins.obsen.app.workspace.layoutReady,
		}));

		expect(loaded.hasPorts).toBe(true);
		expect(loaded.pluginDir).toBe(`${configDir}/plugins/obsen`);
		expect(loaded.layoutReady).toBe(true);
	});

	describe("scanning", () => {
		it("sees ordinary notes and the config-dir files the Vault API cannot", async () => {
			const paths = await browser.executeObsidian(async ({ plugins }) =>
				(await plugins.obsen.ports!.vault.list()).map((entry) => entry.path),
			);

			expect(paths).toContain("Notes/one.md");
			expect(paths).toContain("Notes/deep/two.md");
			expect(paths).toContain("attachments/notes.txt");
			// The reason the adapter has a second half at all: Obsidian indexes none of these.
			expect(paths).toContain(`${configDir}/app.json`);
			expect(paths).toContain(`${configDir}/plugins/other/data.json`);
			// Obsen's own code syncs like any other plugin's (spec §2.1).
			expect(paths).toContain(`${configDir}/plugins/obsen/manifest.json`);
		});

		it("honours the Exclusion List on both halves of the scan", async () => {
			await browser.executeObsidian(async ({ plugins }, dir) => {
				const { vault, store } = plugins.obsen.ports!;
				await store.writeState('{"schemaVersion":1}');
				await store.writeShadow("a".repeat(128), new Uint8Array([1, 2, 3]));
				await vault.write("Notes/.DS_Store", new Uint8Array([0]));
				await vault.write(`${dir}/plugins/obsen/data.json`, new Uint8Array([123, 125]));
			}, configDir);

			const paths = await browser.executeObsidian(async ({ plugins }) =>
				(await plugins.obsen.ports!.vault.list()).map((entry) => entry.path),
			);

			expect(paths).not.toContain(`${configDir}/workspace.json`);
			expect(paths).not.toContain(`${configDir}/plugins/obsen/data.json`);
			expect(paths).not.toContain(`${configDir}/plugins/obsen/sync-state.json`);
			expect(paths).not.toContain("Notes/.DS_Store");
			expect(paths.filter((path) => path.includes("/shadow/"))).toEqual([]);
			expect(paths.filter((path) => path.startsWith(".trash/"))).toEqual([]);
		});

		it("reports NFC paths, and preserves the case a name was created with", async () => {
			const listed = await browser.executeObsidian(async ({ app, plugins }, decomposed) => {
				const { vault } = plugins.obsen.ports!;
				// A decomposed name, which is what an APFS vault hands back and what a
				// remote written from a Mac can carry. The engine is promised NFC either
				// way (spec §5.8), and this is the loop that promise breaks if it does not.
				await vault.write(decomposed, new Uint8Array([1]));
				await vault.write("Notes/MixedCase.md", new Uint8Array([1]));

				const beforeIndexing = (await vault.list()).map((entry) => entry.path);
				for (
					let waited = 0;
					waited < 10_000 && !app.vault.getFileByPath(decomposed);
					waited += 100
				) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				return {
					beforeIndexing,
					afterIndexing: (await vault.list()).map((e) => e.path),
				};
			}, NFD_NAME);

			// Both halves of the scan normalize: the one that trusts Obsidian's index, and
			// the one that vouches for a write the index has not caught up with.
			for (const paths of [listed.beforeIndexing, listed.afterIndexing]) {
				expect(paths).toContain(NFC_NAME);
				expect(paths).not.toContain(NFD_NAME);
				// …and case is never folded, because the engine compares case-sensitively.
				expect(paths).toContain("Notes/MixedCase.md");
				expect(paths).not.toContain("Notes/mixedcase.md");
			}
		});
	});

	describe("reading and writing", () => {
		it("round-trips bytes, and hands back the stat it wrote", async () => {
			const result = await browser.executeObsidian(async ({ plugins }) => {
				const { vault } = plugins.obsen.ports!;
				const data = new Uint8Array([0, 1, 2, 253, 254, 255]);
				const stat = await vault.write("attachments/bytes.bin", data);
				return {
					stat,
					read: [...(await vault.read("attachments/bytes.bin"))],
					statAgain: await vault.stat("attachments/bytes.bin"),
				};
			});

			expect(result.read).toEqual([0, 1, 2, 253, 254, 255]);
			expect(result.stat.size).toBe(6);
			expect(result.statAgain).toEqual(result.stat);
		});

		it("makes a written note visible to the very next scan", async () => {
			// The window this closes: Obsidian learns about a `DataAdapter` write from its
			// own watcher, and a note missing from the next scan reads as a local deletion.
			const found = await browser.executeObsidian(async ({ plugins }) => {
				const { vault } = plugins.obsen.ports!;
				await vault.mkdir("Downloaded");
				await vault.write("Downloaded/fresh.md", new Uint8Array([104, 105]));
				return (await vault.list()).map((entry) => entry.path);
			});

			expect(found).toContain("Downloaded/fresh.md");
		});

		it("leaves no scratch file behind after an atomic write", async () => {
			const leftovers = await browser.executeObsidian(async ({ plugins }, dir) => {
				const { vault } = plugins.obsen.ports!;
				await vault.write("Notes/one.md", new Uint8Array([49]));
				await vault.write("Notes/one.md", new Uint8Array([50]));
				const tmp = await plugins.obsen.app.vault.adapter.list(`${dir}/plugins/obsen/tmp`);
				return tmp.files;
			}, configDir);

			expect(leftovers).toEqual([]);
		});

		it("overwrites an existing note without closing the tab it is open in", async () => {
			// The finding this test exists for: replacing an indexed file by renaming over
			// it reads to Obsidian as a delete plus a create, and it **closes the editor
			// tab** — which for a sync plugin means shutting the note the user is reading
			// on every remote edit that lands. Overwrites go through `Vault.modifyBinary`
			// for exactly this reason; this is the assertion that keeps them there.
			const result = await browser.executeObsidian(async ({ app, plugins }) => {
				const { vault } = plugins.obsen.ports!;
				await app.workspace.openLinkText("Notes/one.md", "", true);
				await new Promise((resolve) => setTimeout(resolve, 1_000));

				await vault.write("Notes/one.md", new TextEncoder().encode("replaced"));
				await new Promise((resolve) => setTimeout(resolve, 2_000));

				return {
					text: new TextDecoder().decode(await vault.read("Notes/one.md")),
					openTabs: app.workspace.getLeavesOfType("markdown").length,
					activeFile: app.workspace.getActiveFile()?.path ?? null,
				};
			});

			expect(result.text).toBe("replaced");
			expect(result.openTabs).toBe(1);
			expect(result.activeFile).toBe("Notes/one.md");
		});
	});

	describe("moving and deleting", () => {
		it("renames a note without rewriting the links pointing at it", async () => {
			const after = await browser.executeObsidian(async ({ plugins }) => {
				const { vault } = plugins.obsen.ports!;
				await vault.write("Notes/linker.md", new TextEncoder().encode("see [[one]]"));
				await vault.mkdir("Archive");
				await vault.rename("Notes/one.md", "Archive/one.md");
				return {
					paths: (await vault.list()).map((entry) => entry.path),
					linker: new TextDecoder().decode(await vault.read("Notes/linker.md")),
				};
			});

			expect(after.paths).toContain("Archive/one.md");
			expect(after.paths).not.toContain("Notes/one.md");
			// A sync moves the file and nothing else: rewriting the link would be Obsen
			// inventing a content change to push back to Filen (spec §5.8).
			expect(after.linker).toBe("see [[one]]");
		});

		it("soft-deletes files and folders, and shrugs at what is already gone", async () => {
			const remaining = await browser.executeObsidian(async ({ plugins }) => {
				const { vault } = plugins.obsen.ports!;
				await vault.trash("Notes/one.md");
				await vault.trashFolder("Notes/deep");
				await vault.trash("Notes/one.md"); // redo-safe: already gone is done
				await vault.trashFolder("Nowhere");
				return (await vault.list()).map((entry) => entry.path);
			});

			expect(remaining).not.toContain("Notes/one.md");
			expect(remaining).not.toContain("Notes/deep/two.md");
			// Whatever the user's trash preference is, the content left the vault tree and
			// nothing under `.trash/` is ever in scope (spec §2.1).
			expect(remaining.filter((path) => path.startsWith(".trash/"))).toEqual([]);
		});

		it("creates folders recursively and idempotently", async () => {
			const exists = await browser.executeObsidian(async ({ plugins }) => {
				const { vault } = plugins.obsen.ports!;
				await vault.mkdir("a/b/c");
				await vault.mkdir("a/b/c");
				await vault.write("a/b/c/note.md", new Uint8Array([1]));
				return (await vault.list()).map((entry) => entry.path);
			});

			expect(exists).toContain("a/b/c/note.md");
		});
	});

	describe("watching", () => {
		it("delivers creates, edits, renames and deletes, each with its stat", async () => {
			const events = await browser.executeObsidian(async ({ app, plugins }) => {
				const { vault } = plugins.obsen.ports!;
				const seen: unknown[] = [];
				const stop = vault.watch((event) => seen.push(event));
				// Obsidian learns about an adapter write from its own watcher, and this
				// suite is the thing that measured how long that takes (~260 ms). Each step
				// waits for the index rather than racing it, because a Run that renamed a
				// note Obsidian had not indexed yet would go through the adapter and
				// legitimately produce no event at all.
				const settle = async (path: string, present: boolean): Promise<void> => {
					for (let waited = 0; waited < 10_000; waited += 100) {
						if ((app.vault.getFileByPath(path) !== null) === present) return;
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
				};
				try {
					await vault.mkdir("Watched");
					await vault.write("Watched/note.md", new Uint8Array([1]));
					await settle("Watched/note.md", true);
					await vault.write("Watched/note.md", new Uint8Array([1, 2]));
					await new Promise((resolve) => setTimeout(resolve, 500));
					await vault.rename("Watched/note.md", "Watched/moved.md");
					await settle("Watched/moved.md", true);
					await vault.trash("Watched/moved.md");
					await settle("Watched/moved.md", false);
				} finally {
					stop();
				}
				return JSON.parse(JSON.stringify(seen)) as {
					type: string;
					stat: unknown;
				}[];
			});

			expect(events.map((event) => event.type)).toEqual(["create", "modify", "rename", "delete"]);
			// The Own-Writes Filter matches on stats, so an event without one is useless.
			expect(events[0]?.stat).toEqual({ size: 1, mtime: expect.any(Number) });
			expect(events[3]?.stat).toBe(null);
		});

		it("expands a folder rename into one event per file inside it", async () => {
			const events = await browser.executeObsidian(async ({ plugins }) => {
				const { app } = plugins.obsen;
				const { vault } = plugins.obsen.ports!;
				const seen: unknown[] = [];
				const stop = vault.watch((event) => seen.push(event));
				try {
					const folder = app.vault.getFolderByPath("Notes/deep")!;
					await app.vault.rename(folder, "Notes/shallow");
					await new Promise((resolve) => setTimeout(resolve, 1_000));
				} finally {
					stop();
				}
				return JSON.parse(JSON.stringify(seen)) as {
					type: string;
					from?: string;
					to?: string;
					stat?: { size: number };
				}[];
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				type: "rename",
				from: "Notes/deep/two.md",
				to: "Notes/shallow/two.md",
			});
			expect(events[0]?.stat?.size).toBeGreaterThan(0);
		});

		it("reports the files a deleted folder took with it, and not the folder", async () => {
			// The port drops folder events, which is only safe because Obsidian fires one
			// `delete` per file inside the folder *first*. This is the assertion that says
			// so — without it, deleting a folder would propagate nothing until the next
			// Reconcile, and spec §4 has no periodic one to fall back on.
			const events = await browser.executeObsidian(async ({ app, plugins }) => {
				const { vault } = plugins.obsen.ports!;
				const seen: unknown[] = [];
				const stop = vault.watch((event) => seen.push(event));
				try {
					await vault.trashFolder("Notes/deep");
					await new Promise((resolve) => setTimeout(resolve, 2_000));
				} finally {
					stop();
				}
				return {
					events: JSON.parse(JSON.stringify(seen)) as { type: string; path?: string }[],
					folderGone: app.vault.getFolderByPath("Notes/deep") === null,
				};
			});

			expect(events.folderGone).toBe(true);
			expect(events.events).toEqual([
				{ type: "delete", path: "Notes/deep/two.md", stat: null },
			]);
		});

		it("says nothing at all about a vault that is merely sitting there", async () => {
			// Obsidian replays `create` for every existing file while a vault initialises,
			// which is why the shell registers watchers in `onLayoutReady` and not `onload`
			// (spec §1.3). Layout is long since ready here, so a fresh watcher on a quiet
			// vault must hear nothing — including nothing from the Exclusion List.
			const events = await browser.executeObsidian(async ({ plugins }) => {
				const { vault } = plugins.obsen.ports!;
				const seen: unknown[] = [];
				const stop = vault.watch((event) => seen.push(event));
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				stop();
				return seen.length;
			});

			expect(events).toBe(0);
		});
	});

	describe("names this device cannot hold", () => {
		it("refuses what Obsidian would never show, and allows the config dir's own", async () => {
			const verdicts = await browser.executeObsidian(({ plugins }, dir) => {
				const { vault } = plugins.obsen.ports!;
				return {
					note: vault.isWritablePath("Notes/one.md"),
					hidden: vault.isWritablePath("Notes/.secret.md"),
					config: vault.isWritablePath(`${dir}/plugins/obsen/main.js`),
				};
			}, configDir);

			expect(verdicts).toEqual({ note: true, hidden: false, config: true });
		});
	});
});
