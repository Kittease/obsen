---
id: 20
title: "Design: sync-state schema and change detection"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: [14, 15]
---

## Question

Design the per-device sync state that powers reconcile, deletion detection ([007](007-deletion-semantics.md)), rename pairing ([008](008-rename-move-semantics.md)) and ancestor lookup ([015](015-research-ancestor-source.md)):

- What is stored per file: path, content hash (which hash — the SDK tree already uses xxhash; alignment with Filen's own metadata?), size, local mtime, remote UUID + version reference, last-synced timestamp?
- Change detection cheap path: can mtime+size skip hashing on reconcile scans, with hash as the decider only when they differ? (Envelope: thousands of files, ≤1 GB — [012](012-scale-envelope-and-distribution.md).)
- Where does state live (plugin data vs separate local file), how is it excluded from sync ([004](004-dot-obsidian-handling.md)), and how does it survive crashes mid-sync (write-ahead / atomic swap)?
- Versioning/migration of the schema itself.
- Must not assume "local vault ≡ full remote tree": the end goal ([003](003-sync-scope-v1.md)) is devices materializing a selected subset of remote subfolders, so state/reconcile must be scopeable to a selection without treating unselected remote content as locally deleted.

## Resolution

**Hash: SHA-512 hex, everywhere.** Corrects the ticket's premise: the SDK's xxhash (`xxHash32`, `utils.js`) is only an internal string-hash for cache keys. Filen's real content hash is a **SHA-512 of the whole plaintext**, computed client-side in `uploadWebFile` and stored in the E2EE `FileMetadata.hash?`. Using the same digest as `lastSyncedHash` gives remote change detection by string comparison (zero downloads), free upload verification, and one hash serving as dirty-detector, shadow-store key ([015](015-research-ancestor-source.md)) and rename-pairing key ([008](008-rename-move-semantics.md)). Local hashing via WebCrypto `crypto.subtle.digest("SHA-512", …)`. `metadata.hash` is optional on remote files (other/older clients) — absent means *unknown*, never *unchanged*.

**Change detection cheap path: yes.** Store `size` + `localMtime` (ms, per Obsidian `adapter.stat`); both unchanged → skip hashing. Either differs → hash; if hash equals `lastSyncedHash` (touch, identical rewrite) → not dirty, refresh stored mtime/size. After Obsen writes a file (download), immediately stat and record. A manual **full re-hash recovery command** (discard state → re-bootstrap) is part of the contract.

**Per-file record**, keyed by vault-relative path as the ports report it (normalization is [021](021-design-sync-engine-algorithm.md)'s):

```json
{
  "schemaVersion": 1,
  "remoteRoot": "<uuid of the linked Filen folder>",
  "files": {
    "<path>": {
      "lastSyncedHash": "<sha512 hex>",
      "size": 12345,
      "localMtime": 1737000000000,
      "remoteUuid": "<filen file uuid>",
      "mergeable": true
    }
  }
}
```

- `remoteUuid` doubles as the remote change detector: a Filen content update **replaces the file UUID** (same-name upload → new UUID, old becomes a version), so listing-UUID ≠ stored-UUID ⇒ remote changed, even without `metadata.hash`. Renames/moves keep the UUID — exactly what rename detection wants.
- **Excluded by decision**: `lastSyncedAt` (no algorithm reads it), `remoteLastModified`/`remoteSize` (redundant given UUID-as-revision), and **folder records** — folder existence derives from contents ([007](007-deletion-semantics.md)); Filen folder UUIDs needed as upload parents are a session cache rebuilt from the listing. Accepted consequence: **empty folders don't sync**.

**Storage & crash safety**: dedicated `.obsidian/plugins/obsen/sync-state.json` (sibling of `shadow/`; already on the [004](004-dot-obsidian-handling.md) exclusion list; **not** in `data.json` — settings and state have different lifecycles; **not** IndexedDB — evictable, invisible, hostile to the headless harness). Writes are atomic: write `sync-state.json.tmp`, rename over. With 015's ordering (shadow blob before state commit), a crash loses at most the in-flight op, which the state honestly reports as unsynced → idempotent redo at next reconcile; no WAL. **Corrupt/missing state degrades to first-link re-bootstrap ([011](011-first-link-bootstrap.md))** — worst case is redundant hashing and a rare spurious conflict copy, never data loss.

**Envelope guards**:
- `schemaVersion` (int): older-than-current → stepwise shipped migrations (re-bootstrap is not free — it forgets ancestors); newer-than-current (downgrade) → discard, notify, re-bootstrap.
- `remoteRoot` (uuid): the state is only meaningful relative to one Remote Folder. Verified in the SDK: **folder UUIDs are stable across move and rename** (`dir/move {uuid, to}`), so the link survives the user reorganizing their drive; a genuine re-link → UUID mismatch → discard + re-bootstrap. **Unresolvable root (folder deleted/trashed) freezes sync with an error — never interpreted as "everything deleted remotely".** Corollary recorded on [022](022-design-settings-onboarding-ux.md): settings must store the linked folder by UUID, not path.

**Selection-scope contract** (normative, protects [003](003-sync-scope-v1.md)'s end goal): the state's universe is *paths within the sync scope*; state, local scan, and remote listing are all filtered by the same scope predicate **before** diffing — out-of-scope remote content is invisible to the diff, so it can never read as "missing locally → deleted". When a path leaves the scope, its records are **dropped** — a bookkeeping edit, never a deletion signal. v1's predicate is constantly true; no `selection` field ships in v1 (additive later behind `schemaVersion`).

**`mergeable`**: extension ∈ {`.md`, `.txt`}, evaluated when the record is written. The allowlist lives as an **engine constant** (policy in code — not in state, which stores outcomes; not a user setting in v1, structured formats like `.json`/`.canvas` merge unsafely line-wise). Each record snapshots the decision, so widening the list later needs no migration — records upgrade on their next sync. Only mergeable files get shadow entries, shrinking shadow cost further.
