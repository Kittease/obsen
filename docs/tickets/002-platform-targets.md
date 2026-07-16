---
id: 2
title: "Platform targets: desktop-only or mobile too?"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

Must Obsen run on Obsidian mobile (iOS/Android), or is desktop-only acceptable for v1?

## Resolution

**Mobile is the must-have** — it is the reason Obsen exists. Desktop already has Filen's built-in folder sync; the gap is mobile, where no Filen sync exists. One plugin must run on every platform Obsidian runs on (Windows, macOS, Linux, Android, iOS).

Consequences:

- Browser-compatible JavaScript only. No Node.js APIs anywhere in the bundle (`manifest.json: isDesktopOnly: false`).
- All file access goes through Obsidian's vault adapter, never `fs`.
- Filen is E2EE — all crypto runs client-side, so mobile CPU/memory budgets matter.
- `@filen/sdk` ships a browser build (`"browser": "dist/browser/index.js"`, verified from the 0.4.2 tarball), which lowers the risk — but real bundling/on-device verification is a frontier research ticket.
