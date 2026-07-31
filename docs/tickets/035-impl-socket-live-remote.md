---
id: 35
title: "Socket-driven live remote sync"
labels: [impl, afk]
status: open
assignee:
blocked_by: [28, 34]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §7, §5.6 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

`RemotePort.watch` over `sdk.socket`: connect with the apiKey after login (`connectToSocket` stays off), subscribe to the v1 event set, decrypt payload metadata and resolve UUID→path via the port's index, emit `{change, path}` or `{unresolved}` (→ engine escalates to FULL). Handle the verified 0.4.2 quirks: always attach an `"error"` listener, re-drive `connect()` after `authFailed` + re-auth, never consult `isAuthenticated()`, treat `disconnected → connected` as a FULL trigger, `passwordChanged` → `auth-error`. The remote Own-Writes UUID set (TTL 60 s) suppresses self-echo re-scans; idempotent reconcile remains the guarantee.

## Acceptance criteria

- [ ] Real-remote test: a change made via a second SDK client appears in the vault while the plugin is open, without manual sync (generous timeout; no exact-count assertions — delivery is best-effort)
- [ ] An event with unknown UUID / undecryptable metadata escalates to a FULL Run, never dropped
- [ ] Own upload's echo triggers no transfer (UUID set), and a slipped echo costs at most one empty Run
- [ ] Socket error/reconnect churn never crashes the plugin; reconnect fires a FULL Run
- [ ] `passwordChanged` lands the engine in `auth-error`

## Blocked by

- [028](028-impl-filen-remoteport-adapter.md), [034](034-impl-trigger-wiring.md)
