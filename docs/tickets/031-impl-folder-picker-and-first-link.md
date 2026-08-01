---
id: 31
title: "Folder picker, link/unlink, First Link flow"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [27, 28, 29, 30]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §8.3, §8.4 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The linking surface: modal Filen tree browser (tap selects, right-edge chevron descends, current folder is default selection, "New folder" at current level, root selectable behind a warning modal), the link stored by folder **UUID** (path display-only). The First Link flow: static explanation modal → scan with in-modal progress and free Cancel → dry-run preview from the engine's plan-only entry point (upload/download/identical/conflict counts, conflict paths when ≤10, First-Link rules text, dual-engine caution) → confirm executes the already-computed plan as a normal non-blocking Run with a completion tally notice. Unlink drops link + Sync State + Shadow Store, touches no files on either side. The dual-engine warning also becomes a persistent callout in linked-state settings.

## Acceptance criteria

- [x] wdio: pick a folder, preview matches a seeded local/remote divergence, confirm syncs it; vault usable during the Run
- [x] Nothing is written during scan/preview; Cancel leaves both sides untouched
- [x] Link survives the Remote Folder being renamed/moved on Filen (UUID-bound); re-link after Unlink triggers Re-Bootstrap
- [x] Root selection is gated by the warning modal; dual-engine caution appears in both specified placements
- [x] Unlink removes state + shadow and no vault/remote file changes

## Blocked by

- [027](027-impl-engine-core.md), [028](028-impl-filen-remoteport-adapter.md), [029](029-impl-obsidian-adapters-and-wdio.md), [030](030-impl-login-and-secretstorage.md)

## Resolution

A vault can now be linked, previewed, synced and unlinked from the settings tab. `npm run
verify` is green (lint → typecheck ×2 → 462 unit tests → 15 bundle-gate tests), `npm run
test:wdio` passes 6 new specs per capability across {1.11.4, 1.13.4} × {desktop,
`emulateMobile`}, and `npm run test:remote` adds four assertions against the real test account
for `cloud.listDirectory`, the one Filen surface no other suite touches.

**The link is a small state machine, and it is not the settings tab.** `src/link.ts` owns three
transitions — **stage** a candidate folder, **commit** the plan the user approved, **unlink** —
and, through them, the Sync Engine's whole lifetime. It imports neither `obsidian` nor
`@filen/sdk` (the `RemotePort` arrives as a `remoteFor(uuid)` factory), so the entire flow is a
14-test headless suite rather than a browser one, and the modals on top of it stay thin enough
to be worth testing only in real Obsidian.

**Staging is what makes step 2's Cancel free.** A candidate engine reads the Sync State and
plans; only a Run writes, and only `commit` starts one — so "nothing is written during
scan/preview" is a property of the design rather than a rule the code remembers to follow. On
top of that the planner gained a **cooperative `cancelled` predicate**
(`PlanCancelledError`), asked before the listing, before the vault scan and between hashed
files: a Cancel on a large vault stops at the next file instead of hashing to the end and
throwing the answer away. Ordinary Runs pass no predicate, so nothing about them changed.

**Where "the link is a UUID" is actually enforced.** `data.json` holds `{ folderUuid, path }`
and the path is display-only, load-bearing nowhere: the engine is opened on the UUID
(`remoteRoot`), the wdio suite renames the folder on the fake drive and syncs again cleanly, and
a link written by an older Obsen with no `path` at all still resolves (it renders as the Filen
root, which an empty path legitimately means). Re-linking after an Unlink re-bootstraps because
the store was swept, not because anything special-cases it — `SyncEngine.open` finds no state
and reports `stateReset: "missing"`.

**Unlink's ordering is the interesting part.** The engine stops first, so nothing it had queued
can re-persist the state about to be deleted; the link is dropped next, because that is the
decision the user made and it must not be left half-made; the store sweep runs last and its
failure is logged rather than surfaced — the leftovers are recreatable garbage, and telling
someone their unlink failed when the vault is demonstrably unlinked would be worse than untrue.
`ObsidianStore.reset()` is the new `StorePort` extension (`AdapterApi` gained `rmdir`), and it
deliberately stops at Obsen's own two files: `data.json` is settings, not sync state.

**Two things only real Obsidian could have told us.** `Modal` assigns its own `selection` field
inside `open()` — after the constructor, before `onOpen` — so the picker's `private selection`
was silently replaced by a DOM `Selection` and the modal died mid-render on the first paint. It
is called `chosen` now, with the reason written down. And Obsidian indexes a `DataAdapter` write
*after the fact*, so a vault snapshot taken the instant a Run finishes legitimately does not
list a note already on disk; the wdio suite waits for the index rather than pretending
otherwise.

**The layer-3 seam, stated honestly.** `ObsenPlugin.remotes` is one replaceable object holding
the two Filen-side surfaces (`folders()` for the picker, `remote(uuid)` for the engine). It
exists so the Obsidian integration suite can run against a fake Filen — spec §9 puts layer 3
"mostly against fake RemotePort", and pointing forty modal-clicking specs at a real account
would make them slow, flaky and secret-dependent. The one real end-to-end smoke path stays layer
4's.

**Three judgement calls.** The picker browses **one level at a time** (`listDirectory` with
`onlyDirectories`, verified against the real API) rather than fetching a tree: it is the only
shape that stays usable on a phone and on a drive with thousands of files. The folder being
browsed is a **row of its own** in the list, so "I descended one level too far" is one tap to
fix rather than a navigation. And a failed "New folder" is reported *above* the list rather than
instead of it — a transient create error should not cost the user their place in the tree.

**Boundaries with the tickets that own the neighbours.** `link.start()` runs at layout-ready and
opens the engine without syncing: the startup Reconcile and every other trigger are
[034](034-impl-trigger-wiring.md)'s, and the linked settings state needs an engine handle to
render at all. Logout now stops that engine and a re-login re-opens it, which is what makes spec
§8.2's "sync stops until you log in again" true rather than aspirational. The First-Link
completion notice is here because spec §8.6 grants a manual completion exactly one notice; its
`offline` wording is a completion report, and reconciling it with the Attention-State notice
policy belongs to [037](037-impl-status-surface-ux.md), which also owns opening `conflicts.md`
after a Run that made copies. The preview's `skipped` row deliberately says nothing about where
to look afterwards — Recent activity is [038](038-impl-activity-troubleshooting.md)'s.

**Two ancillary changes.** `styles.css` is new — the picker needs a bounded scrolling list and a
selected-row highlight, and there is no Obsidian component for either; it uses only Obsidian's
CSS variables, and [039](039-impl-release-engineering.md) must ship it as a release asset
alongside `main.js` and `manifest.json`. And `eslint.config.mjs` teaches the sentence-case rule
that "Filen" and "Obsen" are proper nouns (via `ignoreWords`, because `brands` *replaces* the
plugin's list rather than extending it).

**Known and accepted:** a Cancel during the remote listing closes the modal at once, but the
in-flight listing still has to resolve before the candidate engine is discarded. No writes
happen either way, and the alternative is an abort mechanism the `RemotePort` does not have.
