---
id: 16
title: "Research: Filen socket events — types, payloads, reliability"
labels: [wayfinder:research]
status: open
assignee:
blocked_by: []
---

## Question

The trigger model ([005](005-sync-triggers.md)) uses the SDK's socket module for live remote→local sync, with reconcile as the correctness backstop. What exactly does the socket deliver?

- Which event types exist (file upload/rename/move/trash/restore, dir events)? What are the payloads — do they carry enough (paths/UUIDs/metadata) to apply a change directly, or only enough to know *something* changed (triggering a targeted re-scan)?
- Are event payloads encrypted (names/metadata needing master-key decryption client-side)?
- Does the socket work in the browser build (websocket transport, no Node `net`)?
- Connection lifecycle: auth handshake, reconnection behavior, and what guarantees exist (none expected — confirm events are best-effort so reconcile-on-resume remains mandatory).
- Do our *own* writes echo back as events (self-echo suppression needed in the engine)?

Output: a markdown summary in `docs/research/` feeding the sync-engine algorithm design ([021](021-design-sync-engine-algorithm.md)).
