---
id: 26
title: "Plugin scaffold, browser-gate build, and CI"
labels: [impl, afk]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.2, §1.3, §10 — backlog seeded by wayfinder ticket [023](023-write-v1-spec.md).

## What to build

The repo becomes a loadable Obsidian plugin with the mobile-safety gate enforced from the first commit. Scaffold per the official sample plugin layout, but with the spec's esbuild build: `--platform=browser`, `format: cjs`, only `obsidian` external — Node builtins are build errors, not silent landmines. Bundle `@filen/sdk@0.4.2` with the exact shim recipe from the [014 research doc](../research/014-sdk-in-obsidian-feasibility.md) and verify the SDK constructs at plugin load. Manifest: `id: obsen`, name "Obsen", `isDesktopOnly: false`, `minAppVersion: 1.11.4`, the spec's description string. Add the compliance package: root `LICENSE` (AGPL-3.0 verbatim), `package.json` license field, README skeleton with the §10.3 disclosures. CI runs typecheck, `eslint-plugin-obsidianmd` (recommended config), vitest, and the bundle gate on every push.

## Acceptance criteria

- [x] `npm run build` produces a `main.js` that loads in Obsidian (desktop) and constructs a `FilenSDK` without error
- [x] Adding `import "fs"` anywhere (including a dependency) fails the build
- [x] CI is green with lint + typecheck + vitest + bundle gate; `eslint-plugin-obsidianmd` recommended config passes
- [x] `manifest.json`, `versions.json`, `LICENSE`, `package.json` license, README disclosures match spec §10
- [x] No personal account details anywhere in repo or CI

## Blocked by

None — can start immediately.

## Resolution

The repo is a loadable Obsidian plugin with the mobile-safety gate enforced from this
commit. `npm run verify` runs the four gates CI runs: `lint` → `typecheck` → `test`
(29 unit) → `gate` (13 bundle).

**Build (spec §1.2).** One shared options module, `build/esbuild-options.ts`, is the single
source of truth for both the release build (`build/build.ts`) and the gate, so they cannot
drift. It reproduces the [014 research](../research/014-sdk-in-obsidian-feasibility.md)
recipe exactly — nine aliases, the five verbatim shims under `shims/`, `--inject` of
`Buffer`/`process`, the load-bearing `define: { global: "globalThis" }`, `format: cjs`,
`external: ["obsidian"]` and nothing else. Node builtins are deliberately *not*
externalized: `import "fs"` in `src/` fails `npm run build` with exit 1 and a pointed
esbuild diagnostic. Output: 1.2 MB minified, matching the research measurement.

**The gate is layer 2 of spec §9, as a vitest suite** (`tests/gate/`). Beyond rejecting
builtins — directly, via a submodule (`fs/promises`), and *transitively* through a
dependency — it evaluates the built `main.js` in a `node:vm` realm with **no Node globals
at all** (no `process`, no `Buffer`, no bare `global`) and only `obsidian` requirable. In
that webview-like realm it runs `onload` and asserts a `FilenSDK` is constructed, checks
the SDK's runtime `environment` is `"browser"`, and confirms via the esbuild metafile that
every `@filen/sdk` input came from `dist/browser/`. This is what catches the class of
mobile load crash the 014 research found (`typeof global.…` → `ReferenceError`) on a
desktop machine.

**Compliance (spec §10)** is asserted, not just written: `tests/unit/compliance.test.ts`
checks identity, the version floor, `versions.json`, the verbatim AGPL-3.0 `LICENSE`, the
`package.json` license field and every §10.3 README disclosure.
`tests/unit/privacy.test.ts` enforces the CLAUDE.md privacy rule over every tracked or
new-but-unignored file — no email addresses outside ticket `assignee:` lines, no committed
`.env`/key files — with a positive control so the scan cannot pass vacuously.

**Two findings worth carrying forward:**

1. **Spec §10.1's description string cannot pass the directory-review linter.**
   `obsidianmd/validate-manifest` accepts only `[A-Za-z0-9\s.,!?'"-]`, so the spec's em
   dash fails (a colon fails too). Shipped as two sentences instead: "Sync your vault with
   a Filen folder. End-to-end encrypted, two-way, on desktop and mobile." Every constraint
   §10.1 actually *states* — action verb, ≤250 chars, final period, trademark casing —
   still holds. Treat this as the amendment to §10.1's literal string.
2. **The recommended eslint config enables `validate-manifest` but registers it only on
   JS/TS globs, so it silently never ran on `manifest.json`**; `eslint.config.mjs` wires it
   explicitly. Relatedly, most `obsidianmd` rules are *warnings*, so `eslint .` exited 0 on
   real violations (hardcoded `.obsidian`, `innerHTML`, Node imports) — the lint script is
   `--max-warnings 0`, which is what gives spec §1.3's "rules with teeth" teeth. Verified
   by planting a hardcoded config path and watching CI's lint step fail.

**Deliberately deferred, not forgotten:**

- **No UI at all** — settings tab (030), ribbon icon and status surface (037) are later
  tickets; a placeholder tab or a "Sync now" command with no engine behind it would be a
  lying UI. `onload` constructs the SDK and nothing else; the comment in `src/main.ts`
  records where registrations vs `onLayoutReady` startup work must go (spec §1.3).
- **`version-bump.mjs` and the tag → draft-release workflow** belong to [039](039-impl-release-engineering.md);
  spec §10.4 also forbids committing a bumped root `manifest.json` during beta, so shipping
  bump tooling before the release flow exists would invite exactly that mistake. The README
  states only what is true today.
- **Real-Obsidian load** is proven headlessly here (webview realm) but not yet against a
  running Obsidian; that is [029](029-impl-obsidian-adapters-and-wdio.md)'s wdio harness
  (spec §9 layer 3).

**Toolchain notes for the next ticket:** build scripts and tests are TypeScript executed by
Node's native type stripping, so `package.json` declares `"engines": { "node": ">=24" }`
and CI pins Node 24. `src/**` additionally bans Node builtins and Node globals
(`process`, `Buffer`, `global`, `require`, `__dirname`) via eslint, since `@types/node` is
in scope for the Node-side files. `main.js` is gitignored; the gate builds its own copy
into a scratch directory so it never clobbers a `npm run dev` watch artifact.
