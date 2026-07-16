---
id: 7
title: "Deletion semantics"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

How are deletions detected, propagated, and how hard are they? What wins when a delete races an edit?

## Resolution

- **Detection is state-based, no explicit tombstones:** a file present in the last-synced state but missing locally was deleted locally → propagate to remote; missing remotely → delete locally.
- **Edit beats delete:** deleted on one side but *modified* on the other since last sync → the modification wins; the edited version survives and is restored to the deleting side. Never destroy an edit on the say-so of stale state.
- **Soft delete on both sides, never permanent:** propagated deletes go to Filen's trash remotely and follow Obsidian's configured trash behavior (`.trash`/system trash) locally. Combined with Filen file versioning, nearly every sync mistake is recoverable.
- Folder deletions follow from their contents (a folder empties, then goes).
