import { Plugin } from "obsidian";

import type FilenSDK from "@filen/sdk";

import { createFilenSdk } from "./filen/sdk";

/**
 * The plugin shell.
 *
 * Constructing the Filen SDK is all `onload` may do here: it is offline and cheap,
 * and everything else this plugin will grow belongs elsewhere (spec §1.3).
 * Registrations — settings tab, ribbon icon, commands — go in `onload` as they
 * arrive. Startup *work* (auth restore, socket connect, the startup Reconcile,
 * and crucially the vault-event watchers) must instead wait for
 * `workspace.onLayoutReady()`, because Obsidian replays `vault.on("create")` for
 * every existing file while a vault initialises — in `onload` that would read as a
 * vault-wide creation storm.
 */
export default class ObsenPlugin extends Plugin {
	/** Unauthenticated until a login supplies an Auth Config. */
	filen: FilenSDK | null = null;

	override onload(): void {
		this.filen = createFilenSdk();
	}

	override onunload(): void {
		this.filen = null;
	}
}
