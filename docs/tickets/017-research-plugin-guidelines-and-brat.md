---
id: 17
title: "Research: Obsidian community plugin guidelines and BRAT release mechanics"
labels: [wayfinder:research]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

Distribution is BRAT-first, directory-standards-from-day-one ([012](012-scale-envelope-and-distribution.md)). What exactly must the repo and code comply with?

- Obsidian's plugin review guidelines relevant to Obsen: mobile compatibility rules, network-use disclosure requirements (a sync plugin talks to a third-party service and stores credentials — what must the README/manifest declare?), forbidden APIs, `manifest.json`/`versions.json` requirements.
- BRAT mechanics: exact release-asset layout (`main.js`, `manifest.json`, `styles.css` on GitHub releases), versioning rules, beta-channel behavior on mobile.
- The standard scaffold worth adopting: obsidianmd sample-plugin structure, esbuild config, GitHub Actions release workflow.

Output: a markdown summary in `docs/research/` — a compliance checklist the spec ([023](023-write-v1-spec.md)) incorporates.

## Resolution

**Nothing in Obsidian's policies blocks a Filen sync plugin** — network use, account-required, and payment-required services are all explicitly allowed with README disclosure. Obsen can comply from day one, and the review surface is machine-checkable via the official `eslint-plugin-obsidianmd`. Full findings and the compliance checklist: [the research doc](../research/017-plugin-guidelines-and-brat.md).

Key findings:

- **Obsidian has a first-party secrets API**: `SecretStorage` + `SecretComponent` (since Obsidian 1.11.4) is the documented fix for plaintext credentials in `data.json`. This challenges the accepted-risk decision in [009](009-auth-and-credential-storage.md) and sets a candidate `minAppVersion: 1.11.4` → spawned [025](025-adopt-secretstorage-for-credentials.md).
- **`vault.on('create')` fires for every existing file during vault init** — sync watchers must be registered inside `onLayoutReady`, not `onload`. Load-bearing for the engine algorithm ([021](021-design-sync-engine-algorithm.md)).
- **BRAT ≥ 1.1.0 installs purely from GitHub release assets**: `main.js` + `manifest.json` (+ optional `styles.css`) fetched by exact filename; tag == release name == released-manifest version, no `v` prefix; the pre-release flag doesn't hide releases from BRAT; `manifest-beta.json` is legacy. BRAT works on mobile.
- **Beta→stable version trap**: Obsidian's updater ignores prerelease suffixes, so users on `1.0.1-beta.N` are never offered `1.0.1` — first stable must be strictly higher, and the root-branch `manifest.json` must not be bumped during beta.
- **Sample scaffold's esbuild config is too permissive for Obsen**: it externalizes `electron` and all Node builtins, so a stray `import "fs"` builds green and crashes on mobile — replace the `builtinModules` externals with the `--platform=browser` gate; keep `format: cjs` + `external: ['obsidian']`.
- **Sync-relevant API rules with teeth**: Vault API over Adapter, `Vault.process` for background edits (atomic), `FileManager.trashFile()` for propagated deletes (respects the user's trash setting, per [007](007-deletion-semantics.md)), `normalizePath()` on all remote-derived paths.
- **Directory submission is now via community.obsidian.md** with automated review (no longer a PR to obsidian-releases); the directory reads `manifest.json` at HEAD of the default branch.
- **`requestUrl` is not mandated** — it exists to bypass CORS; whether the Filen SDK's `fetch` hits CORS walls in the webview belongs to the on-device spike ([019](019-prototype-on-device-spike.md)), with `requestUrl` as the sanctioned fallback.
- **Naming caveat**: manifest rules ban "Obsidian" *and variations like "Obsi-"/"-sidian"*; "Obsen" is neither literally but is Obsidian-evocative — reviewer discretion at directory submission, not a beta blocker (names can change post-publication).
- **License is policy-level**: Developer policies require complying with incorporated-code licenses with README attribution — raises the stakes of [024](024-choose-license.md), already on the frontier.
