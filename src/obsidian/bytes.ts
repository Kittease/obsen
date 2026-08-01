/**
 * Obsidian's binary I/O speaks `ArrayBuffer`; the ports speak `Uint8Array`. One
 * conversion, in one place, so neither adapter grows its own.
 *
 * The fast path hands the same bytes over rather than copying: a vault read is
 * normally already backed by its own buffer, and doubling peak memory here would do it
 * on exactly the large attachments spec §12 flags.
 */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const { buffer, byteOffset, byteLength } = data;
	if (byteOffset === 0 && byteLength === buffer.byteLength && buffer instanceof ArrayBuffer) {
		return buffer;
	}
	const copy = new ArrayBuffer(byteLength);
	new Uint8Array(copy).set(data);
	return copy;
}
