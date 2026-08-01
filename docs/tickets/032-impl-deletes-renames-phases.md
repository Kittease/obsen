---
id: 32
title: "Engine: deletions, rename pairing, five-phase execution"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §5.2–5.5 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

Complete the decision matrix in the headless engine: state-based deletion detection with Soft Delete propagation, edit-beats-delete restoration, both-missing convergence; the three-tier rename pairing pass (remote same-UUID-new-path, live Rename Hints validated against the scan, offline exact-hash 1:1 pairing, ambiguity → delete+create), folder rename-hint prefix rekey with a single remote `moveFolder`; and the five sequential execution phases with deletes last, transfer concurrency 4, per-op state updates flushed at phase boundaries and ~5 s during transfers, the re-stat guard, and the redo-safety invariant (every op safe to redo when its state update is lost).

## Acceptance criteria

- [x] Headless: delete on one side propagates as soft delete; edit-vs-delete restores the edit to the deleting side; folders vanish only when emptied, deepest first
- [x] Rename scenarios pass all three tiers, including rename+edit via hint and offline hash pairing; ambiguous cases degrade without wrong pairings
- [x] Phase ordering verified: a simulated crash after any phase leaves a state the next FULL Run converges from (property-style test over interrupted runs)
- [x] Re-stat guard: a file mutated between classification and write is skipped and re-dirtied, never clobbered
- [x] Out-of-scope remote content (Sync Scope predicate) is never read as locally deleted

## Resolution

The decision matrix is complete apart from its conflict cells, and all five execution phases
run. `npm run verify` is green: lint → typecheck → 126 unit tests → 14 bundle-gate tests.

**Renames became their own module.** `src/engine/rename.ts` holds the three-tier pass and
nothing else; `plan.ts` orchestrates. The pass returns *pairings*, and the planner folds each
one into the draft it lands on — the record moves to the new path, and so does whichever
side's observation was still filed under the old one. Classification then judges one path
holding one file, which is why **"rename + edit" needs no cell of its own**: it falls out as a
pairing followed by an ordinary upload. The one wrinkle that earned a field is `Draft.readPath`
— a pairing can move a record onto a path the vault does not hold *yet*, so until phase 2
performs the rename, reading the file means reading its old path.

Tier ordering is spec order (remote UUID → hints → content hash), with a `taken` set making
pairings mutually exclusive. Tier 3 is the only one that costs reads, and it only asks for
them when a vanished file leaves it something to look for (`hasContentRenameSources`) —
otherwise a pure local add is never hashed, exactly as before.

**Four judgement calls the spec left open:**

1. **Tier 1 requires the old path to be free remotely.** If a *different* remote file has
   appeared at the source path, the pairing is abandoned. Degrading there costs two transfers
   and converges correctly; the alternative is reasoning about a three-way path swap for a
   case Filen should never produce.
2. **Emptied-folder deletes issue the *topmost* emptied folder, not each one deepest-first.**
   `trashFolder` is recursive on both ports, so one call does what the chain would, and
   issuing the descendants too would mean trashing folders that no longer exist. The
   deepest-first ordering §5.4 asks for is kept for *siblings*, where it still means something.
3. **A file merely *moved* out of a folder does not empty it.** Only deletions feed phase 5.
   An empty folder costs nothing and never syncs, so the conservative reading is free.
4. **The re-stat guard re-dirties rather than fails.** A guarded skip is not an error — it is
   work the next Run has to do — so the paths go straight back into the Dirty Set and the
   summary counts them as `requeued`, not as failures. `RunSummary` also gained `moved` and
   `deleted`, and lost `deferred`: with only the conflict cells left pending, `conflicts`
   already counts exactly what is unexecuted.

**The bug the review caught — the one that could destroy a note.** Phase 5 judged folder
emptiness from a snapshot taken *before* execution. A folder that lost its last tracked file
and gained a brand-new one in the same Run was therefore "empty", and the recursive trash
deleted the file phase 3 had just transferred — then the next Run propagated that loss to the
other side. Both directions reproduced. The fix counts the paths a plan will *create* on each
side as inventory (`creations()`); two regression tests fail without it. This is precisely the
failure mode §5.5's "deletes last" exists to prevent, arriving one phase later than expected.

**Crash recovery is tested as a property.** The fakes are wrapped in a proxy that rejects every
mutating call — including `writeState` — once a budget of operations is spent, so the store
keeps exactly what it had persisted at that instant. The scenario (a rename, a delete each
way, an edit) costs exactly 8 mutating calls, so budgets 0–8 cover **every** interruption point
plus the uninterrupted run. After each, a single fresh startup Reconcile converges both sides
— one run, not two, because that is all a real restart gets before the user starts typing.

**Deliberately still deferred:** three-way merge, Conflict Copies, the Shadow Store and
`conflicts.md` — [033](033-impl-conflicts-merge-shadow.md); both-modified and no-ancestor
paths stay `pending` and are reported, never resolved by force. Retries, offline backoff and
the error taxonomy — [036](036-impl-engine-resilience.md). Local emptied-folder detection is
skipped on scoped Runs (no local inventory to prove emptiness with); the next FULL Reconcile
cleans up, which startup and Foreground-Resume both guarantee.

**Ancillary:** the engine-test helpers moved to `tests/helpers/sync-world.ts` so the new
scenarios and `run.test.ts` share one world; both fakes now record `trashedFolders`, so a test
claiming a folder was removed can actually prove it rather than inferring it from file trash.

## Blocked by

- [027](027-impl-engine-core.md)
