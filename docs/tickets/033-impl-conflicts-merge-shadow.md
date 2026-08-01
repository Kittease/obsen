---
id: 33
title: "Engine: Shadow Store, three-way merge, Conflict Copies, conflicts.md"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §3.4, §6 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The conflict path end-to-end: the content-addressed Shadow Store (Mergeable files only, deflate via feature-detected `CompressionStream` with raw fallback, write-before-state-flush ordering, mark-and-sweep GC, corrupt-entry detection → no Ancestor); diff3 three-way merge for both-modified Mergeable files with an Ancestor (clean → written to both sides; overlap → Conflict Copy); Conflict Copies with the §6.1 naming convention (timestamp + sanitized Device Name, collision suffixes, incoming version becomes the copy); and the `conflicts.md` manifest with the §6.2 format and lifecycle (append per copy, recreate with header when missing, never auto-pruned, opened in Obsidian after any Run that created copies — no notice).

## Acceptance criteria

- [x] Headless: non-overlapping concurrent edits merge cleanly to both sides; overlapping edits, binaries, and no-ancestor cases produce a Conflict Copy and never lose either version
- [x] Shadow entries exist only for Mergeable files; GC removes unreferenced entries; a corrupt entry falls back to Conflict Copy
- [x] Copy names match the convention, are wikilink-safe, and dodge collisions
- [x] `conflicts.md` rows appended exactly once per copy; file recreated when missing; a conflicted `conflicts.md` itself resolves like any note
- [ ] wdio: a Run creating a copy opens `conflicts.md` in Obsidian — **deferred to [029](029-impl-obsidian-adapters-and-wdio.md)**: no Obsidian adapter and no wdio harness exist yet. The engine's half of that contract ships here as `RunSummary.conflicts` (copies created — what §6.2 keys the open on) and `RunSummary.manifestWritten` (whether the rows reached the file).

## Resolution

The conflict path is complete end to end, headless. `npm run verify` is green: lint →
typecheck → 191 unit tests → 14 bundle-gate tests.

**Four new engine modules, no new dependency.** `merge.ts` (diff3), `shadow.ts` (the Shadow
Store), `conflict.ts` (copy naming + the manifest) and `text.ts` (the one strict UTF-8 codec).
The spec suggests `node-diff3`; the engine's standing rule is that it imports *nothing* — not
`obsidian`, not the SDK, not a helper from `src/` — and diff3 is one line diff plus one overlap
rule, so it was written rather than pulled in. The diff is LCS after common prefix/suffix
trimming, with a one-million-cell work budget: past that the file was replaced rather than
edited, and a Conflict Copy is cheaper *and* more honest than a merge.

**The overlap rule is the whole safety argument.** Two hunks are judged together when their
base ranges overlap **or when they start at the same line** — the second clause is what catches
two insertions at one point, which have no length to overlap with but no defined order either.
Judged-together hunks merge only if both sides produce identical text; anything else refuses.
Adjacent-but-disjoint edits both apply, which is the daily-note case (two devices appending in
different places) working as users expect.

**Where merge/copy is decided: execution, not planning.** The planner emits one `conflict`
operation — replacing 032's `pending` — carrying the record, stat, hash and remote entry. It
deliberately does *not* consult the Shadow Store, so planning stays cheap and the First-Link
dry-run preview stays a pure listing pass. Consequence, documented on `PlanCounts.conflict`:
the preview's conflict count is an **upper bound** on copies (a both-modified pair may still
merge), and at First Link — no records, so no Ancestors — it is exact.

**Execution also resolves conflicts the planner could not.** It has to fetch the remote bytes
anyway, so it hashes them: a pair the planner could not prove identical (an older Filen client
records no plaintext hash) converges instead of spawning a spurious copy. That flipped one
existing test — the "unknown remote hash is unproven" case now asserts at the *plan* level,
which is where the unprovenness actually lives.

**Judgement calls the spec left open:**

1. **A Conflict Copy is `ok`, not `partial`.** A resolved conflict is work completed; `partial`
   now means only failures, skips or requeues. Both versions are on both sides when the Run
   ends — the copy is uploaded in the same Run, since its path is brand new and cannot collide
   with anything the Run has not already seen.
2. **The row is recorded the instant the copy exists on disk**, before the two uploads that
   could still fail. A copy the manifest never mentions would be exactly the silent conflict
   §6.2 exists to prevent. (This was a review finding: it used to be recorded last.)
3. **Manifest rows are sorted before appending**, not written in completion order — phase 3
   runs four at a time, and this file *syncs*, so a nondeterministic row order would be one
   more thing for two devices to merge.
4. **`conflicts.md` is written once per Run, after every copy is on disk**, then pushed by a
   follow-up Run (`ExecutionReport.followUp`, the same mechanism as the re-stat requeue). That
   ordering is what lets a conflicted `conflicts.md` resolve *first* and its rows land on the
   winner. A manifest that is not valid UTF-8 fails the operation rather than being replaced —
   Obsen only ever writes text there, so something else wrote it and overwriting would destroy
   it.
5. **Converged pairs read their Ancestor back.** A hash-identical pair transfers nothing, so
   nothing hands the Shadow Store its bytes — and without it every First-Link pairing would be
   a Conflict Copy waiting for the first divergence. The read only happens when the entry is
   missing *or unsound*, which also heals a corrupt entry from the file it describes, and it
   runs at transfer concurrency because a First Link can converge thousands of files at once.

**GC is delta-based, and that is a real limitation.** `StorePort` is normative (spec §1.1) and
has no listing call, so the sweep can only consider what the Sync State referenced at Run start
plus what the store wrote since. That collects every superseded Ancestor — the garbage a
running Obsen actually produces — but *cannot* reach a blob written by a Run that then crashed,
nor the whole store after a Re-Bootstrap discarded the state referencing it. Those leak until
the `StorePort` adapter can enumerate its own `shadow/` folder, which is [029](029-impl-obsidian-adapters-and-wdio.md)'s
to add; the limitation is written on the field it constrains.

**Compression is feature-detected per the spec** (`CompressionStream`, absent on iOS < 16.4),
with a one-byte `raw | deflate` header so devices that cannot compress still read everyone
else's entries. Every read re-hashes what it decoded: an entry that does not hash to its own
name is *no Ancestor*, never a wrong one.

**Ancillary:** `SyncEngine` gained `deviceName` (spec §8.7 feeds §6.1) and a `busy` getter —
the synchronous counterpart of `idle()`, which the test world needs because a Run can now queue
a Run and a frozen clock never expires the debounce that would start it. `RunSummary` gained
`merged` and `manifestWritten`. One eslint rule (`obsidianmd/prefer-window-timers`) is off for
the already-existing node-side file list: there is no `window` in a headless test run.

**Deliberately still deferred:** retries, offline backoff, the error taxonomy and the
Skip-and-Surface *surface* — [036](036-impl-engine-resilience.md); an unwritable Conflict Copy
name is reported as a failure today rather than as a skip. Opening `conflicts.md` in Obsidian —
[029](029-impl-obsidian-adapters-and-wdio.md)/[037](037-impl-status-surface-ux.md).

## Blocked by

- [027](027-impl-engine-core.md)
