---
id: 6
title: "Conflict semantics: what happens when both sides changed the same file?"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

When a file changed on both sides between syncs: last-writer-wins, conflict copies, interactive merge, or automatic merge?

## Resolution

**Automatic 3-way merge where safe; conflict copies where not. Never last-writer-wins, never a blocking prompt, never guess.**

- **Text files** (`.md`, `.txt`, `.json`, `.canvas`): 3-way merge (diff3-style, e.g. `node-diff3` — pure JS, browser-safe) against the **common ancestor** (the content as of the last successful sync). Clean merge → merged result written to both sides. Overlapping hunks → conflict copy.
- **Binary files**: no merge possible → conflict copy always.
- **No ancestor available** (e.g. first link): conflict copy — never guess.

**`conflicts.md` manifest (user decision):** whenever a conflict copy is created — during first link or a failed auto-merge — Obsen appends a row to `conflicts.md` at the vault root: a two-column table of wikilinks, original file | conflict copy, so each diff is one click away. **When the manifest is created (first conflict), Obsen immediately opens it in Obsidian** so the user knows a conflict just happened — conflicts must never be silent. It is a normal note (it syncs); the user clears rows/file as conflicts are resolved.

Open dependency: **where the ancestor comes from** (local shadow store vs Filen file versioning) is a frontier research ticket. Conflict-copy naming convention (timestamp + device name) is a spec-writing detail.
