---
id: 18
title: "Research: integration test harness for desktop and mobile-emulated paths"
labels: [wayfinder:research]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

The testability architecture ([013](013-testability-architecture.md)) covers the engine with headless vitest + fakes. Above that layer, an implementing agent needs an **integration harness** it can run in a sandbox. What does it look like?

- **Real Obsidian in CI:** evaluate `wdio-obsidian-service` (WebdriverIO service that downloads and drives real Obsidian desktop) — can an agent run it locally/headlessly? Can it install the plugin under test, create/modify vault files, and assert on plugin behavior?
- **Mobile emulation fidelity:** Obsidian desktop has an emulate-mobile mode (`this.app.emulateMobile(true)`). What does it actually change (Platform flags, UI) vs. NOT change (Node APIs remain available in Electron — the browser-only bundle gate from 013 covers that instead)? Is wdio-obsidian-service's mobile-emulation support usable? What residual risk does emulation leave that only real iOS/Android reveals?
- **Real-remote integration tests:** a dedicated free Filen test account + a dedicated test folder, exercised from plain Node/vitest against the real API (login, upload, download, move, trash, versions, socket). What are rate-limit/free-tier constraints? How do tests isolate and clean up (per-run subfolder)?
- What remains **HITL on-device only**, to be written up as a manual test checklist in the spec.

Output: a markdown summary in `docs/research/` recommending the harness stack; the spec's testing-strategy section builds on it.

## Resolution

Full findings in [the research doc](../research/018-agent-test-harness.md). **All four layers exist and are agent-runnable except the last (real-device HITL).**

- **wdio-obsidian-service — adopted.** Drives real, sandboxed Obsidian desktop (temp vault copy + isolated config dir, auto-cleaned). No true headless (Electron), but its own CI runs Linux under Xvfb + a window manager (`herbstluftwm` — required for some Obsidian features); macOS/Windows runners go windowed; an agent runs it locally unattended. Installs the plugin under test via `plugins: ["."]`; two vault-reset speeds (`reloadObsidian` full / `obsidianPage.resetVault()` fast in-place). Tests reach *inside* Obsidian: `browser.executeObsidian(({app, obsidian, plugins}) => …)` exposes the live plugin instance; `obsidianPage` has read/write/mkdir/delete/enablePlugin helpers; `executeObsidianCommand` runs any command. Version matrix pins app + installer independently (`earliest` = manifest `minAppVersion`, `latest`); downloads cached with a proven `actions/cache` recipe. Companion `obsidian-launcher` adds a hot-reload `watch` CLI and downloads the Obsidian APK.
- **Mobile emulation — useful for UI paths only.** `this.app.emulateMobile(true)` just sets localStorage `EmulateMobile=1`: it flips the UI-mode flags (`Platform.isMobile`) but not the app flags (`isMobileApp`) — Node/Electron APIs stay available, so it cannot catch Node-API leaks; the 013 browser-only bundle gate remains the mechanical catch. wdio supports `emulateMobile: true` as a capability, plus real Obsidian **APK on an Android emulator via Appium** (working GitHub Actions job in the sample template). No automated iOS path exists.
- **Real-remote Filen — mirror Filen's own practice.** `filen-sdk-ts` and `filen-cli` run vitest against the production API on every push, auth via email/password GitHub secrets. SDK login sends a `"XXXXXX"` 2FA placeholder — **2FA must be off** on the dedicated test account. Free tier is 10 GB (ample); signup is network-classified, so create the account from a consumer connection, not CI. No documented rate limits; the SDK self-limits (32 concurrent API requests; 8 uploads/16 downloads). Isolation: per-run `run-<timestamp>-<random>` subfolder, teardown trash, stale-run sweep at suite start, `emptyTrash()`.
- **HITL on-device checklist (goes in the spec):** first-run login UX, backgrounding mid-sync/foreground-resume reconcile, offline transitions, large-vault device performance, everything iOS, battery/network budget, conflict UX on small screens.

**Recommended stack (layered):** 1. engine vitest + fakes (agent sandbox, every change) → 2. browser-bundle gate (same) → 3. wdio integration, matrix {earliest, latest} × {desktop, emulateMobile}, mostly against a fake RemotePort + one real-E2E smoke spec (agent locally; CI ubuntu/Xvfb) → 4. real-remote Filen vitest suite, env-gated creds (skipped on fork PRs) → 5. optional Android-APK Appium job (CI nightly) → 6. manual on-device checklist (HITL, per release).
