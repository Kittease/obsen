---
title: "Obsen v1 — specification"
ticket: 23
status: normative
---

# Obsen v1 — specification

Obsen is an Obsidian plugin that two-way syncs a vault with one Filen folder, end-to-end encrypted, on **every platform Obsidian runs on** — Windows, macOS, Linux, **Android, iOS**. Mobile is the reason Obsen exists: desktop already has Filen's native folder sync; mobile has nothing.

This document is the validated v1 spec — the destination of the [wayfinder map](../map.md). Every decision here was settled on a map ticket; section headers link the tickets and research docs that hold the full reasoning. Terms in **bold capitals** follow the ubiquitous language in [`CONTEXT.md`](../../CONTEXT.md) — code, tickets, and tests use those words with exactly those meanings.

**Scale envelope** ([012](../tickets/012-scale-envelope-and-distribution.md)): a few hundred to a few thousand Markdown files plus small side files, ~50 MB to ~1 GB total. Bigger vaults are a known non-goal for v1.

**Supported topology** ([010](../tickets/010-engine-coexistence-topology.md)): one sync engine per folder per device. Different engines on different devices sharing a Remote Folder is supported and tested; Filen's desktop app syncing the same local folder Obsen runs in is explicitly unsupported (documentation + settings warning, no auto-detection).

---

## 1. Architecture

### 1.1 Pure-TS engine behind three ports ([013](../tickets/013-testability-architecture.md), [021](../tickets/021-design-sync-engine-algorithm.md))

The **Sync Engine** is pure TypeScript with zero imports from `obsidian` or `@filen/sdk`. Three ports isolate every environment dependency; production adapters on one side, in-memory fakes in tests:

- **`VaultPort`** — Obsidian vault access. Production: a wrapper over Obsidian's Vault API (never the Adapter API where Vault suffices; deletions via `FileManager.trashFile()`).
- **`RemotePort`** — Filen access. Production: a wrapper over `@filen/sdk`. Ops are **UUID-addressed**; the port owns socket-event decryption and UUID→path resolution.
- **`StorePort`** — Obsen's own persistence (**Sync State** + **Shadow Store**). Production: files under the plugin folder via the vault adapter.

Hashing (WebCrypto SHA-512) lives in the engine. The clock and timers are injected so debounce/backoff are testable headless. Whole-file `Uint8Array` I/O is accepted for v1 (huge-attachment streaming is on the watch list, §10).

The port signatures are **normative** (finalized on [021](../tickets/021-design-sync-engine-algorithm.md)):

```ts
type Stat = { size: number; mtime: number };

type VaultEvent =
  | { type: "create" | "modify" | "delete"; path: string; stat: Stat | null }
  | { type: "rename"; from: string; to: string; stat: Stat };

interface VaultPort {
  list(): Promise<{ path: string; stat: Stat }[]>;      // full scan, NFC paths
  stat(path: string): Promise<Stat | null>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<Stat>; // ATOMIC (tmp+rename) for a new file — see below
  rename(from: string, to: string): Promise<Stat>;
  trash(path: string): Promise<void>;                   // Obsidian's configured trash
  mkdir(path: string): Promise<void>;
  trashFolder(path: string): Promise<void>;
  isWritablePath(path: string): boolean;                // platform name constraints
  watch(onEvent: (e: VaultEvent) => void): () => void;
}

type RemoteEntry = { path: string; uuid: string; size: number; hash?: string }; // sha512 hex; absent = unknown

type RemoteEvent =
  | { type: "change"; path: string }  // port resolved UUID→path
  | { type: "unresolved" };           // engine escalates scope to FULL

interface RemotePort {
  listing(): Promise<RemoteEntry[]>;  // full recursive tree, one call, decrypted, NFC
  download(uuid: string): Promise<Uint8Array>;
  upload(path: string, data: Uint8Array): Promise<{ uuid: string }>;
  move(uuid: string, toPath: string): Promise<void>;
  trashFile(uuid: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  trashFolder(path: string): Promise<void>;
  moveFolder(fromPath: string, toPath: string): Promise<void>;
  watch(onEvent: (e: RemoteEvent) => void): () => void; // socket; port owns decrypt + resolution
}

interface StorePort {                 // sync-state.json + shadow/
  readState(): Promise<string | null>;
  writeState(json: string): Promise<void>;  // ATOMIC
  readShadow(hash: string): Promise<Uint8Array | null>;
  writeShadow(hash: string, data: Uint8Array): Promise<void>;
  deleteShadow(hash: string): Promise<void>;
}
```

**Amendment (ticket [029](../tickets/029-impl-obsidian-adapters-and-wdio.md), from real Obsidian):** `VaultPort.write` is atomic for a file that does not exist yet, and for everything in `<configDir>/`. **Overwriting a file Obsidian has indexed is not**, because renaming over one makes Obsidian's watcher read a delete followed by a create and **close the editor tab the note is open in** — which would shut the user's note on every remote edit that arrived while they were reading it. Overwrites go through `Vault.modifyBinary`, the call Obsidian's own editor saves through, leaving them exactly as exposed to a torn write as any note the user types; the next Run's re-hash repairs one. The measurement and the regression test are in `tests/wdio/vault-port.e2e.ts`.

### 1.2 Bundling — the mobile-safety gate ([014 research](../research/014-sdk-in-obsidian-feasibility.md), [017 research](../research/017-plugin-guidelines-and-brat.md))

`manifest.json` declares `isDesktopOnly: false`; the build **enforces** it: esbuild runs with `--platform=browser` and does **not** externalize Node builtins (unlike the sample scaffold), so any stray `import "fs"` — including in dependencies — is a build **error**, not a mobile crash. Keep `format: cjs` and `external: ["obsidian"]` (non-negotiable: Obsidian loads `main.js` as CJS and provides `obsidian` at runtime).

`@filen/sdk@0.4.2`'s browser build bundles with **build-time shims only, zero SDK source modifications** — the exact esbuild invocation and verbatim shim files are in the [014 research doc](../research/014-sdk-in-obsidian-feasibility.md) and were proven on a real Android phone ([019](../tickets/019-prototype-on-device-spike.md)). Summary: 8 module aliases (empty stubs `crypto`/`https`/`url`/`fs-extra`/`progress-stream`; functional stubs `os`/`stream`; real polyfills `events`/`path-browserify`), `--inject`ed `Buffer`/`process`, and the load-bearing `--define:global=globalThis`. Bundle: 2.6 MB raw / 1.2 MB minified, ~45 ms parse on desktop. The shim list is coupled to 0.4.2's import graph — re-run the bundle gate on every SDK bump.

SDK surfaces used (all browser-pathed, verified): `login`, auth-config export/re-init, `cloud.getDirectoryTree` (the whole recursive listing in one call, decrypted and path-keyed, via `/v3/dir/download`), `cloud.uploadWebFile` (never `fs.writeFile` — Node-stream dead end), `cloud.downloadFileToReadableStream`, move/rename, trash, `sdk.socket`. All four Filen API hosts answer CORS preflights with `*`; if webview XHR ever misbehaves, `FilenSDK` accepts a custom `axiosInstance` backed by Obsidian's `requestUrl` (documented escape hatch, not used by default).

### 1.3 Plugin shell lifecycle ([017 research](../research/017-plugin-guidelines-and-brat.md))

- `onload`: registrations only — settings tab, ribbon icon, commands. Nothing computational, no network.
- All startup work — auth restore, socket connect, startup **Reconcile**, and **crucially the vault-event watchers** — goes in `workspace.onLayoutReady()`. Obsidian fires `vault.on('create')` for *every existing file* during vault init; registering watchers in `onload` would read as a vault-wide creation storm.
- Cleanup via `registerEvent`/`addCommand`/`registerInterval`; the unload path is exercised on every BRAT update.
- Code-level rules with teeth (all lintable via `eslint-plugin-obsidianmd`, wired into CI from the first commit): Vault API over Adapter, `Vault.process` for background edits, `FileManager.trashFile()`, `normalizePath()` on all remote-derived paths, `Vault#configDir` never hardcoded `.obsidian`, no `innerHTML`, no default hotkeys, sentence-case settings UI, errors-only console.

---

## 2. Sync scope ([003](../tickets/003-sync-scope-v1.md), [004](../tickets/004-dot-obsidian-handling.md))

v1 syncs the **whole vault ↔ one Remote Folder**. `.obsidian/` syncs (settings and plugins follow the user across devices) minus the **Exclusion List**.

**Selection-scope contract** (normative, protects the post-v1 selective-sync end goal): the engine's universe is *paths within the **Sync Scope***. Sync State, local scan, and remote listing are all filtered by the same scope predicate **before** diffing — out-of-scope content is invisible to the diff and can never read as "missing → deleted". When a path leaves the scope its records are dropped (bookkeeping, never a deletion signal). v1's predicate is "everything except the Exclusion List"; no `selection` field ships in v1.

### 2.1 Exclusion List (exact, v1-normative)

Evaluated against vault-relative NFC paths. Excluded paths are invisible to both sides — never uploaded, never downloaded, never deleted.

| Pattern | Why |
|---|---|
| `<configDir>/workspace.json`, `<configDir>/workspace-mobile.json`, `<configDir>/workspace` (legacy) | churns on every pane interaction; no sync value |
| `<configDir>/plugins/obsen/data.json` | Obsen settings — device-local by design (Device Name, verbose-log toggle) |
| `<configDir>/plugins/obsen/sync-state.json` (+ `.tmp` sibling) | **Sync State** — per-device |
| `<configDir>/plugins/obsen/shadow/**` | **Shadow Store** — per-device |
| `<configDir>/plugins/obsen/logs/**` | rolling verbose log — per-device |
| `.trash/**` | Obsidian's local trash — soft-deleted content must not resurrect via sync |
| `.DS_Store`, `Thumbs.db`, `desktop.ini` (any directory) | OS junk |

Notes: `<configDir>` is `Vault#configDir` (usually `.obsidian`), never hardcoded. Obsen's own *code* (`plugins/obsen/main.js`, `manifest.json`, `styles.css`) **does** sync, like any other plugin's — that is how "my plugins follow me" works; Obsidian picks the new file up at next plugin (re)load, and BRAT remains the update mechanism of record. Other plugins' `data.json` files sync (that's the point of syncing `.obsidian/`). The list is an engine constant; widening it later is a code change, not a migration.

---

## 3. Sync State and change detection ([020](../tickets/020-design-sync-state-schema.md))

### 3.1 Schema

Dedicated file `<configDir>/plugins/obsen/sync-state.json` (not `data.json` — settings and state have different lifecycles; not IndexedDB — evictable, invisible, hostile to headless tests). Written atomically (tmp + rename), always via `StorePort`.

```json
{
  "schemaVersion": 1,
  "remoteRoot": "<uuid of the linked Filen folder>",
  "files": {
    "<vault-relative NFC path>": {
      "lastSyncedHash": "<sha512 hex>",
      "size": 12345,
      "localMtime": 1737000000000,
      "remoteUuid": "<filen file uuid>",
      "mergeable": true
    }
  }
}
```

- **Hash: SHA-512 hex, everywhere.** It is Filen's own plaintext content hash (computed client-side in `uploadWebFile`, stored in E2EE `FileMetadata.hash?`), so one digest serves as dirty-detector, **Shadow Store** key, and rename-pairing key, and remote change detection is string comparison. Local hashing via `crypto.subtle.digest("SHA-512", …)`. Remote `hash` is optional (other/older clients) — absent means *unknown*, never *unchanged*.
- **`remoteUuid` doubles as the remote change detector**: a Filen content update mints a new file UUID (same-name upload → new UUID, old becomes a version); renames/moves keep the UUID — exactly what rename detection wants.
- **No folder records** — folder existence derives from contents; parent UUIDs needed for uploads are a session cache rebuilt from the listing. Accepted consequence: **empty folders don't sync**.
- **Excluded by decision**: `lastSyncedAt`, `remoteLastModified`, `remoteSize` (redundant given UUID-as-revision).

### 3.2 Change detection cheap path

`size` + `localMtime` both unchanged → skip hashing. Either differs → hash; hash equal to `lastSyncedHash` (touch, identical rewrite) → not dirty, refresh stored stat. After Obsen writes a file (download), immediately stat and record. A manual **"Verify and repair"** command marks the next Run FULL-with-rehash, bypassing the cheap path.

### 3.3 Envelope guards

- `schemaVersion`: older → stepwise shipped migrations; newer (downgrade) → discard, notify, **Re-Bootstrap**.
- `remoteRoot`: folder UUIDs are stable across move/rename, so the link survives drive reorganization. Genuine re-link → UUID mismatch → discard + Re-Bootstrap. **Unresolvable root (folder deleted/trashed) freezes sync (`frozen`) — never interpreted as "everything deleted remotely"**.
- Corrupt/missing/lost state degrades to First-Link re-bootstrap ([011](../tickets/011-first-link-bootstrap.md)): worst case redundant hashing and a rare spurious **Conflict Copy**, never data loss.

### 3.4 Shadow Store ([015 research](../research/015-ancestor-source.md))

Device-local, content-addressed store of last-synced text content — where **Ancestors** come from. Filen file versioning was rejected on retention grounds (100-version cap, quota-counted, user-flippable toggle, dies with the parent file — exactly the edit-vs-delete case); `remoteUuid` is recorded anyway, keeping a post-v1 versioning fallback open.

- One entry per unique content under `<configDir>/plugins/obsen/shadow/`, named by `lastSyncedHash`, holding the last-synced bytes; one header field for encoding `raw | deflate`. Deflate via `CompressionStream` where available (**feature-detect** — absent on iOS < 16.4 → store raw; compression is an optimization, not correctness).
- Only **Mergeable** files get entries (measured 2.6–3.4× compression on real Markdown; ~20 MB for a 50 MB text subset).
- **Write-ordering invariant**: shadow entry flushed **before** any Sync State flush referencing its hash. Crash between the two leaves an orphan blob (harmless), never a dangling reference.
- Lookup at merge time: entry present and content hashes to its name → Ancestor; absent/corrupt → no Ancestor → Conflict Copy.
- GC: mark-and-sweep after each Run — delete entries referenced by no record.

**Mergeable** = extension ∈ {`.md`, `.txt`} (engine constant; policy in code — structured formats like `.json`/`.canvas` merge unsafely line-wise). Each record snapshots the decision, so widening the list later needs no migration.

---

## 4. Triggers and the scheduler ([005](../tickets/005-sync-triggers.md), [021](../tickets/021-design-sync-engine-algorithm.md))

**Single path, single flight, journal-less.** Every trigger does exactly one thing: mark paths dirty and request a **Run**. There is no live-sync fast path — "live sync" is a scoped Reconcile firing shortly after events settle. One machinery for ordering, conflicts, echo, and recovery; headless tests exercise the same code production runs.

Triggers:

| Trigger | Scope | Notes |
|---|---|---|
| Startup (`onLayoutReady`) | FULL | correctness backstop |
| **Foreground-Resume** (`visibilitychange` → visible; `window` focus on desktop) | FULL | mobile OSes kill the socket while suspended; proven reliable on Android ([019](../tickets/019-prototype-on-device-spike.md)) |
| Vault events (`create`/`modify`/`delete`/`rename`) | path (+ **Rename Hint**) | registered inside `onLayoutReady` only |
| Socket events | path, or FULL if `unresolved` | trigger, never ledger (§7) |
| Manual "Sync now" (ribbon / command) | FULL | escape hatch and reassurance |
| Socket `connected` after a disconnect | FULL | reconnect catch-up |

**No periodic interval** — a deliberate decision.

**Scheduler**: at most one Run executes (fixes the interleaved-runs race observed in the [019 spike](../tickets/019-prototype-on-device-spike.md)). A request carries a scope (path set or FULL); requests arriving mid-Run merge into a pending scope (union; FULL absorbs) that triggers a follow-up Run. Mid-Run changes always land in the *next* Run — never mutate the executing plan. FULL triggers run immediately; vault/socket events get a **2 s trailing debounce with a 15 s max-wait cap** so continuous typing can't starve pushes (engine constants, timers injected).

---

## 5. The Run: reconcile algorithm ([021](../tickets/021-design-sync-engine-algorithm.md))

### 5.1 Anatomy

1. **Snapshot-and-clear** the pending scope. A socket event unresolvable to a path (unknown UUID, undecryptable metadata, dropped event type) has already escalated scope to FULL — never ignored.
2. **Full remote listing, every Run** — one cheap call (`cloud.getDirectoryTree` → `/v3/dir/download`; ~50–160 ms measured on-device). Scope only ever constrains the *local* side.
3. **Remote-delta scope expansion**: compare the listing against the whole state by UUID; any disagreement joins the diff set for free. Every Run, however small, catches **all** remote changes — socket gaps only ever cost latency, never correctness.
4. **Stat/hash the diff set** locally (cheap path, §3.2).
5. **Classify → pair renames → plan → execute → commit.** The plan is fully computed before anything executes.

### 5.2 Decision matrix

Each side classifies every in-scope path as unchanged / modified / added / missing vs its record. Notable cells:

- **Both modified**: compare hashes first — equal ⇒ silently converge (no transfer, refresh record); different ⇒ **Three-Way Merge** if Mergeable + Ancestor available, else Conflict Copy.
- **Edit beats delete** ([007](../tickets/007-deletion-semantics.md)): deleted on one side, modified on the other ⇒ the edit survives and is restored to the deleting side. Never destroy an edit on the say-so of stale state.
- **Both missing** ⇒ converged; drop the record.
- **No-record rows** reproduce the First-Link rules ([011](../tickets/011-first-link-bootstrap.md)) exactly — and with no records, no delete can fire. **First Link is just a FULL Reconcile with empty state; there is no bootstrap module.** Re-Bootstrap = delete state, run.

Deletions are state-based, no tombstones: present in state, missing on one side ⇒ deleted there ⇒ propagate as **Soft Delete** (Filen trash remotely; `FileManager.trashFile()` locally). Folder deletions follow from their contents (a folder empties, then goes).

### 5.3 Rename pairing — three tiers, one pass ([008](../tickets/008-rename-move-semantics.md))

Runs between classification and the matrix:

1. **Remote renames, free**: same UUID at a new path ⇒ rename the local file + rekey the record; any content delta is handled after.
2. **Live local renames**: **Rename Hints** (old→new) from vault `rename` events, validated against the scan — pair even when content also changed (move, then upload).
3. **Offline local renames**: exact `lastSyncedHash` equality, unique 1:1 in both directions.

Anything ambiguous degrades to delete+create (Soft Delete makes it safe). A folder Rename Hint rekeys all records under the prefix and issues a single remote `moveFolder`. No case-folded pairing — wrong pairings are worse than a visible skip.

### 5.4 Execution — five sequential phases

folder creates (parents first) → moves/renames (occupied target ⇒ degrade at planning) → content transfers (uploads / downloads / merges / conflict copies; **concurrency 4**) → file deletes (soft) → emptied-folder deletes (deepest first). **Deletes last**: a crash leaves extra files, never a removed file whose replacement didn't arrive.

### 5.5 Crash recovery — the matrix is the mechanism

No WAL, no journal. **Invariant: every operation must remain redo-safe when its state update is lost** (upload ⇒ idempotent re-upload; download ⇒ hash-equal convergence; delete ⇒ both-missing; move ⇒ re-pairs). A crashed Run is an unfinished Run; the startup FULL Reconcile finishes it. Supporting rules:

- State updates in-memory per op; flushed (atomic) at phase boundaries + every ~5 s during transfers + Run end.
- Shadow blob before any state flush referencing its hash (§3.4).
- **Re-stat guard** before overwriting any local file: stat moved since classification ⇒ skip the op, re-dirty the path — the next Run merges/conflicts instead of clobbering.
- `VaultPort.write` is contractually atomic; `lastSyncedHash` is the hash of the bytes actually sent.

### 5.6 Self-echo ([016 research](../research/016-filen-socket-events.md))

Precise best-effort filters; **idempotence is the guarantee** — an echo that slips through costs one empty Run and can never loop.

- Local (**Own-Writes Filter**): map of (path → resulting mtime+size) for the engine's own writes; a vault event matching exactly is dropped and consumed; a real user edit stats differently and always survives.
- Remote: recent-own-write UUID set (TTL ~60 s) — naturally precise, since foreign edits mint fresh UUIDs.

### 5.7 Errors and status

- **Transient per-op**: 3 attempts (1 s / 5 s), then requeue the path into the pending scope and continue the Run — one bad file never blocks the vault.
- **Offline** (the listing itself fails): abort as `offline`; backoff 10 s → 30 s → 1 m → cap 5 m; events during backoff coalesce without resetting it; Foreground-Resume and manual sync cut through; success resets. (Ticks only while failed work is pending — not the rejected periodic poll.)
- **Permanent**: `auth-error` freezes sync until re-login. `quota` blocks uploads only — downloads and deletes keep flowing. Filen-rejected names ⇒ **Skip-and-Surface**, never auto-retried.
- **Status Surface** (the contract the UX presents, §8): `idle | syncing | offline | quota | auth-error | frozen` + per-run summary (trigger, duration, up/down/conflict/skip counts, outcome).

### 5.8 Paths

Both ports normalize to **NFC at the boundary** (kills the APFS-NFD phantom-change loop). The engine compares case-sensitively; a remote case collision syncs the known/lexicographically-first path and Skip-and-Surfaces the other. Names the local platform can't materialize (Windows-reserved names, `:`/`|`, trailing dots — `VaultPort.isWritablePath`) are Skip-and-Surfaced — **never auto-renamed** (the engine must not invent content changes or break wikilinks).

### 5.9 Engine constants (one table, all normative)

| Constant | Value |
|---|---|
| Event debounce / max-wait | 2 s / 15 s |
| Transfer concurrency | 4 |
| Transient retries | 3 (delays 1 s, 5 s) |
| Offline backoff | 10 s → 30 s → 1 m → cap 5 m |
| Own-write UUID TTL | 60 s |
| Mergeable extensions | `.md`, `.txt` |
| State flush during transfers | ~5 s |
| Conflict list in First-Link preview | ≤10 paths shown |

---

## 6. Conflicts ([006](../tickets/006-conflict-semantics.md), [015](../tickets/015-research-ancestor-source.md))

**Automatic 3-way merge where safe; Conflict Copies where not. Never last-writer-wins, never a blocking prompt, never guess.**

- Mergeable + Ancestor available: diff3 merge (e.g. `node-diff3`, pure JS) of local and remote against the Ancestor. Clean ⇒ merged result written to both sides. Overlapping hunks ⇒ Conflict Copy.
- Binary / non-mergeable / no Ancestor (First Link, lost shadow): Conflict Copy always.

### 6.1 Conflict Copy naming (v1-normative, settles the map's open item)

```
<stem> (conflict <YYYY-MM-DD HHmm> <Device Name>).<ext>
```

Example: `Meeting notes (conflict 2026-07-31 1402 iPhone).md`.

- Timestamp is local time, minute precision, filename-safe (no colon).
- **Device Name** (§8.7) is sanitized for the filename and for wikilinks: characters `\ / : * ? " < > | # ^ [ ]` are replaced with `-`; leading/trailing dots and spaces trimmed; empty after sanitizing → platform default.
- Name taken ⇒ append ` 2`, ` 3`, … before the extension.
- The copy holds the **incoming** (losing) version; the winning version stays under the original name. For a merge failure the local version keeps the original path and the remote version becomes the copy; at First Link the remote version becomes the copy.

### 6.2 Conflict Manifest — `conflicts.md` (v1-normative, settles the map's open item)

A normal note at the vault root (it syncs). Format:

```markdown
# Sync conflicts

Each row links a file and the conflict copy Obsen created for it. Review, merge what you need, then delete rows (or this file) — Obsen recreates it on the next conflict.

| Original | Conflict copy |
| --- | --- |
| [[Meeting notes]] | [[Meeting notes (conflict 2026-07-31 1402 iPhone)]] |
```

Lifecycle rules:

- One row appended per Conflict Copy created, during the Run that created it (a local write that then syncs normally). Copy names are unique, so duplicate rows cannot occur; no dedup pass needed.
- File missing ⇒ recreated with the header. Rows are **never auto-pruned** — the file is user-owned; clearing rows or deleting the file is always safe.
- After any Run that created ≥1 Conflict Copy, Obsen **opens `conflicts.md` in Obsidian** — conflicts are never silent (and produce no notice; the open *is* the announcement).
- `conflicts.md` itself is an ordinary Mergeable note: concurrent appends on two devices usually 3-way-merge; if the merge fails it gets a Conflict Copy like any other note — rows are never lost, at worst split across the copy.

---

## 7. Filen integration ([014](../research/014-sdk-in-obsidian-feasibility.md), [016](../research/016-filen-socket-events.md))

- SDK: `@filen/sdk@0.4.2`, browser build, bundled per §1.2. The engine never touches the SDK — only the `RemotePort` adapter does.
- **Socket = trigger, never ledger** (validated on four primary-source grounds: no delivery guarantees, known event gaps in 0.4.2, Filen's own sync product polls instead, Filen's clients refetch on reconnect). Reconcile stays mandatory.
- Leave `connectToSocket` **off**; drive `sdk.socket.connect({ apiKey })` directly.
- v1 subscription set: `fileNew`, `fileRename`, `fileMove`, `fileTrash`, `fileRestore`, `fileArchiveRestored`, `fileDeletedPermanent`, `folderSubCreated`, `folderRename`, `folderMove`, `folderTrash`, `folderRestore`, `trashEmpty`, `passwordChanged`. Ignore the rest. Permanent folder deletions and metadata-only changes produce **no** 0.4.2 event — only Reconcile catches them.
- Payloads are UUID-centric and E2EE: the `RemotePort` adapter decrypts (`sdk.crypto().decrypt().fileMetadata/folderMetadata` — folder events hide encrypted metadata in a field named `name`) and resolves UUID→path via its index, emitting `{change, path}` or `{unresolved}`.
- Client quirks (all verified in 0.4.2, all handled in the adapter): `isAuthenticated()` always returns false — never consult it; `authFailed` permanently stops reconnection until `connect()` is re-called — re-drive it after re-login; **always attach an `"error"` listener** (unhandled `error` on an EventEmitter crashes Electron); treat `disconnected → connected` as a FULL trigger; `passwordChanged` ⇒ enter `auth-error`.

---

## 8. Credentials, settings, and onboarding UX ([009](../tickets/009-auth-and-credential-storage.md), [025](../tickets/025-adopt-secretstorage-for-credentials.md), [022](../tickets/022-design-settings-onboarding-ux.md))

### 8.1 Credentials

- Login form (email / masked password / optional 2FA) runs SDK login once; **nothing the user types is persisted**.
- The derived **Auth Config** (API key + master keys) is written programmatically to **SecretStorage only** — `app.secretStorage.setSecret("obsen-filen-auth", …)` — with **no copy in `data.json`** and no fallback path. No `SecretComponent` (it stores what the user types; wiring it to the password field would persist the raw password). *(Corrected during [030](../tickets/030-impl-login-and-secretstorage.md): this section first wrote the id `obsen:filen-auth`, and Obsidian validates ids against `/^[a-z0-9-]+$/` — the colon throws. Same name, dash instead.)*
- **`minAppVersion: 1.11.4`, hard floor** (SecretStorage's version; BRAT 2.2.0 itself requires it).
- SecretStorage is localStorage-backed, vault-scoped, **not documented as encrypted at rest**. What it buys is removal of the vault-tree leak class: no vault sync/backup tool (git, iCloud, Syncthing, Obsidian Sync) can ever ship the master keys off-device. Eviction (rare, mostly iOS) ⇒ secret missing ⇒ re-prompt login. *(Sharpened during [030](../tickets/030-impl-login-and-secretstorage.md), from the shipped 1.11.4 and 1.13.4 bundles: 1.11.4 is plain local storage; 1.13 puts a per-platform secure-storage adapter in front of it, loads secrets **asynchronously** — so a startup restore must also listen for the store's `changed` event — and can have **no** adapter at all, in which case `setSecret` throws "Secure storage is not available.". The floor the README states stays true; the ceiling is better than it promises.)*
- README credential statement (verbatim intent): credentials live in Obsidian's SecretStorage, scoped to this vault, outside the vault folder — never in any file vault syncs or backups can pick up, never leaving the device. *Residual risk, stated honestly*: SecretStorage is not documented as encrypted at rest; someone with device or disk access may extract the keys — protect the device, consider 2FA on the Filen account.

### 8.2 Settings tab — a state machine

Logged out → logged in, unlinked → linked. The tab is the whole onboarding surface; no wizard. Modals exist only for the folder browser and the First Link gate.

- **Login**: email; password (masked, eye toggle); a "My account has 2FA" switch revealing a plain code field. If the switch is off and the SDK answers "2FA required", the switch flips on and the user re-submits — no dead end.
- **Logout**: clears SecretStorage, drops the SDK client; warns when a folder is linked (sync stops until re-login) but **keeps Sync State** — re-login resumes cleanly.

### 8.3 Folder picker (logged in, unlinked)

Modal tree browser over the Filen tree from root. Tap/click a row **selects**; a chevron at the row's right edge (desktop bonus: double-click) **descends**; the folder currently navigated into is the default selection. "New folder" button at the current level. Selecting the **Filen root is allowed but gated** by an explicit warning modal. The link stores the folder **UUID** (path is display-only). **Unlink** drops the link, Sync State, and Shadow Store — all recreatable — and touches no files on either side.

### 8.4 First Link flow

1. Static explanation modal: "we'll scan both sides to compute a preview — nothing syncs in this step".
2. Scan with in-modal progress ("Listing remote folder…", "Hashing local files… 420/953"), free Cancel.
3. **Dry-run preview** from a **plan-only engine entry point** (the planner runs, nothing executes): counts for upload / download / already-identical / conflict copies, conflict paths listed when ≤10; plus the First-Link rules text and the dual-engine caution.
4. Confirm executes the already-computed plan as a **normal non-blocking Run** — modal closes, Obsidian stays usable, progress on the status surface. Completion notice with real tallies; `conflicts.md` opening is the durable report when conflicts exist.

**Dual-engine warning** ("Don't sync this vault's folder with the Filen desktop app on this device — one sync engine per folder per device"): a line in the First-Link confirmation modal **and** a persistent small callout in linked-state settings, both platforms.

### 8.5 Status presentation

Obsidian mobile has **no status bar** — three layers, one source of truth (the Status Surface):

1. **Ribbon icon, both platforms** — universal indicator + manual-sync trigger: animated while `syncing`, badge/color for **Attention States** (`offline|quota|auth-error|frozen`). Pinnable to the mobile toolbar.
2. **Status-bar item, desktop only** — icon + short text ("Obsen: syncing 12/38"); bonus richness.
3. **Settings tab, both platforms** — full picture: current state, last successful sync, last-run summary, error detail + recovery actions.

### 8.6 Notices policy — silent by default, state-entry only

| Event | Notice |
|---|---|
| Automatic runs, clean | never |
| Manual sync completion | one — tally or "Already up to date" |
| `offline` entry / recovery | none (ribbon + backoff handle it) |
| `quota` / `auth-error` entry | one; click opens settings |
| `frozen` entry | one, sticky; click opens settings |
| Conflict Copies | none — `conflicts.md` opens instead |
| Skip-and-Surface | none — shown in Recent activity |

Attention-state recovery flows (in settings): `auth-error` ⇒ login form reappears, email prefilled, Sync State kept. `quota` ⇒ callout + "Manage storage on filen.io" link; self-clears on next successful Run. `frozen` (Remote Folder really gone — UUIDs survive moves/renames) ⇒ callout explaining sync froze *to protect local files*; actions **"Check again"** (revives after a Filen-trash restore; reconcile triggers also auto-thaw) and **"Unlink…"**. Deliberately no "recreate folder" — a fresh empty folder is a full re-upload masquerading as recovery.

### 8.7 Activity, troubleshooting, Device Name

- **Recent activity**: last ~20 run summaries, newest first, local-only; Skip-and-Surface paths appear here with reasons.
- **Verbose logging** toggle (default off): timestamped rolling log, capped and rotated, in `plugins/obsen/logs/` (Exclusion List). **"Copy debug info"** puts recent log + environment facts on the clipboard.
- **"Verify and repair (re-hash all files)"** button + palette command (§3.2). No separate "reset sync state" — Unlink is the nuclear path.
- **Device Name**: user-editable setting, defaulted from Obsidian `Platform` flags (Mac / Windows / Linux / iPhone / iPad / Android), stored in device-local `data.json`. Feeds Conflict Copy names (§6.1).

---

## 9. Testing strategy ([013](../tickets/013-testability-architecture.md), [018 research](../research/018-agent-test-harness.md))

Layered; 1–2 are the inner loop, 3–4 the pre-merge loop, 5–6 release gates.

| # | Layer | Tooling | Runs |
|---|---|---|---|
| 1 | Engine unit/property tests | vitest + in-memory fakes for all three ports; injected clock | every change, headless, seconds |
| 2 | Mobile-safety gate | the §1.2 esbuild browser build — Node leak = build error | every change |
| 3 | Obsidian integration | `wdio-obsidian-service`, plugin via `plugins: ["."]`, matrix {`earliest`, `latest`} × {desktop, `emulateMobile: true`}; mostly against fake RemotePort + **one** minimal real-E2E smoke spec | agent locally (macOS windowed / Linux Xvfb + window manager); CI ubuntu |
| 4 | Real-remote Filen suite | plain Node vitest + `@filen/sdk` against production, mirroring Filen's own CI | agent/CI, env-gated creds |
| 5 | Real Android APK | wdio + Appium, AVD `obsidian_test` (proven GH Actions job) | CI nightly / pre-release |
| 6 | On-device manual checklist | below | HITL, per release |

Layer-4 rules: **dedicated Filen test account** (created manually from a consumer connection — signup is network-classified; 10 GB free is ample), **2FA off** (SDK sends the `"XXXXXX"` placeholder), credentials via env/GitHub secrets only, suite skipped when absent (fork PRs). Isolation: per-run `/obsen-tests/run-<timestamp>-<random>` subfolder; teardown trashes it; stale-run sweep (> 6 h) at suite start; periodic `emptyTrash()`; vitest single-thread, generous timeouts. Never assert exact socket event counts (delivery is best-effort). **No personal account ever appears in this repo or its CI.**

Layer-3 notes: `emulateMobile` flips UI-mode flags only (`Platform.isMobile`), not app flags — it validates mobile UI paths and proves nothing about Node-API absence (layer 2's job) or WebKit/Capacitor behavior (layers 5–6). Cache Obsidian downloads with `actions/cache` keyed on the resolved version list.

**HITL on-device checklist (per release; iOS has no automated path at all):**

1. First-run: BRAT install, login with on-screen keyboard (field visibility, autofill, safe-area), First Link of an existing vault.
2. Backgrounding mid-sync → foreground: socket reconnects, resume-Reconcile converges, no duplicate/partial writes.
3. Offline transitions: airplane mode mid-sync and at launch; offline edits sync on reconnect; Wi-Fi↔cellular handoff.
4. Large-vault performance: initial reconcile time, UI responsiveness, memory with the largest supported attachment.
5. iOS specifically: everything above, plus login key-derivation time under WebKit, long-session socket stability, storage eviction of plugin state.
6. Battery/network budget: overnight idle — no runaway activity.
7. Conflict UX on a small screen: produce a real desktop↔phone conflict; review via `conflicts.md`.

---

## 10. Distribution and compliance ([012](../tickets/012-scale-envelope-and-distribution.md), [017 research](../research/017-plugin-guidelines-and-brat.md), [024](../tickets/024-choose-license.md))

### 10.1 Identity (settles the map's open naming item)

- `id: obsen` (passes the manifest rules: no "obsidian", doesn't end in "plugin").
- **Display name: "Obsen"** for the beta. The manifest rules ban "Obsidian" *and variations like "Obsi-"/"-sidian"*; "Obsen" is neither literally, but is Obsidian-evocative — acceptance is reviewer discretion at directory submission, which is post-v1. Decision: ship the beta as "Obsen"; if directory review objects, rename then (names can change post-publication). No further naming work in v1.
- `description` (≤250 chars, action verb, period, trademark casing): "Sync your vault with a Filen folder — end-to-end encrypted, two-way, on desktop and mobile."
- `isDesktopOnly: false`; `minAppVersion: 1.11.4`; no `fundingUrl`.

### 10.2 License ([024](../tickets/024-choose-license.md))

**AGPL-3.0-only, single license for the whole repo.** Compliance package: verbatim AGPL-3.0 text in root `LICENSE`; `package.json` `"license": "AGPL-3.0-only"`; nothing in `manifest.json` (no license field exists); README "License" section stating Obsen is AGPL-3.0-only and that the distributed `main.js` bundles [`@filen/sdk`](https://github.com/FilenCloudDienste/filen-sdk-ts) (AGPL-3.0) — the Obsidian-policy attribution; source for every release is its tagged commit. No per-file headers.

### 10.3 README disclosures (required by Obsidian developer policies; ship with the first beta)

- **Network**: names Filen's endpoints (API gateway, ingest/egest file hosts, `socket.filen.io`) and why each is contacted; nothing is sent to any other server.
- **Account**: a Filen account is required.
- **Payment**: Filen free tier vs paid storage plans boundary, clearly indicated.
- **Credentials**: the §8.1 statement.
- **Dual-engine caveat** (§8.4) and the Supported Topology rule.
- No telemetry, no ads, no self-update mechanism (BRAT/Obsidian own updates), no code obfuscation, no file access outside the vault.

### 10.4 Release engineering (BRAT-first)

- Repo layout per the official sample scaffold (`src/main.ts` → `main.js`, `manifest.json` + `versions.json` at root, `version-bump.mjs`, `tsc -noEmit` then esbuild), with the §1.2 build replacing the permissive externals.
- Official GH Actions release workflow: tag push → build → **draft** release with assets `main.js`, `manifest.json` (`styles.css` if used) — publish manually (drafts are invisible to BRAT).
- **Tag == release name == released-manifest `version`, exact `x.y.z(-suffix)`, no `v` prefix.** Betas: `X.Y.Z-beta.N`, pre-release flag optional (BRAT installs either way).
- During beta, **never commit a bumped version to root `manifest.json`** on the default branch (Obsidian's updater reads HEAD). **First stable must be strictly higher than every beta** (the updater ignores prerelease suffixes — `1.0.1-beta.N` users are never offered `1.0.1`).
- No `manifest-beta.json` (legacy, ignored).
- `eslint-plugin-obsidianmd` (recommended config) in CI from the first commit — it is the machine-readable form of directory review. Community-directory submission itself is **post-v1**.

---

## 11. End goals and non-goals

**Documented end goals (post-v1; v1 must not paint them out):**

- **Selective sync of remote subfolders** — the Remote Folder is the canonical full vault; each device materializes a chosen slice; `.obsidian/` always syncs. Protected now by the Sync Scope predicate contract (§2) and the schema's additive `selection` path (§3.3).
- **Post-v1 versioning fallback for Ancestors** — kept open by recording `remoteUuid` (§3.4).
- **Interactive merge UI** — Conflict Copies + `conflicts.md` cover v1.
- **Community directory submission** — v1 only complies with its standards.
- **Direct-apply of rich socket payloads** — v1's mark-dirty-and-rescan is the correct baseline; direct apply is a latency optimization.

**Non-goals (v1 and beyond as noted):**

- Background sync on mobile — OS-impossible for a plugin; sync happens while the app is open.
- Same-device dual-engine support — explicitly unsupported topology.
- Vaults beyond the §0 scale envelope.
- Periodic-interval sync — rejected by decision.
- Storing anything user-typed (passwords, 2FA codes) — only the derived Auth Config persists.

## 12. Watch list (open risks an implementer must not silently drop)

1. **Huge single attachments** — whole-file buffering could OOM a phone webview; 8 MiB proven fine on Android, ~hundreds of MB unproven. If it bites: `downloadFileToReadableStream` + ranged reads exist as mitigation ([014 research](../research/014-sdk-in-obsidian-feasibility.md)).
2. **iOS is entirely unverified** — no automated path exists; first HITL checklist run on a real iPhone is the gate for calling v1 mobile-complete.
3. **SDK upgrades** — the shim list is coupled to `0.4.2`'s import graph; the bundle gate must run on every bump. Filen is migrating to a Rust/wasm SDK; watch for `@filen/sdk` deprecation.
4. **On-device socket behavior under long sessions** — reconnect churn is handled by design (trigger-never-ledger), but battery cost is HITL-checklist item 6.
