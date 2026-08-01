---
id: 30
title: "Login, SecretStorage credentials, logged-in/out settings states"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [28, 29]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §8.1, §8.2 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

End-to-end auth: the settings tab's logged-out state (email, masked password with eye toggle, "My account has 2FA" switch revealing a plain code field, the no-dead-end re-submit when the SDK answers 2FA-required), SDK login, and programmatic persistence of the derived Auth Config to SecretStorage under `obsen:filen-auth` — no `data.json` copy, no `SecretComponent`, nothing user-typed persisted. Startup auth restore in `onLayoutReady` (missing/evicted secret → logged-out state, no crash). Logout clears SecretStorage, drops the SDK client, warns when a folder is linked, keeps Sync State. Settings tab shows "Logged in as \<email\>" + Logout when authed.

## Acceptance criteria

- [x] Login against the test account succeeds from the settings form; Auth Config lands in SecretStorage only (assert `data.json` never contains keys)
- [x] App restart restores the session without re-prompt (wdio: reloadObsidian)
- [x] 2FA-required answer flips the switch and lets the user re-submit without losing input
- [x] Logout clears the secret, keeps Sync State, and warns if linked
- [x] Missing/evicted secret degrades to the logged-out state gracefully

## Blocked by

- [028](028-impl-filen-remoteport-adapter.md), [029](029-impl-obsidian-adapters-and-wdio.md)

## Resolution

Auth works end to end: `npm run verify` is green (lint → typecheck ×2 → 429 unit tests → 15
bundle-gate tests), `npm run test:wdio` passes 12 new assertions per capability across
{1.11.4, 1.13.4} × {desktop, `emulateMobile`}, and `npm run test:remote` logs into the real
test account and rebuilds a working client from the stored Auth Config alone.

**Three collaborators, one rule each.** `src/filen/auth.ts` owns the SDK: it runs the login and
builds the **Auth Config field by field** rather than copying `sdk.config` — the SDK leaves
`password: "redacted"` and `twoFactorCode: "redacted"` on that object, and picking fields is the
only spelling where a field a later SDK adds cannot ride along into storage. `src/obsidian/
secrets.ts` owns `SecretStorage` and knows nothing about what the secret contains.
`src/session.ts` owns the state machine (restore / log in / log out) and imports no `obsidian`,
which is what lets the whole matrix be tested in milliseconds against fakes. The settings tab
renders `Session`'s state and keeps none of its own.

**Five things about `SecretStorage` that the published API does not say**, all read out of the
shipped 1.11.4 and 1.13.4 bundles and then pinned by a test:

1. **`setSecret` validates the id** — `/^[a-z0-9-]+$/`, 64 chars — and throws otherwise, so the
   spec's `obsen:filen-auth` is not a legal id. The implementation uses `obsen-filen-auth`;
   [spec §8.1 is corrected](../specs/obsen-v1.md), and a wdio assertion holds Obsidian to both
   halves of the finding.
2. **`deleteSecret` exists** in both versions and is in no `.d.ts`. Logging out must actually
   remove the secret, so the slice declares it optional and falls back to writing `""` — which
   `read()` treats as absent everywhere, so the two spellings of "cleared" cannot diverge.
3. **1.13 loads secrets asynchronously** behind a per-platform secure-storage adapter, so
   `onLayoutReady` can genuinely run first. This showed up as an *intermittently* failing
   restore — the worst possible way to ask a user for a password they already gave. The plugin
   now retries the restore on the store's `changed` event, feature-tested because 1.11.4 reads
   local storage synchronously and is not an `Events` at all.
4. **1.13 can have no adapter**, in which case `setSecret` throws *"Secure storage is not
   available."*. A login that works and cannot be saved is a real state: `logIn` resolves
   `{persisted: false}` and the tab says so in a Notice, rather than either failing a good login
   or losing it silently at the next restart.
5. **1.13's `setWarning()` is `setDestructive().setCta()`**, and the destructive class was
   renamed (`mod-warning` → `mod-destructive`). The confirm modal adds both classes: the typed
   method is deprecated and its replacement is a `TypeError` at the 1.11.4 floor.

**One SDK finding with teeth.** `FilenSDK.init()` does not clear a session — it *replaces* the
config with Filen's anonymous one, which is **complete**: every field a real session has, each
holding the string `"anonymous"`. So a validator asking "are the fields present" calls a
logged-out client logged in; `authConfigOf` rejects the sentinel outright. `init()` also leaves
`hmacKey` alone, and it is derived from the private key and cached forever — logging into a
second account would inherit the first one's key — so `dropFilenAuth` nulls it explicitly. The
SDK instance itself is kept across a logout rather than replaced, so everything already holding
a reference stays valid.

**Where each acceptance criterion is actually proved.** "Login from the settings form" is split
across two layers on purpose: layer 3 clicks the real button in real Obsidian and follows the
whole path — button → `Session.logIn` → failure → message under the form → button usable again
— submitting an empty form, because that is the one failure `filenLogin` produces *without*
contacting Filen and the wdio suite is deliberately network-free. Layer 4
(`tests/remote/auth.test.ts`) proves the call that path makes works against the real account,
including that a wrong password classifies as `credentials-rejected` rather than as a mystery,
which is the one branch the form's wording depends on. The 2FA reveal is decided in
`src/ui/login-feedback.ts`, a pure function, so the no-dead-end rule is a unit test rather than
a DOM interaction; the wdio suite separately proves the switch redraws the form **from the
draft**, so nothing typed is lost. Logging out of a *linked* vault is driven end to end at layer
3 too — warning modal, Cancel keeps the session and the secret, confirm clears both and leaves
the link alone.

**Three deliberate judgement calls.** A secret Obsen cannot parse is *kept*, not deleted: being
unreadable is not the same as being worthless, and a downgrade must not destroy what a newer
version wrote — the next successful login overwrites it anyway. The password lives only in the
tab's draft, which `hide()` empties, so it does not outlive the form it was typed into — and a
login still in flight when settings close writes nothing back, so the next visit is a clean form
rather than a stale failure. And the repo-wide privacy scan (`tests/unit/privacy.test.ts`) gained
one exemption: addresses on the domains RFC 2606 and RFC 6761 *reserve* for documentation and
testing, which a login placeholder and a fake account both need and neither of which can belong
to a person. The scan keeps a positive control proving the hole is a hole and not a floor.

**Left for the tickets that own them.** `data.json` gains only `link: { folderUuid } | null` —
the UUID is what a link *is* (spec §8.3), and answering "is a folder linked?" is all the logout
warning needs; ticket [031](031-impl-folder-picker-and-first-link.md) owns the link itself and
whatever else it must remember, and its folder picker is the first real user of
`baseFolderUUID`. The `auth-error` recovery flow (login form reappearing with the email
prefilled) is ticket [037](037-impl-status-surface-ux.md)'s, and `Session` is already
re-loginnable in place for it. Nothing here connects the socket: `passwordChanged` ⇒
`auth-error` is ticket [035](035-impl-socket-live-remote.md).
