---
id: 25
title: "Adopt Obsidian's SecretStorage for Filen credentials?"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

The [plugin-guidelines research](../research/017-plugin-guidelines-and-brat.md) found that Obsidian ships a first-party secrets API — `SecretStorage` + `SecretComponent`, since Obsidian 1.11.4 — which is the documented fix for exactly the plaintext-credentials-in-`data.json` risk that [009](009-auth-and-credential-storage.md) accepted on the premise that "Obsidian has no secure-storage API". That premise no longer holds.

Decide:

- Does Obsen store the SDK auth config (API key + master keys) in `SecretStorage` instead of (or alongside) local plugin data?
- What does that imply for `minAppVersion` (candidate: 1.11.4) — is requiring a recent Obsidian acceptable for v1?
- Does the settings login form use `SecretComponent`?
- What remains of 009's documented at-rest-risk wording once this is decided?

The answer feeds the settings/onboarding UX design ([022](022-design-settings-onboarding-ux.md), blocked on this) and updates the credential-storage section of the spec ([023](023-write-v1-spec.md)).

## Resolution

**Yes — SecretStorage only.** The SDK auth config (API key + master keys) is stored via `app.secretStorage.setSecret()` under a namespaced id (e.g. `obsen:filen-auth`; exact id is spec detail), with **no copy in `data.json`**.

Grounding fact (primary sources: [Store secrets guide](https://docs.obsidian.md/Plugins/Guides/Store+secrets), [SecretStorage API](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage)): SecretStorage is **localStorage-backed, vault-scoped, with no documented encryption at rest** — not an OS keychain. What it buys is therefore not disk-level secrecy but **removal of the vault-tree leak class**: credentials leave `.obsidian/plugins/obsen/data.json`, so no vault sync/backup tool (git, iCloud, Syncthing, Obsidian Sync) can ever ship the master keys off-device. 004's exclusion list only protects against Obsen syncing the file; SecretStorage protects against everything that walks the vault. Failure mode is graceful: localStorage eviction (rare, mostly iOS) → secret missing → re-prompt login.

Decisions:

1. **Storage:** SecretStorage only, no `data.json` copy or fallback — a "backup" copy would re-open the leak class and defeat the point.
2. **`minAppVersion: 1.11.4`, hard floor, no feature-detect fallback.** A fallback means maintaining a second (plaintext) credential path for the least-secure users, plus migration code. Current BRAT (2.2.0) itself requires 1.11.4, so every possible beta installer already meets the floor; the installer enforces it cleanly for stragglers.
3. **No `SecretComponent`.** It targets paste-a-long-lived-key plugins: it *stores what the user types*. Wiring it to Obsen's password field would persist the raw password — strictly worse than [009](009-auth-and-credential-storage.md). The login form keeps 009's transient email/password/2FA inputs; after successful SDK login, Obsen writes the *derived* auth config programmatically. Settings UI thereafter shows logged-in state, never the secret (screen design → [022](022-design-settings-onboarding-ux.md)).
4. **009's at-rest wording is superseded** (009 stays closed as history). New README credential statement: *where* — "credentials are stored in Obsidian's SecretStorage, scoped to this vault, outside the vault folder; they are never written to any file that vault syncs or backups can pick up, and never leave the device"; *residual risk, stated honestly* — "SecretStorage is not documented as encrypted at rest; someone with access to your device or its disk may be able to extract the keys — protect the device, and consider enabling 2FA on your Filen account." The dead "Obsidian has no secure-storage API" premise and the "every comparable plugin makes the same trade" apology are dropped.

Feeds [022](022-design-settings-onboarding-ux.md) (now unblocked) and the credential-storage section of the spec ([023](023-write-v1-spec.md)).
