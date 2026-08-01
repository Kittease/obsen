---
id: 36
title: "Engine resilience: offline backoff, retries, error taxonomy, Skip-and-Surface"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [27, 32]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §5.7–5.9 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The engine's error handling and the Status Surface it exposes: per-op transient retries (3 attempts, 1 s / 5 s, then requeue into the pending scope — one bad file never blocks the vault); `offline` state when the listing fails, with 10 s → 5 m capped backoff that coalescing events don't reset and Foreground-Resume/manual sync cut through; `auth-error` freeze until re-login; `quota` blocking uploads only; `frozen` when the Remote Folder root is unresolvable (never "everything deleted"); Skip-and-Surface for unmaterializable names and remote case collisions per §5.8. The engine exposes `idle|syncing|offline|quota|auth-error|frozen` plus the per-run summary record (trigger, duration, up/down/conflict/skip counts, outcome).

## Acceptance criteria

- [x] Headless with injected clock: backoff sequence and cut-through verified; success resets; backoff ticks stop when nothing is pending
- [x] A persistently failing file requeues while the rest of the Run completes
- [x] Quota-full blocks uploads while downloads and deletes proceed, with distinct status
- [x] Unresolvable remote root freezes sync; no delete is ever planned from it
- [x] Windows-reserved and case-colliding names are skipped and reported in the run summary, never auto-renamed

## Resolution

Done, headless. `npm run verify` is green: lint → typecheck → 253 unit tests → 15 bundle-gate tests.
The ladders are asserted **in milliseconds** against the injected clock, which is the only way
to tell a 10 s → 5 m backoff from a busy loop; the new suite is `tests/unit/engine/resilience.test.ts`.

**The taxonomy is a port contract, not an engine guess.** `src/engine/errors.ts` gains
`FaultKind` = `transient | auth | quota | missing-root | rejected`, a `SyncFault` carrying one,
and `attentionFor(kind)` — the single table mapping a fault to the Attention State it causes, so
the planner's half and the executor's cannot drift. The engine cannot read an HTTP status or a
Filen error code and must not learn how, so **each adapter classifies its own failures** and the
engine reacts to the kind alone. An adapter that classifies nothing still works: an unrecognized
failure is `transient`, which retries and then requeues, and every operation is redo-safe
(§5.5), so that is the safe direction to be wrong in.

**Where the policy lives:** `FaultPolicy` in `execute.ts`, the one place every operation already
passed through. Its rule is the spec's — *one bad file never blocks the vault* — so a fault stops
its own operation and at most the class that cannot succeed either: `quota` stops later uploads
without asking again, `auth`/`missing-root` stop the Run outright. Nothing rethrows; a path that
could not be finished lands in `deferred` or `skips`, the phases run to completion, and the
engine decides what that means.

**Two requeue lanes, deliberately.** `ExecutionReport.requeue` (the re-stat guard, a real user
edit) is re-dirtied immediately as before; the new `deferred` (a fault outlived its retries, or
an upload the account has no room for) is re-dirtied *behind a backoff rung*. Without the split,
a path failing against a sick remote would spin on the 2 s event debounce forever. §5.7's
parenthetical is what licenses the rung — the ladder "ticks only while failed work is pending —
not the rejected periodic poll" — and an idle, healthy Obsen arms nothing at all.

**Status is derived, not latched.** Every Run ends by computing `idle | offline | quota |
auth-error | frozen` from what it did, so a Run that lists, transfers and finishes clean *is* the
recovery. The one exception is the auth freeze, which outlives its Run because only
`credentialsRestored()` can lift it — and that comes back with a FULL Reconcile rather than the
paths the frozen Run left behind, since what happened on either side while the credentials were
wrong is unknown.

**Judgement calls:**

1. **`RunSummary` gained `attention`, and an outcome named `blocked`.** A frozen root and a dead
   network are the same *outcome* — the remote could not be read, nothing was planned — but very
   different things to tell a user, and §8.7's Recent-activity list shows *past* Runs, where the
   live status is no help. So the state travels on the record. `blocked` is a Run that never
   started because sync is frozen; it costs no round trip, which is the point.
2. **Four triggers cut through a backoff, not two.** §5.7 names Foreground-Resume and manual;
   `verify-repair` and `first-link` are the same kind of caller — someone who just pressed
   something and is watching. `startup` is deliberately absent: the engine is built after it.
3. **The `frozen` root shares the offline ladder.** §5.7 scopes the ladder to `offline`, but the
   alternative for `frozen` is a listing call per debounce burst; "Check again" still cuts
   through, which is the recovery §8.6 specifies.
4. **A Conflict waits *whole* under `quota`, local write included.** Resolving it and failing to
   push leaves the expensive half done. Deferring leaves both versions exactly where they are,
   on both sides, and costs only latency.
5. **A case collision is resolved by dropping one path from the diff, never by renaming.** The
   winner is the path a record already tracks — dropping a tracked path would read as "gone from
   the remote" and propagate a delete — else the lexicographically first by code unit, so two
   devices reach the same answer independently. §5.8 says that singular, and one tracked path is
   the ordinary case; where *two* are tracked the vault demonstrably holds both, so both are kept
   and the collision is not one.

**Two defects the retry ladder exposed, both fixed here:**

- **A retried Conflict resolution minted a fresh Conflict Copy per attempt.** Naming is now
  stable for the same conflict — remembered per original path within a Run, and a candidate name
  already holding *exactly the incoming bytes* is adopted rather than stepped over, which also
  closes the across-Run case (a resolution that wrote its copy and then failed to push it is
  redone by the next Reconcile). `appendConflictRows` correspondingly no longer appends a row it
  can already see, and returns its input unchanged when there is nothing to add so the user's
  file and its mtime are left alone. An adopted copy is not counted in `RunSummary.conflicts`:
  it is an earlier Run's, being finished rather than created.
- **`RunScheduler` reported `isRunning` for one microtask after resolving its requesters**, so
  `busy` lied to anyone who awaited a summary and then asked whether work remained. The Run is
  now marked finished before its waiters are told.

**Filen's half of the contract** (`src/filen/remote.ts`): one Proxy wraps `sdk.cloud()` so no
future method can forget to classify, mapping `APIError#code` and the SDK's
`invalid_http_status_code` message onto `auth` and `quota`. Matched by **pattern anchored to code
segments**, not an exact table: Filen's codes are not part of the SDK's typed surface, so a table
would be a guess that rots silently, and being wrong towards `auth` latches a freeze. `listing()`
additionally raises `missing-root` when Filen says `folder_not_found` *or* when the Remote Folder
is absent from its own tree — reading that as an empty listing would mean "every file was deleted
there", the one conclusion §5.7 forbids. Sharpening the patterns against codes observed on a real
account is on [040](040-impl-on-device-checklist.md).

**Ancillary:** `RunSummary.skipped: number` became `skips: SkipRecord[]` (path + reason +
a sentence), since a skip the user cannot act on is not surfaced at all; `SkipReason` moved to
`status.ts`, which owns the reporting vocabulary, and gained `case-collision` and
`remote-rejected`. `SyncEngine` gained `backingOff` — the difference between "syncing" and "will
try again shortly", which [037](037-impl-status-surface-ux.md) has to be able to say. An
unwritable Conflict Copy name is now a skip rather than a failure, which is the loose end
[033](033-impl-conflicts-merge-shadow.md) left. The scheduler gained `holdFor`/`release`/`requeue`
and dedupes triggers, so a Run requeued down the ladder does not repeat its own labels for as
long as the remote stays down. The test world gained `pump()` — it fires armed timers one at a
time until a Run settles, and throws rather than letting a stuck Run become a bare vitest timeout.

**Not here:** the notices, badges and attention-state *flows* that render any of this —
[037](037-impl-status-surface-ux.md); the Recent-activity list and rolling log that consume
`RunSummary` — [038](038-impl-activity-troubleshooting.md); the real `isWritablePath` that knows
what this platform actually refuses — [029](029-impl-obsidian-adapters-and-wdio.md), which is why
the Windows-reserved case is tested through the fake's `unwritable` predicate.

## Blocked by

- [027](027-impl-engine-core.md), [032](032-impl-deletes-renames-phases.md)
