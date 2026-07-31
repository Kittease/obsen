---
id: 29
title: "Obsidian VaultPort/StorePort adapters and wdio integration harness"
labels: [impl, afk]
status: open
assignee:
blocked_by: [26, 27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.1, §1.3, §2.1, §9 layer 3 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The production `VaultPort` over Obsidian's Vault API (atomic write via tmp+rename, `FileManager.trashFile()` for trash, NFC normalization at the boundary, `isWritablePath` platform name constraints, watch events carrying stats registered inside `onLayoutReady`) and `StorePort` (sync-state.json atomic write, shadow blob files under the plugin folder). The Exclusion List predicate from spec §2.1 is applied here at the scope boundary. Alongside: bootstrap the `wdio-obsidian-service` harness — plugin installed via `plugins: ["."]`, fixture vault, `resetVault()` between tests, Xvfb + window-manager recipe for Linux CI, Obsidian download caching — with a first spec that drives `VaultPort` inside real Obsidian.

## Acceptance criteria

- [ ] wdio spec: create/read/write/rename/trash a note through `VaultPort` inside real sandboxed Obsidian; watch events fire with stats; no events fire for vault-init `create` storm
- [ ] Exclusion List honored: workspace files, `plugins/obsen/` state files, `.trash/`, OS junk are invisible to `list()` and `watch`
- [ ] StorePort round-trips sync-state.json atomically and shadow blobs by hash
- [ ] wdio matrix runs {earliest, latest} × {desktop, emulateMobile} locally and in CI (ubuntu + Xvfb + WM, cached downloads)
- [ ] Paths returned NFC; case-sensitivity behavior matches spec §5.8

## Blocked by

- [026](026-impl-scaffold-and-build-gate.md), [027](027-impl-engine-core.md)
