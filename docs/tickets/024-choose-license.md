---
id: 24
title: "Choose Obsen's license under the AGPL-3.0 SDK constraint"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

The SDK feasibility research ([014](014-research-sdk-in-obsidian-feasibility.md)) confirmed `@filen/sdk` is **AGPL-3.0**, and Obsen bundles it into its distributed `main.js`. That constrains Obsen's own license: it must be AGPL-compatible, and the combined distributed work is effectively AGPL-governed.

Decide:

- What license does Obsen adopt? (AGPL-3.0 itself is the obvious candidate; is there any reason to prefer a permissive license for Obsen's own code while acknowledging the combined work is AGPL?)
- Does AGPL raise any friction with Obsidian community-directory submission or BRAT distribution (check against the [017](017-research-plugin-guidelines-and-brat.md) compliance findings)?
- What must the README/manifest state about licensing?

The answer lands in the spec's distribution/compliance section ([023](023-write-v1-spec.md)).

## Resolution

**Obsen is licensed AGPL-3.0-only, single license for the whole repo.**

- **Why not MIT-for-own-code + AGPL bundle:** legally sound (MIT is AGPL-compatible; the SDK stays AGPL regardless and is only combined at build time into `main.js`), but it buys nothing unless closed-source reuse of the engine is a goal — and it costs a two-license story to explain at directory review. The engine-reuse scenario is hypothetical; as sole copyright holder the dev can relicense their own code later if it ever materializes.
- **Why `-only` not `-or-later`:** no pre-commitment to unread future AGPL terms; a solo maintainer with full copyright can adopt a future version deliberately if desired. Compatibility with the SDK's deprecated `AGPL-3.0` identifier is unaffected either way.
- **Distribution friction: none.** Obsidian developer policies require a root LICENSE and compliance/attribution for incorporated code but don't restrict license choice; BRAT is license-agnostic; AGPL's source obligation is satisfied because releases are built from the public repo and BRAT's tag == manifest-version convention pins each release to its exact source commit.
- **Compliance package (lands in the spec's distribution/compliance section, [023](023-write-v1-spec.md)):**
  1. `LICENSE` at repo root — verbatim AGPL-3.0 text.
  2. `package.json`: `"license": "AGPL-3.0-only"`.
  3. `manifest.json`: nothing — the Obsidian manifest schema has no license field.
  4. README "License" section: Obsen is AGPL-3.0-only; the distributed `main.js` bundles [`@filen/sdk`](https://github.com/FilenCloudDienste/filen-sdk-ts) (AGPL-3.0) — this is the Obsidian-policy attribution; source for every release is the tagged commit in this repo.
  5. No per-file license headers — root LICENSE + package.json declaration suffice.
