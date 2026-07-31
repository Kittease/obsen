// Only referenced from @filen/sdk's node-only request paths.
// See docs/research/014-sdk-in-obsidian-feasibility.md.
export default function progressStream() {
	throw new Error("progress-stream is not available in the browser bundle")
}
