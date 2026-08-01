import { type App, Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";

import type { Session } from "../session";
import { confirm } from "./confirm";
import { type LoginFeedback, loginFeedback } from "./login-feedback";

/**
 * The settings tab (spec §8.2): the whole onboarding surface, as a state machine.
 * Logged out → logged in, unlinked → linked; no wizard, and modals only where a
 * decision needs one.
 *
 * This slice implements the first transition. The linked half — folder picker, First
 * Link, status and activity — is tickets 031, 037 and 038, and lands under the same
 * `display()` switch.
 *
 * The tab keeps **no session state of its own**: it renders {@link Session}'s and
 * re-renders when that changes. What it does own is the login *draft* — the three
 * fields as typed, held across a re-render so that "2FA required" can reveal the code
 * field without emptying the form (spec §8.2's no-dead-end rule) — and it drops the
 * draft the moment the tab closes, because a password has no business outliving the
 * form it was typed into.
 */

type LoginDraft = { email: string; password: string; twoFactor: boolean; code: string };

/** What the tab needs of the plugin around it, so ticket 031 can grow `isLinked`. */
export type SettingsHost = {
	session: Session;
	/** Whether a Remote Folder is linked — what makes logging out worth a warning. */
	isLinked(): boolean;
};

export class ObsenSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;
	private draft = emptyDraft();
	private showPassword = false;
	private busy = false;
	private error: string | null = null;
	/** Whether Obsidian currently has this tab open — `display()` on, `hide()` off. */
	private displayed = false;
	private unsubscribe: (() => void) | null = null;
	/** The live password field, so the eye toggle can flip it without a re-render. */
	private passwordEl: HTMLInputElement | null = null;

	constructor(app: App, plugin: Plugin, host: SettingsHost) {
		super(app, plugin);
		this.host = host;
	}

	override display(): void {
		this.displayed = true;
		// Obsidian calls `display()` again every time the tab is re-opened, and `hide()`
		// in between; subscribing here and dropping it there keeps exactly one listener
		// alive for exactly as long as something is drawn.
		this.unsubscribe ??= this.host.session.subscribe(() => {
			this.render();
		});
		this.render();
	}

	/** Redraws, if there is anything drawn — for state the tab does not subscribe to. */
	refresh(): void {
		if (this.displayed) this.render();
	}

	override hide(): void {
		this.displayed = false;
		this.unsubscribe?.();
		this.unsubscribe = null;
		// The password is gone as soon as the form is: nothing the user types is kept
		// anywhere, in storage or in memory (spec §8.1).
		this.draft = emptyDraft();
		this.showPassword = false;
		this.error = null;
		this.containerEl.empty();
	}

	private render(): void {
		this.containerEl.empty();
		this.passwordEl = null;
		const state = this.host.session.state;
		if (state.status === "logged-in") this.renderAccount(state.email);
		else this.renderLogin();
	}

	// ---- logged out ----

	private renderLogin(): void {
		const container = this.containerEl;
		new Setting(container).setName("Filen account").setHeading();
		container.createEl("p", {
			text:
				"Obsen signs in to Filen once and keeps the resulting keys in Obsidian's secure " +
				"storage. Your password is never saved.",
			cls: "setting-item-description",
		});

		new Setting(container).setName("Email").addText((text) =>
			text
				.setPlaceholder("you@example.com")
				.setValue(this.draft.email)
				.onChange((value) => {
					this.draft.email = value;
				})
				.then((text) => {
					text.inputEl.type = "email";
					text.inputEl.autocapitalize = "off";
					this.submitOnEnter(text.inputEl);
				}),
		);

		new Setting(container)
			.setName("Password")
			.addText((text) =>
				text
					.setValue(this.draft.password)
					.onChange((value) => {
						this.draft.password = value;
					})
					.then((text) => {
						this.passwordEl = text.inputEl;
						text.inputEl.type = this.showPassword ? "text" : "password";
						this.submitOnEnter(text.inputEl);
					}),
			)
			.addExtraButton((button) => {
				const dress = (): void => {
					button.setIcon(this.showPassword ? "eye-off" : "eye");
					button.setTooltip(this.showPassword ? "Hide password" : "Show password");
				};
				dress();
				button.onClick(() => {
					// Flipped in place rather than by re-rendering: a re-render would take the
					// focus and the caret with it, mid-password.
					this.showPassword = !this.showPassword;
					if (this.passwordEl !== null) {
						this.passwordEl.type = this.showPassword ? "text" : "password";
					}
					dress();
				});
			});

		new Setting(container)
			.setName("My account has 2FA")
			.setDesc("Two-factor authentication is on for this account.")
			.addToggle((toggle) =>
				toggle.setValue(this.draft.twoFactor).onChange((value) => {
					this.draft.twoFactor = value;
					if (!value) this.draft.code = "";
					this.render();
				}),
			);

		if (this.draft.twoFactor) {
			new Setting(container)
				.setName("Two-factor code")
				.setDesc("From your authenticator app. Used once, never saved.")
				.addText((text) =>
					text
						.setPlaceholder("123456")
						.setValue(this.draft.code)
						.onChange((value) => {
							this.draft.code = value;
						})
						.then((text) => {
							text.inputEl.inputMode = "numeric";
							text.inputEl.autocomplete = "one-time-code";
							this.submitOnEnter(text.inputEl);
						}),
				);
		}

		if (this.error !== null) {
			container.createDiv({ cls: "setting-item-description mod-warning", text: this.error });
		}

		new Setting(container).addButton((button) =>
			button
				.setButtonText(this.busy ? "Logging in…" : "Log in")
				.setCta()
				.setDisabled(this.busy)
				.onClick(() => {
					void this.submit();
				}),
		);
	}

	private submitOnEnter(input: HTMLInputElement): void {
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			void this.submit();
		});
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.error = null;
		this.render();

		let feedback: LoginFeedback | null = null;
		let persisted = true;
		try {
			persisted = (
				await this.host.session.logIn({
					email: this.draft.email,
					password: this.draft.password,
					...(this.draft.twoFactor ? { twoFactorCode: this.draft.code } : {}),
				})
			).persisted;
		} catch (error) {
			feedback = loginFeedback(error);
			// The console is the only place Obsen writes detail to, and only for what it
			// has no sentence for.
			if (feedback.unexpected) console.error("Obsen: login failed", error);
		}
		this.busy = false;

		if (!persisted) {
			// A session that works now and not after a restart is worth interrupting for —
			// it is the one case where the honest answer is "log in again next time". Said
			// before the check below, because it is true whether or not settings are open.
			new Notice(
				"Logged in, but this device has no secure storage — you will have to log in again next time Obsidian starts.",
				10_000,
			);
		}

		// Settings can close mid-login. `hide()` has already dropped the draft and the
		// error by then, and writing them back would greet the next visit with a stale
		// failure and a password field that is not empty.
		if (!this.displayed) return;

		if (feedback === null) this.draft = emptyDraft();
		else {
			// The no-dead-end rule (spec §8.2): an account that turns out to have 2FA flips
			// the switch itself, keeping everything already typed, and the user re-submits.
			if (feedback.revealTwoFactor) this.draft.twoFactor = true;
			this.error = feedback.message;
		}
		this.render();
	}

	// ---- logged in ----

	private renderAccount(email: string): void {
		new Setting(this.containerEl).setName("Filen account").setHeading();

		new Setting(this.containerEl)
			.setName(`Logged in as ${email}`)
			.setDesc("Credentials are kept in Obsidian's secure storage, outside this vault's folder.")
			.addButton((button) =>
				button.setButtonText("Log out").onClick(() => {
					void this.logOut();
				}),
			);
	}

	private async logOut(): Promise<void> {
		// Only worth a modal when it stops something: with no folder linked, logging out
		// is as reversible as logging in (spec §8.2).
		if (this.host.isLinked()) {
			const confirmed = await confirm(this.app, {
				title: "Log out of Filen?",
				body: [
					"Sync stops until you log in again. This vault stays linked to its Filen " +
						"folder and nothing is deleted on either side.",
					"Obsen keeps what it has already synced, so logging back in resumes instead " +
						"of starting over.",
				],
				cta: "Log out",
				destructive: true,
			});
			if (!confirmed) return;
		}
		this.host.session.logOut();
	}
}

function emptyDraft(): LoginDraft {
	return { email: "", password: "", twoFactor: false, code: "" };
}
