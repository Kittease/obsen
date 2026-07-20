// Load-test the bundled main.js in Node with a stubbed `obsidian` module.
// Verifies the bundle parses and its module graph evaluates without Node builtins.
// Browser-ish globals the webview provides but plain Node doesn't.
globalThis.window = globalThis
globalThis.self = globalThis
globalThis.navigator ??= { userAgent: "smoke" }
globalThis.document ??= {
	addEventListener() {},
	visibilityState: "visible",
	createElement: () => ({ setAttribute() {}, href: "http://localhost/", protocol: "http:", host: "localhost", hostname: "localhost", search: "", hash: "", pathname: "/", port: "" })
}
globalThis.location ??= { href: "http://localhost/", protocol: "http:", host: "localhost" }

const Module = require("module")
const origLoad = Module._load
const obsidianStub = {
	App: class {},
	Notice: class {},
	Platform: { isIosApp: false, isAndroidApp: false, isMobile: false },
	Plugin: class {},
	PluginSettingTab: class {},
	Setting: class {},
	normalizePath: p => p
}
Module._load = function (request, ...rest) {
	if (request === "obsidian") return obsidianStub
	return origLoad.call(this, request, ...rest)
}
const mod = require("./main.js")
const PluginClass = mod.default ?? mod
if (typeof PluginClass !== "function") throw new Error("bundle did not export a plugin class")
console.log("smoke PASS: bundle loads, exports plugin class", PluginClass.name)
