// @filen/sdk's browser build calls `os.tmpdir()` **at module load**
// (dist/browser/constants.js:47, ANONYMOUS_SDK_CONFIG.tmpPath), so this shim
// cannot be empty. See docs/research/014-sdk-in-obsidian-feasibility.md.
const os = {
	tmpdir: () => "/tmp",
	platform: () => "browser",
	arch: () => "browser",
	homedir: () => "/",
	EOL: "\n"
}
export default os
