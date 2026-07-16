---
id: 3
title: "Sync scope v1: whole vault or selectable subset?"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

Does v1 sync the entire vault against one remote folder, or a selectable subset of local folders?

## Resolution

**v1: whole vault ↔ one selected Filen remote folder.** No per-folder selection.

**Documented end goal (post-v1, must not be painted out of): selective sync of *remote* subfolders.** The Filen remote folder holds one canonical, complete vault; each device chooses which of its subfolders to materialize in its local vault. Example: the remote vault contains `work/`, `gaming/` and `personal knowledge/` — the work macOS laptop syncs only `work/`, the home Windows PC syncs `gaming/` + `personal knowledge/`, the phone syncs everything. In every case the Obsidian themes, plugins and configs (`.obsidian/`, per [004](004-dot-obsidian-handling.md)) sync regardless of the selection, so every device shares the same vault setup.

Note the direction: this is **not** picking local folders to push — the remote is the superset and source of the full vault; a device's local vault may be a partial materialization of it. Consequence for the engine's data model: never assume "local vault ≡ full remote tree" — deletion detection and reconcile must be scoped to the selected subset so that remote content outside the selection is not treated as locally deleted.
