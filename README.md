# Obsen — Obsidian ↔ Filen two-way sync

Obsen syncs an Obsidian vault with one folder on [Filen](https://filen.io), end-to-end
encrypted, in both directions, on **every platform Obsidian runs on** — Windows, macOS,
Linux, **Android and iOS**.

Mobile is the reason Obsen exists: on desktop, Filen's own app already syncs a local
folder; on mobile it cannot.

> **Status: in development.** The design is settled — see [the v1 spec](docs/specs/obsen-v1.md) —
> and implementation is under way against the ticket backlog in [`docs/tickets/`](docs/tickets/).
> There is no release to install yet. Do not point Obsen at a vault you have not backed up.

## How it works

- One vault ↔ one Filen folder. `.obsidian/` syncs too, so settings and plugins follow you
  across devices (minus workspace layout files and Obsen's own per-device state).
- Sync runs on startup, when the app returns to the foreground, when files change, when
  Filen pushes a change over its socket, and whenever you ask it to. There is no periodic
  polling, and — an OS limitation no plugin can lift — **no background sync on mobile**:
  sync happens while Obsidian is open.
- Concurrent edits to a note are merged three-way against the last-synced version. When a
  merge is unsafe, Obsen writes a **conflict copy** next to the file and logs it in
  `conflicts.md` at the vault root, so a conflict is never silent and never overwrites.
- Deletions are soft: files go to Obsidian's trash locally and to Filen's trash remotely,
  never straight to permanent deletion. An edit always beats a delete.

## Requirements

- Obsidian **1.11.4** or newer (Obsen stores credentials in Obsidian's SecretStorage, which
  arrived in that version).
- **A Filen account is required.** Obsen is a client for your own Filen storage; it is not
  a storage provider and has no accounts, servers, or backend of its own.

## Install

Not yet released. When the first beta ships it will be installable with
[BRAT](https://github.com/TfTHacker/obsidian42-brat) (**Add beta plugin** → `Kittease/obsen`),
on desktop and mobile alike. Obsen is not in the community plugin directory yet.

## Disclosures

### Network use

Obsen talks to Filen and to **no other server** — no analytics endpoint, no update check, no
third party:

| Host | Why it is contacted |
|---|---|
| `gateway.filen.io` | Filen's HTTP API: login, folder listings, moves, renames, trash |
| `ingest.filen.io` | uploading encrypted file chunks |
| `egest.filen.io` | downloading encrypted file chunks |
| `socket.filen.io` | Filen's WebSocket, so remote changes arrive without polling |

Nothing is contacted until you log in and link a folder.

### Payment

A Filen account is needed, and Filen's **free tier** is enough to use Obsen. Storage beyond
that tier is a paid Filen plan — a Filen matter, unrelated to Obsen, which is free and has
no paid features, ads, or upsells.

### Credentials

Your Filen email, password and 2FA code are used once, to log in, and are **never stored**.
What Obsen keeps is the derived auth material (API key and master keys) that the Filen SDK
needs to stay logged in. It is written to **Obsidian's SecretStorage**, scoped to this vault
and held outside the vault folder — so no vault sync or backup tool (git, iCloud, Syncthing,
Obsidian Sync) can ever carry your keys off the device, and Obsen never sends them anywhere
except to Filen.

**Residual risk, stated plainly:** SecretStorage is not documented as encrypted at rest.
Someone with access to your device or its disk may be able to extract those keys. Protect
the device, and consider enabling 2FA on your Filen account.

### Supported setup

**One sync engine per folder per device.** Different devices may each run Obsen against the
same Filen folder — that is the point. What is *not* supported is two engines fighting over
the same files on one device: do not have the Filen desktop app sync the same local folder
that Obsen is syncing. Obsen cannot detect this, and the result is a loop of mutual
overwrites.

### What Obsen does not do

- No telemetry, analytics, or crash reporting.
- No ads, sponsored content, or paid features.
- No self-updating: Obsidian and BRAT are the only update mechanisms.
- No obfuscated or remotely-loaded code — every released `main.js` is built from the source at
  the commit its tag points at, with the build in this repo.
- No file access outside your vault, apart from Obsidian's own credential storage.

## Development

```sh
npm install
npm run dev        # watch build into main.js
npm run verify     # lint + typecheck + unit tests + mobile-safety gate
```

`npm run gate` is the mobile-safety gate: it bundles the plugin with esbuild's browser
platform, so any Node built-in reaching the bundle — from Obsen or from a dependency — is a
build error rather than a crash on a phone, and it evaluates the built `main.js` in a
webview-like sandbox with no Node globals at all. Run it on every `@filen/sdk` bump.

### The real-remote test suite

```sh
npm run test:remote
```

This one talks to Filen for real, to check that the assumptions Obsen's sync algorithm
rests on are still true — that a content update mints a new file id, that a rename keeps
it, that the content hash Filen stores is the one Obsen computes. Without credentials it
skips itself, which is what it does on every fork pull request.

**Use a dedicated Filen account — never your own.** Everything the suite does happens
inside `/obsen-tests/run-<timestamp>-<random>`, and teardown permanently removes that
folder and the trashed items that came out of it — nothing else on the account is read or
written. Turn 2FA **off** on that account (the SDK sends a placeholder code).

Credentials come from the environment, or from a `.env` file at the repo root if you make
one (git-ignored, and `npm run test:remote` reads it automatically):

```sh
FILEN_TEST_EMAIL=…
FILEN_TEST_PASSWORD=…
```

In CI the same two values come from repository secrets of the same names. Note that Filen's
ingest host occasionally answers `Internal error` under repeated runs; the suite does not
retry, so re-run a red one before believing it.

## License

Obsen is licensed **AGPL-3.0-only** — see [`LICENSE`](LICENSE) for the full text. The
distributed `main.js` bundles [`@filen/sdk`](https://github.com/FilenCloudDienste/filen-sdk-ts),
which is also AGPL-3.0. The complete source for any release is the commit its tag points at.
