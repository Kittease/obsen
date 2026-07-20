# Obsen spike — ticket 019 (THROWAWAY PROTOTYPE)

> **This is not production code.** It exists to answer one question and will be
> deleted once [ticket 019](../../docs/tickets/019-prototype-on-device-spike.md)
> is resolved.

**Question:** does the `@filen/sdk` browser build (per the
[014 research](../../docs/research/014-sdk-in-obsidian-feasibility.md)) actually
work on a real phone inside Obsidian — login, list, E2EE upload/download
round-trip, `visibilitychange` on foreground-resume?

## What it does

A minimal Obsidian plugin bundling `@filen/sdk@0.4.2` with the exact esbuild
recipe from the 014 research (browser platform, 8 shims, Buffer/process inject).

- **Settings tab**: Filen email / password / 2FA login. On success the SDK auth
  config (API key, master keys — never the password) is persisted to the
  plugin's `data.json` (plaintext — acceptable for a throwaway spike only).
- **Command "Run spike"** (also a settings button): lists the remote root,
  creates `/obsen-spike` remotely, uploads `obsen-spike-upload.md` from the
  vault, downloads it back, byte-compares, and writes the downloaded copy to
  `obsen-spike-download.md` in the vault.
- **Command "Transfer test"**: round-trips an 8 MiB random binary to observe
  E2EE transfer speed and memory behavior.
- **`visibilitychange`** events are logged with a Notice, to verify
  foreground-resume detection fires on iOS/Android.
- Everything is appended to **`obsen-spike-log.md`** at the vault root — read or
  paste that note to report results.

## Install on a phone (BRAT)

1. Install & enable **BRAT** from the community directory.
2. BRAT → *Add beta plugin* → repo `<owner>/obsen` → pick the `0.0.1-spike.1`
   release → enable **Obsen Spike**.
3. Follow the test protocol in
   [ticket 019](../../docs/tickets/019-prototype-on-device-spike.md).

Use a **test vault** and (ideally) the dedicated Filen test account.

## Build

```sh
npm install
npm run build   # produces main.js next to manifest.json
```

`npm run smoke` load-tests the bundle in Node with a stubbed `obsidian` module.
