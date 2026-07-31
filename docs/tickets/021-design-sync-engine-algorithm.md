---
id: 21
title: "Design: sync engine algorithm — reconcile, ordering, atomicity, recovery"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: [16, 19, 20]
---

## Question

The core design session. Specify the engine that implements the locked semantics ([005](005-sync-triggers.md), [006](006-conflict-semantics.md), [007](007-deletion-semantics.md), [008](008-rename-move-semantics.md), [011](011-first-link-bootstrap.md)) on top of the sync-state schema ([020](020-design-sync-state-schema.md)):

- The reconcile algorithm: three-way diff of (last-synced state, local scan, remote listing) → operation plan; operation ordering (folders before files, deletes last?); concurrency limits for transfers.
- Serialization: reconcile vs live events vs socket events running concurrently — single sync queue? What happens when a vault event fires mid-reconcile?
- Self-echo suppression: our own remote writes coming back via socket; our own local writes (downloads) firing vault events.
- Crash/offline recovery: partial sync interrupted (app killed mid-transfer, network drop) — how does the next reconcile converge? Retry policy for transient errors.
- Case-sensitivity and path normalization across platforms (APFS/NTFS case-insensitive vs Filen), filename constraints.
- Port interfaces (`VaultPort`, `RemotePort` — [013](013-testability-architecture.md)) finalized as TypeScript signatures.

## Resolution

**Single path, single flight, journal-less.** Every trigger — startup, foreground-resume, vault event, socket event, manual command — does exactly one thing: mark paths dirty and request a run. There is no live-sync fast path; "live sync" is a scoped reconcile firing ~2 s after events settle. One machinery for ordering, conflicts, echo, and recovery, and the headless tests exercise the same code production runs.

**Scheduler.** At most one run executes (fixes the [019 spike](019-prototype-on-device-spike.md)'s interleaved-runs race). A run request carries a scope (path set or FULL); requests arriving mid-run merge into a pending scope (union; FULL absorbs) that triggers a follow-up run. Mid-run changes always land in the *next* run — never mutate the current plan. FULL triggers (startup/resume/manual) run immediately; vault and socket events get a 2 s trailing debounce with a 15 s max-wait cap so continuous typing can't starve pushes (all engine constants).

**Run anatomy.** (1) Snapshot-and-clear the pending scope — a socket event unresolvable to a path (unknown UUID, undecryptable metadata, dropped event type) escalates scope to FULL, never ignored. (2) Full remote listing always — it is one cheap call (`/v3/dir/tree`, ~50–160 ms in the spike), so scope only ever constrains the local side. (3) **Remote-delta scope expansion**: compare the listing against the whole state by UUID; any disagreement joins the diff set for free — every run, however small, catches all remote changes, so socket gaps only ever cost latency. (4) Stat/hash the diff set locally ([020](020-design-sync-state-schema.md)'s cheap path). (5) Classify → plan → execute → commit; the plan is fully computed before anything executes.

**Decision matrix.** Each side classifies unchanged / modified / added / missing vs the record. Notable cells: both-modified compares hashes first — equal ⇒ silently converge (no transfer, refresh record); different ⇒ 3-way merge if mergeable + ancestor, else conflict copy ([006](006-conflict-semantics.md)). Edit beats delete restores across ([007](007-deletion-semantics.md)). Both-missing ⇒ converged, drop record. No-record rows reproduce [011](011-first-link-bootstrap.md) exactly, and with no records no delete can fire — **first link is just a FULL reconcile with empty state; there is no bootstrap module**, and Re-Bootstrap = delete state, run.

**Renames — three tiers into one pairing pass** (runs between classification and the matrix): (1) remote renames detected free via stable UUIDs — same UUID at a new path ⇒ local vault rename + rekey, content delta handled after; (2) live local renames enqueue **rename hints** (old→new) in the dirty set — validated hints pair even when content also changed (move, then upload); (3) offline local renames pair by exact `lastSyncedHash` equality, unique 1:1 both directions. Anything ambiguous degrades to delete+create ([008](008-rename-move-semantics.md); soft-delete makes it safe). A folder rename hint rekeys all records under the prefix and issues a single remote `dir/move` — no folder records needed.

**Execution: five sequential phases** — folder creates (parents first) → moves/renames (occupied target ⇒ degrade at planning) → content transfers (uploads/downloads/merges/conflict copies; **concurrency 4**, engine constant) → file deletes (soft) → emptied-folder deletes (deepest first). Deletes last: a crash leaves extra files, never a removed file whose replacement didn't arrive.

**Crash recovery: the matrix is the mechanism — no WAL, no journal.** Stated invariant: every operation must remain redo-safe when its state update is lost (upload ⇒ idempotent re-upload; download ⇒ hash-equal convergence; delete ⇒ both-missing; move ⇒ re-pairs). A crashed run is an unfinished run; the startup FULL reconcile finishes it. Supporting rules: state updates in-memory per op, flushed (atomic tmp+rename) at phase boundaries + every ~5 s during transfers + run end; shadow blob writes before any state flush referencing its hash ([015](015-research-ancestor-source.md)); **re-stat guard** before overwriting any local file (stat moved since classification ⇒ skip op, re-dirty path — the next run merges/conflicts instead of clobbering); VaultPort writes are contractually atomic; `lastSyncedHash` is the hash of the bytes actually sent.

**Self-echo: precise best-effort filters; idempotence is the guarantee.** An echo that slips through costs one empty run and can never loop. Local filter: own-writes map of (path, resulting mtime+size) — an event matching exactly is dropped and consumed; a real user edit stats differently and always survives. Remote filter: recent-own-write UUID set (TTL ~60 s) — naturally precise since foreign edits mint fresh UUIDs ([016](016-research-filen-socket-events.md)).

**Errors.** Transient per-op: 3 attempts (1 s / 5 s), then requeue the path into the pending scope and continue the run — one bad file never blocks the vault. Offline (listing itself fails): abort as OFFLINE, backoff 10 s → 30 s → 1 m → cap 5 m; events during backoff coalesce without resetting it; foreground-resume and manual sync cut through; success resets. (Not the periodic polling [005](005-sync-triggers.md) rejected — ticks only while failed work is pending.) Permanent: auth-error freezes sync until re-login; quota-full blocks uploads only (downloads/deletes keep flowing), distinct status; Filen-rejected names are skipped + surfaced, never auto-retried. Engine exposes a **status surface** — `idle | syncing | offline | quota | auth-error | frozen` + per-run summary — as the contract [022](022-design-settings-onboarding-ux.md) presents.

**Paths.** Both ports normalize to NFC at the boundary (kills the APFS-NFD phantom-change loop); the engine compares case-sensitively; case collisions on the remote sync the known/lexicographically-first path and **skip + surface** the other; names the local platform can't materialize (Windows-reserved, `:`/`|`, trailing dots) skip + surface — **never auto-rename** (the engine must not invent content changes or break wikilinks). No case-folded pairing: wrong pairings are worse than a visible skip.

**Ports — three, finalized.** `VaultPort` (list/stat/read/atomic-write/rename/trash/mkdir/trashFolder/isWritablePath/watch — events carry stats for the echo filter), `RemotePort` (listing/download/upload/move/trashFile/mkdir/trashFolder/moveFolder/watch — **UUID-addressed ops**; the port owns socket decryption and UUID→path resolution, emitting `{change, path}` or `{unresolved}`), and new `StorePort` (readState/atomic-writeState/read-write-deleteShadow) for [020](020-design-sync-state-schema.md)'s files. Hashing (WebCrypto SHA-512) lives in the engine; the clock/timers are injected for headless debounce tests; whole-file `Uint8Array` I/O accepted for v1 (huge-attachment streaming stays on the [014](014-research-sdk-in-obsidian-feasibility.md) watch list). Full TypeScript signatures:

```ts
type Stat = { size: number; mtime: number };

type VaultEvent =
  | { type: "create" | "modify" | "delete"; path: string; stat: Stat | null }
  | { type: "rename"; from: string; to: string; stat: Stat };

interface VaultPort {
  list(): Promise<{ path: string; stat: Stat }[]>;      // full scan, NFC paths
  stat(path: string): Promise<Stat | null>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<Stat>; // ATOMIC (tmp+rename)
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
