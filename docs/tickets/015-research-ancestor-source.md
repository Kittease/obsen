---
id: 15
title: "Research: where does the 3-way-merge ancestor come from?"
labels: [wayfinder:research]
status: open
assignee:
blocked_by: []
---

## Question

The conflict semantics ([006](006-conflict-semantics.md)) require producing the **ancestor** — the content of a file as of the last successful sync — for any text file. Two candidate sources; which one does the spec adopt?

- **Local shadow store**: keep a copy (or compressed copy) of last-synced content per text file, in device-local plugin storage. Simple, always available offline; costs up to ~2× text storage on mobile (envelope: ≤1 GB vault, mostly Markdown — is the real cost acceptable? Text-only, so likely far below vault total).
- **Filen file versioning**: store only a version reference (UUID) per file in sync state; fetch the ancestor version from Filen on conflict. Near-zero local storage; but depends on the SDK exposing version fetch, on versioning being enabled account-side, on version retention (does Filen prune old versions?), and requires network at merge time.

Also evaluate: hybrid (shadow store for text files only, versioning as fallback), and what happens when the ancestor is unavailable (already decided: conflict copy — never guess).

Output: a markdown summary in `docs/research/` with a recommendation and its consequences for the sync-state schema ([020](020-design-sync-state-schema.md)).
