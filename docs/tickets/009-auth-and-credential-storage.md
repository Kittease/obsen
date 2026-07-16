---
id: 9
title: "Authentication and credential storage"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

How does the user log in to Filen, and where do credentials live?

## Resolution

- **Login UX:** a settings-tab form (email / password / optional TOTP 2FA code) runs the SDK login once. The raw password is never stored.
- **Persistence:** the SDK's exported auth config (API key + master keys) is stored in Obsen's local plugin data file, which is **excluded from sync** (per [004](004-dot-obsidian-handling.md)) — credentials never leave the device.
- **Accepted risk, documented in the README:** Obsidian has no secure-storage API; plugin data is plaintext on disk (inside the app sandbox on mobile). Anyone with local disk access can read the master keys. Re-prompting every launch is unusable on mobile; every comparable plugin makes the same trade.
