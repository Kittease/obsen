import { type App, Setting, setIcon } from "obsidian";

import type { FolderTree, RemoteFolder } from "../filen/folders";
import type { VaultLink } from "../obsidian/data";
import { AnsweringModal, ask } from "./answering-modal";
import { confirm } from "./confirm";
import { promptForText } from "./prompt";

/**
 * The folder picker (spec §8.3): a modal tree browser over the Filen drive, one level
 * at a time.
 *
 * The interaction is the one ticket 022 settled, and every part of it is there because
 * a phone has no hover and no right-click:
 *
 * - **Tap a row to select it**; the chevron at its right edge descends into it. Two
 *   targets, one row — which is also why a desktop double-click descends as a bonus.
 * - **The folder you are looking at is the default selection**, so "open the folder I
 *   want and press the button" is a complete interaction on its own.
 * - **"New folder"** creates at the current level, because the folder a user wants to
 *   sync into very often does not exist yet.
 * - **The Filen root is selectable but gated** by a warning: it works, and it means
 *   every other folder on the account becomes part of this vault.
 *
 * Resolves with the link to store — UUID, plus the path for display only — or `null`
 * for Cancel, Escape, and every other way of closing a modal.
 */
export function pickRemoteFolder(app: App, tree: FolderTree): Promise<VaultLink | null> {
	return ask((resolve) => new FolderPickerModal(app, tree, resolve));
}

/** How a Remote Folder path reads in a list or a settings row; `""` is the account root. */
export function folderLabel(path: string): string {
	return path === "" ? "Filen root" : path;
}

/**
 * One selectable entry: a folder, and the path a link to it would remember.
 *
 * Not called `Selection`, and never stored on a field of that name: Obsidian's `Modal`
 * keeps the editor selection it will restore in `this.selection`, assigns it inside
 * `open()` — after the constructor, before `onOpen` — and a subclass field of the same
 * name is silently replaced by a DOM `Selection` on the way in.
 */
type Choice = { folder: RemoteFolder; path: string };

type Listing =
	| { status: "loading" }
	| { status: "ready"; folders: RemoteFolder[] }
	| { status: "failed"; message: string };

class FolderPickerModal extends AnsweringModal<VaultLink | null> {
	/** Root first, then every folder descended into — the breadcrumb, and the path. */
	private trail: RemoteFolder[];
	private listing: Listing = { status: "loading" };
	private chosen: Choice;
	/** A one-off message above the list — what a failed "New folder" has to say. */
	private notice: string | null = null;
	/** Bumped on every navigation, so a slow listing cannot overwrite a newer one. */
	private generation = 0;

	constructor(
		app: App,
		private readonly tree: FolderTree,
		resolve: (picked: VaultLink | null) => void,
	) {
		super(app, resolve);
		this.trail = [tree.root];
		this.chosen = { folder: tree.root, path: "" };
	}

	protected override get fallback(): VaultLink | null {
		return null;
	}

	override onOpen(): void {
		this.setTitle("Choose a Filen folder");
		this.render();
		void this.load();
	}

	// ---- navigation ----

	/** The folder currently being browsed. */
	private get current(): RemoteFolder {
		return this.trail[this.trail.length - 1] as RemoteFolder;
	}

	/** Its path, relative to the Filen root, which is `""`. */
	private get currentPath(): string {
		return this.trail
			.slice(1)
			.map((folder) => folder.name)
			.join("/");
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		this.listing = { status: "loading" };
		this.notice = null;
		this.render();
		try {
			const folders = await this.tree.children(this.current.uuid);
			if (generation !== this.generation) return;
			this.listing = { status: "ready", folders };
		} catch (error) {
			if (generation !== this.generation) return;
			// The console keeps the detail; the modal says the one thing a user can act on.
			console.error("Obsen: could not list the Filen folder", error);
			this.listing = { status: "failed", message: "Filen could not be reached." };
		}
		this.render();
	}

	/** Descends, and selects what was descended into — the default-selection rule. */
	private descend(folder: RemoteFolder): void {
		this.trail.push(folder);
		this.chosen = { folder, path: this.currentPath };
		void this.load();
	}

	/** Jumps back to a breadcrumb level, selecting it for the same reason. */
	private ascendTo(depth: number): void {
		if (depth >= this.trail.length - 1) return;
		this.trail = this.trail.slice(0, depth + 1);
		this.chosen = { folder: this.current, path: this.currentPath };
		void this.load();
	}

	private select(choice: Choice): void {
		this.chosen = choice;
		this.render();
	}

	// ---- rendering ----

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "This whole vault will sync with the folder you choose. Tap a folder to select it, or use the arrow to look inside.",
		});

		this.renderTrail(contentEl.createDiv({ cls: "obsen-picker-trail" }));
		if (this.notice !== null) {
			contentEl.createDiv({ cls: "setting-item-description mod-warning", text: this.notice });
		}
		this.renderList(contentEl.createDiv({ cls: "obsen-picker-list" }));

		new Setting(contentEl)
			.setName(`Selected: ${folderLabel(this.chosen.path)}`)
			.addButton((button) =>
				button.setButtonText("New folder").onClick(() => {
					void this.createFolder();
				}),
			);

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Use this folder")
					.setCta()
					.onClick(() => {
						void this.choose();
					}),
			);
	}

	private renderTrail(trailEl: HTMLElement): void {
		this.trail.forEach((folder, depth) => {
			if (depth > 0) trailEl.createSpan({ cls: "obsen-picker-separator", text: "/" });
			const last = depth === this.trail.length - 1;
			if (last) {
				trailEl.createSpan({ cls: "obsen-picker-crumb", text: folder.name });
				return;
			}
			const crumb = trailEl.createEl("button", { cls: "obsen-picker-crumb", text: folder.name });
			crumb.addEventListener("click", () => this.ascendTo(depth));
		});
	}

	private renderList(listEl: HTMLElement): void {
		// The folder being browsed is a row of its own, so a user who descended one level
		// too far can select the parent without navigating back to it.
		this.renderRow(listEl, {
			choice: { folder: this.current, path: this.currentPath },
			label: `${folderLabel(this.currentPath)} — this folder`,
			descend: false,
		});

		if (this.listing.status === "loading") {
			listEl.createDiv({ cls: "obsen-picker-note", text: "Loading…" });
			return;
		}
		if (this.listing.status === "failed") {
			listEl.createDiv({ cls: "obsen-picker-note mod-warning", text: this.listing.message });
			const retry = listEl.createEl("button", { text: "Try again" });
			retry.addEventListener("click", () => void this.load());
			return;
		}
		if (this.listing.folders.length === 0) {
			listEl.createDiv({ cls: "obsen-picker-note", text: "No folders in here yet." });
			return;
		}
		for (const folder of this.listing.folders) {
			this.renderRow(listEl, {
				choice: { folder, path: join(this.currentPath, folder.name) },
				label: folder.name,
				descend: true,
			});
		}
	}

	private renderRow(
		listEl: HTMLElement,
		options: { choice: Choice; label: string; descend: boolean },
	): void {
		const { choice, label, descend } = options;
		const selected = choice.folder.uuid === this.chosen.folder.uuid;
		const row = listEl.createDiv({
			cls: `obsen-picker-row${selected ? " is-selected" : ""}`,
			attr: { role: "button", tabindex: "0", "aria-pressed": String(selected) },
		});
		row.createSpan({ cls: "obsen-picker-name", text: label });
		row.addEventListener("click", () => this.select(choice));
		row.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			this.select(choice);
		});

		if (!descend) return;
		// Desktop bonus (spec §8.3); on a phone the chevron is the only way in, which is
		// why it is a target of its own rather than a decoration.
		row.addEventListener("dblclick", () => this.descend(choice.folder));
		const chevron = row.createEl("button", {
			cls: "clickable-icon obsen-picker-descend",
			attr: { "aria-label": `Open ${label}` },
		});
		setIcon(chevron, "chevron-right");
		chevron.addEventListener("click", (event) => {
			event.stopPropagation();
			this.descend(choice.folder);
		});
	}

	// ---- actions ----

	private async createFolder(): Promise<void> {
		const name = await promptForText(this.app, {
			title: "New folder",
			body: `Created inside ${folderLabel(this.currentPath)} on Filen.`,
			placeholder: "Vault",
			cta: "Create",
		});
		if (name === null) return;

		try {
			const created = await this.tree.create(this.current.uuid, name);
			// Selected rather than descended into: a folder just created is almost always
			// the answer, and descending would hide it behind its own empty listing.
			this.chosen = { folder: created, path: join(this.currentPath, created.name) };
			await this.load();
		} catch (error) {
			// Reported above the list rather than instead of it: a failed create is no
			// reason to lose the folders already loaded, or the place in the tree.
			console.error("Obsen: could not create the Filen folder", error);
			this.notice = `“${name}” could not be created.`;
			this.render();
		}
	}

	private async choose(): Promise<void> {
		const picked = this.chosen;
		if (picked.path === "") {
			// Allowed, and never by accident: the whole account becomes this vault, including
			// everything another Filen client puts on it later.
			const confirmed = await confirm(this.app, {
				title: "Sync with your entire Filen drive?",
				body: [
					"Everything in your Filen account will be downloaded into this vault, and everything in this vault will be uploaded to the top level of your drive.",
					"Most people want a folder of their own instead. You can go back and pick or create one.",
				],
				cta: "Use the Filen root",
				destructive: true,
			});
			if (!confirmed) return;
		}
		this.answer({ folderUuid: picked.folder.uuid, path: picked.path });
		this.close();
	}
}

function join(parent: string, name: string): string {
	return parent === "" ? name : `${parent}/${name}`;
}
