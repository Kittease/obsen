/**
 * Content hashing: SHA-512 hex, everywhere (spec §3.1).
 *
 * One digest serves as dirty-detector, Shadow Store key and rename-pairing key
 * because it is *Filen's own* plaintext content hash — so remote change detection
 * is a string comparison, with no extra bytes computed or transferred.
 *
 * WebCrypto only: `crypto.subtle` exists in every Obsidian webview, and reaching
 * for Node's `crypto` would break mobile.
 */

/** Injected wherever hashing happens, so tests can count or stub digests. */
export type Hasher = (data: Uint8Array) => Promise<string>;

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
	return hex;
}

export const sha512Hex: Hasher = async (data) => {
	// `data.slice()` copies into a plain ArrayBuffer view: WebCrypto rejects the
	// SharedArrayBuffer-backed case, and a copy is cheaper than being wrong about
	// which one a caller handed us.
	const digest = await crypto.subtle.digest("SHA-512", data.slice());
	return toHex(new Uint8Array(digest));
};
