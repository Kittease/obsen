---
id: 26
title: "Plugin scaffold, browser-gate build, and CI"
labels: [impl, afk]
status: open
assignee:
blocked_by: []
---

## Parent

[Obsen v1 spec](../specs/obsen-v1.md) §1.2, §1.3, §10 — backlog seeded by wayfinder ticket [023](023-write-v1-spec.md).

## What to build

The repo becomes a loadable Obsidian plugin with the mobile-safety gate enforced from the first commit. Scaffold per the official sample plugin layout, but with the spec's esbuild build: `--platform=browser`, `format: cjs`, only `obsidian` external — Node builtins are build errors, not silent landmines. Bundle `@filen/sdk@0.4.2` with the exact shim recipe from the [014 research doc](../research/014-sdk-in-obsidian-feasibility.md) and verify the SDK constructs at plugin load. Manifest: `id: obsen`, name "Obsen", `isDesktopOnly: false`, `minAppVersion: 1.11.4`, the spec's description string. Add the compliance package: root `LICENSE` (AGPL-3.0 verbatim), `package.json` license field, README skeleton with the §10.3 disclosures. CI runs typecheck, `eslint-plugin-obsidianmd` (recommended config), vitest, and the bundle gate on every push.

## Acceptance criteria

- [ ] `npm run build` produces a `main.js` that loads in Obsidian (desktop) and constructs a `FilenSDK` without error
- [ ] Adding `import "fs"` anywhere (including a dependency) fails the build
- [ ] CI is green with lint + typecheck + vitest + bundle gate; `eslint-plugin-obsidianmd` recommended config passes
- [ ] `manifest.json`, `versions.json`, `LICENSE`, `package.json` license, README disclosures match spec §10
- [ ] No personal account details anywhere in repo or CI

## Blocked by

None — can start immediately.
