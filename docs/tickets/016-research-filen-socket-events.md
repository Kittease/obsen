---
id: 16
title: "Research: Filen socket events — types, payloads, reliability"
labels: [wayfinder:research]
status: closed
assignee: camercey@gmail.com
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

## Resolution

Full findings, all primary-sourced against the `@filen/sdk@0.4.2` tarball and Filen's own consumer repos: **[research/016-filen-socket-events.md](../research/016-filen-socket-events.md)**.

Answers to the five sub-questions:

1. **Event types:** 15 drive events reach a 0.4.2 listener (file new/rename/move/trash/restore/archived/archive-restored/deleted-permanent, folder sub-created/rename/move/trash/restore, plus `trashEmpty`, `passwordChanged`). **Caveat:** the backend emits at least 5 more that 0.4.2 silently drops — including `folder-deleted-permanent` and `file/folder-metadata-changed` (proven via the Rust SDK's wire-name table). The socket is a *known-incomplete* event source.
2. **Payloads:** UUID-centric. Creates/moves/restores are rich enough to apply directly *given a UUID→path index*; renames/trashes/deletes carry only UUIDs. All names/metadata arrive E2EE-encrypted and need `sdk.crypto().decrypt().fileMetadata/folderMetadata` (folder events hide encrypted metadata in a field named `name`).
3. **Browser build: yes.** Hand-rolled socket.io/EIO=3 client over the native `WebSocket` global; sole import is `events`, already shimmed by the 014 esbuild recipe. Zero additional shims.
4. **Lifecycle:** apiKey auth over hard-coded `wss://socket.filen.io`; 1 s→30 s backoff auto-reconnect; **zero delivery guarantees** (no acks/cursor/replay). Filen's own sync product ignores the socket entirely and polls `/v3/dir/tree` every 5 s; its next-gen mobile client refetches on every reconnect. **Reconcile-on-resume confirmed mandatory** — the [005](005-sync-triggers.md) trigger model is validated as-is.
5. **Self-echo: yes, assume it.** Filen's own code documents that the server echoes a client's own writes back; drive events carry **no originator field**, so suppression must be engine-side: idempotent apply against the sync index (mandatory anyway), optionally a recent-own-writes UUID set.

Key inputs handed to [021](021-design-sync-engine-algorithm.md) (detailed in the research doc's consequences section): treat the socket as **trigger, never ledger**; baseline reaction to any event is mark-dirty → debounced scoped reconcile, with direct-apply as a later optimization; `/v3/dir/tree` with a stable `deviceId` returns an empty diff when nothing changed, making socket-triggered rescans (or an optional low-frequency backstop poll, should 021 want one — [005](005-sync-triggers.md)'s no-periodic-interval decision stands) cheap; v1 subscribes to 14 named events and ignores the rest; three client quirks to design around (`isAuthenticated()` always false, `authFailed` kills reconnection until `connect()` is re-called, always attach an `"error"` listener or risk a crash). On-device webview socket behavior under app suspension remains unverified — that lands in the [019 spike](019-prototype-on-device-spike.md).
