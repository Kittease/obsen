---
id: 19
title: "Prototype: on-device spike — login, list, round-trip a file from Obsidian mobile"
labels: [wayfinder:prototype]
status: open
assignee: camercey@gmail.com
blocked_by: [14]
---

## Question

Does the chosen Filen client approach (per [014](014-research-sdk-in-obsidian-feasibility.md)) actually work on a real phone? Build a throwaway plugin that proves the riskiest path end-to-end:

- log in with email/password/2FA from the settings tab and persist the auth config
- list the contents of a remote folder
- upload one file from the vault, download one file into the vault
- verify foreground-resume detection fires (`visibilitychange`) on iOS and/or Android
- note memory/CPU behavior during E2EE transfer of a representative file

HITL: the user installs the spike via BRAT on their phone and reports results. The spike's code is a linked asset (throwaway branch or `prototypes/` folder), not production code.

## Assets

- Spike plugin: [`prototypes/019-on-device-spike/`](../../prototypes/019-on-device-spike/) — bundles `@filen/sdk@0.4.2` with the exact esbuild recipe from the [014 research](../research/014-sdk-in-obsidian-feasibility.md); 1.2 MB minified (matches the research measurement); Node load-smoke passes.
- BRAT release: tag `0.0.1-spike.1` on this repo (assets `main.js` + `manifest.json`).

## HITL test protocol

Use a **test vault** and preferably the dedicated Filen test account. Results accumulate in `obsen-spike-log.md` at the vault root — paste that note back to resolve this ticket.

1. **Install**: BRAT (from the community directory) → *Add beta plugin* → `Kittease/obsen` → release `0.0.1-spike.1` → enable **Obsen Spike**. Confirm the plugin loads (a line appears in `obsen-spike-log.md`, with load-time platform label).
2. **Login**: settings → Obsen Spike → email/password (+2FA if set) → *Log in*. Expect `login OK in <n> ms`. Kill and reopen the app: the log should say `auth restored from data.json`.
3. **Run spike** (command palette or settings button): expect list of remote root, upload + download of `obsen-spike-upload.md`, `content MATCHES ✅`, and `obsen-spike-download.md` appearing in the vault.
4. **Foreground-resume**: background Obsidian (home screen / app switcher), wait ~10 s, return. Expect a `visibilitychange → hidden` then `→ visible` pair in the log (and Notices). Repeat with the screen locked.
5. **Transfer test** (command or button): 8 MiB random round-trip. Note the up/down timings and any `heap` readings (Android logs heap; iOS shows `heap n/a`) — and whether the app stutters, gets killed, or heats up.
6. Report: paste `obsen-spike-log.md`, plus device model/OS and anything odd (CORS errors, crashes, UI freezes).

## Resolution

_(pending — awaiting on-device results)_
