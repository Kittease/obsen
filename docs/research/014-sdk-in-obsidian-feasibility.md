---
title: "Research: @filen/sdk browser build inside a mobile-safe Obsidian plugin"
ticket: 14
labels: [wayfinder:research]
---

# Can `@filen/sdk`'s browser build run inside an Obsidian plugin?

Tested against **`@filen/sdk@0.4.2`** (latest on npm at research time, same version the map lists as verified), bundled with **esbuild 0.28.1**, smoke-tested under Node v26 with (a) browser-ish globals and (b) a locked-down `vm` sandbox emulating a mobile webview (no `Buffer`, no `process`, no `global`, no Node `require`, WebCrypto + web streams only).

## VERDICT: **SDK with patches** — build-time shims only, zero source modifications

The browser build bundles cleanly with `esbuild --platform=browser` once eight Node-builtin/Node-only module IDs are aliased to small local shims and `Buffer`/`process`/`global` are provided. The resulting single CJS `main.js` loads, constructs a `FilenSDK`, detects `environment === "browser"`, and runs real WebCrypto encrypt/decrypt round-trips and login key derivation **in a sandbox with no Node globals at all**. Every API surface Obsen needs exists and is browser-pathed, with one exception (`fs.writeFile`, avoidable — see table).

- **Confidence: high** for "it bundles and its crypto/API plumbing is browser-safe" — verified hands-on, evidence below.
- **Unverified (belongs to tickets 018/019):** actual network round-trips with a real account (login, upload, download, socket events end-to-end); behavior on a physical iOS/Android device (memory ceiling on ~1 GB transfers, webview WebCrypto performance, Capacitor quirks); long-session socket stability.
- **License note:** the SDK is **AGPL-3.0** ([package.json](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/package.json)); bundling it into Obsen's distributed `main.js` constrains Obsen's own license choice (AGPL-compatible). Flag for the spec ticket.

## The exact build that works

`package.json` deps used by the experiment: `@filen/sdk@0.4.2`, `esbuild@0.28.1`, plus three real polyfills: `events@3.3.0`, `path-browserify@1.0.1`, `buffer@6.0.3`.

```sh
esbuild main.ts --bundle --platform=browser --format=cjs --external:obsidian \
  --define:global=globalThis \
  --alias:os=./shims/os.js \
  --alias:path=path-browserify \
  --alias:stream=./shims/stream.js \
  --alias:crypto=./shims/empty.js \
  --alias:https=./shims/empty.js \
  --alias:url=./shims/empty.js \
  --alias:fs-extra=./shims/empty.js \
  --alias:progress-stream=./shims/progress-stream.js \
  --alias:events=events \
  --inject:./shims/globals.js \
  --minify --outfile=main.js
```

With `--platform=browser`, esbuild honors the SDK's `"browser": "dist/browser/index.js"` field automatically (no `exports` map exists), confirmed via the build metafile: all 185 `@filen/sdk` inputs came from `dist/browser/`. `--external:obsidian` matches the standard Obsidian plugin build.

### Shim files (verbatim)

`shims/empty.js` — for `crypto`, `https`, `url`, `fs-extra`, whose call sites all sit behind `environment === "node"` runtime guards:

```js
export default {}
```

`shims/os.js` — the browser build calls `os.tmpdir()` **at module load** (`dist/browser/constants.js:47`, `ANONYMOUS_SDK_CONFIG.tmpPath`), so this one cannot be empty:

```js
const os = {
	tmpdir: () => "/tmp",
	platform: () => "browser",
	arch: () => "browser",
	homedir: () => "/",
	EOL: "\n"
}
export default os
```

`shims/stream.js` — `ChunkedUploadWriter extends Writable` at class-definition time (`dist/browser/cloud/streams.js:15`), so `Writable` must be a real extendable class; nothing on the browser path ever *constructs* a Node stream:

```js
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
```

`shims/progress-stream.js` — only referenced in node-only request paths:

```js
export default function progressStream() {
	throw new Error("progress-stream is not available in the browser bundle")
}
```

`shims/globals.js` (used via `--inject`) — the SDK uses `Buffer` pervasively even on its WebCrypto paths, and `dist/browser/constants.js:49` reads `process?.env?...` at module load (a bare `process` identifier throws `ReferenceError` where no global exists):

```js
import { Buffer as BufferPolyfill } from "buffer"
export const Buffer = typeof globalThis.Buffer !== "undefined" ? globalThis.Buffer : BufferPolyfill
export const process = typeof globalThis.process !== "undefined" ? globalThis.process : { env: {} }
```

### Why each flag exists (what broke without it)

A naive `esbuild --bundle --platform=browser` fails with **53 resolution errors**, all Node builtins — no npm dependency failed to resolve (`agentkeepalive` ships its own `browser.js` stub; `axios@0.28` resolves to its XHR adapter via its `browser` field):

| Broken import | Imported by | Load-time side effect that forces a non-trivial fix |
|---|---|---|
| `os` (7×) | `constants.js`, `index.js`, `utils.js`, crypto | `os.tmpdir()` runs at module load (`constants.js:47`) → functional stub |
| `path` (19×) | nearly everywhere | `pathModule.posix.dirname()` used on **browser** runtime paths (`fs/index.js`) → real impl (`path-browserify`, has `.posix`) |
| `stream` (9×) | api/client, cloud, streams/* | `ChunkedUploadWriter extends Writable` at load (`cloud/streams.js:15`) → extendable class stub |
| `crypto` (7×) | crypto/*, cloud | runtime-guarded only → empty stub |
| `events` (3×) | `socket/index.js`, deps | `Socket extends EventEmitter` at load → real impl (`events` pkg) |
| `https`, `url` | `api/client.js` | node-only request path → empty stub |
| `fs`/`util`/`assert`/`constants` | via `fs-extra` (graceful-fs, jsonfile) and `progress-stream` (through2/readable-stream) | aliasing `fs-extra` + `progress-stream` themselves removes the whole subtree |
| `agentkeepalive` | `api/client.js:9` | `new HttpsAgent()` runs at module load — harmless because the package's own browser stub is picked up; no alias needed |
| bare `global` | `constants.js:8` (`isReactNative` check) | `typeof global.IS_EXPO_REACT_NATIVE` throws `ReferenceError` in a webview with no `global` → `--define:global=globalThis` (found by sandbox smoke test, would have crashed on mobile at plugin load) |

## Per-surface table

"Bundle smoke" = surface exists and is callable in the bundled output under the no-Node-globals sandbox (experiment artifacts: `main.ts`, `smoke.cjs`, `smoke-mobile.cjs` in the ticket-014 scratchpad). Network round-trips deliberately not exercised (no credentials in this task).

| SDK surface | Browser build? | Evidence |
|---|---|---|
| `sdk.login({email,password,twoFactorCode})` | Yes | `dist/browser/index.js:484`; key derivation runs via `@noble/hashes` argon2id / WebCrypto PBKDF2 (`crypto/utils.js:167`); derivation for authVersion 2 executed successfully in sandbox smoke test |
| Auth-config export | Yes | `login()` ends by `init()`-ing `sdk.config` with `apiKey`, `masterKeys`, `publicKey/privateKey`, `baseFolderUUID`, `userId` (`dist/browser/index.js:530-542`); persist `sdk.config` and re-`init` — matches CONTEXT.md "Auth Config" |
| Dir listing `cloud.listDirectory` | Yes | env-agnostic: `api.v3().dir().content()` + metadata decrypt through worker (`dist/browser/cloud/index.js`, `listDirectory`); bundle smoke PASS |
| Upload (browser path) `cloud.uploadWebFile({file: File})` | Yes — **the** browser upload | explicitly `environment !== "browser" → throw` guard (`dist/browser/cloud/index.js:3687`); chunked 1 MiB (`UPLOAD_CHUNK_SIZE`, `constants.js`), hashes via `@noble/hashes` `sha512.create()`, posts chunks through axios XHR. Obsidian gives `ArrayBuffer`; wrap with `new File([buf], name, {lastModified})` |
| Download `cloud.downloadFileToReadableStream` | Yes — returns a **web** `ReadableStream` | `dist/browser/cloud/index.js:2626`; chunk GETs via axios, decrypt via WebCrypto; `fs.readFile` wraps it into an in-memory Buffer (`dist/browser/fs/index.js:1051` `read()`) — fine at Obsen's mostly-Markdown envelope |
| `fs.writeFile` facade | **No** — two dead Node deps | uses `Readable.from` + `uploadLocalFileStream` (`fs/index.js:1167`), and `ChunkedUploadWriter` calls `nodeCrypto.createHash("sha512")` unconditionally in its constructor (`cloud/streams.js:87`). Use `cloud.uploadWebFile` instead; rest of the `fs` facade (readdir/stat/mkdir/rename/unlink/readFile) is browser-pathed |
| Move / rename | Yes | `cloud.moveFile/moveDirectory/renameFile/renameDirectory` → `api/v3/{file,dir}/{move,rename}` + metadata re-encrypt (WebCrypto path); bundle smoke PASS |
| Trash (soft delete) | Yes | `cloud.trashFile/trashDirectory` → `api/v3/{file,dir}/trash`; bundle smoke PASS |
| File versioning | Yes | `cloud.fileVersions` / `cloud.restoreFileVersion` → `api/v3/file/versions`, `api/v3/file/version/restore`; bundle smoke PASS |
| Socket module | Yes — pure WebSocket | hand-rolled socket.io protocol over the **global `WebSocket`** (`dist/browser/socket/index.js:95`, `new WebSocket(wsUrl)`; source `src/socket/index.ts`); no Node `net`/socket.io-client dependency; only needs the `events` polyfill |
| Crypto (metadata + file) | Yes — WebCrypto | every encrypt/decrypt has an `environment === "browser"` branch using `globalThis.crypto.subtle` (`crypto/encrypt.js:78-136`, `crypto/decrypt.js:66-96`); round-trip executed in sandbox smoke test |
| Custom HTTP transport | Yes — injectable | `FilenSDK` config accepts `axiosInstance` (`dist/browser/index.js:88`) — an adapter backed by Obsidian's `requestUrl` can be dropped in if webview XHR ever misbehaves |

**CORS (would have been the silent killer):** verified live — `gateway.filen.io`, `egest.filen.io`, `ingest.filen.io`, `socket.filen.io` all answer preflights with `access-control-allow-origin: *` (checked with `Origin: app://obsidian.md`). Filen's own web app runs this same browser build, so this is by design, not luck.

## Bundle size and load time

Measured on the working build above (entry = minimal plugin class touching all surfaces):

| Artifact | Size |
|---|---|
| `main.js` raw | **2.6 MB** |
| `main.js` minified | **1.2 MB** |
| minified + gzip -9 (reference) | 325 KB |

Parse+eval of the bundle (proxy for Obsidian's synchronous plugin load), Node v26 on desktop hardware: **~45 ms minified, ~30 ms raw**. Expect a few-hundred-ms on older phones — acceptable, but the spec should note it. Composition (metafile): the SDK's own code is only ~566 KB; the rest is its crypto stack kept for legacy-format compatibility — `node-forge` 565 KB, `crypto-api-v1` 254 KB, `crypto-js` 209 KB, `mime-db` 208 KB, `elliptic`+`bn.js` ~200 KB. Little of it is droppable without patching the SDK, since v1/v1.5 decrypt paths reference them.

## Fallback assessment: thin custom client over HTTP API v3

Not needed on current evidence, but viable as a documented escape hatch:

- **Where everything lives:** endpoints are one-file-per-endpoint under [`src/api/v3/`](https://github.com/FilenCloudDienste/filen-sdk-ts/tree/main/src/api/v3) (auth/info, login, dir/content, dir/create, dir/move, dir/rename, dir/trash, file/move, file/rename, file/trash, file/versions, file/version/restore, upload/done, file/upload/chunk/buffer, user/baseFolder, user/info, …). Request framing (bearer `Authorization`, sha512 `Checksum` header, gateway/ingest/egest host pools) is all in [`src/api/client.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/client.ts).
- **Crypto scheme to reimplement** ([`src/crypto/encrypt.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/crypto/encrypt.ts) / [`decrypt.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/crypto/decrypt.ts)): metadata v2 = AES-256-GCM, key = PBKDF2(masterKey, salt=masterKey, 1 iter, SHA-512, 256-bit), 12-char utf-8 IV, `"002" + iv + base64(cipher+tag)`; metadata v3 = AES-256-GCM with 64-hex key, `"003" + hexIv + base64`; file data v2 = AES-256-GCM per-1 MiB chunk with per-file random 32-char key; auth v1/v2 = PBKDF2-derived password+master keys, v3 = argon2id. All WebCrypto/`@noble`-expressible.
- **Scope estimate:** for Obsen's surfaces (auth, list, up/download, move/rename, trash, versions, socket) a thin client is roughly 15–20 endpoints + the v2/v3 crypto + chunked transfer logic — a few weeks of careful work, and it takes on **protocol-drift risk the SDK currently absorbs** (multi-host failover, legacy metadata versions, checksum header semantics). The socket protocol would also need reimplementing (or keep just the SDK's dependency-free `src/socket/index.ts`, which is nearly standalone).
- **Middle option** if bundle size ever becomes the complaint: keep the SDK but fork out the v1/v1.5 legacy crypto (drops ~1 MB of forge/crypto-js/crypto-api-v1) — only worth it with evidence that vaults never contain legacy-encrypted items, which is false in general (old accounts).

## What breaks this verdict (watch list)

1. On-device mobile run (ticket 019): webview memory on big binary files — `fs.readFile`/upload paths buffer whole files in memory; at the ≤1 GB envelope a single huge attachment could OOM a phone webview. Mitigation exists (`downloadFileToReadableStream` + ranged reads), but uploads of very large single files are in-memory-chunked from a `File`, which webviews handle via disk-backed Blobs — needs on-device confirmation.
2. Real-account round-trips (ticket 018 harness): nothing here proves the server accepts what the browser paths produce — Filen's own web app is strong but indirect evidence.
3. SDK upgrades: the shim list is coupled to 0.4.2's import graph; re-run the bundle gate (already a standing constraint) on every bump.

## Citations

- npm package inspected: `@filen/sdk@0.4.2` (`node_modules/@filen/sdk/package.json`: `"main": "dist/node/index.js"`, `"browser": "dist/browser/index.js"`, no `exports` field; node build = CJS, browser build = ESM of the same sources with runtime `environment` switching — `dist/browser/constants.js:1-16`).
- GitHub source (paths confirmed against the sourcemaps shipped in the npm package): [FilenCloudDienste/filen-sdk-ts](https://github.com/FilenCloudDienste/filen-sdk-ts) — [`src/constants.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/constants.ts) (env detection, `global.*` probe, `os.tmpdir()` at load), [`src/api/client.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/client.ts) (axios browser path, node `https` path, `keepAliveAgent` at load), [`src/cloud/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/cloud/index.ts) (`uploadWebFile`, `downloadFileToReadableStream`), [`src/cloud/streams.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/cloud/streams.ts) (`ChunkedUploadWriter extends Writable`, unconditional `nodeCrypto.createHash`), [`src/crypto/encrypt.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/crypto/encrypt.ts) / [`decrypt.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/crypto/decrypt.ts) / [`utils.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/crypto/utils.ts) (WebCrypto branches), [`src/socket/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/socket/index.ts) (WebSocket transport), [`src/fs/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/fs/index.ts) (facade, `writeFile` Node-stream dependency).
- Experiment artifacts (ticket-014 scratchpad, not committed): `main.ts` (plugin-shaped entry), `shims/*`, `smoke.cjs` (browser-globals-in-Node run: 14/14 PASS incl. WebCrypto round-trip), `smoke-mobile.cjs` (vm sandbox without Buffer/process/global/require: PASS incl. login key derivation), `meta.json` (esbuild metafile; browser-entry + size attribution), CORS preflights via `curl -X OPTIONS` against the four Filen hosts.
