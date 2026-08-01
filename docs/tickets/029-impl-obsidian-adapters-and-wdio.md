---
id: 29
title: "Obsidian VaultPort/StorePort adapters and wdio integration harness"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: [26, 27]
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.1, §1.3, §2.1, §9 layer 3 — backlog seeded by [023](023-write-v1-spec.md).

## What to build

The production `VaultPort` over Obsidian's Vault API (atomic write via tmp+rename, `FileManager.trashFile()` for trash, NFC normalization at the boundary, `isWritablePath` platform name constraints, watch events carrying stats registered inside `onLayoutReady`) and `StorePort` (sync-state.json atomic write, shadow blob files under the plugin folder). The Exclusion List predicate from spec §2.1 is applied here at the scope boundary. Alongside: bootstrap the `wdio-obsidian-service` harness — plugin installed via `plugins: ["."]`, fixture vault, `resetVault()` between tests, Xvfb + window-manager recipe for Linux CI, Obsidian download caching — with a first spec that drives `VaultPort` inside real Obsidian.

## Acceptance criteria

- [x] wdio spec: create/read/write/rename/trash a note through `VaultPort` inside real sandboxed Obsidian; watch events fire with stats; no events fire for vault-init `create` storm
- [x] Exclusion List honored: workspace files, `plugins/obsen/` state files, `.trash/`, OS junk are invisible to `list()` and `watch`
- [x] StorePort round-trips sync-state.json atomically and shadow blobs by hash
- [x] wdio matrix runs {earliest, latest} × {desktop, emulateMobile} locally and in CI (ubuntu + Xvfb + WM, cached downloads)
- [x] Paths returned NFC; case-sensitivity behavior matches spec §5.8

## Blocked by

- [026](026-impl-scaffold-and-build-gate.md), [027](027-impl-engine-core.md)

## Resolution

Both Obsidian-side ports exist and are driven by real Obsidian. `npm run verify` is green —
lint → typecheck (two projects) → 356 unit tests → 15 bundle-gate tests — and `npm run test:wdio`
passes 16 assertions per capability across {1.11.4, 1.13.4} × {desktop, `emulateMobile`}, 8 spec
files in ~45 s once downloads are cached.

**The adapter has two halves, and Obsidian decides which.** Its Vault API indexes nothing
hidden, and `.obsidian/` is exactly what spec §2 says must sync — so `isConfigPath` routes each
call: the Vault API for ordinary content (it suffices, and it keeps Obsidian's own index right
as Obsen mutates the vault), the `DataAdapter` for the config dir, which the Vault API cannot
reach at all. `src/obsidian/api.ts` writes out the slice of Obsidian used; `createObsidianPorts`
assigns the real `app.vault`/`app.fileManager` to it, which is the compile-time proof the slice
is a slice — the same trick `createFilenRemote` plays on the SDK. Nothing in `src/obsidian/`
except `adapters.ts` imports `obsidian`, so the whole thing is unit-testable headless against
`FakeObsidian`, which models the two behaviours that matter: hidden paths are invisible to the
Vault API, and adapter writes reach its index second.

**Three findings from real Obsidian that the fakes could not have produced.**

1. **Renaming over an indexed file closes the editor tab it is open in.** Obsidian's watcher
   reads the replacement as a delete plus a create and tears the view down — measured, then
   turned into a regression test. For a sync plugin that is not cosmetic: it would shut the
   user's note on every remote edit that landed while they were reading it. So `write` is
   atomic (tmp + rename) for a **new** file and for the config dir, and an **overwrite** goes
   through `Vault.modifyBinary`, the call Obsidian's own editor saves through. That contradicts
   the normative `// ATOMIC (tmp+rename)` line, so [spec §1.1 now carries an
   amendment](../specs/obsen-v1.md) and `src/engine/ports.ts` states the weaker contract the
   engine may actually rely on. An overwrite is now exactly as exposed to a torn write as any
   note the user types, and the next Run's re-hash repairs one; a closed tab repairs itself
   never.
2. **Obsidian indexes a `DataAdapter` write ~260 ms later**, via its own watcher — and a Run
   downloads and re-scans faster than that. Without cover, a note written moments ago would be
   missing from the next `list()`, the decision matrix would read that as a local deletion, and
   Obsen would propagate a delete for a file it had just created. `ObsidianVault.unacknowledged`
   vouches for those paths until a scan finds Obsidian has caught up.
3. **A deleted folder fires one `delete` per file inside it first.** That is what makes it safe
   for the port to drop folder events and keep the engine's universe to files; it is asserted
   rather than assumed, because spec §4 has no periodic Reconcile to fall back on.

**Two additions to `isWritablePath` beyond the spec's three examples**, both turning silent data
loss into one Skip-and-Surface row. A **dot-prefixed name** is legal everywhere and invisible to
Obsidian's Vault API — the file would download, vanish from the next scan, and read as a local
deletion to push back to Filen. And a name Obsidian's **`normalizePath()`** would rewrite (a
backslash, a `.`/`..` segment, a stray slash) is refused rather than normalized: spec §1.3 asks
for `normalizePath()` on remote-derived paths and §5.8 forbids auto-renaming, and refusing the
name is the only way to obey both — applying it would quietly turn `a\b.md` into `a/b.md`.

**One entry added to the Exclusion List:** `<pluginDir>/tmp/**`, the scratch folder the atomic
write renames out of. Same case as the `sync-state.json.tmp` sibling §2.1 already carves out —
a file that exists for milliseconds and is never content. Scratch lives in one folder rather
than beside each target so a crash leaves its leftovers somewhere findable.

**Harness.** `wdio.conf.ts` runs the full {earliest, latest} × {desktop, `emulateMobile`} matrix
locally as well as in CI (`OBSIDIAN_VERSIONS` narrows it for a fast loop); the fixture vault
under `tests/wdio/fixtures/vault` carries a real `.obsidian/`, without which the Exclusion List
could not be exercised at all. `tests/wdio` is its own TypeScript project so Mocha's and
WebdriverIO's globals stay out of the vitest suites. The CI job installs Xvfb **and**
`herbstluftwm` — Obsidian is Electron, and the service's own CI warns that a virtual display
alone is not enough — and caches `.obsidian-cache` on the resolved version pair, not on the
strings that asked for it.

**Left for the tickets that own them.** `VaultPort.watch` registers watchers wherever it is
called; putting that call inside `workspace.onLayoutReady` is the shell's job when the triggers
are wired (ticket [034](034-impl-trigger-wiring.md)) — `onload` still does registrations only.
Config-dir changes fire no vault events, so another plugin's settings edit converges at the next
full Run rather than live; the startup Reconcile is the backstop spec §4 exists for. And the
Shadow Store still has no orphan sweep for blobs no live process named — `StorePort` has no
listing call by design, and the natural consumer is "Verify and repair" (ticket
[038](038-impl-activity-troubleshooting.md)).

