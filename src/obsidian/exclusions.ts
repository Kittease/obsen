import { baseName } from "../engine/paths";
import type { SyncScope } from "../engine/scope";
import type { ObsenLayout } from "./layout";

/**
 * The Exclusion List (spec §2.1) as the production {@link SyncScope}.
 *
 * v1's scope predicate is "everything except this list", and it is applied at the
 * *scope boundary* — before anything diffs — so an excluded path is invisible to both
 * sides rather than being a file the engine decides not to send. That distinction is
 * the whole selection-scope contract: something the diff cannot see can never read as
 * "missing → deleted" (spec §2).
 *
 * What is on the list, and why it is not longer:
 *
 * - **Workspace files** churn on every pane interaction and describe one screen.
 * - **Obsen's own state** — settings, Sync State, Shadow Store, logs, in-flight atomic
 *   writes — describes *this* device. Syncing it would have two devices overwriting
 *   each other's idea of what is already synced, forever.
 * - **`.trash/`**, or a Soft Delete on one device would resurrect through the other.
 * - **OS junk**, which no vault wants and every OS regenerates.
 *
 * Obsen's *code* is deliberately absent: `main.js`, `manifest.json` and `styles.css`
 * sync like any other plugin's, because that is what "my plugins follow me" means.
 * So does every other plugin's `data.json`.
 *
 * One entry extends the spec's table: `<pluginDir>/tmp/**`, the scratch folder the
 * atomic vault write renames out of. It is the same case as the `sync-state.json.tmp`
 * sibling the table already carves out — a file that exists for milliseconds and is
 * never content.
 */
export type ExclusionList = {
	/** The engine's Sync Scope: does this **file** sync? */
	readonly inScope: SyncScope;
	/**
	 * Can anything under this **folder** sync? Purely an optimization, and one the
	 * config-dir walk needs: `shadow/` holds one blob per unique synced text, so a scan
	 * that descended into it before filtering would do most of its work for nothing.
	 */
	readonly folderInScope: (path: string) => boolean;
};

export function createExclusionList(layout: ObsenLayout): ExclusionList {
	const { configDir, pluginDir } = layout;

	// Whole-name matches: cheap, and the reason `Thumbs.db.md` is an ordinary note.
	const junk = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

	const exactly = new Set([
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		`${configDir}/workspace`, // the legacy name
		`${pluginDir}/data.json`,
		layout.stateFile,
		layout.stateTmpFile,
	]);

	const folders = [layout.shadowDir, layout.logsDir, layout.tmpDir, ".trash"];
	// Matched as `<folder>/…` so a prefix-sharing neighbour — `shadow-notes/`,
	// `.trashcan/` — stays ordinary content.
	const under = folders.map((folder) => `${folder}/`);

	const excludedFolder = (path: string): boolean =>
		folders.includes(path) || under.some((prefix) => path.startsWith(prefix));

	return {
		inScope: (path) =>
			!junk.has(baseName(path)) && !exactly.has(path) && !under.some((p) => path.startsWith(p)),
		folderInScope: (path) => !excludedFolder(path),
	};
}
