/**
 * The engine's only text codec.
 *
 * Sync moves bytes; merging, the Conflict Manifest and Conflict Copy names are the
 * three places bytes have to be read as text. Decoding is **strict**: a file that
 * is not valid UTF-8 is not a text file, whatever its extension says, and merging
 * it line-wise would corrupt it — so it degrades to a Conflict Copy instead.
 */

const STRICT = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();

export function encodeUtf8(text: string): Uint8Array {
	return ENCODER.encode(text);
}

/** `null` when the bytes are not valid UTF-8 — the caller must treat that as binary. */
export function decodeUtf8(data: Uint8Array): string | null {
	try {
		return STRICT.decode(data);
	} catch {
		return null;
	}
}
