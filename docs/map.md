---
title: "Obsen — Obsidian ↔ Filen two-way sync plugin"
labels: [wayfinder:map]
---

# Obsen — wayfinder map

## Destination

**A complete, validated spec for Obsen v1** — architecture, sync algorithm, UX, testing strategy — plus implementation-ready tickets, for a cross-platform (desktop **and mobile**) Obsidian plugin that two-way syncs a vault with one Filen folder. The map is done when [Write the Obsen v1 spec](tickets/023-write-v1-spec.md) closes: nothing left to decide before building.

## Notes

- **Tracker**: local markdown. Tickets live in `docs/tickets/NNN-slug.md` with frontmatter (`id`, `labels: [wayfinder:<type>]`, `status: open|closed`, `assignee`, `blocked_by: [ids]`). A session claims a ticket by setting `assignee` before working it; the `assignee` value is always the claiming user's current git email (`git config user.email`). The frontier = open tickets with empty `assignee` whose `blocked_by` tickets are all closed. Resolutions are written into the ticket's `## Resolution` section, then `status: closed`.
- Research assets go to `docs/research/`; specs to `docs/specs/`.
- **Skills**: use `/grilling` + `/domain-modeling` for design tickets (keep `CONTEXT.md` at repo root sharp); `/research` for research tickets; `/prototype` for the spike.
- **Standing constraints**: mobile-first (browser-safe JS only — no Node APIs; the esbuild `--platform=browser` bundle is the enforcement gate); engine is pure TS behind `VaultPort`/`RemotePort` so an agent can test it headless; user works single-device ~99% of the time. Automated tests use a dedicated Filen test account (per the harness research), never a personal one; no personal account details ever land in this repo.
- Verified facts: `@filen/sdk@0.4.2` ships a browser build and a socket module; `@filen/sync` exists but is Node-oriented (desktop product).

## Decisions so far

- [Destination: what is this map finding its way to?](tickets/001-destination-and-planning-mode.md) — a validated v1 spec + implementation-ready tickets; implementation is a follow-on effort.
- [Platform targets](tickets/002-platform-targets.md) — mobile is the must-have and the reason Obsen exists; browser-safe JS only, everywhere Obsidian runs.
- [Sync scope v1](tickets/003-sync-scope-v1.md) — whole vault ↔ one remote folder; the documented end goal is selective sync of *remote* subfolders (remote = the canonical full vault, each device materializes a chosen slice; `.obsidian/` always syncs), not designed now.
- [.obsidian handling](tickets/004-dot-obsidian-handling.md) — synced, with built-in exclusions (workspace files, Obsen's own data, caches).
- [Sync triggers](tickets/005-sync-triggers.md) — reconcile on startup + foreground-resume as the correctness backstop; live vault events, socket-driven remote pull, manual command; no periodic interval.
- [Conflict semantics](tickets/006-conflict-semantics.md) — 3-way auto-merge for text against the last-synced ancestor; conflict copies for overlaps/binaries/no-ancestor; every conflict copy logged as a wikilink row in `conflicts.md` at vault root, opened in Obsidian on creation so conflicts are never silent.
- [Deletion semantics](tickets/007-deletion-semantics.md) — state-based detection; edit beats delete; soft-delete to trash on both sides, never permanent.
- [Rename/move semantics](tickets/008-rename-move-semantics.md) — 1:1 via rename events live; exact-hash pairing at reconcile; delete+create fallback.
- [Auth and credential storage](tickets/009-auth-and-credential-storage.md) — settings-form login (email/password/2FA); SDK auth config in local-only plugin data; at-rest risk documented.
- [Engine coexistence topology](tickets/010-engine-coexistence-topology.md) — different engines on different devices supported; two engines on one device unsupported (warning only).
- [First-link bootstrap](tickets/011-first-link-bootstrap.md) — hash-identical pairs silently; same-path-different-content → conflict copy; one-sided → copy over; nothing overwritten or deleted.
- [Scale envelope and distribution](tickets/012-scale-envelope-and-distribution.md) — thousands of Markdown files, ≤1 GB; community-directory standards from day one, BRAT delivery, directory submission post-v1.
- [Testability architecture](tickets/013-testability-architecture.md) — pure-TS engine behind VaultPort/RemotePort, headless vitest with fakes; browser-only bundle as the mobile-safety gate.
- [SDK-in-Obsidian feasibility](tickets/014-research-sdk-in-obsidian-feasibility.md) — verdict: SDK with patches; browser build bundles with build-time shims only (exact esbuild recipe in [the research doc](research/014-sdk-in-obsidian-feasibility.md)); all needed surfaces browser-pathed; 1.2 MB minified; AGPL-3.0 spawns [Choose Obsen's license](tickets/024-choose-license.md).
- [Ancestor source](tickets/015-research-ancestor-source.md) — local shadow store (text only, content-addressed by `lastSyncedHash`, deflate-compressed with feature-detect); Filen versioning rejected on retention grounds (100-cap, quota-counted, dies with parent file), not API surface; no hybrid in v1; `remoteUuid` recorded anyway, keeping a post-v1 versioning fallback open.
- [Filen socket events](tickets/016-research-filen-socket-events.md) — works in the browser build (native WebSocket, zero extra shims) but is trigger-never-ledger: no delivery guarantees, known event gaps in 0.4.2, E2EE UUID-centric payloads, self-echo with no originator field; reconcile stays mandatory; full findings in [the research doc](research/016-filen-socket-events.md).
- [Plugin guidelines and BRAT](tickets/017-research-plugin-guidelines-and-brat.md) — nothing blocks a sync plugin (network/account/payment all allowed with README disclosure); compliance is lintable via `eslint-plugin-obsidianmd`; BRAT installs from release assets (tag == manifest version, no `v` prefix), works on mobile; SecretStorage finding spawned [Adopt SecretStorage?](tickets/025-adopt-secretstorage-for-credentials.md); checklist in [the research doc](research/017-plugin-guidelines-and-brat.md).
- [Agent test harness](tickets/018-research-agent-test-harness.md) — layered stack: engine vitest + fakes → browser-bundle gate → wdio-obsidian-service (real sandboxed Obsidian; Xvfb+WM on Linux CI; `emulateMobile` for UI paths; Android APK via Appium) → real-remote Filen vitest suite mirroring Filen's own CI (dedicated test account, 2FA off, per-run subfolder isolation) → manual on-device checklist (iOS has no automated path); full findings in [the research doc](research/018-agent-test-harness.md).

## Frontier / open tickets

Found by query, not listed here — open tickets in `docs/tickets/` with all blockers closed and no assignee. All research tickets are resolved; [019 on-device spike](tickets/019-prototype-on-device-spike.md), [020 sync-state schema](tickets/020-design-sync-state-schema.md), [024 choose license](tickets/024-choose-license.md), and [025 adopt SecretStorage?](tickets/025-adopt-secretstorage-for-credentials.md) are all unblocked and parallelizable; [022 settings/onboarding UX](tickets/022-design-settings-onboarding-ux.md) now waits on 025.

## Not yet specified

- **Exact `.obsidian/` exclusion list** — the concrete file list beyond the agreed categories; settle during the sync-state/spec work.
- **Conflict-copy naming convention** — timestamp + device name format; and where "device name" comes from (user-set setting?).
- **Error-retry and offline policy details** — beyond "reconcile converges"; backoff, quota-full behavior, auth-expiry re-prompt flow. Sharpens inside the engine-algorithm and UX design tickets.
- **Sync status / activity UI specifics** — status-bar states, log format. Sharpens inside the UX design ticket.
- **`conflicts.md` exact format and lifecycle** — table layout is decided; dedup of rows, behavior when the file itself conflicts, whether resolved rows are ever auto-pruned.
- **Plugin display name** — manifest rules ban "Obsidian" and variations ("Obsi-"/"-sidian"); "Obsen" is neither literally but is Obsidian-evocative, and acceptance is reviewer discretion at directory submission. Not a beta blocker (names can change post-publication); settle in the spec ([017 research](research/017-plugin-guidelines-and-brat.md)).

## Out of scope

- **Implementation of the plugin** — the destination is the spec; building it is the follow-on effort seeded by [023](tickets/023-write-v1-spec.md).
- **Per-subfolder selective sync design** — documented end goal only; v1 decisions must not block it ([003](tickets/003-sync-scope-v1.md)).
- **Interactive merge UI** — conflict copies + `conflicts.md` cover v1; a merge UI is a documented later goal.
- **Background sync on mobile** — OS-impossible for a plugin; sync happens while the app is open.
- **Same-device dual-engine support** — explicitly unsupported topology ([010](tickets/010-engine-coexistence-topology.md)).
- **Community directory submission** — post-v1; v1 only *complies* with its standards.
