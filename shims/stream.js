// `ChunkedUploadWriter extends Writable` at class-definition time
// (@filen/sdk dist/browser/cloud/streams.js:15), so `Writable` must be a real
// extendable class. Nothing on the browser path ever *constructs* a Node stream.
// See docs/research/014-sdk-in-obsidian-feasibility.md.
class NotSupported {
	constructor() {
		throw new Error("Node streams are not available in the browser bundle (node-only SDK path)")
	}
}
export class Readable extends NotSupported {
	static from() { throw new Error("stream.Readable.from is not available in the browser bundle") }
	static fromWeb() { throw new Error("stream.Readable.fromWeb is not available in the browser bundle") }
}
export class Writable {
	constructor() {
		if (new.target === Writable) throw new Error("Node streams are not available in the browser bundle")
	}
}
export class Transform extends NotSupported {}
export class PassThrough extends NotSupported {}
export function pipeline() { throw new Error("stream.pipeline is not available in the browser bundle") }
export default { Readable, Writable, Transform, PassThrough, pipeline }
