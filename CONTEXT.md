# Obsen — Ubiquitous Language

Glossary of the Obsen domain. Terms are canonical: code, tickets, and specs use these words with exactly these meanings.

## Terms

- **Vault** — the local Obsidian vault: the folder tree Obsidian manages on a device, accessed only through Obsidian's vault adapter.
- **Remote Folder** — the single Filen directory a vault is linked to. The remote side of the sync.
- **Link / First Link** — the act of connecting a vault to a Remote Folder for the first time, before any Sync State exists. First-link rules are conservative: nothing is overwritten or deleted. A link *is* the Remote Folder's UUID; the path is remembered for display only, so renaming or moving the folder on Filen does not break it.
- **Dry Run** — the plan-only pass the First Link preview is built from: the planner runs, nothing executes, and cancelling it costs nothing because no plan has been acted on.
- **Unlink** — undoing a link: the link, the Sync State and the Shadow Store are dropped, and no file is touched on either side. All three are recreatable, so re-linking the same folder is a Re-Bootstrap.
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
- **VaultPort / RemotePort / StorePort** — the three interfaces isolating the Sync Engine from Obsidian, Filen, and its own persistence (Sync State + Shadow Store) respectively; production adapters on one side, in-memory fakes in tests. Ports speak NFC-normalized paths; RemotePort ops address files by UUID.
- **Run** — one single-flight execution of the reconcile machinery over a scope (the Dirty Set, or FULL). Every trigger produces a run; at most one executes at a time, and changes arriving mid-run land in the next one.
- **Dirty Set** — the pending scope awaiting the next Run: paths marked by vault/socket events plus Rename Hints; requests coalesce here (FULL absorbs everything).
- **Rename Hint** — an old→new path pair enqueued when a live Obsidian rename event fires; consumed first by the Run's pairing pass, pairing even when content also changed.
- **Own-Writes Filter** — the precise best-effort self-echo suppressor: (path, stat) map for the engine's local writes, recent-UUID set for its remote writes. An optimization only — idempotent reconcile is the correctness guarantee.
- **Skip-and-Surface** — the planner's verdict for a path this platform cannot sync (unmaterializable filename, case collision): excluded from the plan but visibly reported, never silently dropped, never auto-renamed.
- **Status Surface** — the engine's exposed state (`idle|syncing|offline|quota|auth-error|frozen` + per-run summary); the contract the settings/onboarding UX presents.
- **Attention State** — a Status Surface state needing user awareness (`offline|quota|auth-error|frozen`). Always visible on the indicator; the ones requiring user action (`quota|auth-error|frozen`) additionally announce themselves once on entry and carry a recovery flow in settings.
- **Device Name** — the user-editable, per-device label (platform-derived default) naming which device produced a Conflict Copy; device-local, never synced.
- **Auth Config** — the reusable credential material exported by the Filen SDK after login (API key + master keys); stored device-local only.
- **Supported Topology** — one sync engine per folder per device. Different engines on different devices sharing a Remote Folder is supported; two engines on the same device/folder is not.
