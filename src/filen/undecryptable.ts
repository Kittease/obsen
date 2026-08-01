/**
 * A name the SDK could not decrypt.
 *
 * It substitutes this placeholder rather than failing, and the substitute must never
 * reach the vault or the folder picker: the item's key is part of the same unreadable
 * metadata, so nothing behind the name can be fetched either. Materializing it would
 * create a note whose every download fails; offering it as a link target would link a
 * vault to a folder Obsen can never read.
 *
 * Hiding a *file* does not hide one that would otherwise sync. A file whose metadata
 * will not decrypt has already lost its real path — the tree keys it under this
 * placeholder — so the Run sees the real path as missing either way. That is Filen-side
 * corruption, and no adapter can reconcile it; what this filter buys is that the
 * corruption does not also spawn a junk note.
 */
const UNDECRYPTABLE = "CANNOT_DECRYPT_NAME_";

export function isUndecryptableName(name: string): boolean {
	return name.startsWith(UNDECRYPTABLE);
}

/** The same question for a whole path: any segment being unreadable condemns it. */
export function hasUndecryptableSegment(path: string): boolean {
	return path.split("/").some(isUndecryptableName);
}
