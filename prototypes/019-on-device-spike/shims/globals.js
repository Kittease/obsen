import { Buffer as BufferPolyfill } from "buffer"
export const Buffer = typeof globalThis.Buffer !== "undefined" ? globalThis.Buffer : BufferPolyfill
export const process = typeof globalThis.process !== "undefined" ? globalThis.process : { env: {} }
