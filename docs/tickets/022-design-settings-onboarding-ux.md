---
id: 22
title: "Design: settings and onboarding UX"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: [14, 25]
---

## Question

Specify the user-facing surface (informed by what the client can do, per [014](014-research-sdk-in-obsidian-feasibility.md)):

- Settings tab: login form (email/password/2FA — [009](009-auth-and-credential-storage.md)), logout/re-auth, remote folder picker (browse the Filen tree from within Obsidian?), the dual-engine warning ([010](010-engine-coexistence-topology.md)).
- First-link flow: how the three bootstrap cases ([011](011-first-link-bootstrap.md)) are presented — progress, summary of what will happen, result report.
- Sync feedback: status-bar indicator (idle/syncing/error/offline), notices policy (when to interrupt vs stay quiet), a sync-activity view or log file.
- Error surfacing: auth expiry, quota full, network down — what the user sees and what they're asked to do.

Constraints inherited from [020](020-design-sync-state-schema.md): the folder picker must store the linked Remote Folder by **UUID, not path** (folder UUIDs survive moves/renames; the sync state binds to that UUID); surface the manual **full re-hash recovery command**; and design the "linked folder no longer exists" error state (sync freezes — never mass-deletes).

## Resolution

### Container

The settings tab is a **state machine** — logged out → logged in, unlinked → linked — and is the whole onboarding surface; no wizard. Modals exist only for the folder browser and the First Link gate.

### Login (logged-out state)

- Fields: email; password (masked, eye visibility toggle); a **"My account has 2FA" switch** that reveals a plain (unmasked) 2FA code field. If the user leaves the switch off and the SDK answers "2FA required", the switch flips on, the field appears, and the user re-submits — no dead end.
- Nothing persisted from the form; on success the Auth Config goes to SecretStorage ([025](025-adopt-secretstorage-for-credentials.md)) and the tab enters the logged-in state: "Logged in as \<email\>" + **Logout**. Logout clears SecretStorage and drops the SDK client; it warns when a Remote Folder is linked (sync stops until re-login) but **keeps Sync State** — re-login resumes cleanly, no re-bootstrap.

### Folder picker (logged-in, unlinked state)

- **Modal tree browser** over the Filen tree, starting at root. Tap/click a row **selects** it; a chevron at the row's right edge (desktop bonus: double-click) **navigates into** the folder, replacing the view with its children; the folder currently navigated into is the default selection when no child is selected. "Select this folder" confirms.
- **"New folder"** button at the current level opens a small modal with a name input.
- Selecting the **Filen root is allowed but gated** by an explicit warning modal (confirm / cancel-and-pick-another) — it pours the whole drive into the vault.
- The link stores the folder **UUID** (path is display-only, refreshed when cheaply known; UUID shown as detail) per [020](020-design-sync-state-schema.md).
- **Unlink** drops the link, Sync State, and Shadow Store — all recreatable at next link — and touches no files on either side.

### First Link flow

1. **Static explanation modal**: "we'll scan both sides to compute a preview — nothing syncs in this step", so slow devices/connections don't feel hung before the scan.
2. **Scan with in-modal progress** ("Listing remote folder…", "Hashing local files… 420/953") and a free Cancel (nothing written yet).
3. **Computed dry-run preview** (the planner runs before execution — First Link is Reconcile with empty state per [021](021-design-sync-engine-algorithm.md), so this needs a plan-only engine entry point): counts for upload / download / already-identical / conflict copies, with conflict paths listed when ≤10 ("and N more" beyond); plus the [011](011-first-link-bootstrap.md) rules text and the dual-engine caution. Confirm executes the already-computed plan.
4. **Execution is a normal non-blocking Run** — modal closes, Obsidian stays usable, progress rides the standard status surface. Completion notice with real tallies ("First link complete: 142 uploaded, 38 downloaded, 3 conflict copies"); `conflicts.md` opening ([006](006-conflict-semantics.md)) is the durable report when conflicts exist. No separate report screen.

### Dual-engine warning ([010](010-engine-coexistence-topology.md))

Static one-liner ("Don't sync this vault's folder with the Filen desktop app on this device — one sync engine per folder per device") in **two placements**: a line in the First Link confirmation modal, and a persistent small callout in the linked-state settings, on both platforms.

### Status surface presentation

Fact that shaped this: **Obsidian mobile has no status bar** — status-bar items are desktop-only. Three layers, one source of truth (`idle|syncing|offline|quota|auth-error|frozen`):

1. **Ribbon icon, both platforms** — the universal indicator and the manual-sync trigger ([005](005-sync-triggers.md)): animated while `syncing`, badge/color for attention states (`offline|quota|auth-error|frozen`). Pinnable to the mobile toolbar.
2. **Status-bar item, desktop only** — icon + short text ("Obsen: syncing 12/38"); bonus richness, mobile loses nothing critical.
3. **Settings tab, both platforms** — full picture: current state, last successful sync time, last-run summary, error detail + recovery actions.

### Notices policy

Silent by default; notices fire on **state entry only**, never per retry:

| Event | Notice |
|---|---|
| Automatic runs, clean | never |
| Manual sync completion | one — tally or "Already up to date" |
| `offline` entry / recovery | none (ribbon + backoff handle it) |
| `quota` / `auth-error` entry | one; click opens settings |
| `frozen` entry | one, sticky; click opens settings |
| Conflict copies | none — `conflicts.md` opens instead |
| Skip-and-Surface | none — shown in Recent activity |

### Attention-state flows (in settings)

- **`auth-error`**: callout replaces the logged-in row; login form reappears with **email prefilled**; re-login keeps Sync State and resumes.
- **`quota`**: callout + "Manage storage on filen.io" external link; self-clears on the next successful Run.
- **`frozen`** (Remote Folder deleted/trashed — UUIDs survive moves/renames, so it's really gone): callout explains sync froze *to protect local files*; actions: **"Check again"** (revives the link after a Filen-trash restore; reconcile triggers also auto-thaw) and **"Unlink…"** (into the normal unlink → pick → first-link path; divergence becomes conflict copies). Deliberately no "recreate folder" — a fresh empty folder is a full re-upload masquerading as recovery.

### Activity & troubleshooting

- **Recent activity** section in settings: last ~20 run summaries (trigger, duration, up/down/conflict/skip counts, outcome), newest first, local-only. Skip-and-Surface paths appear here with reasons.
- **Verbose logging** toggle (off by default): timestamped plain-text rolling log, capped and rotated, inside Obsen's plugin folder (on the Exclusion List — never syncs). **"Copy debug info"** button puts recent log + environment facts on the clipboard (mobile-friendly export).
- **Troubleshooting** section: **"Verify and repair (re-hash all files)"** button + palette command — marks the next Run FULL-with-rehash (bypasses the mtime+size cheap path), surfaces the [020](020-design-sync-state-schema.md) recovery command. Safe, never deletes. No separate "reset sync state" button — Unlink is the nuclear path.

### Device name

A user-editable **Device name** setting, defaulted from Obsidian `Platform` flags (Mac / Windows / Linux / iPhone / iPad / Android), stored in local-only plugin data (per-device by nature). Used in conflict-copy filenames; the **exact filename format remains for the spec** ([023](023-write-v1-spec.md)).
