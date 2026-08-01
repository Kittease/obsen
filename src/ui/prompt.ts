import { type App, Setting } from "obsidian";

import { AnsweringModal, ask } from "./answering-modal";

/**
 * The one-answer modal: *"what should it be called?"*.
 *
 * The sibling of {@link import("./confirm").confirm} — same contract, one text field
 * instead of a yes. Resolves with the trimmed answer, or `null` for Cancel, Escape and
 * every other way of closing a modal.
 *
 * The CTA is disabled while the field is empty, so the only way to reach it is with
 * something to submit.
 */
export type PromptOptions = {
	title: string;
	/** One `<p>` of explanation, when the title is not enough on its own. */
	body?: string;
	placeholder?: string;
	cta: string;
};

export function promptForText(app: App, options: PromptOptions): Promise<string | null> {
	return ask((resolve) => new PromptModal(app, options, resolve));
}

class PromptModal extends AnsweringModal<string | null> {
	private value = "";

	constructor(
		app: App,
		private readonly options: PromptOptions,
		resolve: (answer: string | null) => void,
	) {
		super(app, resolve);
	}

	protected override get fallback(): string | null {
		return null;
	}

	override onOpen(): void {
		this.setTitle(this.options.title);
		if (this.options.body !== undefined) {
			this.contentEl.createEl("p", { text: this.options.body });
		}

		let submit: { setDisabled(disabled: boolean): unknown } | null = null;
		new Setting(this.contentEl).addText((text) =>
			text
				.setPlaceholder(this.options.placeholder ?? "")
				.onChange((value) => {
					this.value = value;
					submit?.setDisabled(value.trim() === "");
				})
				.then((text) => {
					text.inputEl.addEventListener("keydown", (event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						this.submit();
					});
					// Focus is the whole reason this modal exists rather than an inline field:
					// the user asked for it, so they should be able to type straight away.
					window.setTimeout(() => text.inputEl.focus(), 0);
				}),
		);

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((button) => {
				submit = button;
				button
					.setButtonText(this.options.cta)
					.setCta()
					.setDisabled(true)
					.onClick(() => {
						this.submit();
					});
			});
	}

	private submit(): void {
		const answer = this.value.trim();
		if (answer === "") return;
		this.answer(answer);
		this.close();
	}
}
