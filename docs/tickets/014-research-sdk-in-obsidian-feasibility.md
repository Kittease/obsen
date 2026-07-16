---
id: 14
title: "Research: can @filen/sdk's browser build run inside an Obsidian plugin?"
labels: [wayfinder:research]
status: open
assignee:
blocked_by: []
---

## Question

The riskiest unknown on the map. Can `@filen/sdk` (browser build, `dist/browser/index.js`) be bundled into a mobile-safe Obsidian plugin — and if not, what's the fallback?

To answer:

- Bundle the SDK's browser entry with `esbuild --platform=browser` into an Obsidian plugin shell. Which dependencies break? (Known Node-only deps in the tree: `fs-extra`, `agentkeepalive`; axios needs its browser adapter; check crypto — WebCrypto vs `node-forge`/`crypto-js` paths in the browser build.)
- Which SDK surfaces does Obsen actually need, and do they work in the browser build: login/auth-config export, dir listing, file upload/download (streaming vs in-memory at our ≤1 GB envelope), move/rename, trash, file versioning API, socket module?
- Bundle size and plugin load-time impact (Obsidian loads plugin `main.js` synchronously).
- If the SDK is unusable: assess fallback — calling Filen's HTTP API v3 directly with our own thin client (the SDK source documents the endpoints and the E2EE crypto scheme).

Output: a markdown summary in `docs/research/` with a verdict (SDK as-is / SDK with patches / thin custom client) and the list of workable API surfaces. Desktop-Electron verification can be done AFK; final on-device mobile confirmation belongs to the prototype ticket ([019](019-prototype-on-device-spike.md)).
