---
id: 23
title: "Write the Obsen v1 spec — the destination"
labels: [wayfinder:task]
status: closed
assignee: camercey@gmail.com
blocked_by: [17, 18, 21, 22, 24]
---

## Question

Assemble the complete, validated v1 spec in `docs/specs/` from everything the map has settled: locked semantics (tickets 001–013), research verdicts (014–018), prototype findings (019), and the three design sessions (020–022). Include:

- architecture (ports, engine, adapters, bundling)
- sync algorithm and all semantics
- settings/onboarding UX
- testing strategy (headless engine tests, integration harness, HITL on-device checklist)
- distribution/compliance checklist
- documented end goals and non-goals (per-subfolder sync, merge UI, live-sync caveats, scale envelope)

Then break the spec into implementation-ready tickets (e.g. via /to-issues) as the follow-on effort's backlog. When this closes, the map is done: nothing left to decide before building.

## Resolution

**Done — the spec is [docs/specs/obsen-v1.md](../specs/obsen-v1.md), and the implementation backlog is tickets [026](026-impl-scaffold-and-build-gate.md)–[040](040-impl-on-device-checklist.md) (label `impl`).** The map is complete: nothing left to decide before building.

The spec assembles every settled decision (semantics 001–013, research verdicts 014–018, spike findings 019, design sessions 020–022, license 024, SecretStorage 025) into one normative document: architecture and ports, bundling recipe, sync scope, Sync State schema, triggers/scheduler, the full Run algorithm with decision matrix and crash recovery, conflicts, Filen integration, credentials, settings/onboarding UX, the layered testing strategy with the HITL on-device checklist, distribution/compliance, end goals/non-goals, and a watch list of open risks.

It also settles the map's four remaining "Not yet specified" items:

- **Exclusion List** (spec §2.1): workspace files (incl. legacy `workspace`), Obsen's device-local state (`data.json`, `sync-state.json`+tmp, `shadow/`, `logs/`), `.trash/`, OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`). Obsen's own plugin *code* syncs like any other plugin's.
- **Conflict Copy naming** (§6.1): `<stem> (conflict <YYYY-MM-DD HHmm> <Device Name>).<ext>`, wikilink-safe sanitization, collision suffixes; the incoming version becomes the copy.
- **`conflicts.md` format/lifecycle** (§6.2): two-column wikilink table with header; append per copy (unique names ⇒ no dedup needed); recreated when missing; never auto-pruned; opened after any Run creating copies; itself an ordinary Mergeable note.
- **Display name** (§10.1): ship the beta as "Obsen" (`id: obsen`); rename only if directory review objects post-v1 — no further naming work in v1.

The backlog is 15 tracer-bullet slices in dependency order: scaffold/build-gate (026) → engine core (027) → Filen adapter (028) ∥ Obsidian adapters + wdio (029) → login/SecretStorage (030) → link + First Link (031); engine deepening in parallel: deletes/renames/phases (032), conflicts/merge/shadow (033), trigger wiring (034), socket (035), resilience (036); then status UX (037), activity/troubleshooting (038), release + first BRAT beta (039), and the HITL on-device checklist (040) — the only HITL slice, and the v1 mobile-complete gate.
