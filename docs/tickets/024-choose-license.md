---
id: 24
title: "Choose Obsen's license under the AGPL-3.0 SDK constraint"
labels: [wayfinder:grilling]
status: open
assignee:
blocked_by: []
---

## Question

The SDK feasibility research ([014](014-research-sdk-in-obsidian-feasibility.md)) confirmed `@filen/sdk` is **AGPL-3.0**, and Obsen bundles it into its distributed `main.js`. That constrains Obsen's own license: it must be AGPL-compatible, and the combined distributed work is effectively AGPL-governed.

Decide:

- What license does Obsen adopt? (AGPL-3.0 itself is the obvious candidate; is there any reason to prefer a permissive license for Obsen's own code while acknowledging the combined work is AGPL?)
- Does AGPL raise any friction with Obsidian community-directory submission or BRAT distribution (check against the [017](017-research-plugin-guidelines-and-brat.md) compliance findings)?
- What must the README/manifest state about licensing?

The answer lands in the spec's distribution/compliance section ([023](023-write-v1-spec.md)).
