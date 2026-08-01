/**
 * Setup for the real-remote suite: the webview globals Node does not have,
 * installed before `@filen/sdk` is ever imported.
 *
 * The SDK picks its code paths at **runtime**, from the globals present — and the
 * paths Obsen ships are the browser ones (`cloud.uploadWebFile`, WebCrypto,
 * `downloadFileToReadableStream`). A suite that let the SDK detect Node would
 * exercise code no phone will ever run and, worse, `uploadWebFile` throws outright
 * for a non-browser environment. So the suite says "browser" and means it.
 *
 * Only two globals are missing: a `window` shaped enough for the SDK's detection
 * (`constants.ts` looks for `window.document` and `window.navigator`), and
 * `FileReader`, which the web upload path uses to read chunks out of a `File`.
 * Everything else the browser paths need — `File`, `Blob`, `crypto.subtle`,
 * `ReadableStream` — Node has. Notably `XMLHttpRequest` stays absent, so axios
 * keeps its Node HTTP adapter and no same-origin policy stands between the suite
 * and Filen's API.
 *
 * This is emphatically **not** a claim that the bundle is browser-safe. That is the
 * mobile-safety gate's job (spec §9 layer 2), and it makes the claim the other way
 * round: with *no* Node globals at all.
 */

Object.defineProperty(globalThis, "window", {
	value: { document: {}, navigator: {} },
	configurable: true,
	writable: true,
});

/** Just the surface `cloud/utils.readWebFileChunk` touches. */
class BlobFileReader {
	result: ArrayBuffer | string | null = null;
	onloadend: (() => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;

	readAsArrayBuffer(blob: Blob): void {
		blob.arrayBuffer().then(
			(buffer) => {
				this.result = buffer;
				this.onloadend?.();
			},
			(error: unknown) => {
				this.onerror?.(error);
			},
		);
	}
}

Object.defineProperty(globalThis, "FileReader", {
	value: BlobFileReader,
	configurable: true,
	writable: true,
});
