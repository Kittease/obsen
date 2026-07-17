---
title: "Research: Obsidian plugin guidelines, review requirements, and BRAT mechanics"
ticket: 17
labels: [wayfinder:research]
---

# What must Obsen comply with for BRAT beta delivery and eventual directory submission?

Researched 2026-07-17 against primary sources only: the official developer docs at [docs.obsidian.md](https://docs.obsidian.md) (cross-checked against their source repo [obsidianmd/obsidian-developer-docs@main](https://github.com/obsidianmd/obsidian-developer-docs)), [obsidianmd/obsidian-sample-plugin@master](https://github.com/obsidianmd/obsidian-sample-plugin) (package version 1.0.0, `esbuild@0.25.5`, `eslint-plugin-obsidianmd@^0.4.0`), the official lint plugin [obsidianmd/eslint-plugin@master](https://github.com/obsidianmd/eslint-plugin) (which encodes the automated review checks), and the BRAT repo [TfTHacker/obsidian42-brat@main](https://github.com/TfTHacker/obsidian42-brat) (v2.2.0) — specifically its in-repo [`BRAT-DEVELOPER-GUIDE.md`](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md) and the release-resolution source (`src/features/BetaPlugins.ts`, `src/features/githubUtils.ts`).

## TL;DR — verdict

**Nothing in Obsidian's policies blocks a Filen sync plugin; Obsen can be compliant from day one.** Network use and account requirements are explicitly *allowed with README disclosure* ([Developer policies §Disclosures](https://docs.obsidian.md/Developer+policies)). The `isDesktopOnly: false` commitment is exactly Obsen's existing constraint: zero Node.js/Electron APIs, **including in dependencies**, and no regex lookbehind (iOS < 16.4). Five findings change or sharpen the plan:

1. **Obsidian now has a first-party secrets API.** `SecretStorage` + `SecretComponent` (since Obsidian **1.11.4**) is the documented way to store API keys/tokens outside plaintext `data.json` ([Store secrets guide](https://docs.obsidian.md/Plugins/Guides/Store+secrets), [SecretStorage API](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage)). Using it answers the credential-storage question and sets `minAppVersion ≥ 1.11.4`.
2. **Directory submission is no longer a PR to obsidian-releases.** It goes through [community.obsidian.md](https://community.obsidian.md) with an **automated review**; the directory reads `manifest.json` at the HEAD of the default branch, and installs come from the GitHub release whose tag matches the manifest version ([Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)).
3. **BRAT ≥ 1.1.0 works purely from GitHub releases** — `manifest-beta.json` is legacy and ignored. Beta channel = pre-releases with semver tags (`1.0.0-beta.3`); tag, release name, and released `manifest.json` version must all match ([BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)). BRAT runs on mobile (`isDesktopOnly: false` in [its manifest](https://github.com/TfTHacker/obsidian42-brat/blob/main/manifest.json)).
4. **The vault `create` event fires for every existing file during startup.** A sync engine that registers `vault.on('create')` in `onload` will see the whole vault "created" — event registration must go inside `onLayoutReady` ([Optimize plugin load time §Pitfalls](https://docs.obsidian.md/Plugins/Guides/Optimize+plugin+load+time)). This is load-bearing for the watcher design.
5. **The sample scaffold's esbuild config is *too permissive* for Obsen**: it externalizes `electron` and all Node builtins, so a stray `import "fs"` builds green and crashes on mobile. Obsen's planned `--platform=browser` gate (research 014) is stricter than upstream and should replace the `builtinModules` external list.

One naming watch-item: the manifest rules ban names containing "Obsidian" *"or variations like 'Obsi-' and '-sidian'"* ([Manifest §name](https://docs.obsidian.md/Reference/Manifest)). "Obsen" is neither, but it is `Obs-`-adjacent — reviewer discretion applies; see §1.4.

---

## Compliance checklist (for the v1 spec)

### Manifest & repository

- [ ] `manifest.json` at repo root; directory reads it from HEAD of the default branch — [Submit your plugin §3](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [ ] `id`: lowercase letters and hyphens only, must not contain `obsidian`, must not end with `plugin`; unique across the directory; equal to the plugin folder name in dev vaults (else `onExternalSettingsChange` never fires) — [Manifest](https://docs.obsidian.md/Reference/Manifest)
- [ ] `name`: short, Basic Latin only, no punctuation except hyphen/plus/parentheses, no emoji; must not contain "Plugin", "Obsidian" or variations ("Obsi-", "-sidian"); must not reuse core-feature names; unique — [Manifest §name](https://docs.obsidian.md/Reference/Manifest)
- [ ] `version`: Semantic Versioning, `x.y.z` format only ("Versions supported only in the format x.y.z") — [Submit your plugin §Step 2](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin); Obsidian does **not** support the full semver spec (see release/BRAT section) — [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
- [ ] `minAppVersion`: minimum compatible Obsidian version (latest stable if unsure) — [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins); **≥ 1.11.4 if `SecretStorage` is used** — [SecretStorage API](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage)
- [ ] `description`: ≤ 250 chars, starts with an action verb (their own example: *"Sync highlights and annotations from..."*), ends with a period, no emoji/special characters, correct capitalization of trademarks ("Obsidian", "Markdown"), never "This is a plugin..." — [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [ ] `isDesktopOnly: false` — permitted **only if** no Node.js or Electron API is used anywhere, dependencies included — [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins), [Mobile development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- [ ] No `fundingUrl` unless actually accepting donations — [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [ ] `versions.json` at repo root (`{"plugin-version": "minAppVersion"}`); update **only** when `minAppVersion` changes — [Versions reference](https://docs.obsidian.md/Reference/Versions)
- [ ] `README.md` at root describing purpose and usage; `LICENSE` at root with clear license — [Submit your plugin §Before you begin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [ ] Comply with licenses of all incorporated code, with README attribution where required (⚠ feeds ticket 024: `@filen/sdk` is AGPL-3.0) — [Developer policies §Copyright and licensing](https://docs.obsidian.md/Developer+policies)
- [ ] No self-update mechanism in the plugin (BRAT/Obsidian do updates, never Obsen itself); no client-side telemetry; no code obfuscation; no ads — [Developer policies §Not allowed](https://docs.obsidian.md/Developer+policies)

### Disclosure / README

- [ ] **Network use**: "Clearly explain which remote services are used and why they're needed" — name Filen's endpoints (API gateway, up/down file hosts, `socket.filen.io`) and why each is contacted — [Developer policies §Disclosures](https://docs.obsidian.md/Developer+policies)
- [ ] **Account required for full access**: disclose that a Filen account is required — [Developer policies §Disclosures](https://docs.obsidian.md/Developer+policies)
- [ ] **Payment**: disclose the boundary between Filen's free tier and paid storage plans (payment-for-full-access must be "clearly indicated") — [Developer policies §Disclosures](https://docs.obsidian.md/Developer+policies)
- [ ] **Do not access files outside the vault** (would require its own disclosure; Obsen has no reason to) — [Developer policies §Disclosures](https://docs.obsidian.md/Developer+policies)
- [ ] Server-side telemetry would require a linked privacy policy — Obsen sends nothing to any server but Filen's; state that — [Developer policies §Disclosures](https://docs.obsidian.md/Developer+policies)
- [ ] Credential storage statement: not literally mandated by policy, but the official guidance is that plaintext secrets in `data.json` are a problem and `SecretStorage` is the fix — document where credentials live — [Store secrets](https://docs.obsidian.md/Plugins/Guides/Store+secrets)

### Code-level (what review + the official lint flags)

The automated checks are encoded in [`eslint-plugin-obsidianmd`](https://github.com/obsidianmd/eslint-plugin); the sample scaffold ships it preconfigured (`npm run lint`). Adopting `obsidianmd.configs.recommended` in CI covers most of this list mechanically.

- [ ] No Node/Electron imports, incl. transitive deps; lint rule `no-nodejs-modules` (allows only `Platform.isDesktop`-guarded use — Obsen wants zero) — [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins), [eslint rules](https://github.com/obsidianmd/eslint-plugin#rules)
- [ ] No regex lookbehind (unsupported below iOS 16.4; users still run older); lint rule `regex-lookbehind` — [Mobile development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- [ ] Use `this.app`, never the global `app`/`window.app` ("intended for debugging... might be removed") — [Plugin guidelines §General](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] Default console output = errors only; no debug logging noise — [Plugin guidelines §General](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] Prefer the **Vault API over the Adapter API** (caching + serialized operations avoid race conditions — directly relevant to a sync engine) — [Plugin guidelines §Vault](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] Background edits via `Vault.process` (atomic), never `Vault.modify`; frontmatter via `FileManager.processFrontMatter`; active-note edits via the Editor API — [Plugin guidelines §Vault](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] Deletions via `FileManager.trashFile()` (respects the user's trash preference), not `Vault.delete()`; lint rule `prefer-file-manager-trash-file` — [eslint rules](https://github.com/obsidianmd/eslint-plugin#rules)
- [ ] Lookups via `Vault.getFileByPath`/`getFolderByPath`/`getAbstractFileByPath`, never iterate all files; `instanceof TFile/TFolder`, never casts (lint `no-tfile-tfolder-cast`) — [Plugin guidelines §Vault](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines), [eslint rules](https://github.com/obsidianmd/eslint-plugin#rules)
- [ ] `normalizePath()` on every user-supplied or constructed vault path — [Plugin guidelines §Vault](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] Never hardcode `.obsidian` — use `Vault#configDir`; lint rule `hardcoded-config-path` — [eslint rules](https://github.com/obsidianmd/eslint-plugin#rules)
- [ ] Keep `onload` minimal (registrations only, nothing computational, no data fetching); run startup work in `workspace.onLayoutReady()` — [Optimize plugin load time](https://docs.obsidian.md/Plugins/Guides/Optimize+plugin+load+time)
- [ ] Register `vault.on('create')` handlers **inside `onLayoutReady`** (or check `workspace.layoutReady`): vault initialization calls `create` for every file — [Optimize plugin load time §Pitfalls](https://docs.obsidian.md/Plugins/Guides/Optimize+plugin+load+time)
- [ ] Resource cleanup via `registerEvent()`/`addCommand()`/`registerInterval()`; do **not** detach leaves in `onunload` — [Plugin guidelines §Resource management](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] No `innerHTML`/`outerHTML`/`insertAdjacentHTML`; use `createEl()`/`createDiv()`/`createSpan()`, clear with `el.empty()` — [Plugin guidelines §Security](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] No inline JS styling; CSS classes in `styles.css` using Obsidian's CSS variables; lint `no-static-styles-assignment` — [Plugin guidelines §Styling](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] No default hotkeys; no plugin ID in command IDs (Obsidian prefixes automatically); correct command callback types (`callback` vs `checkCallback`) — [Plugin guidelines §Commands](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines), [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [ ] Settings UI: sentence case everywhere; no top-level heading in the settings tab; no "settings" in headings; headings via `new Setting(el).setHeading()` not `<h1>/<h2>` — [Plugin guidelines §UI text](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] `const`/`let` only; `async/await` over promise chains — [Plugin guidelines §TypeScript](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [ ] Remove all sample-plugin code and rename placeholder classes (`MyPlugin`, `SampleSettingTab`); lint `no-sample-code`, `sample-names` — [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [ ] Credentials via `SecretComponent`/`app.secretStorage.getSecret()` rather than plaintext in `data.json` — [Store secrets](https://docs.obsidian.md/Plugins/Guides/Store+secrets)

### Release & BRAT

- [ ] Every release: tag **==** release name **==** `version` in the *released* `manifest.json`, exact `x.y.z(-suffix)`, **no `v` prefix** — [Submit your plugin §Step 2](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin), [sample-plugin README](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases), [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
- [ ] Assets attached as binaries: `main.js`, `manifest.json`, `styles.css` (optional if unused) — Obsidian and BRAT both download exactly these, by filename, from release assets — [Submit your plugin §Step 2](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin), [BRAT `githubUtils.ts` `grabReleaseFileFromRepository`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/githubUtils.ts)
- [ ] `main.js` in releases = production build (minified, no inline sourcemap) — [Optimize plugin load time](https://docs.obsidian.md/Plugins/Guides/Optimize+plugin+load+time)
- [ ] Beta releases: semver-suffixed tag (e.g. `0.3.0-beta.1`), optionally flagged "pre-release" on GitHub — BRAT installs/updates them either way (`includePrerelease: true` in its install path) — [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md), [`BetaPlugins.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/BetaPlugins.ts)
- [ ] Publish the release — the official GH Actions workflow creates a **draft**, which is invisible to the GitHub releases API BRAT reads until published — [Release your plugin with GitHub Actions](https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions)
- [ ] During beta: do **not** commit the bumped version in root `manifest.json` to the default branch until the stable release (Obsidian's updater keys off HEAD manifest) — [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
- [ ] No `manifest-beta.json` — legacy, ignored by BRAT ≥ 1.1.0 — [BRAT developer guide §Legacy](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
- [ ] Version-jump rule for going stable: if beta users installed `1.0.1-beta.n`, Obsidian's updater will **not** offer `1.0.1` (its comparison isn't full semver); release the stable as at least the next patch (`1.0.2`) or have users update once via BRAT — [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
- [ ] Ship the official release workflow (`.github/workflows/release.yml`: tag push → build → `gh release create "$tag" --title="$tag" --draft main.js manifest.json styles.css`) with repo Actions set to read-write — [Release your plugin with GitHub Actions](https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions)

---

## 1. Review guidelines relevant to Obsen

### 1.1 Developer policies — what a Filen sync plugin triggers

[Developer policies](https://docs.obsidian.md/Developer+policies) open with the framing that matters: the directory prioritizes *"private and offline usage of the app"*. A cloud-sync plugin is the maximal opposite, and it is still fully allowed — every network-related concern is a **disclosure**, not a prohibition:

- *Allowed with README disclosure:* network use ("clearly explain which remote services are used and why they're needed"), account required for full access, payment required for full access.
- *Prohibited outright:* client-side telemetry, dynamic ads, self-update mechanisms, code obfuscation. The self-update ban is why the BRAT-first plan is architecturally clean: BRAT owns beta updates, Obsen never touches its own binaries.
- *Copyright:* LICENSE file required; must "comply with the original licenses of any code your plugin makes use of, including attribution in the README if required" — this is the policy hook for the AGPL question on `@filen/sdk` (ticket 024).
- *Trademark:* don't use "Obsidian" in a way suggesting first-party status.

Violations get a contact-and-fix window; malicious/uncooperative/repeat cases are removed immediately, and *"unmaintained or severely broken"* plugins can also be delisted ([Developer policies §Removing](https://docs.obsidian.md/Developer+policies)).

### 1.2 Credential storage — SecretStorage (Obsidian ≥ 1.11.4)

The docs now have a dedicated guide, [Store secrets](https://docs.obsidian.md/Plugins/Guides/Store+secrets): storing secrets in `data.json` is called out as a security problem ("stored in plaintext alongside other plugin data"), and the sanctioned alternative is the `SecretStorage` API — a vault-scoped, name-keyed secret store living in local storage, with a `SecretComponent` settings control (used via `Setting#addComponent`, because it needs the `App` instance). Plugin settings then hold the secret's *name*, never its value; retrieval is `app.secretStorage.getSecret(name)` (nullable). `SecretStorage` is stamped **since 1.11.4** in the [API reference](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage) — coincidentally exactly BRAT 2.2.0's own `minAppVersion`.

For Obsen this decides the credential design: store the Filen password/API key (or derived auth artifacts) under SecretStorage, keep only non-secret config in `data.json`, and set `minAppVersion: 1.11.4` (or gate with a fallback if older support is wanted — `requireApiVersion()` exists, but the simple path is the version floor).

### 1.3 Mobile: what `isDesktopOnly: false` commits to

From [Mobile development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development) and [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins):

- Node.js and Electron APIs are unavailable on mobile and "can crash your plugin"; **"dependencies must also avoid these APIs"**. If any are used, `isDesktopOnly: true` is mandatory — so `false` is a declaration of a fully browser-safe bundle.
- Regex lookbehind is only supported on iOS ≥ 16.4; the docs tell you to version-check or avoid it. The official lint enforces this (`regex-lookbehind`, error level in `recommended`).
- Suggested Web-API substitutions are documented: `SubtleCrypto` for `crypto`, `navigator.clipboard` for clipboard.
- Testing affordances: `this.app.emulateMobile(true)` in the desktop console; `Platform.isIosApp` / `Platform.isAndroidApp` for runtime branching; remote inspection via `chrome://inspect` (Android) or Safari/WebKit (iOS ≥ 16.4, macOS required).
- There is no documented mobile-specific *human* review pass beyond these rules; the enforcement surface is the manifest flag plus the lint rules (`no-nodejs-modules`, `regex-lookbehind`, `platform` — the latter bans `navigator`-based OS sniffing in favor of `Platform`).

### 1.4 Manifest and versions.json semantics

Full field table in [Manifest](https://docs.obsidian.md/Reference/Manifest) (summarized in the checklist). Notable exact semantics:

- `id` uniqueness is enforced at submission; it "can't contain `obsidian`" and "can't end with `plugin`". `obsen` passes.
- `name` rules are the strictest field: Basic Latin only; no "Obsidian" *"or variations like 'Obsi-' and '-sidian'"*; no core-feature names; plugins may not contain the word "Plugin". Plugin names *can* be changed post-publication via the manifest (an invalid new name delists until fixed). **Watch item:** "Obsen" is not literally "Obsi-" or "-sidian", but it is an Obsidian-evocative contraction; the listed variations are examples ("variations **like**"), so a reviewer could push back. Low risk, non-zero; worth deciding whether to keep before submission.
- `isDesktopOnly` is defined bluntly as "whether your plugin uses NodeJS or Electron APIs".
- `versions.json` ([Versions reference](https://docs.obsidian.md/Reference/Versions)) is a root-of-repo JSON object mapping plugin version → `minAppVersion`, consulted **only** when a user's app is older than the current `minAppVersion`, to serve them the newest compatible older release. You only add entries when `minAppVersion` changes.
- Manifest version ↔ release tag: the release's tag must equal the manifest `version` ([Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin): "The 'Tag version' of the release must match the version in your manifest.json"); no `v` prefix ([sample README](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases): "Use the exact version number, don't include a prefix `v`"). The released `manifest.json` must therefore be a copy of the root one at that version ("the manifest.json file must be in two places, first the root path of your repository and also in the release", ibid.).

### 1.5 The automated review and the code-level guideline set

[Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin) describes the current flow: submission happens on **community.obsidian.md** (Obsidian account + linked GitHub proving repo ownership), *"your plugin is reviewed automatically and the directory shows guidance for anything that needs to be corrected"*, and the plugin "won't be installable from within Obsidian until the automated review passes". Fixes are shipped by publishing a new release with an incremented version. (The sample README's older "make a PR to obsidianmd/obsidian-releases" instruction is superseded by this page.)

[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) is explicitly "common review comments" — recommendations that "depending on their severity, we may still require you to address". Every item is in the checklist above; the ones with teeth for Obsen specifically:

- **Vault over Adapter** — the Vault API "performs file operations serially to avoid any race conditions"; a sync engine writing many files wants that serialization anyway.
- **`Vault.process` for background edits** — atomic, conflict-free with other plugins.
- **`normalizePath()`** for the sync-root setting and every remote-derived path (slash cleanup, NBSP replacement, unicode NFC via `String.prototype.normalize`).
- **`fetch` vs `requestUrl`**: there is **no guideline mandating `requestUrl`**; it exists to make requests "without any CORS restrictions" ([requestUrl API](https://docs.obsidian.md/Reference/TypeScript+API/requestUrl)) and the guidelines' own async examples use it. Relevance to Obsen: the Filen SDK uses standard `fetch`/XHR internally; whether Filen's API hosts send permissive CORS headers inside Obsidian's webview is part of ticket 019's on-device spike. If CORS bites, `requestUrl` is the sanctioned escape hatch.
- **Console hygiene** — errors only by default.

The [official ESLint plugin](https://github.com/obsidianmd/eslint-plugin) is the machine-readable form of this review (39 rules at 0.4.x). Beyond the guideline mirrors, rules worth knowing that the docs pages *don't* spell out: `prefer-file-manager-trash-file` (respect the user's trash setting — Obsen's remote-deletion handling should use `FileManager.trashFile()`), `hardcoded-config-path` (`Vault#configDir`), `no-global-this` / `prefer-window-timers` / `prefer-active-doc` / `prefer-instanceof` (pop-out-window safety), `no-tfile-tfolder-cast`, `no-unsupported-api` (API calls newer than `minAppVersion`), `validate-manifest`, `validate-license`. The sample scaffold wires this plugin into `npm run lint` and a CI action ([sample README §eslint](https://github.com/obsidianmd/obsidian-sample-plugin#improve-code-quality-with-eslint)).

### 1.6 Sync-plugin-specific: files, consent, and startup

There is no dedicated "sync plugins" policy page. The applicable primary-source rules for a plugin that writes many files:

- **Vault data safety** = the Vault-API guidelines above (serialized ops, atomic `process`, `trashFile`). Nothing in the policies forbids modifying files as the plugin's core disclosed function; the disclosure regime (README explains what the plugin does with the network and why) is the consent mechanism.
- **Startup**: `onload` must stay cheap ([Optimize plugin load time](https://docs.obsidian.md/Plugins/Guides/Optimize+plugin+load+time): registrations only, "should not include anything computationally expensive or data fetching") — so login, socket connect, and initial reconcile all belong in `workspace.onLayoutReady()`.
- **The `vault.on('create')` pitfall** (same page) is the single most sync-relevant line in the docs: *"As part of Obsidian's vault initialization process, it will call `create` for every file."* Obsen's local-watcher registration must be deferred to `onLayoutReady` or every startup would look like a vault-wide creation storm.
- **Unload**: rely on `registerEvent`/`registerInterval` auto-cleanup; never detach leaves in `onunload` (plugin updates reload the plugin — BRAT does this on every beta update, so Obsen's unload path gets exercised constantly during beta).

## 2. BRAT mechanics

Source: [BRAT-DEVELOPER-GUIDE.md](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md) (in-repo, v2.2.0) plus the implementation in [`src/features/BetaPlugins.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/BetaPlugins.ts) and [`src/features/githubUtils.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/githubUtils.ts).

- **Release-asset contract:** identical to Obsidian's own — BRAT downloads `manifest.json`, `main.js`, `styles.css` by exact filename from the release's asset list (`grabReleaseFileFromRepository`: `release.assets.find(a => a.name === fileName)`). A release without `main.js` is rejected: *"The release is not complete and cannot be downloaded"* (`BetaPlugins.ts`). `styles.css` is optional (written only if present).
- **Manifest source of truth:** since v1.1.0 the `manifest.json` is read **from the release assets**, "making BRAT independent of the version numbering in the repository root". `manifest-beta.json` in the repo root is legacy and **ignored** by BRAT ≥ 1.1.0.
- **Tag/version discipline:** BRAT validates release-tag version against the released manifest's version; on mismatch it uses the **tag as source of truth**, overwrites the manifest version, and notifies the user. The guide reiterates that Obsidian requires tag == release name == released-manifest version, "this applies to beta plugins tested with BRAT too".
- **"Latest" resolution:** fetches `GET /repos/{repo}/releases`, sorts by `semver.coerce(tag_name)` descending (date-published fallback for uncoercible tags), and in the install/update path filters with `includePrereleases: true` — so **the GitHub "pre-release" flag does not hide a release from BRAT**; marking betas as pre-release is purely informational (and keeps them out of BRAT's "stable update available" check, which does exclude prereleases). Draft releases never appear (the REST endpoint omits drafts for unauthenticated callers).
- **Frozen versions:** a tracked plugin can pin one specific release tag (`GET /releases/tags/{version}`), "regardless of whether it's marked as a pre-release"; frozen installs are skipped by "update all" runs. Users can switch a pin back to `latest` in BRAT's settings.
- **Update flow to users:** BRAT re-checks tracked (non-frozen) repos on demand or at startup (setting), downloads the newest release's assets, overwrites the plugin folder, and reloads the plugin.
- **Interaction with Obsidian's own updater:** Obsidian checks the `manifest.json` at the repo default-branch HEAD; hence the guide's instruction to **not commit a beta version bump to the default branch** while it's beta-only. And because Obsidian's version comparison ignores prerelease suffixes, a user on `1.0.1-preview.1` will *not* be offered `1.0.1` — only `1.0.2`+ re-engages the official updater (worked example table in the guide). Practical policy for Obsen: betas as `X.Y.Z-beta.N`, and the first directory-visible stable strictly greater than any beta shipped.
- **Mobile:** BRAT itself declares `isDesktopOnly: false` and `minAppVersion: 1.11.4` ([manifest.json](https://github.com/TfTHacker/obsidian42-brat/blob/main/manifest.json)) — it runs on iOS/Android. When a beta plugin's manifest says `isDesktopOnly: true` and the device is mobile, BRAT blocks the install (or, with the "allow incompatible" setting, asks "Do you want to forcefully run it on mobile anyways?") — `BetaPlugins.ts` `Platform.isMobile` branch. Since Obsen is `isDesktopOnly: false`, mobile beta testing through BRAT works with no caveats beyond GitHub API rate limits (60 req/h anonymous; testers can add a `public_repo` PAT for 5000 req/h — guide §Rate Limits).
- **Officially sanctioned:** the Obsidian docs themselves recommend BRAT for beta distribution: *"we recommend that you use the BRAT plugin to distribute your plugin to beta testers before it's been published"* ([Beta-testing plugins](https://docs.obsidian.md/Plugins/Releasing/Beta-testing+plugins)).

## 3. Standard scaffold (obsidianmd/obsidian-sample-plugin)

All from [obsidian-sample-plugin@master](https://github.com/obsidianmd/obsidian-sample-plugin), fetched 2026-07-17.

- **Layout:** `src/main.ts` → bundled to `main.js` at repo root; `manifest.json`, `versions.json`, `styles.css`, `esbuild.config.mjs`, `version-bump.mjs`, `tsconfig.json` at root; `package.json` `"type": "module"`.
- **esbuild** (`esbuild.config.mjs`): `entryPoints: ['src/main.ts']`, `bundle: true`, `format: 'cjs'`, `target: 'es2021'`, `outfile: 'main.js'`, `treeShaking: true`, banner comment, `sourcemap: 'inline'` in dev / `false` in prod, `minify` in prod; watch mode unless `production` argv. **Externals:** `obsidian`, `electron`, all `@codemirror/*` and `@lezer/*` packages, and `...builtinModules` (every Node builtin). No `platform` key (esbuild default `browser`, but with builtins externalized rather than errored).
- **TypeScript** (`tsconfig.json`): `strict: true`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `isolatedModules`, `module: ESNext`, `moduleResolution: node`, `target: ES2021`, `lib: [ES2021, DOM]`, `inlineSourceMap`/`inlineSources`, `skipLibCheck`.
- **npm scripts:** `dev` (esbuild watch), `build` (`tsc -noEmit -skipLibCheck && node esbuild.config.mjs production` — typecheck is part of build), `version` (`node version-bump.mjs && git add manifest.json versions.json`), `lint` (`eslint .` with `eslint-plugin-obsidianmd`).
- **`version-bump.mjs`:** driven by `npm version patch|minor|major`; reads `npm_package_version`, writes it into `manifest.json` `version`, and appends `{targetVersion: minAppVersion}` to `versions.json` if absent. Convention: bump `minAppVersion` by hand first, then `npm version ...` ([sample README](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases)).
- **Release workflow** ([Release your plugin with GitHub Actions](https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions)): trigger `on: push: tags: ["*"]`; ubuntu; `permissions: contents: write`; Node 18.x; `npm install && npm run build`; then `gh release create "$tag" --title="$tag" --draft main.js manifest.json styles.css` with `GITHUB_TOKEN`. Requires repo setting Actions → Workflow permissions → "Read and write". Tag created as annotated tag matching the manifest version. The created release is a **draft** you publish manually after writing notes — remember drafts are invisible to BRAT and Obsidian until published.

### Adaptations for Obsen

1. **Replace the permissive externals with a hard browser gate.** Externalizing `electron` + `builtinModules` makes any Node import a *silent runtime landmine* on mobile instead of a build error. Obsen's build (research 014) should keep `external: ['obsidian', '@codemirror/*', '@lezer/*']` only, set `platform: 'browser'` explicitly, drop `electron` and `builtinModules` from externals, and let the build **fail** on unshimmed Node builtins (with the deliberate `events` alias from research 014 as the sole shim). This is stricter than upstream and is what enforces `isDesktopOnly: false` mechanically.
2. **Keep `format: 'cjs'` and `external: ['obsidian']`** — non-negotiable: Obsidian loads `main.js` as CommonJS and provides the `obsidian` module at runtime.
3. Keep the `tsc -noEmit`-then-esbuild build, the `version-bump.mjs` flow, and `eslint-plugin-obsidianmd` in CI — the lint config doubles as a pre-submission review rehearsal.
4. Pure-TS engine: nothing in the scaffold conflicts; the engine just lives under `src/` and gets bundled. `target: es2021` is safely below any lookbehind-free/iOS floor Obsen needs; consider whether the Filen SDK's output needs a different target (research 014 owns that).
5. Add to the workflow what the sample leaves manual: none required — but note `npm install` (not `ci`) is upstream's choice; using `npm ci` with a committed lockfile is compatible and more reproducible.

## Consequences for the v1 spec (ticket 023)

1. Adopt the compliance checklist above verbatim as spec requirements; wire `eslint-plugin-obsidianmd` (recommended config) into CI from the first commit.
2. Credential design: SecretStorage-backed, `minAppVersion: 1.11.4`, README states where secrets live.
3. README must ship with the first beta (BRAT users read it from the repo): network/account/payment disclosures cost nothing to write now and are mandatory later.
4. Watcher design: local-event registration inside `onLayoutReady`; all startup sync work deferred; unload path exercised on every BRAT update.
5. Release engineering: official GH Actions workflow + `version-bump.mjs`; beta channel = published pre-releases `X.Y.Z-beta.N` with matching tag/name/manifest; root manifest stays at last stable during betas; first stable > every beta.
6. Naming: confirm "Obsen" against the name policy before directory submission (rename is possible post-publication for plugins, so this is not a beta blocker).
7. License: AGPL attribution/compliance for `@filen/sdk` is a policy-level requirement, not just hygiene — ticket 024 gates directory submission.
