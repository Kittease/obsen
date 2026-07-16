# Obsen — agent guide

Obsen is an Obsidian ↔ Filen two-way sync plugin (desktop AND mobile). Work is driven by the wayfinder map at `docs/map.md` — read it before doing anything; the domain glossary is `CONTEXT.md`.

## Privacy

This repo is public from day one and open-source by design — anyone may read it or open a PR. Never write personal details into repo files: no emails, no personal account references, no credentials or tokens. Automated tests use a dedicated Filen test account, never a personal one.

One deliberate exception: ticket `assignee` fields in `docs/tickets/` use the claiming user's git email (`git config user.email`) — that identity is already public in the commit history, so it reveals nothing new.

## Commit convention

Combine **Gitmoji + Conventional Commits**, in that order:

```
<gitmoji> <type>(<scope>)?: <subject>
```

- `<gitmoji>`: the actual emoji character (not `:shortcode:`) from https://gitmoji.dev, matching the change (✨ feat, 🐛 fix, 📝 docs, ♻️ refactor, ✅ tests, 🎉 first commit, …).
- `<type>`: Conventional Commits type (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`). Scope optional.
- `<subject>`: imperative, lowercase, no trailing period.
- **Subject line only — never write a commit body or footers.**
- **Never add a co-author** (no `Co-Authored-By:` trailer of any kind).

Example: `✨ feat(engine): pair renamed files by content hash at reconcile`
