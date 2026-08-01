import { browser, expect } from "@wdio/globals";

import type { RemoteEntry } from "../../src/engine/ports.ts";
import { AUTH_SECRET_ID } from "../../src/obsidian/secrets.ts";

/**
 * Linking a vault, in real Obsidian (spec §9 layer 3): the folder picker, the First
 * Link flow, and Unlink — against a **fake Filen**, which is what layer 3 is for. What
 * a real account does is layers 4–6's; what only a running Obsidian can answer is
 * whether the modals, the settings state machine and the adapters behave when a person
 * clicks through them.
 *
 * The fake and a small DOM driver are installed onto `window` by {@link installFake},
 * because every `executeObsidian` callback is serialized on its own and can close over
 * nothing: putting the shared apparatus in the page is what keeps each spec down to the
 * clicks it is actually about.
 */

/** A synthetic Auth Config: the right shape, with keys that unlock nothing. */
const AUTH = JSON.stringify({
	email: "someone@example.test",
	apiKey: "e2e-api-key",
	masterKeys: ["e2e-master-key"],
	publicKey: "e2e-public-key",
	privateKey: "e2e-private-key",
	authVersion: 2,
	baseFolderUUID: "e2e-base-folder",
	userId: 1,
});

/** The fixture vault's own notes — the local half of every divergence below. */
const LOCAL_NOTE = "Notes/one.md";

declare global {
	interface Window {
		/** The fake Filen drive, as the specs poke at it. */
		obsenFake: {
			seed(path: string, text: string): Promise<void>;
			snapshot(): Record<string, string>;
			folderUuid(name: string): string | null;
			renameFolder(uuid: string, name: string): void;
			/** Every folder UUID a `RemotePort` has been built for, in order. */
			builtFor: string[];
			/**
			 * Milliseconds every transfer takes. In-memory Filen is instantaneous, and a
			 * Run that finishes inside one polling interval cannot show that it did not
			 * block; a real network never has that problem.
			 */
			latencyMs: number;
		};
		/** A minimal DOM driver: the modals are the interface under test. */
		obsenUi: {
			sleep(ms: number): Promise<void>;
			waitFor(predicate: () => boolean, what: string): Promise<void>;
			click(label: string): boolean;
			clickButton(label: string): Promise<void>;
			clickRow(name: string): void;
			descend(name: string): void;
			modalText(): string;
			modals(): number;
		};
	}
}

/**
 * Installs the fake Filen drive and the DOM driver, and logs the plugin in.
 *
 * The fake keeps one flat set of files rather than a folder tree of them: what these
 * specs are about is the flow, and the folder a link points at is proved by
 * `builtFor` — the UUIDs the plugin actually built a `RemotePort` for.
 */
async function installFake(): Promise<void> {
	await browser.executeObsidian(({ app, plugins }, secretId, auth) => {
		// Whatever a failed spec left on screen: a leftover modal would swallow the next
		// spec's clicks and report it as a missing button.
		for (const modal of [...document.querySelectorAll(".modal-container")]) modal.remove();
		app.secretStorage.setSecret(secretId, auth);
		plugins.obsen.session?.restore();

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		let ids = 0;
		const nextId = (prefix: string): string => `${prefix}-${(ids += 1)}`;

		const ROOT = "filen-root";
		const folders = new Map<string, { name: string; parent: string | null }>([
			[ROOT, { name: "Filen", parent: null }],
		]);
		type Row = { uuid: string; data: Uint8Array; hash: string };
		const files = new Map<string, Row>();
		const builtFor: string[] = [];
		const latency = { ms: 0 };
		const slowly = <T,>(value: T): Promise<T> =>
			new Promise((resolve) => window.setTimeout(() => resolve(value), latency.ms));

		const digest = async (data: Uint8Array): Promise<string> => {
			const buffer = await crypto.subtle.digest("SHA-512", data as BufferSource);
			return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		};
		const put = async (path: string, data: Uint8Array): Promise<string> => {
			const uuid = nextId("file");
			files.set(path, { uuid, data, hash: await digest(data) });
			return uuid;
		};
		const pathOf = (uuid: string): string | null => {
			for (const [path, row] of files) if (row.uuid === uuid) return path;
			return null;
		};

		plugins.obsen.remotes = {
			folders: () => ({
				root: { uuid: ROOT, name: "Filen" },
				children: (uuid) =>
					Promise.resolve(
						[...folders]
							.filter(([, folder]) => folder.parent === uuid)
							.map(([id, folder]) => ({ uuid: id, name: folder.name }))
							.sort((a, b) => a.name.localeCompare(b.name)),
					),
				create: (parent, name) => {
					const uuid = nextId("dir");
					folders.set(uuid, { name: name.trim(), parent });
					return Promise.resolve({ uuid, name: name.trim() });
				},
			}),
			remote: (folderUuid) => {
				builtFor.push(folderUuid);
				// A link is a UUID: a folder that no longer exists must fail the listing, not
				// read as an empty one.
				const alive = (): void => {
					if (!folders.has(folderUuid)) throw new Error(`no such Filen folder ${folderUuid}`);
				};
				return {
					listing: () => {
						alive();
						return slowly(
							[...files].map(
								([path, row]): RemoteEntry => ({
									path,
									uuid: row.uuid,
									size: row.data.byteLength,
									hash: row.hash,
								}),
							),
						);
					},
					download: (uuid) => {
						const path = pathOf(uuid);
						const row = path === null ? undefined : files.get(path);
						return row ? slowly(row.data) : Promise.reject(new Error(`no ${uuid}`));
					},
					upload: async (path, data) =>
						await slowly({ uuid: await put(path, new Uint8Array(data)) }),
					move: (uuid, toPath) => {
						const from = pathOf(uuid);
						const row = from === null ? undefined : files.get(from);
						if (from === null || row === undefined) return Promise.reject(new Error(`no ${uuid}`));
						files.delete(from);
						files.set(toPath, row);
						return Promise.resolve();
					},
					trashFile: (uuid) => {
						const path = pathOf(uuid);
						if (path !== null) files.delete(path);
						return Promise.resolve();
					},
					mkdir: () => Promise.resolve(),
					trashFolder: (path) => {
						for (const key of [...files.keys()]) {
							if (key === path || key.startsWith(`${path}/`)) files.delete(key);
						}
						return Promise.resolve();
					},
					moveFolder: (fromPath, toPath) => {
						for (const [key, row] of [...files]) {
							if (!key.startsWith(`${fromPath}/`)) continue;
							files.delete(key);
							files.set(`${toPath}${key.slice(fromPath.length)}`, row);
						}
						return Promise.resolve();
					},
					watch: () => () => {},
				};
			},
		};

		window.obsenFake = {
			seed: async (path, text) => {
				await put(path, encoder.encode(text));
			},
			snapshot: () =>
				Object.fromEntries([...files].map(([path, row]) => [path, decoder.decode(row.data)])),
			folderUuid: (name) => [...folders].find(([, folder]) => folder.name === name)?.[0] ?? null,
			renameFolder: (uuid, name) => {
				const folder = folders.get(uuid);
				if (folder) folder.name = name;
			},
			builtFor,
			get latencyMs() {
				return latency.ms;
			},
			set latencyMs(ms: number) {
				latency.ms = ms;
			},
		};

		// A modal that throws while rendering leaves a half-drawn dialog and an error
		// nothing in a `waitFor` would otherwise report; collected here so a timeout says
		// what actually went wrong.
		const faults: string[] = [];
		const describe = (value: unknown): string =>
			value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : String(value);
		window.addEventListener("error", (event) => faults.push(describe(event.error)));
		window.addEventListener("unhandledrejection", (event) => faults.push(describe(event.reason)));

		const sleep = (ms: number): Promise<void> =>
			new Promise((resolve) => window.setTimeout(resolve, ms));
		/**
		 * The topmost modal, or the settings tab. The tab's `containerEl` is *detached*
		 * until Obsidian itself opens the settings window, so a spec that renders it with
		 * `display()` has to look inside it rather than at the document.
		 */
		const scope = (): ParentNode => {
			const modals = document.querySelectorAll(".modal-container");
			const topmost = modals.length > 0 ? modals[modals.length - 1] : undefined;
			return topmost ?? plugins.obsen.settingsTab?.containerEl ?? document;
		};
		const row = (name: string): HTMLElement | undefined =>
			[...scope().querySelectorAll<HTMLElement>(".obsen-picker-row")].find(
				(candidate) =>
					candidate.querySelector(".obsen-picker-name")?.textContent?.trim() === name,
			);

		const ui: Window["obsenUi"] = {
			sleep,
			waitFor: async (predicate, what) => {
				for (let tries = 0; tries < 200; tries += 1) {
					if (predicate()) return;
					await sleep(50);
				}
				// What was on screen instead: a timeout with no context is a second run's
				// worth of guessing, and every one of these waits is inside a browser.
				throw new Error(
					`Obsen e2e: timed out waiting for ${what}.` +
						` modals=${document.querySelectorAll(".modal-container").length}` +
						` session=${plugins.obsen.session?.state.status ?? "none"}` +
						` link=${JSON.stringify(plugins.obsen.settings.link)}` +
						` settings=${plugins.obsen.settingsTab?.containerEl.textContent ?? ""}` +
						` screen=${scope().textContent ?? ""}` +
						(faults.length > 0 ? ` errors=${faults.join(" | ")}` : ""),
				);
			},
			click: (label) => {
				const button = [...scope().querySelectorAll("button")].find(
					(candidate) => candidate.textContent?.trim() === label,
				);
				button?.click();
				return button !== undefined;
			},
			clickButton: async (label) => {
				await ui.waitFor(() => ui.click(label), `the “${label}” button`);
			},
			clickRow: (name) => {
				const found = row(name);
				if (found === undefined) throw new Error(`Obsen e2e: no folder row “${name}”`);
				found.click();
			},
			descend: (name) => {
				const found = row(name);
				const chevron = found?.querySelector<HTMLElement>(".obsen-picker-descend");
				if (!chevron) throw new Error(`Obsen e2e: no chevron on “${name}”`);
				chevron.click();
			},
			modalText: () =>
				[...document.querySelectorAll(".modal-container")]
					.map((modal) => modal.textContent ?? "")
					.join("\n"),
			modals: () => document.querySelectorAll(".modal-container").length,
		};
		window.obsenUi = ui;
	}, AUTH_SECRET_ID, AUTH);
}

/** Seeds the fake Filen drive with one folder to link to, plus files. */
async function seedRemote(files: Record<string, string>): Promise<void> {
	await browser.executeObsidian(async ({ plugins }, seeded: string) => {
		await plugins.obsen.remotes.folders().create("filen-root", "Vault");
		for (const [path, text] of Object.entries(JSON.parse(seeded) as Record<string, string>)) {
			await window.obsenFake.seed(path, text);
		}
	}, JSON.stringify(files));
}

/** Opens the settings tab and walks the picker as far as the preview modal. */
async function previewFirstLink(): Promise<string> {
	return await browser.executeObsidian(async ({ plugins }) => {
		const ui = window.obsenUi;
		plugins.obsen.settingsTab?.display();
		await ui.clickButton("Choose folder…");
		// The picker lists asynchronously; the row is the signal that it is ready.
		await ui.waitFor(() => ui.modalText().includes("Vault"), "the folder list");
		ui.clickRow("Vault");
		ui.click("Use this folder");

		await ui.waitFor(() => ui.modalText().includes("Link this vault"), "the explanation");
		ui.click("Scan");
		await ui.waitFor(() => ui.modalText().includes("Preview the first sync"), "the preview");
		return ui.modalText();
	});
}

/** Everything the assertions look at, in one round trip. */
async function inspect(): Promise<{
	link: { folderUuid: string; path: string } | null;
	syncState: string | null;
	remote: Record<string, string>;
	vault: string[];
	builtFor: string[];
	modals: number;
	settings: string;
}> {
	return await browser.executeObsidian(async ({ app, plugins }) => ({
		link: plugins.obsen.settings.link,
		syncState: await plugins.obsen.ports!.store.readState(),
		remote: window.obsenFake.snapshot(),
		vault: app.vault
			.getFiles()
			.map((file) => file.path)
			.sort(),
		builtFor: [...window.obsenFake.builtFor],
		modals: window.obsenUi.modals(),
		settings: plugins.obsen.settingsTab?.containerEl.textContent ?? "",
	}));
}

/**
 * Waits for Obsidian to index paths Obsen wrote through the `DataAdapter`.
 *
 * Its own file watcher is what tells Obsidian about those, so a snapshot taken the
 * instant a Run finishes legitimately does not list a note that is already on disk.
 */
async function waitForIndexed(paths: string[]): Promise<void> {
	await browser.executeObsidian(async ({ app }, wanted: string[]) => {
		await window.obsenUi.waitFor(
			() => wanted.every((path) => app.vault.getFiles().some((file) => file.path === path)),
			`Obsidian to index ${wanted.join(", ")}`,
		);
	}, paths);
}

/** Waits out the Run the confirmation started, follow-up Runs included. */
async function settle(): Promise<void> {
	await browser.executeObsidian(async ({ plugins }) => {
		await plugins.obsen.link?.engine?.idle();
	});
}

describe("linking a vault to a Filen folder", () => {
	beforeEach(async () => {
		await installFake();
	});

	afterEach(async () => {
		await browser.executeObsidian(async ({ app, plugins }, secretId) => {
			for (const modal of [...document.querySelectorAll(".modal-container")]) modal.remove();
			await plugins.obsen.link?.unlink();
			plugins.obsen.settingsTab?.hide();
			(app.secretStorage as unknown as { deleteSecret(id: string): boolean }).deleteSecret(secretId);
			// Every note a spec created, so the next one starts from the fixture vault.
			// `.trash/` is on the Exclusion List, so what lands there cannot come back.
			for (const file of app.vault.getFiles()) {
				if (file.path.startsWith("e2e-") || file.path === "conflicts.md") {
					await app.fileManager.trashFile(file);
				}
			}
		}, AUTH_SECRET_ID);
	});

	it("previews a real divergence, and syncs it only once confirmed", async () => {
		await seedRemote({
			"e2e-remote-only.md": "written on another device",
			"e2e-clash.md": "the Filen version",
		});
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.create("e2e-clash.md", "the local version");
		});

		const preview = await previewFirstLink();

		expect(preview).toContain("1 file downloaded into this vault");
		expect(preview).toContain("1 file kept as a conflict copy");
		expect(preview).toContain("e2e-clash.md");
		// Spec §8.4's dual-engine caution, in the first of its two required places.
		expect(preview).toContain("one sync engine per folder per device");

		// Step 3 has read both sides and written to neither.
		const beforeConfirm = await inspect();
		expect(beforeConfirm.link).toBe(null);
		expect(beforeConfirm.syncState).toBe(null);
		expect(beforeConfirm.remote["e2e-remote-only.md"]).toBe("written on another device");
		expect(Object.keys(beforeConfirm.remote)).not.toContain(LOCAL_NOTE);
		expect(beforeConfirm.vault).not.toContain("e2e-remote-only.md");

		// Step 4: the modal closes and the Run is an ordinary one — Obsidian stays usable.
		const started = await browser.executeObsidian(async ({ app, plugins }) => {
			const ui = window.obsenUi;
			// Slow enough to be caught in the act: an in-memory Filen would be done before
			// the first poll, and "it did not block" is exactly what this asserts.
			window.obsenFake.latencyMs = 50;
			ui.click("Start sync");
			await ui.waitFor(() => ui.modals() === 0, "the modal to close");
			await ui.waitFor(() => plugins.obsen.link?.engine?.busy === true, "the Run to start");
			// Typed into the vault mid-Run, with no modal in the way.
			const typed = await app.vault.create("e2e-typed-during-the-run.md", "still usable");
			return { busy: plugins.obsen.link?.engine?.busy ?? false, typed: typed.path, modals: ui.modals() };
		});

		expect(started.busy).toBe(true);
		expect(started.modals).toBe(0);
		expect(started.typed).toBe("e2e-typed-during-the-run.md");

		await settle();
		await waitForIndexed(["e2e-remote-only.md", "conflicts.md"]);
		const after = await inspect();

		expect(after.link?.path).toBe("Vault");
		expect(after.builtFor).toEqual([await folderUuid("Vault")]);
		// Downloaded, uploaded, and the clash kept as a copy with both versions intact.
		expect(after.vault).toContain("e2e-remote-only.md");
		expect(after.remote[LOCAL_NOTE]).toContain("The first note.");
		expect(after.remote["e2e-clash.md"]).toBe("the local version");
		expect(after.vault.filter((path) => path.startsWith("e2e-clash"))).toHaveLength(2);
		expect(after.vault).toContain("conflicts.md");
		expect(after.syncState).not.toBe(null);
	});

	it("leaves both sides untouched when the scan is cancelled", async () => {
		await seedRemote({ "e2e-remote-only.md": "written on another device" });

		const outcome = await browser.executeObsidian(async ({ plugins }) => {
			const ui = window.obsenUi;
			plugins.obsen.settingsTab?.display();
			await ui.clickButton("Choose folder…");
			await ui.waitFor(() => ui.modalText().includes("Vault"), "the folder list");
			ui.clickRow("Vault");
			ui.click("Use this folder");
			await ui.waitFor(() => ui.modalText().includes("Link this vault"), "the explanation");
			// Slow enough that there is a scan to cancel: this is what a phone on a train
			// looks like, and it is the only state the Cancel button exists for.
			window.obsenFake.latencyMs = 500;
			ui.click("Scan");

			await ui.waitFor(() => ui.modalText().includes("Scanning"), "the scan");
			ui.click("Cancel");
			await ui.sleep(500);
			return { modals: ui.modals(), text: ui.modalText() };
		});

		// No preview appeared behind the cancelled scan, and nothing moved.
		expect(outcome.modals).toBe(0);
		expect(outcome.text).not.toContain("Preview the first sync");
		const after = await inspect();
		expect(after.link).toBe(null);
		expect(after.syncState).toBe(null);
		expect(after.vault).not.toContain("e2e-remote-only.md");
		expect(Object.keys(after.remote)).toEqual(["e2e-remote-only.md"]);
	});

	it("leaves both sides untouched when the preview is declined", async () => {
		await seedRemote({ "e2e-remote-only.md": "written on another device" });
		await previewFirstLink();

		await browser.executeObsidian(async () => {
			window.obsenUi.click("Cancel");
			await window.obsenUi.waitFor(() => window.obsenUi.modals() === 0, "the modal to close");
		});

		const after = await inspect();
		expect(after.link).toBe(null);
		expect(after.syncState).toBe(null);
		expect(after.vault).not.toContain("e2e-remote-only.md");
		expect(Object.keys(after.remote)).toEqual(["e2e-remote-only.md"]);
		// And the tab is still offering the choice rather than claiming a link.
		expect(after.settings).toContain("Not linked yet");
	});

	it("gates the Filen root behind a warning, which can be refused", async () => {
		await seedRemote({});

		const warning = await browser.executeObsidian(async ({ plugins }) => {
			const ui = window.obsenUi;
			plugins.obsen.settingsTab?.display();
			await ui.clickButton("Choose folder…");
			await ui.waitFor(() => ui.modalText().includes("Vault"), "the folder list");
			// Nothing selected but the folder the picker opened on: the Filen root itself.
			ui.click("Use this folder");
			await ui.waitFor(() => ui.modalText().includes("entire Filen drive"), "the root warning");
			const text = ui.modalText();
			ui.click("Cancel");
			await ui.sleep(300);
			return { text, stillPicking: ui.modalText().includes("Choose a Filen folder") };
		});

		expect(warning.text).toContain("Sync with your entire Filen drive?");
		// Refusing the warning returns to the picker rather than ending the flow.
		expect(warning.stillPicking).toBe(true);
		expect((await inspect()).link).toBe(null);
	});

	it("descends with the chevron and remembers the folder by UUID, not by path", async () => {
		await seedRemote({});
		await browser.executeObsidian(async ({ plugins }) => {
			const vault = window.obsenFake.folderUuid("Vault")!;
			await plugins.obsen.remotes.folders().create(vault, "Inner");
		});

		await browser.executeObsidian(async ({ plugins }) => {
			const ui = window.obsenUi;
			plugins.obsen.settingsTab?.display();
			await ui.clickButton("Choose folder…");
			await ui.waitFor(() => ui.modalText().includes("Vault"), "the folder list");
			ui.descend("Vault");
			await ui.waitFor(() => ui.modalText().includes("Inner"), "the nested folder");
			ui.clickRow("Inner");
			ui.click("Use this folder");
			await ui.waitFor(() => ui.modalText().includes("Link this vault"), "the explanation");
			ui.click("Scan");
			await ui.waitFor(() => ui.modalText().includes("Preview the first sync"), "the preview");
			ui.click("Start sync");
			await ui.waitFor(() => ui.modals() === 0, "the modal to close");
		});
		await settle();

		const inner = await folderUuid("Inner");
		const linked = await inspect();
		expect(linked.link).toEqual({ folderUuid: inner, path: "Vault/Inner" });

		// Renamed on Filen: the stored path is now stale, and the link is not.
		await browser.executeObsidian((_ctx, uuid: string) => {
			window.obsenFake.renameFolder(uuid, "Renamed");
		}, inner);
		const summary = await browser.executeObsidian(
			async ({ plugins }) => (await plugins.obsen.link!.engine!.syncNow("manual")).outcome,
		);

		expect(summary).toBe("ok");
		expect((await inspect()).link?.folderUuid).toBe(inner);
	});

	it("unlinks without touching a file, and re-links from scratch", async () => {
		await seedRemote({ "e2e-remote-only.md": "written on another device" });
		await previewFirstLink();
		await browser.executeObsidian(async () => {
			window.obsenUi.click("Start sync");
			await window.obsenUi.waitFor(() => window.obsenUi.modals() === 0, "the modal to close");
		});
		await settle();
		await waitForIndexed(["e2e-remote-only.md"]);
		const linked = await inspect();
		expect(linked.settings).toContain("Syncing with Vault");
		// The second of the two placements spec §8.4 requires.
		expect(linked.settings).toContain("one sync engine per folder per device");

		const unlinked = await browser.executeObsidian(async ({ app, plugins }, dir: string) => {
			const ui = window.obsenUi;
			await ui.clickButton("Unlink…");
			await ui.waitFor(() => ui.modalText().includes("Unlink this vault?"), "the warning");
			ui.click("Unlink");
			await ui.waitFor(() => ui.modals() === 0, "the modal to close");
			// The sweep happens after the modal is gone, so the files are what to wait on.
			const shadow = `${dir}/plugins/obsen/shadow`;
			for (let tries = 0; tries < 100; tries += 1) {
				if (!(await app.vault.adapter.exists(shadow))) break;
				await ui.sleep(50);
			}
			return {
				shadow: await app.vault.adapter.exists(shadow),
				state: await app.vault.adapter.exists(`${dir}/plugins/obsen/sync-state.json`),
				// The engine itself is a live object and does not survive the wire; whether
				// there is one is the whole question anyway.
				stopped: plugins.obsen.link?.engine === null,
			};
		}, await browser.executeObsidian(({ app }) => app.vault.configDir));

		expect(unlinked.shadow).toBe(false);
		expect(unlinked.state).toBe(false);
		expect(unlinked.stopped).toBe(true);

		const after = await inspect();
		expect(after.link).toBe(null);
		expect(after.settings).toContain("Not linked yet");
		// Not one file moved on either side: unlinking is forgetting, never deleting.
		expect(after.vault).toEqual(linked.vault);
		expect(after.remote).toEqual(linked.remote);

		// And re-linking the same folder re-bootstraps: no records survived, so the whole
		// vault is reconciled from what is actually on both sides.
		const preview = await previewFirstLink();
		expect(preview).toContain("already identical");
		expect(preview).not.toContain("downloaded into this vault");
	});
});

/** The fake's UUID for a folder, by name. */
async function folderUuid(name: string): Promise<string> {
	const uuid = await browser.executeObsidian(
		(_ctx, wanted: string) => window.obsenFake.folderUuid(wanted),
		name,
	);
	if (uuid === null) throw new Error(`no fake Filen folder named ${name}`);
	return uuid;
}
