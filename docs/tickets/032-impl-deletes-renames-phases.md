---
id: 32
title: "Engine: deletions, rename pairing, five-phase execution"
labels: [impl, afk]
status: open
assignee:
blocked_by: [27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §5.2–5.5 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

Complete the decision matrix in the headless engine: state-based deletion detection with Soft Delete propagation, edit-beats-delete restoration, both-missing convergence; the three-tier rename pairing pass (remote same-UUID-new-path, live Rename Hints validated against the scan, offline exact-hash 1:1 pairing, ambiguity → delete+create), folder rename-hint prefix rekey with a single remote `moveFolder`; and the five sequential execution phases with deletes last, transfer concurrency 4, per-op state updates flushed at phase boundaries and ~5 s during transfers, the re-stat guard, and the redo-safety invariant (every op safe to redo when its state update is lost).

## Acceptance criteria

- [ ] Headless: delete on one side propagates as soft delete; edit-vs-delete restores the edit to the deleting side; folders vanish only when emptied, deepest first
- [ ] Rename scenarios pass all three tiers, including rename+edit via hint and offline hash pairing; ambiguous cases degrade without wrong pairings
- [ ] Phase ordering verified: a simulated crash after any phase leaves a state the next FULL Run converges from (property-style test over interrupted runs)
- [ ] Re-stat guard: a file mutated between classification and write is skipped and re-dirtied, never clobbered
- [ ] Out-of-scope remote content (Sync Scope predicate) is never read as locally deleted

## Blocked by

- [027](027-impl-engine-core.md)
