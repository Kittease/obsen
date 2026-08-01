import { type App, Setting } from "obsidian";

import { AnsweringModal, ask } from "./answering-modal";

/**
 * The one-question modal: *"here is what this will do — still want to?"*.
 *
 * Obsen asks it before the handful of actions a user cannot simply undo — logging out
 * of a linked vault, unlinking, choosing the Filen root, starting a First Link — so the
 * wording of the consequence is the caller's and everything else is shared.
 *
 * Resolves `true` for the confirm button and `false` for anything else — Cancel,
 * Escape, or clicking outside — because every other way of closing a modal means the
 * same thing.
 */
export type ConfirmOptions = {
	title: string;
	/** Paragraphs of explanation; plain text, one `<p>` each. */
	body: string[];
	/** The confirm button's label, e.g. "Log out". */
	cta: string;
	/** Whether the confirm button is the destructive-looking one. */
	destructive?: boolean;
};

export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
	return ask((resolve) => new ConfirmModal(app, options, resolve));
}

class ConfirmModal extends AnsweringModal<boolean> {
	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		resolve: (confirmed: boolean) => void,
	) {
		super(app, resolve);
	}

	protected override get fallback(): boolean {
		return false;
	}

	override onOpen(): void {
		this.setTitle(this.options.title);
		for (const paragraph of this.options.body) {
			this.contentEl.createEl("p", { text: paragraph });
		}

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((button) => {
				button.setButtonText(this.options.cta).onClick(() => {
					this.answer(true);
					this.close();
				});
				// Styled by class rather than by `setWarning()`, which is deprecated, and by
				// `setDestructive()`, which is a `TypeError` at Obsen's 1.11.4 floor (spec
				// §8.1). The class is what those methods add, and its name changed with them:
				// 1.11 styles a destructive button `mod-warning`, 1.13 `mod-destructive`.
				// Both, so the button looks right across the whole supported range.
				if (this.options.destructive === true) {
					button.setCta().buttonEl.addClasses(["mod-warning", "mod-destructive"]);
				} else button.setCta();
			});
	}
}
