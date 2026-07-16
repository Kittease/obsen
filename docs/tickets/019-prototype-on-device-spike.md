---
id: 19
title: "Prototype: on-device spike — login, list, round-trip a file from Obsidian mobile"
labels: [wayfinder:prototype]
status: open
assignee:
blocked_by: [14]
---

## Question

Does the chosen Filen client approach (per [014](014-research-sdk-in-obsidian-feasibility.md)) actually work on a real phone? Build a throwaway plugin that proves the riskiest path end-to-end:

- log in with email/password/2FA from the settings tab and persist the auth config
- list the contents of a remote folder
- upload one file from the vault, download one file into the vault
- verify foreground-resume detection fires (`visibilitychange`) on iOS and/or Android
- note memory/CPU behavior during E2EE transfer of a representative file

HITL: the user installs the spike via BRAT on their phone and reports results. The spike's code is a linked asset (throwaway branch or `prototypes/` folder), not production code.

## Resolution

_(pending)_
