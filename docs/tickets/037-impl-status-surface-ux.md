---
id: 37
title: "Status surface UX: ribbon, status bar, notices, attention-state flows"
labels: [impl, afk]
status: open
assignee:
blocked_by: [31, 34, 36]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §8.5, §8.6 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

Present the Status Surface: ribbon icon on both platforms (animated while syncing, badge/color for Attention States, click = manual sync, pinnable to the mobile toolbar); desktop-only status-bar item with short progress text; settings-tab status block (current state, last successful sync, last-run summary, error detail + recovery actions). Implement the notices policy exactly as the §8.6 table — silent by default, one notice per attention-state entry, never per retry, clicks open settings. Attention-state recovery flows in settings: `auth-error` → login form with prefilled email, Sync State kept; `quota` → callout + filen.io link, self-clearing; `frozen` → protective explanation with "Check again" and "Unlink…" actions, no folder recreation.

## Acceptance criteria

- [ ] wdio {desktop, emulateMobile}: ribbon reflects each engine state; status-bar item exists on desktop only, nothing critical lost on mobile
- [ ] Notice policy verified: clean automatic runs are silent; entering offline is silent; quota/auth-error/frozen notice exactly once per entry
- [ ] auth-error re-login resumes sync without Re-Bootstrap
- [ ] "Check again" thaws a frozen link after the folder is restored from Filen trash
- [ ] Settings tab renders the linked-state machine correctly across logged-out/unlinked/linked/attention states

## Blocked by

- [031](031-impl-folder-picker-and-first-link.md), [034](034-impl-trigger-wiring.md), [036](036-impl-engine-resilience.md)
