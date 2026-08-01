import { Plugin } from "obsidian";

import type FilenSDK from "@filen/sdk";

import type { RemotePort } from "./engine/ports";
import { createFilenFolders, type FolderTree } from "./filen/folders";
import { createFilenRemote } from "./filen/remote";
import { createFilenSdk } from "./filen/sdk";
import { Link } from "./link";
import { createObsidianPorts, type ObsidianPorts } from "./obsidian/adapters";
import { DEFAULT_DATA, type ObsenData, readObsenData, type VaultLink } from "./obsidian/data";
import { AUTH_SECRET_ID, createSecretStore, type SecretStorageApi } from "./obsidian/secrets";
import { windowTimers } from "./platform/timers";
import { Session } from "./session";
import { ObsenSettingTab } from "./ui/settings-tab";

/**
 * The two Filen-side surfaces the linking flow needs: the tree the picker browses, and
 * the `RemotePort` an engine syncs through.
 *
 * One replaceable object rather than two direct calls, because the Obsidian integration
 * suite (spec §9 layer 3) runs *mostly against a fake RemotePort*: what it exists to
 * prove is that the plugin, the modals and the adapters behave inside a real Obsidian,
 * and pointing every one of those specs at a real Filen account would make them slow,
 * flaky and dependent on a secret. One real end-to-end smoke spec is worth having; forty
 * are not.
 */
export type RemoteSurfaces = {
	folders(): FolderTree;
	remote(folderUuid: string): RemotePort;
};

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

	/** Unlinked ⇄ linked, and the owner of the Sync Engine's lifetime. */
	link: Link | null = null;

	/** `data.json`: device-local, non-secret settings. Never credentials. */
	override settings: ObsenData = { ...DEFAULT_DATA };

	/** The settings tab, kept because later slices (037, 038) redraw it from outside. */
	settingsTab: ObsenSettingTab | null = null;

	/** How a Filen session becomes a browsable tree and a `RemotePort`. */
	remotes: RemoteSurfaces = {
		folders: () => createFilenFolders(this.expectFilen()),
		remote: (folderUuid) => createFilenRemote(this.expectFilen(), folderUuid),
	};

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

		this.link = new Link({
			vault: this.ports.vault,
			store: this.ports.store,
			scope: this.ports.scope,
			timers: windowTimers,
			remoteFor: (folderUuid) => this.remotes.remote(folderUuid),
			data: {
				read: () => this.settings.link,
				write: (link) => this.saveLink(link),
			},
		});

		// What makes spec §8.2's "sync stops until you log in again" true: the engine is
		// built on an authenticated client, so a logout has to take it down and a re-login
		// has to build a new one. `start()` is idempotent and does nothing for an unlinked
		// vault, so both directions are safe to run on every session change.
		const session = this.session;
		const link = this.link;
		this.register(
			session.subscribe(() => {
				if (session.state.status !== "logged-in") return link.stop();
				void link.start().catch((error: unknown) => {
					console.error("Obsen: could not resume sync after logging in", error);
				});
			}),
		);

		this.settingsTab = new ObsenSettingTab(this.app, this, {
			session: this.session,
			link: this.link,
			folders: () => this.remotes.folders(),
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

		// Opens the engine for a linked vault; it reads the Sync State and syncs nothing.
		// The startup Reconcile is a trigger, and triggers are ticket 034.
		await this.link?.start();
	}

	/** Persists the link, and redraws whatever was drawn from the old one. */
	private async saveLink(link: VaultLink | null): Promise<void> {
		this.settings = { ...this.settings, link };
		await this.saveData(this.settings);
		this.settingsTab?.refresh();
	}

	/** The SDK, or a failure that says why the Filen side is unavailable. */
	private expectFilen(): FilenSDK {
		if (this.filen === null) throw new Error("Obsen: the Filen client is not loaded");
		return this.filen;
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
		// Before anything is dropped: a Run still in flight holds the ports it was built
		// with, and stopping the scheduler is what stops the next one from starting.
		this.link?.stop();
		this.filen = null;
		this.ports = null;
		this.session = null;
		this.link = null;
		this.settingsTab = null;
	}
}
