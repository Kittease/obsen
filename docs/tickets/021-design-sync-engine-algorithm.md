---
id: 21
title: "Design: sync engine algorithm — reconcile, ordering, atomicity, recovery"
labels: [wayfinder:grilling]
status: open
assignee:
blocked_by: [16, 19, 20]
---

## Question

The core design session. Specify the engine that implements the locked semantics ([005](005-sync-triggers.md), [006](006-conflict-semantics.md), [007](007-deletion-semantics.md), [008](008-rename-move-semantics.md), [011](011-first-link-bootstrap.md)) on top of the sync-state schema ([020](020-design-sync-state-schema.md)):

- The reconcile algorithm: three-way diff of (last-synced state, local scan, remote listing) → operation plan; operation ordering (folders before files, deletes last?); concurrency limits for transfers.
- Serialization: reconcile vs live events vs socket events running concurrently — single sync queue? What happens when a vault event fires mid-reconcile?
- Self-echo suppression: our own remote writes coming back via socket; our own local writes (downloads) firing vault events.
- Crash/offline recovery: partial sync interrupted (app killed mid-transfer, network drop) — how does the next reconcile converge? Retry policy for transient errors.
- Case-sensitivity and path normalization across platforms (APFS/NTFS case-insensitive vs Filen), filename constraints.
- Port interfaces (`VaultPort`, `RemotePort` — [013](013-testability-architecture.md)) finalized as TypeScript signatures.

## Resolution

_(pending)_
