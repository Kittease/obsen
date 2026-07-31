---
id: 31
title: "Folder picker, link/unlink, First Link flow"
labels: [impl, afk]
status: open
assignee:
blocked_by: [27, 28, 29, 30]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §8.3, §8.4 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The linking surface: modal Filen tree browser (tap selects, right-edge chevron descends, current folder is default selection, "New folder" at current level, root selectable behind a warning modal), the link stored by folder **UUID** (path display-only). The First Link flow: static explanation modal → scan with in-modal progress and free Cancel → dry-run preview from the engine's plan-only entry point (upload/download/identical/conflict counts, conflict paths when ≤10, First-Link rules text, dual-engine caution) → confirm executes the already-computed plan as a normal non-blocking Run with a completion tally notice. Unlink drops link + Sync State + Shadow Store, touches no files on either side. The dual-engine warning also becomes a persistent callout in linked-state settings.

## Acceptance criteria

- [ ] wdio: pick a folder, preview matches a seeded local/remote divergence, confirm syncs it; vault usable during the Run
- [ ] Nothing is written during scan/preview; Cancel leaves both sides untouched
- [ ] Link survives the Remote Folder being renamed/moved on Filen (UUID-bound); re-link after Unlink triggers Re-Bootstrap
- [ ] Root selection is gated by the warning modal; dual-engine caution appears in both specified placements
- [ ] Unlink removes state + shadow and no vault/remote file changes

## Blocked by

- [027](027-impl-engine-core.md), [028](028-impl-filen-remoteport-adapter.md), [029](029-impl-obsidian-adapters-and-wdio.md), [030](030-impl-login-and-secretstorage.md)
