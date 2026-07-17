---
title: "Research: integration test harness for desktop and mobile-emulated paths"
ticket: 18
labels: [wayfinder:research]
---

# What integration harness can an agent actually run above the engine layer?

Researched against primary sources only: the [wdio-obsidian-service](https://github.com/jesse-r-s-hines/wdio-obsidian-service) repo (source, own CI workflows, docs site) and its [sample plugin template](https://github.com/jesse-r-s-hines/wdio-obsidian-service-sample-plugin), the official Obsidian docs and `obsidian-api`/`obsidian-help` repos, and Filen's own repos ([filen-sdk-ts](https://github.com/FilenCloudDienste/filen-sdk-ts), [filen-cli](https://github.com/FilenCloudDienste/filen-cli)) plus filen.io first-party pages. Builds on research [014](014-sdk-in-obsidian-feasibility.md) (SDK browser build) and [016](016-filen-socket-events.md) (socket events); facts established there are reused, not re-derived.

## Verdict

**All four layers exist and are agent-runnable except the last.** `wdio-obsidian-service` drives real, sandboxed Obsidian desktop with the plugin installed, gives tests direct access to the plugin instance and vault files, runs under Xvfb on Linux CI (no true headless — it's Electron), and has a first-class `emulateMobile` mode plus real-Android-app testing via Appium. Mobile emulation flips Obsidian's UI-mode flags only — Node/Electron APIs stay available — so it validates mobile *UI/UX paths*, while the 013 browser-only esbuild gate remains the mechanical catch for Node-API leaks. Real-remote Filen testing from plain Node/vitest against a dedicated free account is exactly how Filen tests its own SDK and CLI in CI (email+password secrets, 2FA off, fixed test folder wiped at setup); a 10 GB free account is ample for a sync test suite. Only real-device behavior (iOS above all — no automated iOS path exists) stays HITL.

---

## 1. `wdio-obsidian-service`: real Obsidian, driven by tests

Three npm packages in one repo ([README](https://github.com/jesse-r-s-hines/wdio-obsidian-service)): `wdio-obsidian-service` (the WebdriverIO service), `obsidian-launcher` (downloads/launches Obsidian versions), `wdio-obsidian-reporter` (spec reporter that prints the Obsidian version instead of the Chromium version).

### Headless / CI / local

- **No true headless.** Obsidian is Electron; there is no headless flag. The package's own CI ([`.github/workflows/test.yaml`](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/.github/workflows/test.yaml)) and the [sample plugin's test workflow](https://github.com/jesse-r-s-hines/wdio-obsidian-service-sample-plugin/blob/main/.github/workflows/test.yaml) run Linux under a virtual display: `Xvfb :99 -screen 0 1280x1024x24 +extension GLX` **plus a window manager** (`herbstluftwm` — the workflow comment warns "some Obsidian features won't work properly without it"), with `DISPLAY=:99` exported. On Linux the service also passes `--no-sandbox` to Electron (`packages/wdio-obsidian-service/src/service.ts:262`).
- **Own CI matrix:** `ubuntu-latest`, `ubuntu-24.04-arm`, `windows-latest`, `macos-latest`, plus an Android-emulator job — so macOS and Windows CI need no display setup (windowed run on the runner).
- **Locally**, an agent runs `wdio run ./wdio.conf.mts` directly; on macOS this opens real Obsidian windows (works unattended, just not invisible). On a Linux box without a display, the same Xvfb+WM recipe applies (`xvfb-run` alone can miss the WM caveat above).
- **Parallelism:** `maxInstances` controls concurrent sandboxed Obsidian instances; the sample workflow sets `WDIO_MAX_INSTANCES: 2` for 2-core GitHub runners.

### Sandboxing, vaults, plugin install

- Every test session gets a **temporary copy of the vault** and an **isolated Obsidian config dir**; both are tracked and deleted at teardown (`service.ts` `tmpDirs`). Tests never touch the system Obsidian or the original vault. `reloadObsidian({vault, copy})` defaults to `copy: true`; `copy: false` exists for read-only runs on large vaults but is documented as unsafe in parallel ([`browserCommands.ts`](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/src/browserCommands.ts) doc comment).
- **Vault reset between tests, two speeds** ([service README](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/README.md)): `browser.reloadObsidian({vault})` reboots Obsidian with a fresh vault copy (slow, full reset incl. config); `obsidianPage.resetVault()` rewrites vault files in place without rebooting (fast, for `beforeEach`), and can also load a *different* fixture vault's files.
- **Plugin under test:** `'wdio:obsidianOptions': { plugins: ["."] }` installs the built plugin from the repo root into the sandbox vault. Other plugins install by local path, `repo:<github>`, or `id:<community-id>` (with `@version`) — [obsidian-launcher README](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/obsidian-launcher/README.md). Themes likewise.

### Can tests create vault files and assert on plugin behavior? Yes, directly.

- `browser.executeObsidian(({app, obsidian, plugins}, ...args) => ...)` stringifies a function and runs it **inside** Obsidian with the `App` instance, the full `obsidian` module, and an `plugins` map of installed plugin instances (id camelCased) — i.e. tests can call Obsen's own public methods and read its state (`browserCommands.ts:6-78,166-199`; typed plugin access via a `InstalledPlugins` module augmentation).
- `browser.executeObsidianCommand("plugin-id:command-id")` runs any registered command (`browserCommands.ts:84`).
- `obsidianPage` file helpers operate on the sandbox vault: `read`, `readBinary`, `write` (creates parent dirs), `mkdir`, `delete`, plus `openFile`, `enablePlugin`/`disablePlugin`, `setTheme`, `loadWorkspaceLayout`, `getVaultPath`, `getPlatform`, `runObsidianCli` ([`obsidianPage.ts`](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/src/pageobjects/obsidianPage.ts)).
- All of WebdriverIO's DOM assertions remain available for UI checks (modals, status bar, settings tab).

### Version matrix and download caching

- Obsidian ships as **installer** (Electron binary) + **app** (JS bundle, what auto-update replaces), and the service can pin both independently: `browserVersion`/`appVersion` = exact version | `"latest"` | `"latest-beta"` | `"earliest"` (= `minAppVersion` from `manifest.json`); `installerVersion` = exact | `"latest"` | `"earliest"` compatible ([service README, "App vs Installer Versions"](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/README.md)). The canonical matrix is `["earliest","earliest"]` + `["latest","latest"]` + `["latest-beta","latest"]` when `obsidianBetaAvailable()`.
- **Beta downloads need an Obsidian Insiders (Catalyst) account** via `OBSIDIAN_EMAIL`/`OBSIDIAN_PASSWORD` env vars, **2FA disabled** — the README suggests a dedicated second account for CI.
- Downloads are cached in `cacheDir` (`.obsidian-cache`, or `OBSIDIAN_CACHE` env var, default `~/.obsidian-cache`). The sample workflow caches it with `actions/cache@v4`, keyed on the resolved version list (`wdio.conf.mts` prints an `obsidian-cache-key` line under `process.env.CI`).

### Companion packages

- **`obsidian-launcher`**: the download/launch engine, also a standalone CLI. `npx obsidian-launcher watch --copy --plugin . <vault>` launches a sandboxed Obsidian with the plugin installed and **hot-reload on rebuild** (auto-installs `pjeby/hot-reload`) — ideal for an agent's local dev loop outside the test runner. `download` can prefetch `app`/`installer`/`desktop`/**`apk`** assets per platform/arch.
- **`wdio-obsidian-reporter`**: cosmetic but useful in a version matrix — reports which Obsidian version each spec ran under.

---

## 2. Mobile emulation: what it is, what it is not

### The mechanism

- Official API: `this.app.emulateMobile(true)` / `(false)`, toggle via `this.app.emulateMobile(!this.app.isMobile)` — [docs.obsidian.md "Mobile development" page](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development); introduced in Obsidian v0.11.11 ([obsidian-help release notes](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v0.11.11.md)). It is not part of the public `obsidian.d.ts`.
- Under the hood it just persists a localStorage flag: *"`app.emulateMobile` just sets this localStorage variable"* — wdio-obsidian-service seeds `localStorage: {"EmulateMobile": "1"}` instead of calling the API (`service.ts:362-364`).
- **What flips:** Obsidian switches the UI into mobile mode, and the UI-mode platform flags follow — `Platform.isDesktop` / `Platform.isMobile` are documented as "The UI is in desktop/mobile mode" as distinct from `Platform.isMobileApp` "We're running the capacitor-js mobile app" ([obsidian-api `obsidian.d.ts:4825-4863`](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)). `isPhone`/`isTablet` derive from screen space. (Exact flag values under emulation are inferred from those doc comments; the UI-mode vs app-flag split is the API's own distinction.)
- **What does NOT flip:** you are still in Electron — `Platform.isDesktopApp` semantics, and crucially **Node and Electron APIs remain available**. The official docs page's only stated caveat is exactly this: "The Node.js API and the Electron API aren't available on mobile devices." Emulation therefore *cannot* catch accidental Node-API usage — the browser-only esbuild bundle gate from ticket [013](../tickets/013-testability-architecture.md) is the mechanical guard for that.

### wdio support: emulation and real Android

- **Emulation is a one-liner capability**: `'wdio:obsidianOptions': { emulateMobile: true }`, optionally with Chrome's `mobileEmulation.deviceMetrics` for a phone-sized viewport ([service README, "Mobile Emulation"](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/README.md)). The README is explicit about limits: "The real Obsidian mobile app runs on Capacitor.js instead of Electron, so there are various platform differences that can't be properly emulated this way."
- **Real mobile app on Android**: supported via Appium + `appium-uiautomator2-driver` + an AVD named `obsidian_test`; the service downloads the real Obsidian **APK** (obsidian-launcher `download apk`) and installs it in the emulator. `maxInstances: 1` (no parallel Android). The sample plugin ships a working GitHub Actions job (`reactivecircus/android-emulator-runner@v2`, API 36, x86_64, KVM enabled, AVD cache). **iOS is not supported** ("Testing on iOS is currently not supported", service README).

### Residual risk emulation cannot catch (and Android emulator only partly)

Desktop emulation runs Chromium/Electron; Android runs a Chromium webview. The gaps that only real devices — above all iOS — reveal:

1. **iOS WebKit engine differences**: JS feature/perf differences vs Chromium (JIT restrictions in webviews, WebCrypto/argon2 performance for login key derivation), historically lagging regex features, IndexedDB/localStorage eviction policies under storage pressure.
2. **Capacitor filesystem semantics**: Obsidian mobile's vault adapter sits on Capacitor, not Node `fs` — path handling, case sensitivity, mtime precision can differ from anything emulation shows.
3. **Memory ceilings**: research 014's watch-list item — whole-file buffering on big attachments can OOM a phone webview where desktop shrugs.
4. **App lifecycle**: OS suspension mid-sync (sockets killed, timers frozen), foreground-resume reconcile, iOS background execution limits — research 016 already mandates reconcile-on-resume, but only a device proves it.
5. **UI on real hardware**: on-screen keyboard overlaying modals, safe-area insets, touch targets.
6. **Network stack**: cellular/Wi-Fi transitions, captive portals, OS-level connection kills — different from desktop's network stack.

---

## 3. Real-remote suite against Filen

### Prior art: Filen tests its own SDK exactly this way

`filen-sdk-ts` runs **vitest integration tests against the production API on every push** ([`tests/`](https://github.com/FilenCloudDienste/filen-sdk-ts/tree/main/tests), [`.github/workflows/tests.yml`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/.github/workflows/tests.yml)):

- **Auth**: `sdk.login({ email: process.env.TEST_ACC_EMAIL, password: process.env.TEST_ACC_PASS })` — email+password only, from GitHub Actions secrets (`tests/sdk.ts`); a V2/V3 encryption matrix uses two separate test accounts (`V2_TEST_ACC_*` / `V3_TEST_ACC_*` secrets), `ubuntu-latest`, Node 20.
- **Isolation**: global setup wipes and recreates a fixed folder (`sdk.fs().rm({path: "/ts"})` → `mkdir`) and calls `sdk.cloud().emptyTrash()`; teardown re-seeds fixture files (`tests/setup.ts`).
- **Serialization + generous timeouts**: vitest `singleThread: true`, `testTimeout: 1200000` (20 min) (`vitest.config.ts`).
- `filen-cli` does the same: real-account tests in CI with `FILEN_CLI_TESTING_EMAIL`/`_PASSWORD` mapped from the same secrets ([`.github/workflows/test.yml`](https://github.com/FilenCloudDienste/filen-cli/blob/main/.github/workflows/test.yml)).

So the pattern Obsen needs — plain Node/vitest + `@filen/sdk` + a dedicated test account, credentials in env vars/CI secrets — is Filen's own first-party practice. Login, upload, download, move/rename, trash, versions, and socket connect are all exercisable this way (surfaces verified in research [014](014-sdk-in-obsidian-feasibility.md); socket protocol and event catalog in [016](016-filen-socket-events.md); Filen's own `tests/cloud.test.ts`/`fs.test.ts` exercise the cloud/fs surfaces against production).

### Credentials and 2FA

- `sdk.login({email, password, twoFactorCode})` sends the placeholder `"XXXXXX"` when no code is given — the SDK's own doc comment: *"Send 'XXXXXX' as the twoFactorCode when 2FA is disabled"* ([`src/api/v3/login.ts:37`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/v3/login.ts), placeholder default also in [`src/index.ts:631`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/index.ts)). **2FA must be OFF on the test account** for non-interactive login (generating TOTP codes from a stored secret is technically possible but pointless complexity for a dedicated test account holding disposable data).
- Alternatively, log in once and persist `sdk.config` (apiKey + master keys — the "Auth Config" pattern from 014) as a single CI secret, skipping login entirely per run.

### Free-tier constraints

- **10 GB free storage** — but Filen now gates free-signup eligibility with an automated network classification at registration: signups from VPN/proxy/datacenter-looking connections don't get the free 10 GB ([filen.io hub: "An Update on Free Account Creation"](https://filen.io/hub/an-update-on-free-account-creation/), ["Free 10 GB at Signup: Eligibility Check"](https://filen.io/hub/free-10-gb-at-signup-eligibility-check-before-creating-an-account/)). **Create the test account manually from a normal consumer connection**, not from CI/cloud. Using the account from CI afterwards is what Filen itself does. The [pricing page](https://filen.io/pricing) lists only paid tiers (Pro I 200 GiB €1.99/mo …), all with "unlimited bandwidth".
- **No documented numeric API rate limits found** in the SDK source, [filen-docs](https://github.com/FilenCloudDienste/filen-docs), or the pricing page. The SDK's client self-limits and self-heals: max **32 concurrent API requests** (`requestSemaphore = new Semaphore(32)`, [`src/api/client.ts:104`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/client.ts)); any non-200 response (including hypothetical 429s) is retried after a 1 s sleep up to **3600 tries** (`APIClientDefaults` `maxRetries: 3600`, `retryTimeout: 1000`, `client.ts:90-91`; API-level errors with `status: false` throw immediately). Transfer concurrency defaults ([`src/constants.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/constants.ts)): `MAX_CONCURRENT_UPLOADS 8`, `MAX_UPLOAD_THREADS 16`, `MAX_CONCURRENT_DOWNLOADS 16`, `MAX_DOWNLOAD_THREADS 32`, `MAX_CONCURRENT_DIRECTORY_UPLOADS/DOWNLOADS 2`, `MAX_CONCURRENT_LISTING_OPS 128`. Filen running its full suite on every push/PR is de-facto evidence that CI-driven test traffic is tolerated.

### Test isolation pattern for Obsen

Filen's fixed-folder-wipe works for one serialized CI pipeline, but Obsen's suite may run from several places (agent sandbox, CI, developer machine) concurrently. Recommended pattern:

1. **Per-run subfolder**: create `/obsen-tests/run-<ISO-timestamp>-<random>` at suite start; all fixtures live under it. Runs never collide.
2. **Cleanup at end**: trash (or permanently delete) the run folder in global teardown; `emptyTrash()` periodically so trash doesn't eat the 10 GB quota.
3. **Leak sweep at start**: before creating the new run folder, list `/obsen-tests/` and trash any `run-*` folder whose embedded timestamp is older than N hours (e.g. 6) — self-healing cleanup for crashed runs. (`emptyTrash` is account-wide and instant, as used in Filen's own setup.)
4. **Serialize within a run** (vitest `singleThread` like Filen) and keep payloads small (KBs–MBs); the suite then fits comfortably in the free quota and completes in minutes.
5. **Gate on env**: skip the whole suite when `FILEN_TEST_EMAIL`/`FILEN_TEST_PASSWORD` are absent (fork PRs don't receive GitHub secrets — the sample plugin workflow notes the same for Obsidian creds), and never log credentials or account identifiers.

Socket events are testable in the same suite: connect `sdk.socket` with the apiKey (016 §6), drive a change via the SDK, assert the corresponding event arrives — with generous timeouts and the 016 caveat that delivery is best-effort (don't write flaky assertions on exact event counts).

---

## 4. What remains HITL on-device only

Manual checklist for the spec (real iPhone + real Android phone, real Filen account):

1. **First-run experience**: install via BRAT/community list, login form with the on-screen keyboard (field visibility, password-manager autofill, safe-area), first-link bootstrap of an existing vault.
2. **Backgrounding mid-sync**: start a large sync, background the app, wait past OS suspension, foreground — socket reconnects, reconcile-on-resume converges, no duplicate/partial writes.
3. **Offline transitions**: airplane mode mid-sync and at launch; edits made offline sync correctly on reconnect; Wi-Fi↔cellular handoff.
4. **Large-vault performance on device**: initial reconcile time, UI responsiveness during sync, memory behavior with the largest supported attachment (014 watch list: whole-file buffering).
5. **iOS specifically** (no automated path exists): everything above, plus login key-derivation time (argon2/PBKDF2 under WebKit), long-session socket stability, storage eviction of plugin state after the OS reclaims space.
6. **Battery/network budget**: overnight idle with the plugin enabled — no runaway polling, acceptable battery drain, no cellular-data surprises.
7. **Conflict UX on a small screen**: whatever conflict resolution UI the spec defines, exercised by producing a real conflict between desktop and phone.

---

## Recommended harness stack

| Layer | Tooling | Runs where | Who runs it |
|---|---|---|---|
| 1. Engine unit tests | vitest + in-memory `VaultPort`/`RemotePort` fakes (ticket 013) | anywhere, headless, seconds | **agent sandbox**, every change |
| 2. Mobile-safety gate | `esbuild --platform=browser` bundle build (013/014) | anywhere, headless | **agent sandbox**, every change |
| 3. Obsidian integration | `wdio-obsidian-service`, plugin installed via `plugins: ["."]`, fixture vaults + `resetVault()`, assertions via `executeObsidian`/`obsidianPage`; capability matrix = {earliest, latest} × {desktop, `emulateMobile: true`} | local macOS (windowed) or Linux+Xvfb+WM; CI ubuntu with the sample plugin's proven workflow (`.obsidian-cache` cached) | **agent locally** (needs a display or Xvfb — fine in practice, not truly headless) + **CI** |
| 4. Real-remote Filen suite | plain Node vitest + `@filen/sdk`, dedicated free 10 GB test account (2FA off), per-run subfolder + stale-run sweep, creds via env/GitHub secrets, skipped when creds absent | anywhere with network + creds | **agent sandbox** (if given creds) + **CI** (secrets; not on fork PRs) |
| 5. Real Android app (optional, later) | wdio Appium job, real Obsidian APK in AVD (sample plugin workflow) | CI ubuntu w/ KVM, `maxInstances: 1`, slow | **CI nightly/pre-release**, not per-PR |
| 6. On-device manual checklist | §4 above, real iOS + Android | physical devices | **HITL (user)**, per release |

Notes for the spec:

- Layers 1–2 are the inner loop; 3–4 the pre-merge loop; 5–6 release gates.
- In layer 3, the wdio suite should mostly exercise the plugin against a **fake/stub RemotePort** (UI, lifecycle, vault-event handling); keep one small smoke spec that wires real Obsidian to the real Filen test account end-to-end — the only place all layers meet, so keep it minimal to stay fast and quota-friendly.
- `emulateMobile` in layer 3 validates mobile **UI-mode code paths** (`Platform.isMobile` branches, phone-sized layout); it deliberately proves nothing about Node-API absence (layer 2's job) or Capacitor/WebKit behavior (layers 5–6).
- Two dedicated accounts, both with 2FA off, both living only in CI secrets/env: the Filen test account (data plane) and — only if beta-version testing is ever wanted — an Obsidian Catalyst account for `latest-beta` downloads.

## Sources

- wdio-obsidian-service: [repo + README](https://github.com/jesse-r-s-hines/wdio-obsidian-service) · [service README](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/README.md) · [own CI `test.yaml`](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/.github/workflows/test.yaml) · [`browserCommands.ts`](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/src/browserCommands.ts) · [`obsidianPage.ts`](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/src/pageobjects/obsidianPage.ts) · [`service.ts`](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/wdio-obsidian-service/src/service.ts) (EmulateMobile localStorage, `--no-sandbox`, tmpDir cleanup) · [obsidian-launcher README](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/main/packages/obsidian-launcher/README.md) · [docs site](https://jesse-r-s-hines.github.io/wdio-obsidian-service/wdio-obsidian-service/README.html)
- Sample plugin template: [repo](https://github.com/jesse-r-s-hines/wdio-obsidian-service-sample-plugin) · [CI `test.yaml`](https://github.com/jesse-r-s-hines/wdio-obsidian-service-sample-plugin/blob/main/.github/workflows/test.yaml) (Xvfb+herbstluftwm recipe, cache keying, Android emulator job)
- Obsidian: [Mobile development docs page](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development) · [v0.11.11 release notes](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v0.11.11.md) (emulateMobile introduction) · [`obsidian.d.ts` Platform flags](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) (lines ~4825–4863)
- Filen SDK tests/CI: [`tests/sdk.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/tests/sdk.ts) · [`tests/setup.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/tests/setup.ts) · [`vitest.config.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/vitest.config.ts) · [`.github/workflows/tests.yml`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/.github/workflows/tests.yml) · [filen-cli `.github/workflows/test.yml`](https://github.com/FilenCloudDienste/filen-cli/blob/main/.github/workflows/test.yml)
- Filen SDK source: [`src/api/v3/login.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/v3/login.ts) ("XXXXXX" 2FA placeholder) · [`src/index.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/index.ts) (`login()`) · [`src/api/client.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/api/client.ts) (Semaphore(32), retry loop) · [`src/constants.ts`](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/main/src/constants.ts) (concurrency defaults)
- Filen first-party pages: [pricing](https://filen.io/pricing) · [An Update on Free Account Creation](https://filen.io/hub/an-update-on-free-account-creation/) · [Free 10 GB at Signup: Eligibility Check](https://filen.io/hub/free-10-gb-at-signup-eligibility-check-before-creating-an-account/)
- Obsen prior research: [014 SDK-in-Obsidian feasibility](014-sdk-in-obsidian-feasibility.md) · [016 Filen socket events](016-filen-socket-events.md)
