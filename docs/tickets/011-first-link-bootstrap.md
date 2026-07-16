---
id: 11
title: "First link: connecting a vault to a non-empty remote folder"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

What happens on first connection, when there is no sync state and no ancestor — especially when both the vault and the remote folder already have content?

## Resolution

Nothing is ever overwritten or deleted during a first link. Three cases:

- **Remote empty, vault has content** → upload everything.
- **Vault empty, remote has content** → download everything (the phone-onboarding case: the vault already lives in Filen, put there by desktop native sync).
- **Both have content** → conservative pairing:
  - identical path + identical content hash → silently paired (already in sync)
  - same path, different content → **conflict copy** (no ancestor — never guess), logged to `conflicts.md` (per [006](006-conflict-semantics.md))
  - exists on one side only → copied to the other

Worst case is a few conflict copies to clean up by hand; data loss is impossible.
