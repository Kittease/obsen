---
id: 15
title: "Research: where does the 3-way-merge ancestor come from?"
labels: [wayfinder:research]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

The conflict semantics ([006](006-conflict-semantics.md)) require producing the **ancestor** — the content of a file as of the last successful sync — for any text file. Two candidate sources; which one does the spec adopt?

- **Local shadow store**: keep a copy (or compressed copy) of last-synced content per text file, in device-local plugin storage. Simple, always available offline; costs up to ~2× text storage on mobile (envelope: ≤1 GB vault, mostly Markdown — is the real cost acceptable? Text-only, so likely far below vault total).
- **Filen file versioning**: store only a version reference (UUID) per file in sync state; fetch the ancestor version from Filen on conflict. Near-zero local storage; but depends on the SDK exposing version fetch, on versioning being enabled account-side, on version retention (does Filen prune old versions?), and requires network at merge time.

Also evaluate: hybrid (shadow store for text files only, versioning as fallback), and what happens when the ancestor is unavailable (already decided: conflict copy — never guess).

Output: a markdown summary in `docs/research/` with a recommendation and its consequences for the sync-state schema ([020](020-design-sync-state-schema.md)).

## Resolution

**Verdict: local shadow store** — text files only, content-addressed by hash, deflate-compressed where available; no versioning fallback in v1 (hybrid rejected as complexity for a scenario the conflict-copy fallback already covers). Full findings: [docs/research/015-ancestor-source.md](../research/015-ancestor-source.md).

- The SDK is not the blocker: `cloud.fileVersions({uuid})` lists versions and an old version is downloadable read-only via `downloadFileToReadableStream` in the browser build. Versioning loses on Filen's retention contract, not API surface.
- Filen's retention contract is wrong for correctness-critical data (per filen.io knowledgebase): 100-version cap, versions count against storage quota, and versions "remain intact for as long as the parent file is not deleted" — so the ancestor dies in exactly the edit-vs-delete conflict case, and Filen's own quota advice is to delete versioned files.
- Versioning is a global, user-flippable account toggle (`versioningEnabled` in `/v3/user/settings`), silently changeable from any client at any time — Obsen can't rely on it staying on.
- Shadow cost is trivial: measured 2.6–3.4× deflate/gzip compression on real Markdown; a 50 MB text subset shrinks to ~20 MB in the plugin folder. Caveat: `CompressionStream` isn't guaranteed on Obsidian's minimum iOS (Safari gained it in 16.4) → feature-detect, fall back to raw.
- Upload already yields the revision UUID (`uploadWebFile` generates it client-side and returns it in the `CloudItem`), so `remoteUuid` lands in the sync state for free — keeping a post-v1 versioning fallback open with no extra fields now.
- Consequences for [020](020-design-sync-state-schema.md): per-file `path`, `remoteUuid`, `lastSyncedHash` (doubles as the content-addressed shadow key), `mergeable` flag; shadow blobs live outside `data.json` under `.obsidian/plugins/obsen/shadow/`, written before the sync-state commit, GC'd by mark-and-sweep, excluded from Obsen's own sync scope.
