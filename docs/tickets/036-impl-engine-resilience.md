---
id: 36
title: "Engine resilience: offline backoff, retries, error taxonomy, Skip-and-Surface"
labels: [impl, afk]
status: open
assignee:
blocked_by: [27, 32]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §5.7–5.9 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The engine's error handling and the Status Surface it exposes: per-op transient retries (3 attempts, 1 s / 5 s, then requeue into the pending scope — one bad file never blocks the vault); `offline` state when the listing fails, with 10 s → 5 m capped backoff that coalescing events don't reset and Foreground-Resume/manual sync cut through; `auth-error` freeze until re-login; `quota` blocking uploads only; `frozen` when the Remote Folder root is unresolvable (never "everything deleted"); Skip-and-Surface for unmaterializable names and remote case collisions per §5.8. The engine exposes `idle|syncing|offline|quota|auth-error|frozen` plus the per-run summary record (trigger, duration, up/down/conflict/skip counts, outcome).

## Acceptance criteria

- [ ] Headless with injected clock: backoff sequence and cut-through verified; success resets; backoff ticks stop when nothing is pending
- [ ] A persistently failing file requeues while the rest of the Run completes
- [ ] Quota-full blocks uploads while downloads and deletes proceed, with distinct status
- [ ] Unresolvable remote root freezes sync; no delete is ever planned from it
- [ ] Windows-reserved and case-colliding names are skipped and reported in the run summary, never auto-renamed

## Blocked by

- [027](027-impl-engine-core.md), [032](032-impl-deletes-renames-phases.md)
