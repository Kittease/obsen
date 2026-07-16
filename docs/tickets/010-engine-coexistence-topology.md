---
id: 10
title: "Coexistence with Filen's built-in desktop sync: supported topology"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

What happens when Filen's native desktop folder sync and Obsen operate on the same remote folder?

## Resolution

- **Supported and tested:** different engines on different devices (e.g. desktop uses Filen native sync, phone uses Obsen, same remote folder). From Obsen's viewpoint the other engine's writes are just remote changes — indistinguishable from edits in Filen's web app.
- **Explicitly unsupported:** two engines on the **same device and local folder** (Filen desktop app syncing the vault folder while Obsen runs inside Obsidian on it). Feedback loops and double conflict copies. Handled with documentation plus a settings-screen warning; automatic detection is not worth building.

Rule of thumb: **one sync engine per folder per device.**
