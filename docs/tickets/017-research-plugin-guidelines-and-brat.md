---
id: 17
title: "Research: Obsidian community plugin guidelines and BRAT release mechanics"
labels: [wayfinder:research]
status: open
assignee:
blocked_by: []
---

## Question

Distribution is BRAT-first, directory-standards-from-day-one ([012](012-scale-envelope-and-distribution.md)). What exactly must the repo and code comply with?

- Obsidian's plugin review guidelines relevant to Obsen: mobile compatibility rules, network-use disclosure requirements (a sync plugin talks to a third-party service and stores credentials — what must the README/manifest declare?), forbidden APIs, `manifest.json`/`versions.json` requirements.
- BRAT mechanics: exact release-asset layout (`main.js`, `manifest.json`, `styles.css` on GitHub releases), versioning rules, beta-channel behavior on mobile.
- The standard scaffold worth adopting: obsidianmd sample-plugin structure, esbuild config, GitHub Actions release workflow.

Output: a markdown summary in `docs/research/` — a compliance checklist the spec ([023](023-write-v1-spec.md)) incorporates.
