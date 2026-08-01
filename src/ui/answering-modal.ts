import { type App, Modal } from "obsidian";

/**
 * A modal that exists to answer one question, and answers it exactly once.
 *
 * Every dialog Obsen opens has the same three obligations, and getting any of them
 * wrong is a hung promise or a double answer:
 *
 * - **Escape, the close button and a click outside all mean something**, and usually
 *   the same thing as Cancel — so closing has to resolve, not just disappear.
 * - **The answer is final.** A confirm button both decides and closes, and `onClose`
 *   must not then overwrite the decision with the fallback.
 * - **The DOM goes with it**, because Obsidian reuses nothing here.
 *
 * Subclasses build their content in `onOpen` and call {@link answer}; the base owns the
 * latch, the teardown, and the promise. {@link fallback} is what closing any other way
 * means.
 */
export abstract class AnsweringModal<T> extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly resolve: (answer: T) => void,
	) {
		super(app);
	}

	/** What a modal closed without deciding means — Cancel, Escape, or a click outside. */
	protected abstract get fallback(): T;

	/** Settles the promise. The first call wins; later ones are no-ops. */
	protected answer(value: T): void {
		if (this.answered) return;
		this.answered = true;
		this.resolve(value);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.answer(this.fallback);
	}
}

/** Opens a modal and hands back what it answers — the shape every dialog here uses. */
export function ask<T>(build: (resolve: (answer: T) => void) => AnsweringModal<T>): Promise<T> {
	return new Promise<T>((resolve) => {
		build(resolve).open();
	});
}
