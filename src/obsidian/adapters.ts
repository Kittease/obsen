import { type App, Platform, type PluginManifest } from "obsidian";

import type { SyncScope } from "../engine/scope";
import type { FileManagerApi, VaultApi } from "./api";
import { createExclusionList } from "./exclusions";
import { obsenLayout, type ObsenLayout } from "./layout";
import { ObsidianStore } from "./store";
import { ObsidianVault } from "./vault";

/**
 * The composition root for the Obsidian side: the one module that imports `obsidian`
 * and hands the rest of the plugin ports it can test without one.
 *
 * The two local annotations are load-bearing. `VaultApi` and `FileManagerApi` describe
 * the slice of Obsidian the adapters use, and assigning the real objects to them here
 * is the compile-time proof that the slice is a *slice* rather than a hopeful
 * description of one — the same trick `createFilenRemote` uses on the SDK.
 */
export type ObsidianPorts = {
	layout: ObsenLayout;
	/** The Exclusion List, for the engine, which filters by the same predicate. */
	scope: SyncScope;
	vault: ObsidianVault;
	store: ObsidianStore;
};

export function createObsidianPorts(app: App, manifest: PluginManifest): ObsidianPorts {
	const vault: VaultApi = app.vault;
	const fileManager: FileManagerApi = app.fileManager;

	const layout = obsenLayout(app.vault.configDir, manifest);

	return {
		layout,
		// The engine filters by the same predicate the adapter does, from one source
		// (spec §2's selection-scope contract): the two disagreeing would be the one bug
		// that reads as "missing → deleted".
		scope: createExclusionList(layout).inScope,
		vault: new ObsidianVault({ vault, fileManager, layout, windows: Platform.isWin }),
		store: new ObsidianStore({ adapter: vault.adapter, layout }),
	};
}
