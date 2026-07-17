---
title: "Research: where does the 3-way-merge ancestor come from?"
ticket: 15
labels: [wayfinder:research]
---

# Where does the 3-way-merge ancestor come from?

Conflict semantics ([006](../tickets/006-conflict-semantics.md)) need the **ancestor** — a text file's content as of the last successful sync — to run a diff3 merge. Candidates: (1) a **local shadow store** of last-synced content, (2) a **version reference into Filen file versioning**, fetched at merge time, (3) a hybrid. When no ancestor is available the decided fallback is a conflict copy — never guess.

Investigated against `@filen/sdk@0.4.2` (npm package inspected locally; `dist/` paths below map to GitHub `src/` via the shipped sourcemaps, same method as [014](014-sdk-in-obsidian-feasibility.md)), Filen's own docs/knowledgebase, MDN, Apple's App Store lookup API, and Obsidian's API reference.

## VERDICT: **Local shadow store** (text files only, deflate-compressed, content-addressed). Versioning is not used for ancestors in v1 — not even as a fallback.

The SDK *does* expose everything needed to fetch an old version's content in the browser build — that is not the blocker. The blocker is that Filen versioning is the wrong **retention contract** for correctness-critical data: it is a user-toggleable account setting, versions **count against the account's storage quota** (Filen's own support answer for "total usage is wrong" is *delete your versioned files*), there is a **hard cap of 100 versions per file**, versions **vanish when the parent file is deleted** (exactly the edit-vs-delete conflict case), and any of this can change under Obsen's feet from another client. The shadow store costs ~tens of MB at Obsen's envelope, is fully under the plugin's control, works offline, and keeps v1 at one deterministic code path.

## 1. SDK version API surface (browser-safe: yes)

Everything below exists in the **browser build** and none of it is behind an `environment === "node"` guard; ticket [014](014-sdk-in-obsidian-feasibility.md) already bundle-smoke-tested `fileVersions`/`restoreFileVersion`, and `downloadFileToReadableStream` is the browser download path.

- **List versions**: `cloud.fileVersions({ uuid }): Promise<FileVersionsResponse>` — a thin wrapper over `POST /v3/file/versions` (`dist/browser/cloud/index.js:1409`; type at `dist/types/cloud/index.d.ts:505`; GitHub [`src/cloud/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/cloud/index.ts) `fileVersions`, endpoint [`src/api/v3/file/versions.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/v3/file/versions.ts)). Takes the **current** file UUID; returns:

  ```ts
  type FileVersion = { bucket: string; chunks: number; metadata: string;
                       region: string; rm: string; timestamp: number;
                       uuid: string; version: number }   // dist/types/api/v3/file/versions.d.ts
  ```

- **Download an old version's content (read-only, no remote mutation)**: a `FileVersion` carries everything `downloadFileToReadableStream` needs except the file key and size, which live in the version's encrypted `metadata`. Decrypt it with `crypto.decrypt.fileMetadata({ metadata })` → `FileMetadata { name, size, mime, key, lastModified, hash? }` (`dist/types/types.d.ts:8`; browser WebCrypto path per 014), then call `cloud.downloadFileToReadableStream({ uuid, bucket, region, version, key, size, chunks })` → web `ReadableStream` (`dist/types/cloud/index.d.ts:982`; [`src/cloud/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/cloud/index.ts) `downloadFileToReadableStream`). So **yes — fetching a specific old version by UUID is possible in the browser build**, without restoring it.
- **Restore (exists, but mutates remote — Obsen must not use it for reading)**: `cloud.restoreFileVersion({ uuid, currentUUID })` → `POST /v3/file/version/restore` (`dist/browser/cloud/index.js:1377`; [`src/api/v3/file/version/restore.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/v3/file/version/restore.ts)).
- **Detect versioning state at runtime**: `GET/POST /v3/user/settings` returns `versioningEnabled: boolean` plus `versionedFiles: number` and `versionedStorage: number` (`dist/types/api/v3/user/settings.d.ts`); `user.versioning({ enabled })` toggles it and `user.deleteAllVersionedFiles()` nukes all versions (`dist/types/user/index.d.ts:326`, `:168`).

## 2. Filen versioning behavior (the retention contract)

Primary source: Filen's knowledgebase FAQ (the Q&A content is embedded as JSON in [filen.io/knowledgebase](https://filen.io/knowledgebase); quotes verbatim from it), plus [docs.filen.io web settings](https://docs.filen.io/docs/web/settings/).

- **Supported, capped at 100, counts against quota**: *"Yes, we do support file versioning. There is a limit of **100 versions** to prevent excessive storage consumption, as the versions also **count towards the account storage**."* (KB: "Do you support file versioning?")
- **No time-based pruning; versions die with the parent file**: *"File versions remain intact for as long as the parent file is not deleted. You can always manually delete file versions to free up storage space."* (KB: "Are file versions automatically deleted after a period of time?")
- **Per-account toggle, user-flippable at any time**: *"Disable file versioning: Account > File Versioning > Turn Slider Off"* (KB + [docs.filen.io](https://docs.filen.io/docs/web/settings/)). The docs frame versioning as something you *disable*, so it is on by default for new accounts (inference — no doc states the default outright). No per-file setting exists. No free-vs-paid difference is documented anywhere; the 100-version cap and quota accounting are stated unconditionally.
- **Filen actively steers users toward deleting versions**: the KB answer for *"Total usage is wrong"* is *"…check if you have any versioned files which you might not need"* — i.e., quota pressure makes version deletion a normal, encouraged user action, and there is a one-click *"Delete versioned files"* button in account settings (KB: "Delete versioned files").

## 3. How versions are created (can Obsen learn the reference at upload time?)

- **Upload UUIDs are generated client-side**: `uploadWebFile` creates a fresh `uuidv4()` for every upload (or accepts one via its `uuid` param) and returns a `CloudItem` containing `uuid, key, bucket, region, chunks, version, size` (`dist/browser/cloud/index.js:3712` and `:3861–3908`). **Obsen knows each uploaded revision's UUID (and decryption key) at upload time, with no extra API call.**
- **Versioning happens server-side on same-name upload**: uploading a modified file with the same name into the same parent replaces the current file with the new UUID, and the previous revision becomes reachable via `fileVersions(newUUID)` — *"if you now upload a modified version … the old file x is overwritten by the new one. However … you can open the 'Versions' option and then restore the previous version"* (KB: "What is file versioning?"). The server matches by `nameHashed` sent in `upload/done` (`dist/browser/cloud/index.js:3825–3845`). `file/get` responses expose a `versioned: boolean` flag (`dist/types/api/v3/file/get.d.ts:14`), and account events include `fileVersioned` / `deleteVersioned` / `versionedFileRestored` (`dist/types/api/v3/user/events.d.ts`).
- **Rename/move do not change the UUID** (`cloud.moveFile`/`renameFile` operate on the existing uuid; [`src/cloud/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/cloud/index.ts)). So the "remote UUID recorded at last sync" *is* a stable version reference: after a remote edit it should appear in the new current file's version list. Consequence: under the versioning option, the sync state would only need the last-synced remote UUID — which it needs anyway for identity tracking — plus nothing extra. The API cost is real but small; the retention contract is what kills it.

## 4. Shadow-store cost reality check

- **Envelope math**: text subset of a mostly-Markdown ≤1 GB vault is typically tens of MB (thousands of notes at 1–10 KB each). Empirical compression on a real Markdown corpus (102 files, 694 KB, from npm package docs, measured for this ticket): whole-corpus `gzip -6` → 206 KB (**3.4×**); per-file-shaped deflate (zlib level 6 over 4 KB blocks) → 270 KB (**2.6×**). Realistic shadow store: a 50 MB text subset → **~20 MB compressed**; a 5,000-note × 4 KB vault → ~20 MB raw, ~8 MB compressed. Negligible against modern phone storage; well under the vault's own footprint.
- **Compression API**: `CompressionStream`/`DecompressionStream` ("gzip", "deflate", "deflate-raw") is Baseline — *"available across browsers since May 2023"* ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream)); Chromium ≥80 covers Obsidian desktop (Electron) and Android WebView. **Caveat**: Safari gained it in 16.4, but Obsidian iOS declares `minimumOsVersion: 14.5` (Apple lookup API, [itunes.apple.com/lookup?id=1557175442](https://itunes.apple.com/lookup?id=1557175442), checked 2026-07). So on iOS 14.5–16.3 the API may be absent → **feature-detect** (`typeof CompressionStream !== "undefined"`) and fall back to storing raw; compression is an optimization, not a correctness requirement.
- **Where it lives**: the plugin folder. Obsidian's `Plugin.loadData()`/`saveData()` persist *"data.json in the plugin folder"* ([docs.obsidian.md](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/loadData)) — fine for the sync-state index, wrong for shadow blobs (data.json is read/written whole, in memory). Shadow blobs go as individual files under `.obsidian/plugins/obsen/shadow/` via the vault adapter API. No documented size cap on mobile beyond device storage. **Must be excluded from Obsen's own sync scope** (interacts with `.obsidian` handling, ticket [004](../tickets/004-dot-obsidian-handling.md)).

## 5. Failure modes compared

One observation defuses the scariest-sounding versioning failure: **conflict detection happens during a sync, so the device is online at merge time by definition** — "offline at merge" is not a real differentiator. The real differentiators are retention and blast radius.

| Failure mode | Shadow store | Filen versioning |
|---|---|---|
| Versioning disabled account-side (any time, any client) | unaffected | ancestor gone for all future conflicts; detectable via `versioningEnabled` but only mitigable by nagging the user |
| Versions deleted for quota (one-click in settings; Filen's own support advice) | unaffected | ancestor silently gone |
| >100 revisions between Obsen syncs (busy file + other clients) | unaffected | ancestor pruned by cap |
| Remote file deleted/trashed (edit-vs-delete conflict) | ancestor available — merge-quality handling | *"versions remain … as long as the parent file is not deleted"* → ancestor gone in exactly this case |
| Network flake mid-merge | unaffected (local read) | ancestor fetch adds a failure + latency point per conflicted file |
| User deletes plugin data / reinstalls / restores vault from backup | shadow gone → conflict copy (safe, decided fallback); same posture as first link | unaffected |
| Shadow diverges from sync state (crash between writes) | detectable: content-addressed entries + hash in sync state → mismatch ⇒ treat as no-ancestor ⇒ conflict copy | n/a |
| Storage cost | ~tens of MB local (§4) | near-zero local, but **every synced revision charges the user's Filen quota** until pruned |
| Code paths in v1 | one, fully local, deterministic in tests (ticket [013](../tickets/013-testability-architecture.md)) | network + crypto + retention checks; failures only observable against a live account |

Both options degrade to the same safe fallback (conflict copy). The difference: shadow-store loss is **caused by the user touching Obsen's own data** and is self-detecting; version loss is caused by **normal, Filen-encouraged account hygiene** happening anywhere, any time, silently.

## Recommendation: shadow store, and no hybrid in v1

**Adopt the local shadow store** for text files (`.md`, `.txt`, `.json`, `.canvas` — the mergeable set from [006](../tickets/006-conflict-semantics.md)): deflate-compressed when `CompressionStream` exists, raw otherwise, stored content-addressed under the plugin folder.

Why not versioning: the API works (§1), but the ancestor is correctness-critical and versioning's retention is governed by user quota pressure, a global toggle, a 100-cap, and parent-file lifetime (§2, §5) — none under Obsen's control, most failing silently, and one (parent deleted) failing in precisely the edit-vs-delete conflict case. It would also make Obsen's merge quality depend on the user paying Filen for version storage of every revision Obsen uploads.

Why not hybrid: the only scenario versioning-as-fallback rescues is "shadow lost AND remote version chain intact AND conflict pending" — rare, already covered by the safe conflict-copy fallback, and it would double the ancestor machinery (network fetch, metadata decrypt, retention probing) in v1 for marginal benefit. Revisit post-v1 only if real-world conflict-copy rates from shadow loss prove annoying; nothing in this decision forecloses it (the needed remote UUIDs are in the sync state anyway, see below).

## Consequences for the sync-state schema (feeds [020](../tickets/020-design-sync-state-schema.md))

Per-file record must carry:

- `path` — vault-relative path (identity by path; renames handled per [008](../tickets/008-rename-move-semantics.md)).
- `remoteUuid` — current remote revision UUID as of last sync. Needed for identity/change detection regardless of this decision; known at upload time from `uploadWebFile`'s returned `CloudItem` and from directory listings. Also happens to be a valid version reference if a versioning fallback is ever added post-v1.
- `lastSyncedHash` — content hash (e.g. SHA-256 hex) of the file content as of last successful sync. Serves double duty: dirty detection on both sides, and the **key into the shadow store**.
- `mergeable: boolean` — whether the file is in the text/mergeable set (only these get shadow entries).

Shadow store (not in data.json; sibling directory `shadow/` in the plugin folder):

- **Content-addressed**: one file per unique content, named by `lastSyncedHash`, holding the last-synced bytes; entry format carries one header byte/field for encoding (`raw` | `deflate`). Content addressing gives deduplication (N files with identical content share one entry), idempotent writes, and built-in integrity: an entry whose bytes don't hash to its name is corrupt.
- **Write-ordering invariant**: shadow entry is written and flushed **before** the sync-state record that references it is committed. A crash between the two leaves an orphan blob (harmless, GC'd), never a dangling reference.
- **Ancestor lookup at merge time**: `shadow/<lastSyncedHash>` present and valid → ancestor; absent/corrupt → ancestor unavailable → conflict copy (per [006](../tickets/006-conflict-semantics.md)).
- **GC**: mark-and-sweep — delete shadow entries whose hash is referenced by no sync-state record (run after each sync cycle).
- The shadow directory and sync state must be **excluded from Obsen's sync scope** (ticket [004](../tickets/004-dot-obsidian-handling.md)).

Explicitly **not** needed under this decision: per-version UUID chains, remote file keys, region/bucket/chunk counts, or `versioningEnabled` probes in the sync state.

## Citations

- `@filen/sdk@0.4.2` (npm, inspected locally; GitHub [FilenCloudDienste/filen-sdk-ts](https://github.com/FilenCloudDienste/filen-sdk-ts)): `dist/types/api/v3/file/versions.d.ts` (`FileVersion`, `FileVersionsResponse`), `dist/types/api/v3/file/version/restore.d.ts`, `dist/types/cloud/index.d.ts:505` (`fileVersions`), `:491` (`restoreFileVersion`), `:982` (`downloadFileToReadableStream`), `:1233` (`uploadWebFile` → `CloudItem`), `dist/browser/cloud/index.js:1377/1409/3687–3908` (implementations; client-side `uuidv4()` at `:3712–3713`), `dist/types/api/v3/user/settings.d.ts` (`versioningEnabled`, `versionedFiles`, `versionedStorage`), `dist/types/user/index.d.ts:168/:326` (`deleteAllVersionedFiles`, `versioning`), `dist/types/types.d.ts:8` (`FileMetadata`), `dist/types/api/v3/file/get.d.ts:14` (`versioned`), `dist/types/api/v3/user/events.d.ts` (`fileVersioned` etc.).
- Filen knowledgebase, FAQ JSON embedded in [https://filen.io/knowledgebase](https://filen.io/knowledgebase) (fetched 2026-07): entries "Do you support file versioning?", "Are file versions automatically deleted after a period of time?", "What is file versioning?", "Disable file versioning", "Delete versioned files", "Total usage is wrong".
- Filen docs: [https://docs.filen.io/docs/web/settings/](https://docs.filen.io/docs/web/settings/) (versioning toggle, versioned-files deletion), [https://docs.filen.io/docs/web/facts/](https://docs.filen.io/docs/web/facts/) (versioning overview).
- MDN: [CompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream) (Baseline since May 2023).
- Apple App Store lookup API: [https://itunes.apple.com/lookup?id=1557175442](https://itunes.apple.com/lookup?id=1557175442) → Obsidian `minimumOsVersion: 14.5` (checked 2026-07).
- Obsidian API reference: [Plugin.loadData](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/loadData) ("data.json in the plugin folder").
- Compression measurement: 102 Markdown files (694 KB) from npm package docs; `gzip -6` whole-corpus 205,891 B (3.37×), zlib level-6 deflate over 4 KB blocks 270,352 B (2.57×) — scratchpad experiment for this ticket, not committed.
