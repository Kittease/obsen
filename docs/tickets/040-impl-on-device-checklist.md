---
id: 40
title: "On-device HITL checklist run (Android + iOS)"
labels: [impl, hitl]
status: open
assignee:
blocked_by: [39]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §9 (HITL checklist), §12 watch list — backlog seeded by [023](023-write-v1-spec.md).

## What to build

Nothing to code: the user runs the spec's seven-item on-device checklist on a real Android phone and a real iPhone against the `0.1.0-beta.N` BRAT install — first-run/login UX, backgrounding mid-sync, offline transitions, large-vault performance, all-of-iOS (key-derivation time, socket stability, storage eviction), battery/network budget, and a real desktop↔phone conflict reviewed via `conflicts.md`. iOS is the gate for calling v1 mobile-complete (watch-list item 2); the huge-attachment memory question (watch-list item 1) gets a data point with the largest attachment the tester has.

## Acceptance criteria

- [ ] Checklist executed on Android and iOS with results recorded in this ticket (device, OS, findings)
- [ ] Every failure either fixed via a new impl ticket or explicitly accepted and documented in the README
- [ ] Watch-list items 1 (huge attachment) and 4 (battery) have recorded observations
- [ ] iOS run passes items 1–3 and 7 — the v1 mobile-complete gate

## Blocked by

- [039](039-impl-release-engineering.md)
