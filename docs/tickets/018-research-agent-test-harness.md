---
id: 18
title: "Research: integration test harness for desktop and mobile-emulated paths"
labels: [wayfinder:research]
status: open
assignee:
blocked_by: []
---

## Question

The testability architecture ([013](013-testability-architecture.md)) covers the engine with headless vitest + fakes. Above that layer, an implementing agent needs an **integration harness** it can run in a sandbox. What does it look like?

- **Real Obsidian in CI:** evaluate `wdio-obsidian-service` (WebdriverIO service that downloads and drives real Obsidian desktop) — can an agent run it locally/headlessly? Can it install the plugin under test, create/modify vault files, and assert on plugin behavior?
- **Mobile emulation fidelity:** Obsidian desktop has an emulate-mobile mode (`this.app.emulateMobile(true)`). What does it actually change (Platform flags, UI) vs. NOT change (Node APIs remain available in Electron — the browser-only bundle gate from 013 covers that instead)? Is wdio-obsidian-service's mobile-emulation support usable? What residual risk does emulation leave that only real iOS/Android reveals?
- **Real-remote integration tests:** a dedicated free Filen test account + a dedicated test folder, exercised from plain Node/vitest against the real API (login, upload, download, move, trash, versions, socket). What are rate-limit/free-tier constraints? How do tests isolate and clean up (per-run subfolder)?
- What remains **HITL on-device only**, to be written up as a manual test checklist in the spec.

Output: a markdown summary in `docs/research/` recommending the harness stack; the spec's testing-strategy section builds on it.
