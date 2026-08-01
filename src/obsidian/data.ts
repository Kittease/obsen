/**
 * `data.json` — the plugin's device-local, non-secret settings.
 *
 * What lives here is everything that is *not* a credential: credentials go to
 * `SecretStorage` and nowhere else (spec §8.1), and this file exists partly to make
 * that split explicit at the type level. `data.json` sits inside the vault's config
 * folder, which means a vault backup or another sync tool can read it — so anything
 * added here has to be safe in that light.
 *
 * It is deliberately tiny: the link is all of it today, and ticket 038 adds the Device
 * Name.
 */

/**
 * The Remote Folder this vault is linked to.
 *
 * The UUID is what a link *is* — it survives the folder being moved or renamed on Filen
 * (spec §8.3). The path is **display-only**, remembered so settings can say where the
 * folder was without a round trip, and stale by design: a folder renamed on Filen still
 * shows its old path here until the next time it is browsed, and nothing about sync
 * depends on it.
 */
export type VaultLink = {
	folderUuid: string;
	/** Slash-separated, relative to the Filen root; `""` *is* the root (spec §8.3). */
	path: string;
};

export type ObsenData = {
	link: VaultLink | null;
};

export const DEFAULT_DATA: ObsenData = { link: null };

/**
 * Whatever `Plugin#loadData()` returned, as {@link ObsenData}.
 *
 * `loadData()` answers `null` on a first run and, in principle, anything at all on a
 * vault whose `data.json` was hand-edited or written by another version. Unreadable
 * settings degrade to the defaults — an unlinked vault re-links in two clicks, and
 * refusing to load would take the settings tab down with it.
 */
export function readObsenData(raw: unknown): ObsenData {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_DATA };
	const link = (raw as { link?: unknown }).link;
	return { link: readLink(link) };
}

function readLink(raw: unknown): VaultLink | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { folderUuid, path } = raw as { folderUuid?: unknown; path?: unknown };
	if (typeof folderUuid !== "string" || folderUuid === "") return null;
	// A missing path is not a broken link — the UUID is the link, and the display falls
	// back to "the Filen root", which an empty path legitimately means anyway.
	return { folderUuid, path: typeof path === "string" ? path : "" };
}
