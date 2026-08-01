import { Plugin } from "obsidian";

import type FilenSDK from "@filen/sdk";

import { createFilenSdk } from "./filen/sdk";
import { createObsidianPorts, type ObsidianPorts } from "./obsidian/adapters";

/**
 * The plugin shell.
 *
 * `onload` constructs the Filen SDK and the two Obsidian-side ports, and stops there:
 * all three are offline and cheap, and everything else this plugin will grow belongs
 * elsewhere (spec §1.3). Registrations — settings tab, ribbon icon, commands — go in
 * `onload` as they arrive. Startup *work* (auth restore, socket connect, the startup
 * Reconcile, and crucially `VaultPort.watch`) must instead wait for
 * `workspace.onLayoutReady()`, because Obsidian replays `vault.on("create")` for
 * every existing file while a vault initialises — in `onload` that would read as a
 * vault-wide creation storm.
 */
export default class ObsenPlugin extends Plugin {
	/** Unauthenticated until a login supplies an Auth Config. */
	filen: FilenSDK | null = null;

	/** `VaultPort`, `StorePort` and the Exclusion List — the engine's local half. */
	ports: ObsidianPorts | null = null;

	override onload(): void {
		this.filen = createFilenSdk();
		this.ports = createObsidianPorts(this.app, this.manifest);
	}

	override onunload(): void {
		this.filen = null;
		this.ports = null;
	}
}
