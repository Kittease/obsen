/** Content conversions the fakes share, so a test can seed files with plain strings. */

export function toBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function decodeText(data: Uint8Array): string {
	return new TextDecoder().decode(data);
}
