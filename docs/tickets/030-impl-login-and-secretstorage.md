---
id: 30
title: "Login, SecretStorage credentials, logged-in/out settings states"
labels: [impl, afk]
status: open
assignee:
blocked_by: [28, 29]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §8.1, §8.2 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

End-to-end auth: the settings tab's logged-out state (email, masked password with eye toggle, "My account has 2FA" switch revealing a plain code field, the no-dead-end re-submit when the SDK answers 2FA-required), SDK login, and programmatic persistence of the derived Auth Config to SecretStorage under `obsen:filen-auth` — no `data.json` copy, no `SecretComponent`, nothing user-typed persisted. Startup auth restore in `onLayoutReady` (missing/evicted secret → logged-out state, no crash). Logout clears SecretStorage, drops the SDK client, warns when a folder is linked, keeps Sync State. Settings tab shows "Logged in as \<email\>" + Logout when authed.

## Acceptance criteria

- [ ] Login against the test account succeeds from the settings form; Auth Config lands in SecretStorage only (assert `data.json` never contains keys)
- [ ] App restart restores the session without re-prompt (wdio: reloadObsidian)
- [ ] 2FA-required answer flips the switch and lets the user re-submit without losing input
- [ ] Logout clears the secret, keeps Sync State, and warns if linked
- [ ] Missing/evicted secret degrades to the logged-out state gracefully

## Blocked by

- [028](028-impl-filen-remoteport-adapter.md), [029](029-impl-obsidian-adapters-and-wdio.md)
