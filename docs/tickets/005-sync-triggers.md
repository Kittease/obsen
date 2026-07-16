---
id: 5
title: "When does a sync run?"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

What triggers a sync: manual, on-startup, periodic interval, live-on-change, server push?

## Resolution

Four triggers, one correctness principle: **reconcile is the source of truth; events only make syncs happen sooner.**

- **Reconcile on startup and on foreground-resume** — the correctness backstop. Resume is detected via the standard Page Visibility API (`visibilitychange`, plus `window` focus on desktop); there is no first-class Obsidian event for it. Mobile OSes suspend the app and kill the socket, so events fired while suspended are lost — resume-reconcile is what catches up.
- **Live local→remote** — debounced push on Obsidian `vault.on('modify'/'create'/'delete'/'rename')` events.
- **Live remote→local** — the Filen SDK has a socket module (verified in the 0.4.2 tarball, browser build included); apply remote change events as they arrive while the app is open. Socket reliability/semantics is a frontier research ticket.
- **Manual "Sync now" command** — escape hatch and reassurance button.

**No periodic interval** — dropped entirely (user decision).

Context: user works on one device at a time ~99% of the time, so live sync's conflict exposure is low.
