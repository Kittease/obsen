---
id: 39
title: "Release engineering and first BRAT beta"
labels: [impl, afk]
status: open
assignee:
blocked_by: [30, 31, 32, 33, 35, 37, 38]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §10 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

Ship the beta channel: the official GH Actions release workflow (tag push → build → draft release with `main.js` + `manifest.json`, publish manually), `version-bump.mjs` flow, tag == release name == released-manifest version with no `v` prefix, betas as `X.Y.Z-beta.N`, root `manifest.json` never bumped during beta, `versions.json` discipline. Complete the README (all §10.3 disclosures, license section with `@filen/sdk` attribution, credential statement, dual-engine caveat, BRAT install instructions). Add the one real-E2E wdio smoke spec (real Obsidian + real test account, minimal) as the pre-release gate, and cut `0.1.0-beta.1` installable via BRAT on desktop and mobile. Optional follow-up, not blocking: the nightly Android-APK Appium job from the harness research.

## Acceptance criteria

- [ ] Tag push produces a draft release whose assets BRAT accepts; published beta installs via BRAT on desktop and Android
- [ ] Released manifest version == tag; root manifest still at pre-beta version
- [ ] README passes the §10.3 disclosure checklist; `eslint-plugin-obsidianmd` and the automated-review checklist items are green
- [ ] Real-E2E smoke spec (login → link → sync one note both ways) passes in CI with secrets, skipped without
- [ ] `versions.json` maps the beta to `minAppVersion 1.11.4`

## Blocked by

- [030](030-impl-login-and-secretstorage.md), [031](031-impl-folder-picker-and-first-link.md), [032](032-impl-deletes-renames-phases.md), [033](033-impl-conflicts-merge-shadow.md), [035](035-impl-socket-live-remote.md), [037](037-impl-status-surface-ux.md), [038](038-impl-activity-troubleshooting.md)
