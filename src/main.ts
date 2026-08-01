import { Plugin } from "obsidian";

import type FilenSDK from "@filen/sdk";

import { createFilenSdk } from "./filen/sdk";
import { createObsidianPorts, type ObsidianPorts } from "./obsidian/adapters";
import { DEFAULT_DATA, type ObsenData, readObsenData } from "./obsidian/data";
import { AUTH_SECRET_ID, createSecretStore, type SecretStorageApi } from "./obsidian/secrets";
import { Session } from "./session";
import { ObsenSettingTab } from "./ui/settings-tab";

/**
 * The plugin shell.
 *
 * `onload` constructs the Filen SDK, the two Obsidian-side ports and the session, and
 * registers the settings tab. All of it is offline, synchronous and cheap, which is what
 * spec §1.3 asks of it — not even `data.json` is read here.
 *
 * Startup *work* waits for `workspace.onLayoutReady()`: reading settings, restoring the
 * session, and later the socket connect, the startup Reconcile and — crucially —
 * `VaultPort.watch`, because Obsidian replays `vault.on("create")` for every existing
 * file while a vault initialises, and in `onload` that would read as a vault-wide
 * creation storm.
 */
export default class ObsenPlugin extends Plugin {
	/** Unauthenticated until a login or a restore supplies an Auth Config. */
	filen: FilenSDK | null = null;

	/** `VaultPort`, `StorePort` and the Exclusion List — the engine's local half. */
	ports: ObsidianPorts | null = null;

	/** Logged out ⇄ logged in, and the only owner of the stored credentials. */
	session: Session | null = null;

	/** `data.json`: device-local, non-secret settings. Never credentials. */
	override settings: ObsenData = { ...DEFAULT_DATA };

	/** The settings tab, kept because later slices (037, 038) redraw it from outside. */
	settingsTab: ObsenSettingTab | null = null;

	override onload(): void {
		this.filen = createFilenSdk();
		this.ports = createObsidianPorts(this.app, this.manifest);

		// The assignment is the compile-time proof that `SecretStorageApi` is a slice of
		// Obsidian's `SecretStorage` — the same trick the ports play on the Vault API.
		const secretStorage: SecretStorageApi = this.app.secretStorage;
		this.session = new Session({
			sdk: this.filen,
			secrets: createSecretStore(secretStorage, AUTH_SECRET_ID),
		});

		this.settingsTab = new ObsenSettingTab(this.app, this, {
			session: this.session,
			isLinked: () => this.settings.link !== null,
		});
		this.addSettingTab(this.settingsTab);

		this.app.workspace.onLayoutReady(() => {
			void this.start(secretStorage);
		});
	}

	/**
	 * Everything that had to wait for the workspace. Only two things so far, and neither
	 * touches the network: `data.json` off disk, and the session out of secure storage —
	 * the whole reason a restart does not re-prompt for a password.
	 */
	private async start(secretStorage: SecretStorageApi): Promise<void> {
		this.settings = readObsenData(await this.loadData());
		this.settingsTab?.refresh();

		// A missing or unreadable secret is simply the logged-out state (spec §8.1) — the
		// same thing a first run looks like.
		if (this.session?.restore() === false) this.restoreWhenSecretsArrive(secretStorage);
	}

	/**
	 * The second half of the restore, for the Obsidian versions that need one.
	 *
	 * Obsidian 1.13 moved secrets behind a per-platform secure-storage adapter and loads
	 * them **asynchronously** at startup, so `onLayoutReady` sometimes runs first and
	 * reads an empty store — intermittently, which is the worst way for a plugin to ask
	 * for a password that was already given. It announces the load with a `changed`
	 * event; 1.11.4 reads secrets straight out of local storage and has neither the
	 * event nor the gap, hence the feature test rather than a version check.
	 *
	 * Re-running `restore()` is safe however often it happens: an unchanged session is
	 * not a new one, and after a logout there is nothing left to restore.
	 */
	private restoreWhenSecretsArrive(secretStorage: SecretStorageApi): void {
		const { on, offref } = secretStorage;
		if (on === undefined || offref === undefined) return;
		const ref = on.call(secretStorage, "changed", () => {
			if (this.session?.restore() === true) offref.call(secretStorage, ref);
		});
		this.registerEvent(ref);
	}

	override onunload(): void {
		this.filen = null;
		this.ports = null;
		this.session = null;
		this.settingsTab = null;
	}
}
