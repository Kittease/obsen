---
id: 12
title: "Scale envelope and distribution channel"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

What vault scale must the engine be specced for, and how does Obsen get onto devices (especially iOS)?

## Resolution

**Scale envelope (explicit in the spec; bigger vaults are a known non-goal for v1):**

- a few hundred to a few thousand Markdown files, plus small side files
- total vault size ~50 MB to ~1 GB max

Consequences: full reconcile scans stay in "seconds" territory; the Filen SDK's built-in 1 MB chunking covers transfers; no special resumable-upload work needed.

**Distribution:**

- Built to **Obsidian community-plugin-directory standards from day one** (mobile-safe APIs, `isDesktopOnly: false`, proper manifest, public GitHub repo with releases) — this mostly overlaps with constraints already locked in [002](002-platform-targets.md).
- **Delivered via BRAT** (Beta Reviewers Auto-update Tool) while maturing — works on mobile today, no review queue.
- **Community directory submission is a post-v1 goal.**
