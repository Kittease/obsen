# Obsen — Ubiquitous Language

Glossary of the Obsen domain. Terms are canonical: code, tickets, and specs use these words with exactly these meanings.

## Terms

- **Vault** — the local Obsidian vault: the folder tree Obsidian manages on a device, accessed only through Obsidian's vault adapter.
- **Remote Folder** — the single Filen directory a vault is linked to. The remote side of the sync.
- **Link / First Link** — the act of connecting a vault to a Remote Folder for the first time, before any Sync State exists. First-link rules are conservative: nothing is overwritten or deleted.
- **Sync** — making vault and Remote Folder converge on the same content, in both directions.
- **Reconcile** — a full comparison of vault, Remote Folder, and Sync State producing the operations needed to converge. The correctness backstop; runs at startup and foreground-resume. Event-driven syncs are optimizations layered on top.
- **Foreground-Resume** — the moment the Obsidian app returns to the foreground after OS suspension (mobile) or refocus (desktop). Triggers a Reconcile because events during suspension are lost.
- **Live Sync** — event-driven incremental sync while the app is open: local vault events pushed remotely (debounced), remote socket events applied locally.
- **Sync State** — the per-device record of what was last successfully synced (per-file identity, hashes, version references). Device-local, never synced itself.
- **Ancestor** — the content of a file as of the last successful sync of that file; the base of a Three-Way Merge.
- **Shadow Store** — the device-local, content-addressed store (keyed by `lastSyncedHash`, SHA-512) of last-synced text content; where Ancestors come from. Lives beside the Sync State, only Mergeable files get entries.
- **Mergeable** — a per-file flag marking files eligible for Three-Way Merge (`.md`/`.txt` in v1; the allowlist is an engine constant). Snapshotted into the Sync State record when written; non-mergeable conflicts go straight to Conflict Copy.
- **Sync Scope** — the predicate defining which paths participate in sync. All three Reconcile inputs (Sync State, local scan, remote listing) are filtered by it before diffing; out-of-scope content is invisible, never "missing". v1 scope = everything; per-subfolder selection is the documented end goal.
- **Re-Bootstrap** — discarding the Sync State and re-entering First Link rules; the universal safe recovery from corrupt, lost, downgraded, or re-linked state. Loses Ancestors (divergence becomes Conflict Copies), never data.
- **Three-Way Merge** — automatic merge of local and remote versions of a text file against their Ancestor; succeeds when edits don't overlap.
- **Conflict** — the same file changed on both sides since the last sync (or same-path-different-content at First Link).
- **Conflict Copy** — the non-destructive resolution of an unmergeable Conflict: both versions kept, the incoming one under a distinct name, recorded in the Conflict Manifest.
- **Conflict Manifest** — `conflicts.md` at the vault root: a synced note listing each Conflict Copy as a wikilink row (original | copy) for one-click review.
- **Edit Beats Delete** — the rule that a modification on one side always survives a concurrent deletion on the other.
- **Soft Delete** — propagated deletions go to trash (Filen trash remotely, Obsidian trash behavior locally), never permanent removal.
- **Exclusion List** — the built-in set of paths never synced (workspace files, Obsen's own data, caches), even though `.obsidian/` itself syncs.
- **Sync Engine** — the pure-TypeScript core implementing all sync logic behind ports; testable headless.
- **VaultPort / RemotePort** — the two interfaces isolating the Sync Engine from Obsidian and Filen respectively; production adapters on one side, in-memory fakes in tests.
- **Auth Config** — the reusable credential material exported by the Filen SDK after login (API key + master keys); stored device-local only.
- **Supported Topology** — one sync engine per folder per device. Different engines on different devices sharing a Remote Folder is supported; two engines on the same device/folder is not.
