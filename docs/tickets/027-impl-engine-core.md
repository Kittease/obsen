---
id: 27
title: "Sync Engine core: ports, fakes, Sync State, scheduler, add/edit convergence"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [26]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.1, §3, §4, §5.1–5.2 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The pure-TS Sync Engine tracer bullet: the three port interfaces exactly as specified (§1.1 signatures are normative), in-memory fakes for all three, the Sync State schema with atomic persistence and envelope guards (schemaVersion, remoteRoot, corrupt-state → Re-Bootstrap), the single-flight scheduler with coalescing pending scope and injected timers (2 s debounce / 15 s max-wait), and a Run that converges **adds and edits** between the fakes: full remote listing, UUID-based remote-delta scope expansion, mtime+size cheap path with hash-on-mismatch, decision-matrix classification, plan-then-execute. First Link must fall out as FULL Reconcile with empty state — no bootstrap module. Include the plan-only entry point (plan computed, nothing executed) that the First Link preview will consume. Deletes, renames, and conflicts are later slices — their matrix cells may return "not yet implemented" but the matrix shape is complete.

## Acceptance criteria

- [x] Headless vitest: two fakes with divergent adds/edits converge to identical content in one Run; a second Run is a no-op
- [x] First-link cases from spec §5.2 pass with empty state: upload-all, download-all, identical-pair silently, both-sided adds on one path → deferred to conflict slice (explicitly marked)
- [x] Scheduler: concurrent run requests coalesce; at most one Run executes (test with injected clock); FULL absorbs path scopes
- [x] Sync State: atomic write, cheap-path skip verified, corrupt/newer-schema state degrades to Re-Bootstrap without data loss
- [x] Plan-only entry point returns counts (upload/download/identical/conflict) without touching either side
- [x] Engine imports nothing from `obsidian` or `@filen/sdk`

## Resolution

The Sync Engine exists, runs headless, and converges adds and edits between two in-memory
fakes. `npm run verify` is green: lint → typecheck → 94 unit tests → 14 bundle-gate tests.

**Shape.** Twelve small modules under `src/engine/`, none importing anything outside its own
folder — `tests/unit/engine/purity.test.ts` asserts that, since `obsidian` is a legitimate
external one directory away and only a test can catch the slip. `ports.ts` reproduces §1.1
member-for-member and adds the contracts the signatures cannot state (NFC at the boundary,
atomic `write`, **recursive and idempotent `mkdir`**, and `RemotePort.listing()` returning
*files only* — folder existence derives from paths, since Obsen keeps no folder records).
`plan.ts` (observe → classify → decide) and `execute.ts` (the five phases) are separate
halves of a Run, which is what makes the plan-only entry point the same code path a real
Run plans with rather than a second implementation of the matrix.

**The matrix is complete in shape** (`decide()`), and the cells belonging to later slices
plan a `pending` operation naming the slice, so a Run reports "planned, not executed" rather
than pretending a path converged. Deliberately included there: **edit-beats-delete**, which
reduces to an upload/download this slice already implements, is *still* deferred to
[032](032-impl-deletes-renames-phases.md) — shipping half of "edit beats delete" without the
deletion cells beside it would read as working deletion support.

**Three decisions the spec left to the implementer:**

1. **An unknown remote hash is never "identical".** `RemoteEntry.hash` is optional (§3.1:
   "absent means *unknown*, never *unchanged*"), so a both-added or both-modified pair with
   no remote hash cannot be proven equal and goes to the conflict path. Conservative in the
   only safe direction: a Conflict Copy loses nothing.
2. **A download whose bytes disagree with Filen's recorded plaintext hash is rejected**, not
   written. No spec line demands it; the hash is right there, and laundering a corrupt
   transfer into someone's notes is the one failure mode with no recovery.
3. **The upload record stores the stat taken *before* the read** with the size of the bytes
   actually sent. If the file changes mid-read, the older mtime forces a re-hash next Run;
   a fresher stat could hide a real edit behind the cheap path.

**Two bugs the review caught, both fixed with tests that fail without the fix:**

1. **Duplicate remote path picked by UUID order alone** could discard the file the Sync State
   tracks and then "download" the stranger over the top. §5.8 says sync the *known* path:
   the tiebreak now prefers the tracked `remoteUuid`, with UUID order only breaking ties
   between two equally unknown entries. The skip it emits now carries a `detail`, because
   the path itself *does* sync — what is skipped is the second file at it.
2. **`idle()` resolved on `dispose()` while a Run was still executing.** The unload path is
   exactly who asks whether the vault is quiet, so that was a lie; a Run is not cancellable,
   and `idle()` now waits for it.

**Ancillary:** `vitest.config.ts` gained two projects — `unit` (10 s timeout: a hanging
inner-loop test is a bug, not two minutes of CI) and `gate` (120 s, real esbuild bundles).
The bundle gate now also bundles `src/engine/index.ts` and runs SHA-512 inside the webview
realm, cross-checked against Node's digest: the engine is not reachable from `main.ts` yet,
and discovering on a phone that WebCrypto was the missing piece is not a plan.
`Timers` is an interface in the engine with its production implementation in
`src/platform/timers.ts` — `window.setTimeout` is an environment fact, and the engine is not
allowed to know any (`eslint-plugin-obsidianmd` independently insists on `window.` timers).

**Deliberately deferred, not forgotten:**

- **Deletions, rename pairing, conflicts, Shadow Store** — [032](032-impl-deletes-renames-phases.md),
  [033](033-impl-conflicts-merge-shadow.md). Rename Hints are already plumbed through the
  Dirty Set (and tested) so 032 only adds the pairing pass.
- **The re-stat guard and the ~5 s in-transfer flush cadence** belong with 032's
  crash-interruption tests; phase-boundary flushes are enough while every operation is
  individually redo-safe. State is not rewritten when a Run changed nothing — except once
  after a Re-Bootstrap, or the unusable document survives and every startup re-bootstraps.
- **Retries, offline backoff, requeueing a failed path, the rest of Skip-and-Surface** —
  [036](036-impl-engine-resilience.md). A failure today is counted and reported, and the
  path waits for the next FULL Reconcile; requeueing without backoff would hot-loop.
- **Attention-State notices and badges** — [037](037-impl-status-surface-ux.md). The engine
  exposes `EngineStatus` and a per-run summary; only `offline` (a failed listing) is
  reachable, and the Attention-State partition lands with the UX that acts on it.
- **Own-Writes Filter** — [034](034-impl-trigger-wiring.md), with the watchers whose echoes
  it exists to drop. `FakeVault` already emits events for the engine's own writes, so the
  filter will have something real to be tested against.

## Blocked by

- [026](026-impl-scaffold-and-build-gate.md)
