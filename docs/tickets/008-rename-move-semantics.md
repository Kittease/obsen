---
id: 8
title: "Renames and moves: first-class or delete+create?"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

Are renames/moves propagated as first-class operations, or decomposed into delete + create?

## Resolution

**First-class where knowable, hash-paired best-effort at reconcile, delete+create as the safe fallback.**

- **Live:** Obsidian's `rename` event carries old and new paths → map 1:1 to the Filen SDK's move/rename operations. Cheap, preserves remote version history.
- **Reconcile** (change happened while the app was closed): a disappeared file and an appeared file with the **identical content hash** are paired as a move. Anything ambiguous (multiple candidates, content also changed) falls back to delete+create. Exact-hash equality makes wrong pairings impossible.
- Wikilink rewrites that Obsidian performs in *other* files on rename arrive as ordinary modify events and sync as edits — no special handling.
