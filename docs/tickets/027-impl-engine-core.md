---
id: 27
title: "Sync Engine core: ports, fakes, Sync State, scheduler, add/edit convergence"
labels: [impl, afk]
status: open
assignee:
blocked_by: [26]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.1, §3, §4, §5.1–5.2 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The pure-TS Sync Engine tracer bullet: the three port interfaces exactly as specified (§1.1 signatures are normative), in-memory fakes for all three, the Sync State schema with atomic persistence and envelope guards (schemaVersion, remoteRoot, corrupt-state → Re-Bootstrap), the single-flight scheduler with coalescing pending scope and injected timers (2 s debounce / 15 s max-wait), and a Run that converges **adds and edits** between the fakes: full remote listing, UUID-based remote-delta scope expansion, mtime+size cheap path with hash-on-mismatch, decision-matrix classification, plan-then-execute. First Link must fall out as FULL Reconcile with empty state — no bootstrap module. Include the plan-only entry point (plan computed, nothing executed) that the First Link preview will consume. Deletes, renames, and conflicts are later slices — their matrix cells may return "not yet implemented" but the matrix shape is complete.

## Acceptance criteria

- [ ] Headless vitest: two fakes with divergent adds/edits converge to identical content in one Run; a second Run is a no-op
- [ ] First-link cases from spec §5.2 pass with empty state: upload-all, download-all, identical-pair silently, both-sided adds on one path → deferred to conflict slice (explicitly marked)
- [ ] Scheduler: concurrent run requests coalesce; at most one Run executes (test with injected clock); FULL absorbs path scopes
- [ ] Sync State: atomic write, cheap-path skip verified, corrupt/newer-schema state degrades to Re-Bootstrap without data loss
- [ ] Plan-only entry point returns counts (upload/download/identical/conflict) without touching either side
- [ ] Engine imports nothing from `obsidian` or `@filen/sdk`

## Blocked by

- [026](026-impl-scaffold-and-build-gate.md)
