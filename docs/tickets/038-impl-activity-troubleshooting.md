---
id: 38
title: "Activity, troubleshooting, and Device Name settings"
labels: [impl, afk]
status: open
assignee:
blocked_by: [33, 37]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §8.7 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The linked-state settings extras: Recent activity (last ~20 run summaries, newest first, local-only, Skip-and-Surface paths with reasons); the Verbose logging toggle (off by default, timestamped rolling log capped and rotated under the plugin's `logs/` folder — on the Exclusion List) with the "Copy debug info" clipboard export; the "Verify and repair (re-hash all files)" button + palette command marking the next Run FULL-with-rehash; and the user-editable Device Name setting (platform-derived default, device-local `data.json`) feeding Conflict Copy names.

## Acceptance criteria

- [ ] Recent activity shows run summaries including skips with reasons; survives plugin reload; never syncs
- [ ] Verbose log writes only when enabled, rotates at its cap, and never appears in the sync diff
- [ ] "Copy debug info" puts recent log + environment facts on the clipboard on both platforms
- [ ] Verify-and-repair bypasses the mtime+size cheap path exactly once and repairs a hand-corrupted state without deletions
- [ ] Device Name defaults per platform, is editable, sanitizes into Conflict Copy filenames

## Blocked by

- [033](033-impl-conflicts-merge-shadow.md), [037](037-impl-status-surface-ux.md)
