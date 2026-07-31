---
id: 34
title: "Trigger wiring: vault watchers, foreground-resume, manual sync"
labels: [impl, afk]
status: open
assignee:
blocked_by: [27, 29]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §4 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

Connect the plugin shell to the engine's scheduler: startup FULL Reconcile from `onLayoutReady`; vault event watchers (create/modify/delete/rename → mark dirty + Rename Hints, registered inside `onLayoutReady` so the vault-init create storm is never seen); Foreground-Resume via `visibilitychange` (+ `window` focus on desktop) → FULL; the "Sync now" command and ribbon-icon trigger → FULL; the Own-Writes Filter consuming (path, stat) entries so the engine's own downloads don't re-trigger. Debounce/max-wait behavior comes from the engine — this slice proves it end-to-end in real Obsidian.

## Acceptance criteria

- [ ] wdio: editing a note syncs it to a fake remote after the debounce; continuous edits within max-wait still flush by 15 s
- [ ] Startup and simulated visibility-change each produce exactly one FULL Run; no runs overlap
- [ ] Obsen's own file writes fire no feedback loop (Own-Writes Filter consumes them; a real user edit right after still syncs)
- [ ] Rename in Obsidian produces a Rename Hint pairing, not delete+create
- [ ] Manual command and ribbon click trigger a FULL Run and report "Already up to date" when clean

## Blocked by

- [027](027-impl-engine-core.md), [029](029-impl-obsidian-adapters-and-wdio.md)
