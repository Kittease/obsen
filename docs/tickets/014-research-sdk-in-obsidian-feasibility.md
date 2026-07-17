---
id: 14
title: "Research: can @filen/sdk's browser build run inside an Obsidian plugin?"
labels: [wayfinder:research]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

The riskiest unknown on the map. Can `@filen/sdk` (browser build, `dist/browser/index.js`) be bundled into a mobile-safe Obsidian plugin — and if not, what's the fallback?

To answer:

- Bundle the SDK's browser entry with `esbuild --platform=browser` into an Obsidian plugin shell. Which dependencies break? (Known Node-only deps in the tree: `fs-extra`, `agentkeepalive`; axios needs its browser adapter; check crypto — WebCrypto vs `node-forge`/`crypto-js` paths in the browser build.)
- Which SDK surfaces does Obsen actually need, and do they work in the browser build: login/auth-config export, dir listing, file upload/download (streaming vs in-memory at our ≤1 GB envelope), move/rename, trash, file versioning API, socket module?
- Bundle size and plugin load-time impact (Obsidian loads plugin `main.js` synchronously).
- If the SDK is unusable: assess fallback — calling Filen's HTTP API v3 directly with our own thin client (the SDK source documents the endpoints and the E2EE crypto scheme).

Output: a markdown summary in `docs/research/` with a verdict (SDK as-is / SDK with patches / thin custom client) and the list of workable API surfaces. Desktop-Electron verification can be done AFK; final on-device mobile confirmation belongs to the prototype ticket ([019](019-prototype-on-device-spike.md)).

## Resolution

**Verdict: SDK with patches** — build-time shims only, zero SDK source modifications. Full findings: [docs/research/014-sdk-in-obsidian-feasibility.md](../research/014-sdk-in-obsidian-feasibility.md).

- `@filen/sdk@0.4.2`'s browser build (`dist/browser/index.js`) bundles cleanly into a single CJS `main.js` with `esbuild --platform=browser` plus 8 module aliases (empty stubs for `crypto`/`https`/`url`/`fs-extra`/`progress-stream`, functional stubs for `os`/`stream`, real polyfills `events`/`path-browserify`), `--inject`ed `Buffer`/`process`, and `--define:global=globalThis`. The exact invocation and verbatim shims are in the research doc.
- Smoke-tested in a locked-down vm sandbox emulating a mobile webview (no Node globals at all): the SDK constructs, detects `environment === "browser"`, and passes WebCrypto encrypt/decrypt round-trips and login key derivation.
- Every surface Obsen needs is browser-pathed — auth, dir listing, upload (`cloud.uploadWebFile`), download (`downloadFileToReadableStream`), move/rename, trash, versioning, socket (hand-rolled socket.io over global WebSocket) — except `fs.writeFile` (Node streams), which Obsen avoids by using the web-file paths.
- `--define:global=globalThis` is load-bearing: `constants.js` probes bare `global` at module load and would have crashed the plugin in a mobile webview.
- Bundle: 2.6 MB raw / 1.2 MB minified (325 KB gz), ~45 ms parse+eval on desktop. All four Filen API hosts answer CORS preflights with `access-control-allow-origin: *` (verified live against `Origin: app://obsidian.md`).
- Fallback (thin HTTP v3 client) is viable but unnecessary: ~15–20 endpoints + documented E2EE crypto scheme, all in the SDK source. Extra escape hatch: `FilenSDK` accepts a custom `axiosInstance`, so an Obsidian-`requestUrl`-backed adapter is possible if webview XHR misbehaves.
- **Surfaced follow-up:** the SDK is AGPL-3.0, which constrains Obsen's own license → new ticket [024](024-choose-license.md).
- Unverified here (belongs to [018](018-research-agent-test-harness.md)/[019](019-prototype-on-device-spike.md)): real-account network round-trips, on-device mobile behavior, long-session socket stability.
