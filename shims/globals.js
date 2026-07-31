// `--inject`ed into every bundle: @filen/sdk uses `Buffer` pervasively even on its
// WebCrypto paths, and dist/browser/constants.js:49 reads `process?.env?…` at module
// load — a bare `process` identifier throws ReferenceError where no global exists
// (i.e. a mobile webview). See docs/research/014-sdk-in-obsidian-feasibility.md.
import { Buffer as BufferPolyfill } from "buffer"
export const Buffer = typeof globalThis.Buffer !== "undefined" ? globalThis.Buffer : BufferPolyfill
export const process = typeof globalThis.process !== "undefined" ? globalThis.process : { env: {} }
