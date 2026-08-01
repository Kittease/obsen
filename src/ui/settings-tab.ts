import { type App, Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";

import type { FolderTree } from "../filen/folders";
import type { Link } from "../link";
import type { Session } from "../session";
import { confirm } from "./confirm";
import { DUAL_ENGINE_CAUTION, runFirstLink } from "./first-link";
import { folderLabel, pickRemoteFolder } from "./folder-picker";
import { type LoginFeedback, loginFeedback } from "./login-feedback";

/**
 * The settings tab (spec §8.2): the whole onboarding surface, as a state machine.
 * Logged out → logged in, unlinked → linked; no wizard, and modals only where a
 * decision needs one — the folder browser and the First Link gate.
 *
 * The status, activity and troubleshooting sections of the linked state are tickets 037
 * and 038, and land under the same `display()` switch.
 *
 * The tab keeps **no state of its own** about either transition: it renders
 * {@link Session}'s and {@link Link}'s, and re-renders when either changes. What it does
 * own is the login *draft* — the three fields as typed, held across a re-render so that
 * "2FA required" can reveal the code field without emptying the form (spec §8.2's
 * no-dead-end rule) — and it drops the draft the moment the tab closes, because a
 * password has no business outliving the form it was typed into.
 */

type LoginDraft = { email: string; password: string; twoFactor: boolean; code: string };

/** What the tab needs of the plugin around it. */
export type SettingsHost = {
	session: Session;
	/** The link: whether one exists, and the three transitions the tab can cause. */
	link: Link;
	/**
	 * The Filen tree the folder picker browses. A function rather than a value because it
	 * only exists while someone is logged in — which is also the only state that offers it.
	 */
	folders(): FolderTree;
};

export class ObsenSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;
	private draft = emptyDraft();
	private showPassword = false;
	private busy = false;
	private error: string | null = null;
	/** Whether Obsidian currently has this tab open — `display()` on, `hide()` off. */
	private displayed = false;
	/** One per source the tab renders; dropped when Obsidian closes the tab. */
	private subscriptions: (() => void)[] = [];
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
		// per source alive for exactly as long as something is drawn.
		if (this.subscriptions.length === 0) {
			const redraw = (): void => {
				this.render();
			};
			this.subscriptions = [this.host.session.subscribe(redraw), this.host.link.subscribe(redraw)];
		}
		this.render();
	}

	/** Redraws, if there is anything drawn — for state the tab does not subscribe to. */
	refresh(): void {
		if (this.displayed) this.render();
	}

	override hide(): void {
		this.displayed = false;
		for (const drop of this.subscriptions) drop();
		this.subscriptions = [];
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
		if (state.status !== "logged-in") {
			this.renderLogin();
			return;
		}
		this.renderAccount(state.email);
		if (this.host.link.linked) this.renderLinked();
		else this.renderUnlinked();
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

	// ---- unlinked ----

	private renderUnlinked(): void {
		const container = this.containerEl;
		new Setting(container).setName("Remote folder").setHeading();
		container.createEl("p", {
			cls: "setting-item-description",
			text:
				"Pick the Filen folder this vault syncs with. Obsen shows you what the first sync " +
				"would do before anything moves.",
		});

		new Setting(container)
			.setName("Not linked yet")
			.setDesc("Nothing syncs until a folder is chosen.")
			.addButton((button) =>
				button
					.setButtonText("Choose folder…")
					.setCta()
					.onClick(() => {
						void this.chooseFolder();
					}),
			);
	}

	/** The picker, then the First Link flow — spec §8.3 into §8.4. */
	private async chooseFolder(): Promise<void> {
		let tree;
		try {
			tree = this.host.folders();
		} catch (error) {
			console.error("Obsen: no Filen client to browse with", error);
			new Notice("Obsen: log in to Filen again before choosing a folder.");
			return;
		}

		const picked = await pickRemoteFolder(this.app, tree);
		if (picked === null) return;
		await runFirstLink(this.app, this.host.link, picked);
		// A commit redraws through the subscription; a Cancel changes nothing and does not.
	}

	// ---- linked ----

	private renderLinked(): void {
		const container = this.containerEl;
		const folder = this.host.link.folder;
		new Setting(container).setName("Remote folder").setHeading();

		new Setting(container)
			.setName(`Syncing with ${folderLabel(folder?.path ?? "")}`)
			.setDesc(
				"Renaming or moving this folder on Filen is safe — the link follows the folder, " +
					"not its path.",
			)
			.addButton((button) =>
				button.setButtonText("Unlink…").onClick(() => {
					void this.unlink();
				}),
			);

		// The second of the two placements spec §8.4 requires: permanent, because the
		// mistake it warns about can be made long after linking day.
		container.createDiv({ cls: "obsen-callout", text: DUAL_ENGINE_CAUTION });
	}

	private async unlink(): Promise<void> {
		const confirmed = await confirm(this.app, {
			title: "Unlink this vault?",
			body: [
				"Sync stops. Nothing is deleted — every file stays exactly where it is, in this " +
					"vault and on Filen.",
				"Obsen forgets what it had already synced, so linking this vault again scans both " +
					"sides from scratch, the way the first link did.",
			],
			cta: "Unlink",
			destructive: true,
		});
		if (!confirmed) return;

		await this.host.link.unlink();
		new Notice("Obsen: unlinked. No files were changed.");
	}

	private async logOut(): Promise<void> {
		// Only worth a modal when it stops something: with no folder linked, logging out
		// is as reversible as logging in (spec §8.2).
		if (this.host.link.linked) {
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
