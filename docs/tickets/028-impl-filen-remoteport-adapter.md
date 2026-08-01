---
id: 28
title: "Filen RemotePort adapter and real-remote test suite"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [26, 27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.2, §7, §9 layer 4 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The production `RemotePort` over `@filen/sdk`: full recursive listing (decrypted, NFC paths, `RemoteEntry` with uuid/size/optional sha512), download by UUID, upload via `cloud.uploadWebFile` (never the `fs.writeFile` facade), move/rename by UUID, soft-delete to Filen trash, folder create/move/trash, plus the parent-UUID session cache rebuilt from listings. Socket `watch` is a later slice — stub it. Alongside: the real-remote vitest suite mirroring Filen's own CI practice per spec §9: dedicated test account (2FA off), creds via env only, suite skipped when absent, per-run `/obsen-tests/run-<timestamp>-<random>` subfolder, stale-run sweep, teardown trash + `emptyTrash()`, single-thread, generous timeouts.

## Acceptance criteria

- [x] Real-remote suite (env-gated) passes: list, upload/download round-trip byte-identical, move, rename, trash, mkdir, folder move
- [x] Uploaded files' returned UUIDs match a subsequent listing; content update mints a new UUID; rename/move keeps it (the engine's change-detection premises)
- [x] Listing paths are NFC and vault-relative to the Remote Folder root
- [x] Suite self-cleans: no `run-*` folders or trash content left after a green run; stale-run sweep removes crashed-run leftovers
- [x] CI skips the suite on fork PRs / missing secrets; no credentials or account identifiers ever logged

## Resolution

Done and verified against production Filen. `npm run verify` is green (lint → typecheck →
228 unit tests → 15 bundle-gate tests), and `npm run test:remote` is 15/15 against a
dedicated test account, teardown included.

**Every premise the engine rests on is now confirmed against the real API**, not just
against a fake: a content update mints a new UUID, a rename and a cross-folder move both
keep it, an uploaded UUID is the one the next listing reports, the plaintext SHA-512 Filen
records is the digest Obsen computes, a 1.5 MB binary round-trips byte-identically across
chunk boundaries, and an NFD name on Filen comes back NFC.

Two things only the live API could have taught, both now encoded:

1. **Permanently deleting a *live* folder goes through the trash.** `cloud.deleteDirectory`
   on a folder that was not already trashed puts it there and clears it 2–4 s later; an
   already-trashed item goes at once. Teardown polls for the purge instead of asserting a
   latency Filen never promised.
2. **Filen's ingest returns transient `Internal error`s under repeated runs.** One whole
   run failed every upload and the next, unchanged, passed. The suite deliberately does not
   retry — layer 4 exists to observe the API, not to smooth it over — so a red run is worth
   repeating before it is believed. Noted in the README.

### The adapter

`src/filen/remote.ts` (`FilenRemote`) plus `src/filen/session-index.ts`. The split is the
adapter's actual seam: Filen addresses parents and files by UUID and needs decrypted metadata
to re-encrypt on rename; the engine addresses paths. Only a listing knows both, so the index
holds that mapping and `listing()` rebuilds it wholesale. It is a cache of the remote, never a
source of truth — and since a Run lists first (spec §5.1), the window in which it can be stale
is one Run's execution phase, during which this adapter is its only writer.

**Listing is `cloud.getDirectoryTree`, one call, path-keyed and decrypted.** Spec §1.2 said
`cloud.listDirectory (listing via /v3/dir/tree)` and §5.1 said `/v3/dir/tree`; both were
inaccurate and are corrected in place. `listDirectory` is `/v3/dir/content` and is not
recursive; `/v3/dir/tree` does exist in 0.4.2 but is a raw endpoint returning positional
tuples with no decryption helper and a required `deviceId`. `getDirectoryTree` (over
`/v3/dir/download`) is the SDK's supported recursive listing and matches what the spec's
prose actually asks for.

**Judgement calls, each one a trap in the SDK:**

1. **Move first, then rename.** `renameFile` refuses a name already taken *in the file's
   current folder* — it re-fetches the parent itself — while `moveFile` never refuses at all.
   Renaming first therefore tests the **source** folder for the destination's name: it fails
   on names that are free where the file is going, and waves through ones that are not. Moving
   first puts the file in the destination folder before the only call that checks. Folders are
   identical (`renameDirectory`/`moveDirectory`), so `moveFolder` does the same.
2. **An upload's own hash is recomputed, because Filen's response drops it.**
   `uploadWebFile` encrypts a plaintext SHA-512 and a `creation` timestamp into the metadata
   and then returns a hand-built `CloudItem` carrying neither. Indexing that response verbatim
   would make the next `renameFile` re-encrypt the metadata *without* them — silently deleting
   the digest every other device uses for cheap change detection (spec §3.1). So `upload()`
   reconstructs the metadata exactly, digest included. It costs one extra SHA-512 pass over
   bytes the engine has also hashed; the port signature is normative and has nowhere to pass
   the engine's digest in, and the pass is negligible beside the upload it accompanies.
3. **A hash that is not 128 hex characters is reported as no hash.** A present hash is
   authoritative to the engine, and a download disagreeing with it *fails the operation*
   (`execute.ts`). A foreign client's digest in another format would condemn the file; absent
   means "unknown", which merely costs a re-hash.
4. **Undecryptable names are hidden from the listing.** The SDK substitutes
   `CANNOT_DECRYPT_NAME_<uuid>` for metadata it cannot read. This does not hide a file that
   would otherwise sync — such a file has *already* lost its real path, because the tree keys
   it under the placeholder — so the Run sees the real path as missing either way. What the
   filter buys is that Filen-side corruption does not additionally spawn a junk note whose
   every download must fail (the file key lives in the same unreadable metadata).
5. **Two remote names that normalize to one NFC path both come through.** Spec §5.8 has the
   *engine* resolve that collision (`duplicate-remote-path`, already in `plan.ts`); a port that
   quietly dropped one would take the choice away from it.
6. **`watch` is a no-op stub** — ticket [035](035-impl-socket-live-remote.md). Honest, not
   lazy: the socket is a trigger and never a ledger (spec §7), so an engine that never hears
   from it is slower and no less correct.

### The suite (spec §9 layer 4)

`tests/remote/`, its own vitest project, single fork, no concurrency, never part of
`npm test`.

- **It runs the SDK's *browser* paths, from Node.** The SDK picks paths at runtime from the
  globals present, and `uploadWebFile` throws outright for a non-browser environment — so
  `webview-globals.ts` supplies the two globals Node lacks (a `window` with `document` and
  `navigator`; a `FileReader` over `Blob.arrayBuffer()`). `XMLHttpRequest` stays absent, so
  axios keeps its Node HTTP adapter and no same-origin policy stands in the way. This is not a
  browser-safety claim — that is the mobile-safety gate's job, and it makes the claim the
  other way round. `environment.test.ts` checks the shim held, needs no account, and so runs
  everywhere.
- **It deletes exactly what it made, and never calls `emptyTrash()`** — a deliberate
  departure from spec §9's "periodic `emptyTrash()`". That call is account-wide and
  irreversible, so a suite using it needs the account to be provably empty, and the first
  real test account was not: it still held ticket [019](019-prototype-on-device-spike.md)'s
  spike leftovers. Trashing keeps an item's original parent, so "came out of this run" is
  decidable at teardown without the tests having recorded anything; the blast radius is one
  folder, on any account. Teardown then *asserts* it worked rather than assuming it.
- **Its own workflow, not a CI job.** `ci.yml` cancels in-progress runs on a re-push, and a
  cancelled run is a run that skipped its teardown. `real-remote.yml` has a global concurrency
  group that never cancels. No `if:` guard on the secrets: a fork gets empty values and the
  suite skips itself, so the skip condition cannot drift from the suite's own.
- `privacy.test.ts` now polices the shape of all this: the credential names may appear in a
  workflow only as `NAME: ${{ secrets.NAME }}` — never a default, a `run:` line or an echo —
  and `sandbox.ts` must read them from the environment with no committed fallback.

### Ancillary

`baseName` joins `parentPath` in `src/engine/paths.ts`, the documented home for path
arithmetic, and `fileExtension` now uses it. The bundle gate gained a probe for
`src/filen/remote.ts`, since the file that actually touches `@filen/sdk` is not reachable from
`main.ts` until [030](030-impl-login-and-secretstorage.md)–[031](031-impl-folder-picker-and-first-link.md)
and "it is browser-safe" is worth knowing now.

## Blocked by

- [026](026-impl-scaffold-and-build-gate.md), [027](027-impl-engine-core.md)
