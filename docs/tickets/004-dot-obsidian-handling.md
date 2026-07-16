---
id: 4
title: "How is the hidden .obsidian/ folder handled?"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

Is `.obsidian/` synced, excluded, or partially synced in v1?

## Resolution

**Synced by default, with a built-in exclusion list.** The goal is "my settings and plugins follow me across devices" without conflict churn or state corruption.

Excluded from sync:

- `workspace.json` / `workspace-mobile.json` (churns on every pane interaction; no sync value)
- Obsen's own plugin data file (contains Filen auth config and per-device sync state — must stay device-local; see [009](009-auth-and-credential-storage.md))
- Cache files

The exact, exhaustive exclusion list is a spec-writing detail (see the map's Not yet specified section).
