---
id: 20
title: "Design: sync-state schema and change detection"
labels: [wayfinder:grilling]
status: open
assignee:
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

_(pending)_
