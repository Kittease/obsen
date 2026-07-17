---
id: 25
title: "Adopt Obsidian's SecretStorage for Filen credentials?"
labels: [wayfinder:grilling]
status: open
assignee:
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
