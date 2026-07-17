---
title: "Research: Filen socket events — types, payloads, reliability"
ticket: 16
labels: [wayfinder:research]
---

# What does the Filen SDK's socket module actually deliver?

Researched against **`@filen/sdk@0.4.2`** (latest on npm at research time; `npm view @filen/sdk version` → `0.4.2`, license `AGPLv3`), by reading the npm tarball's shipped source (`dist/browser/socket/index.js`, `dist/types/socket/index.d.ts`) and the GitHub repos of Filen's own consumers: [filen-sdk-ts@6f272ff](https://github.com/FilenCloudDienste/filen-sdk-ts), [filen-web@930b12a](https://github.com/FilenCloudDienste/filen-web), [filen-sync@fcf7462](https://github.com/FilenCloudDienste/filen-sync), [filen-desktop@49a4af0](https://github.com/FilenCloudDienste/filen-desktop), [filen-ts@b7e88078](https://github.com/FilenCloudDienste/filen-ts) (next-gen web/mobile monorepo), and [filen-rs@92c1147e](https://github.com/FilenCloudDienste/filen-rs) (next-gen Rust SDK). The socket **server** is closed-source (no server repo in the [FilenCloudDienste org](https://github.com/orgs/FilenCloudDienste/repositories)); Filen's own API docs defer to the SDK source as the authoritative description of the realtime events API ([filen-docs `docs/api/specs/filen_openapi.yaml`](https://github.com/FilenCloudDienste/filen-docs/blob/main/docs/api/specs/filen_openapi.yaml): *"for a full description of the realtime events API, see the SDK's implementations"*). Server-side behavior claims below are therefore inferred from client code and flagged where unverified.

## TL;DR — the five sub-questions

1. **Event types.** 15 drive-relevant events reach a 0.4.2 listener: `fileNew`, `fileRename`, `fileMove`, `fileTrash`, `fileRestore`, `fileArchived`, `fileArchiveRestored`, `fileDeletedPermanent`, `folderSubCreated`, `folderRename`, `folderMove`, `folderTrash`, `folderRestore`, `folderColorChanged`, `itemFavorite`, plus signals `trashEmpty`, `passwordChanged`, and a generic `newEvent` activity entry (rest are notes/chats/contacts). **Caveat:** the backend emits at least 5 more drive events that 0.4.2 silently drops — including `folder-deleted-permanent`, `file-metadata-changed`, `folder-metadata-changed` — proven by the newer Rust SDK's wire-name table.
2. **Payloads.** Create/move/restore events are rich (parent UUID + item UUID + full metadata + chunk/bucket/region info) — enough to apply directly *given a UUID→path index*; rename/trash/delete events carry only the UUID (+ new metadata for renames), so the engine's own index must resolve paths. **All names/metadata arrive E2EE-encrypted** (`metadata` / folder `name` fields are encrypted strings) and need client-side decryption via `sdk.crypto().decrypt().fileMetadata()` / `.folderMetadata()` (master keys) — exactly what filen-web does per event.
3. **Browser compatibility: yes.** `dist/browser/socket/index.js` is a hand-rolled socket.io-protocol (engine.io v3) client over the **native `WebSocket` global** — no `socket.io-client`, no Node `net`/`tls`/`ws`. Its only import is `events` (already shimmed in our esbuild config per research 014).
4. **Lifecycle.** Hard-coded endpoint `wss://socket.filen.io/socket.io/?EIO=3&transport=websocket`; auth = plain `apiKey` sent as a socket event after handshake; auto-reconnect with 1 s→30 s exponential backoff; **zero delivery guarantees** — no acks, no cursor, no replay; events during a disconnect are lost. Filen's own next-gen mobile client refetches state on every reconnect. **Reconcile-on-resume stays mandatory.** (Also: two client bugs/quirks to design around — see §6.)
5. **Self-echo: yes (treat as certain).** Filen's next-gen web client states in code comments that *"the server echoes a note author's OWN edit back to them"* and suppresses via `editorId === own userId`. **Drive events carry no originator field at all**, so payload-based suppression is impossible; Filen's own drive handlers instead apply events idempotently (upsert/remove by UUID). Obsen's engine needs self-echo tolerance (idempotent apply and/or a recent-own-writes suppression set).

---

## 1. Socket architecture: what library, what protocol

The 0.4.2 socket module is **not** socket.io-client. It is a ~450-line hand-written client for the socket.io v2 wire protocol (engine.io protocol `EIO=3`) running over a single native-`WebSocket` transport:

- Endpoint is hard-coded, not configurable: `SOCKET_DEFAULTS.url = "https://socket.filen.io"`, connected as `wss://socket.filen.io/socket.io/?EIO=3&transport=websocket&t=<now>` (tarball `package/dist/browser/socket/index.js`, `SOCKET_DEFAULTS` + `_connect()`; identical logic in `dist/node/socket/index.js` and repo source [`src/socket/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/socket/index.ts)).
- History: SDK ≤0.2.x depended on `socket.io-client@^2.5.0` (`npm view @filen/sdk@0.2.8 dependencies`); 0.3.x had no socket at all (`npm view @filen/sdk@0.3.12 dependencies` lists no socket lib); 0.4.x reintroduced it hand-rolled. `EIO=3` matches the old v2 client — the server is a socket.io 2.x-era gateway.
- The next-gen Rust SDK connects to the **same** endpoint and protocol (`filen-rs/filen-sdk-rs/src/socket/consts.rs`: `WEBSOCKET_URL_CORE = "wss://socket.filen.io/socket.io/?EIO=3&transport=websocket&t="`), so this gateway is not legacy-about-to-die; it is what Filen's newest clients use.

Consumption model: `Socket extends EventEmitter`; every server event is re-emitted as one `"socketEvent"` event carrying a typed discriminated union `SocketEvent = { type: "fileNew", data: SocketFileNew } | …` (tarball `package/dist/types/socket/index.d.ts`). Connection-state events: `"connected"`, `"disconnected"`, `"authFailed"`, `"error"` (`emit()` internal-events list in `dist/browser/socket/index.js`).

The SDK exposes a socket instance as `sdk.socket` but **never connects it itself** — the consumer calls `sdk.socket.connect({ apiKey })` (filen-web does exactly this: [`src/lib/socket.ts`](https://github.com/FilenCloudDienste/filen-web/blob/main/src/lib/socket.ts), `getSocket().connect({ apiKey })`). The SDK config flag `connectToSocket: true` connects a *separate, private* socket owned by the virtual-FS module for its internal cache (tarball `dist/browser/fs/index.js`: `socket = new Socket()` + `_initSocketEvents(params.connectToSocket)`); official docs describe the flag as *"Recommended if you are using the virtual FS class. Keeps the internal item tree up to date with remote changes."* ([filen-docs `docs/sdk/authentication.md`](https://github.com/FilenCloudDienste/filen-docs/blob/main/docs/sdk/authentication.md)). Obsen should leave `connectToSocket` **off** and drive `sdk.socket` directly.

## 2. Event catalog and payloads

All types below are verbatim from tarball `package/dist/types/socket/index.d.ts`; wire-name→type mapping from `eventMappings` in `package/dist/browser/socket/index.js`.

### Drive events a 0.4.2 listener receives

| Event | Payload | Enough to apply directly? |
|---|---|---|
| `fileNew` (wire `file-new`) | `parent`, `uuid`, `metadata` (encrypted), `timestamp`, `chunks`, `bucket`, `region`, `version`, `favorited`, `rm` | Yes — parent UUID + decrypted metadata (name/size/mime/**content key**/lastModified/hash) + chunk locators suffice even to download, if parent UUID resolves in our index |
| `fileRestore` (wire `file-restore`) | same shape as `fileNew` | Yes, as above |
| `fileMove` (wire `file-move`) | same shape as `fileNew` (new `parent`) | Yes — but **old** parent is not included; index lookup by UUID needed to remove the old path |
| `fileArchiveRestored` (wire `file-archive-restored`) | same shape + `currentUUID` (the UUID being replaced) | Yes — old-version restore; UUID rotates from `currentUUID` to `uuid` |
| `fileRename` (wire `file-rename`) | `uuid`, `metadata` (encrypted, carries the new name) | Partially — no parent; UUID→path index required |
| `fileTrash` (wire `file-trash`) | `uuid` only | No — index lookup required |
| `fileArchived` (wire `file-archived`) | `uuid` only — old version archived when a file is overwritten | No — index lookup; see the duplicate-wire-name note below |
| `fileDeletedPermanent` (wire `file-deleted-permanent`) | `uuid` only | No — index lookup |
| `folderSubCreated` (wire `folder-sub-created`) | `name` (**encrypted metadata**, despite the field name), `uuid`, `parent`, `timestamp`, `favorited` | Yes, given parent resolution + decryption |
| `folderRestore` (wire `folder-restore`) | same as `folderSubCreated` | Yes |
| `folderMove` (wire `folder-move`) | same as `folderSubCreated` (new `parent`) | Yes; old parent not included |
| `folderRename` (wire `folder-rename`) | `name` (encrypted metadata), `uuid` | Partially — no parent |
| `folderTrash` (wire `folder-trash`) | `parent`, `uuid` | Index lookup for path |
| `folderColorChanged`, `itemFavorite` | uuid + attribute | Irrelevant to Obsen v1 |
| `trashEmpty` (wire `trash-empty`) | *(no payload)* | Signal only |
| `passwordChanged` | *(no payload)* | Signal → credentials invalid, re-auth needed |
| `newEvent` (wire `new-event`) | `uuid`, `type` (activity string), `timestamp`, `info { ip, metadata, userAgent, uuid }` | Generic activity-log entry; `info.metadata` encrypted |

Remaining union members are notes/chats/contacts events (same file) — irrelevant to Obsen except as proof of echo semantics (§5).

### Events the backend sends that 0.4.2 silently DROPS

The Rust SDK's wire-name table ([`filen-rs/filen-types/src/api/v3/socket.rs`](https://github.com/FilenCloudDienste/filen-rs/blob/main/filen-types/src/api/v3/socket.rs), `classify_event()`) handles these drive events that have **no entry in 0.4.2's `eventMappings`** and are therefore discarded without any callback:

- `file-metadata-changed` — payload `{ uuid, name, metadata, oldMetadata }` (all encrypted) — a metadata-only update (e.g. lastModified/hash rewrite) that is *not* a rename event
- `folder-metadata-changed` — `{ uuid, name: <encrypted meta> }`
- `folder-deleted-permanent` — `{ uuid }` — **a permanent folder deletion produces no event visible to a 0.4.2 listener**
- `deleteAll`, `deleteVersioned` — account-wide purge signals
- `file-versioned` — per the Rust source this is the real wire name for "old version archived"; the Rust client special-cases `file-archived` as *"duplicates of FileVersioned, so we can just ignore them"* ([`filen-sdk-rs/src/socket/events.rs`](https://github.com/FilenCloudDienste/filen-rs/blob/main/filen-sdk-rs/src/socket/events.rs) + `consts.rs` `ARCHIVED_EVENT_PREFIX`). So the backend emits **both** names for one occurrence; 0.4.2 maps only `file-archived`, which nets out to one event — fine, but worth knowing.

**Consequence:** the socket is *known-incomplete* as an event source on 0.4.2 — this is a hard, primary-source-verified reason reconcile cannot be optional.

## 3. Payload encryption

- File `metadata` and folder `name` fields on the wire are E2EE-encrypted strings. Decrypted `FileMetadata = { name, size, mime, key, lastModified, creation?, hash? }`, `FolderMetadata = { name }` (tarball `package/dist/types/types.d.ts`). Decryption API: `sdk.crypto().decrypt().fileMetadata({ metadata })` / `.folderMetadata({ metadata })` (tarball `package/dist/types/crypto/decrypt.d.ts`) using the account master keys.
- Proof by usage: filen-web's drive listing decrypts per event — `worker.decryptFileMetadata({ metadata: event.data.metadata })` on `fileNew`, `worker.decryptFolderMetadata({ metadata: event.data.name })` on `folderSubCreated`/`folderRename` ([`filen-web/src/components/drive/list/index.tsx`](https://github.com/FilenCloudDienste/filen-web/blob/main/src/components/drive/list/index.tsx), lines ~117–190).
- Research 014 already verified the crypto module runs browser-pathed under a mobile-webview-like sandbox, so per-event decryption works on Obsidian mobile.

## 4. Browser compatibility

Verified by reading the shipped browser build (tarball `package/dist/browser/socket/index.js`, selected by esbuild `--platform=browser` via the package's `"browser": "dist/browser/index.js"` field — see research 014):

- Transport is the **global `WebSocket`** constructor only (`this.socket = new WebSocket(wsUrl)` in `_connect()`); plus `URL`, `URLSearchParams`, `setInterval`/`setTimeout`, `JSON` — all webview-native. No `net`, no `tls`, no `ws` package, no XHR/polling fallback.
- Sole module import: `events` (`import { EventEmitter } from "events"` — the only `from "events"` import in the whole `dist/browser` tree). Our 014 build already aliases `--alias:events=events` (the `events@3.3.0` npm polyfill), so the socket module needs **zero additional shims**.
- The node build (`dist/node/socket/index.js`) is logically identical — it also uses the global `WebSocket` (Node ≥22), differing only in CJS-vs-ESM wrapping (verified by diff).
- **Unverified:** actual on-device behavior (iOS/Android webview WebSocket lifetime under app suspension) — that is ticket 019's spike. Webview OS-level socket suspension when the app backgrounds is expected and is another reason for reconcile-on-resume.

## 5. Self-echo: own writes DO come back

- **Direct statement from Filen's own code** (notes domain, next-gen web client): *"Echo suppression — mobile keys on editorId === own userId …: **the server echoes a note author's OWN edit back to them**, and applying it would clobber the editor."* ([`filen-ts/packages/filen-web/src/features/notes/lib/socketHandlers.ts`](https://github.com/FilenCloudDienste/filen-ts/blob/main/packages/filen-web/src/features/notes/lib/socketHandlers.ts), `handleContentEdited`).
- Note events carry `editorId`, enabling that suppression. **No drive event payload carries any originator/device/session field** (verified across every drive interface in `package/dist/types/socket/index.d.ts` and the Rust structs in `filen-types/src/api/v3/socket.rs`) — the generic `newEvent.info` has only `ip`/`userAgent`, which are not reliable self-identifiers.
- How Filen's own drive consumers cope: **idempotent application, not suppression.** filen-web's drive listing dedupes on insert (`prev.filter(i => i.name !== metadata.name && i.uuid !== event.data.uuid)` before appending, `drive/list/index.tsx`); the next-gen drive handlers are all uuid-keyed upserts/removals documented as safe to reapply ([`filen-ts/packages/filen-web/src/features/drive/lib/socketHandlers.ts`](https://github.com/FilenCloudDienste/filen-ts/blob/main/packages/filen-web/src/features/drive/lib/socketHandlers.ts)); the SDK's own FS module just evicts uuid-keyed cache entries (`dist/browser/fs/index.js` `_initSocketEvents`), which is origin-agnostic.
- **Unverified (server closed-source):** whether the echo goes to *every* socket of the account including the exact originating connection, vs. only to *other* connections. The notes comment proves at minimum same-user echo across connections; since drive payloads carry no origin marker, Obsen must assume the originating client receives its own drive events.

**Engine consequence:** self-echo handling is required. Either (a) make remote-event application idempotent against the sync index (an echoed `fileNew` for a UUID the index already maps at the same path = no-op), and/or (b) keep a short-lived "recently written by me" set of UUIDs to skip. (a) is mandatory anyway for reconcile correctness; (b) is an optimization to avoid pointless re-scans.

## 6. Connection lifecycle, auth, and delivery guarantees

All from tarball `package/dist/browser/socket/index.js` unless noted.

- **Connect guard:** `connect({ apiKey })` no-ops unless `apiKey.length >= 32 && apiKey !== "anonymous"` — the socket is only usable after login.
- **Handshake/auth:** WS open → server sends engine.io CONNECT with `pingInterval` → client sends namespace connect + `authed` (timestamp) → server replies `authed:false` → client sends `auth { apiKey }` (the raw API key, in-band) → server replies `["authed",true]` (confirmed as the success message by `filen-rs/socket/consts.rs` `AUTHED_TRUE`) or emits `authFailed`.
- **Keepalive:** engine.io PING + a re-sent `authed` event every `pingInterval` (server-provided, default 15 s).
- **Reconnect:** on close, auto-reconnect with exponential backoff 1 s × 1.5 up to 30 s cap, indefinitely (`_scheduleReconnect`), resetting to 1 s on success. No jitter.
- **Delivery guarantees: none.** The client never acknowledges events (no socket.io ACK usage), payloads carry no sequence number or cursor, and there is no replay/catch-up request in the protocol. Anything emitted while disconnected (or while dropped by the eventMappings gap of §2) is gone. Corroboration from Filen's own next-gen mobile client: on every reconnect (`AuthSuccess`) it refetches state — *"Refetch chats and messages to ensure we have the latest data after reconnect"* ([`filen-ts/packages/filen-mobile/src/components/shell/socket.tsx`](https://github.com/FilenCloudDienste/filen-ts/blob/main/packages/filen-mobile/src/components/shell/socket.tsx)).
- **Strongest corroboration:** Filen's *actual sync product* does not consume socket events for sync at all — `@filen/sync` polls `/v3/dir/tree` every `SYNC_INTERVAL = 5000` ms ([`filen-sync/src/constants.ts`](https://github.com/FilenCloudDienste/filen-sync/blob/main/src/constants.ts), [`src/lib/sync.ts`](https://github.com/FilenCloudDienste/filen-sync/blob/main/src/lib/sync.ts); the repo's only socket reference is passing `connectToSocket: true` to the SDK for its internal FS cache, `src/index.ts`). Filen itself does not trust the socket for sync correctness.

### Client quirks to design around (verified in 0.4.2 source)

1. **`isAuthenticated()` always returns `false`** — no code path ever sets `authenticated = true`, and the documented `socketAuthed` event is listed in `emit()`'s internal-events table but never emitted (grep of `dist/browser/socket/index.js` and `dist/node/socket/index.js`). Don't gate anything on it; treat "connected + events flowing" as the only health signal.
2. **`authFailed` permanently stops the socket** — the handler calls `disconnect()`, which sets `shouldReconnect = false`; no later reconnect happens until `connect()` is called again. Obsen must listen for `authFailed` and re-drive `connect()` after re-auth.
3. **Attach an `"error"` listener or crash (desktop/Node contexts):** filen-desktop deliberately runs `connectToSocket: false` because *"that socket emits 'error' on transient TLS drops (notably macOS sleep/wake); the SDK attaches no 'error' listener … an unhandled 'error' would crash the main process"* ([`filen-desktop/src/ipc/index.ts`](https://github.com/FilenCloudDienste/filen-desktop/blob/main/src/ipc/index.ts) ~line 218). Since `Socket extends EventEmitter` (Node semantics on Obsidian desktop/Electron), Obsen must always register an `error` handler on any socket it connects.

## 7. Version and license notes

- `@filen/sdk@0.4.2` is the latest npm release and matches the GitHub repo HEAD (`filen-sdk-ts` `package.json` version 0.4.2 at commit 6f272ff). All of Filen's shipping TS consumers pin `"@filen/sdk": "^0.4.2"` (package.json of filen-web, filen-sync, filen-desktop).
- License **AGPL-3.0** (`package.json` `"license": "AGPLv3"` + `LICENSE` file) — already flagged in research 014; feeds ticket 024.
- Filen is mid-migration to a Rust SDK (`filen-rs`, consumed via wasm/uniffi by the `filen-ts` monorepo that will replace filen-web/filen-mobile). Its socket layer is a superset (handles the §2 dropped events, exposes explicit `Reconnecting`/`AuthSuccess` lifecycle events, decrypts event metadata for you). Not consumable by Obsen today (different packaging, wasm), but it is the best forward-looking documentation of the gateway's true event set.

## Consequences for the sync-engine design (ticket 021)

1. **Socket = trigger, never ledger.** Confirmed on four independent primary-source grounds: no delivery guarantees in the protocol (no acks/cursor/replay); known event-type gaps in 0.4.2 (`folder-deleted-permanent`, `*-metadata-changed` dropped); Filen's own sync product ignores the socket and polls; Filen's own clients refetch on reconnect. **Reconcile on plugin start, on `connected` after any disconnect, and periodically, is mandatory** — the trigger model in ticket 005 is validated as-is.
2. **Targeted re-scan beats direct apply as the baseline.** Payloads are UUID-centric: renames/trashes/deletes carry no path and moves carry no old parent, so *every* event needs the engine's UUID→path index to be actionable. The cheapest correct reaction to any drive event is: mark dirty → debounce → run a scoped reconcile (or full reconcile — see next point). Direct apply from rich payloads (`fileNew` even includes the content key and chunk locators for immediate download) is a later optimization, not the foundation.
3. **Cheap reconcile exists:** `/v3/dir/tree` with a stable `deviceId` returns an empty diff when nothing changed since that deviceId's last fetch — filen-sync's 5-second poll relies on this (`filen-sync/src/lib/filesystems/remote.ts` `getDirectoryTree`: *"Data did not change, use cache"* on empty response; API shape in tarball `package/dist/types/api/v3/dir/tree.d.ts`, `fetch({ uuid, deviceId, skipCache })`). Socket event → trigger a `dir/tree` fetch is both correct and cheap; this also makes a low-frequency backstop poll affordable on mobile.
4. **Self-echo tolerance is required** (§5): idempotent event application against the sync index (mandatory anyway), optionally a recent-own-writes UUID suppression set to skip no-op re-scans right after our own uploads.
5. **Decryption per event** (if payloads are ever consumed directly): `sdk.crypto().decrypt().fileMetadata/folderMetadata` with master keys; folder events hide encrypted metadata in a field named `name`.
6. **Socket plumbing checklist for the engine:** call `sdk.socket.connect({ apiKey })` ourselves and keep `connectToSocket` off (avoid the FS module's private unguardable socket); always attach an `"error"` listener (crash risk, §6.3); handle `authFailed` by re-authing then re-calling `connect()` (§6.2); never consult `isAuthenticated()` (§6.1); treat `disconnected`→`connected` transitions as reconcile triggers; expect the webview to kill the socket when the app backgrounds on mobile (unverified on-device — ticket 019) and reconcile on resume.
7. **Event subscription set for v1 scope** (files + folders under the sync root): `fileNew`, `fileRename`, `fileMove`, `fileTrash`, `fileRestore`, `fileArchiveRestored`, `fileDeletedPermanent`, `folderSubCreated`, `folderRename`, `folderMove`, `folderTrash`, `folderRestore`, `trashEmpty`, `passwordChanged`. Ignore `fileArchived` (versioning bookkeeping, the replacing content arrives as its own `fileNew`), `folderColorChanged`, `itemFavorite`, `newEvent`, and all notes/chats/contacts events. Remember permanent folder deletions and metadata-only changes produce **no** 0.4.2 event (§2) — only reconcile catches them.
