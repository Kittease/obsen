import FilenSDK from "@filen/sdk";
import { describe, expect, it } from "vitest";

import { sdkEnvironment } from "../../src/filen/sdk.ts";

/**
 * The one part of the real-remote suite that needs no account: proof that
 * `tests/remote/webview-globals.ts` actually put the SDK on its **browser** code
 * paths.
 *
 * Without it the suite would either exercise Node paths no phone runs, or fail
 * every upload on `uploadWebFile is not implemented for node` — and it would do so
 * only where credentials exist, which is the worst place to discover it. Here it
 * fails on any machine, in a second.
 */
describe("the real-remote suite's environment", () => {
	it("has the SDK agree it is in a browser", () => {
		expect(sdkEnvironment()).toBe("browser");
	});

	it("supplies the FileReader the web upload path reads chunks with", async () => {
		// Exactly how `cloud.uploadWebFile` gets at a File's bytes.
		const chunk: Uint8Array = await new FilenSDK().cloud().utils.utils.readWebFileChunk({
			file: new File(["obsen"], "note.md"),
			index: 0,
			length: 5,
		});

		expect(new TextDecoder().decode(chunk)).toBe("obsen");
	});

	it("leaves XMLHttpRequest absent, so axios keeps its Node HTTP adapter", () => {
		// A DOM environment would hand axios an XHR adapter and a same-origin policy,
		// and every call to Filen would fail CORS.
		expect(typeof XMLHttpRequest).toBe("undefined");
	});
});
