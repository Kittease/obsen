// Shim for `crypto`, `https`, `url`, `fs-extra` — @filen/sdk's call sites for all
// four sit behind `environment === "node"` runtime guards, so an empty object is
// enough to satisfy the bundler. See docs/research/014-sdk-in-obsidian-feasibility.md.
export default {}
