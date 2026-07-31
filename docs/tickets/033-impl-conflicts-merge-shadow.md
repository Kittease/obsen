---
id: 33
title: "Engine: Shadow Store, three-way merge, Conflict Copies, conflicts.md"
labels: [impl, afk]
status: open
assignee:
blocked_by: [27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §3.4, §6 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The conflict path end-to-end: the content-addressed Shadow Store (Mergeable files only, deflate via feature-detected `CompressionStream` with raw fallback, write-before-state-flush ordering, mark-and-sweep GC, corrupt-entry detection → no Ancestor); diff3 three-way merge for both-modified Mergeable files with an Ancestor (clean → written to both sides; overlap → Conflict Copy); Conflict Copies with the §6.1 naming convention (timestamp + sanitized Device Name, collision suffixes, incoming version becomes the copy); and the `conflicts.md` manifest with the §6.2 format and lifecycle (append per copy, recreate with header when missing, never auto-pruned, opened in Obsidian after any Run that created copies — no notice).

## Acceptance criteria

- [ ] Headless: non-overlapping concurrent edits merge cleanly to both sides; overlapping edits, binaries, and no-ancestor cases produce a Conflict Copy and never lose either version
- [ ] Shadow entries exist only for Mergeable files; GC removes unreferenced entries; a corrupt entry falls back to Conflict Copy
- [ ] Copy names match the convention, are wikilink-safe, and dodge collisions
- [ ] `conflicts.md` rows appended exactly once per copy; file recreated when missing; a conflicted `conflicts.md` itself resolves like any note
- [ ] wdio: a Run creating a copy opens `conflicts.md` in Obsidian

## Blocked by

- [027](027-impl-engine-core.md)
