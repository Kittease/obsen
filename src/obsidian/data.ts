/**
 * `data.json` — the plugin's device-local, non-secret settings.
 *
 * What lives here is everything that is *not* a credential: credentials go to
 * `SecretStorage` and nowhere else (spec §8.1), and this file exists partly to make
 * that split explicit at the type level. `data.json` sits inside the vault's config
 * folder, which means a vault backup or another sync tool can read it — so anything
 * added here has to be safe in that light.
 *
 * It is deliberately tiny for now: the link is the only thing 030 needs to know about,
 * because logging out of a *linked* vault is the one logout worth warning about. Ticket
 * 031 fills the link in, 038 adds the Device Name.
 */

/**
 * The Remote Folder this vault is linked to. The UUID is what a link *is* — it survives
 * the folder being moved or renamed (spec §8.3) — and it is all this slice needs, to
 * answer "is a folder linked?" when logging out. Ticket 031 owns the link itself and
 * whatever else it needs to remember about the folder.
 */
export type VaultLink = { folderUuid: string };

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
	const { folderUuid } = raw as { folderUuid?: unknown };
	if (typeof folderUuid !== "string" || folderUuid === "") return null;
	return { folderUuid };
}
