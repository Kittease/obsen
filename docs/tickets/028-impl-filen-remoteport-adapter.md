---
id: 28
title: "Filen RemotePort adapter and real-remote test suite"
labels: [impl, afk]
status: open
assignee:
blocked_by: [26, 27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.2, §7, §9 layer 4 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The production `RemotePort` over `@filen/sdk`: full recursive listing (decrypted, NFC paths, `RemoteEntry` with uuid/size/optional sha512), download by UUID, upload via `cloud.uploadWebFile` (never the `fs.writeFile` facade), move/rename by UUID, soft-delete to Filen trash, folder create/move/trash, plus the parent-UUID session cache rebuilt from listings. Socket `watch` is a later slice — stub it. Alongside: the real-remote vitest suite mirroring Filen's own CI practice per spec §9: dedicated test account (2FA off), creds via env only, suite skipped when absent, per-run `/obsen-tests/run-<timestamp>-<random>` subfolder, stale-run sweep, teardown trash + `emptyTrash()`, single-thread, generous timeouts.

## Acceptance criteria

- [ ] Real-remote suite (env-gated) passes: list, upload/download round-trip byte-identical, move, rename, trash, mkdir, folder move
- [ ] Uploaded files' returned UUIDs match a subsequent listing; content update mints a new UUID; rename/move keeps it (the engine's change-detection premises)
- [ ] Listing paths are NFC and vault-relative to the Remote Folder root
- [ ] Suite self-cleans: no `run-*` folders or trash content left after a green run; stale-run sweep removes crashed-run leftovers
- [ ] CI skips the suite on fork PRs / missing secrets; no credentials or account identifiers ever logged

## Blocked by

- [026](026-impl-scaffold-and-build-gate.md), [027](027-impl-engine-core.md)
