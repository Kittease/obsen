---
id: 13
title: "Testability architecture: the engine must be testable by an agent"
labels: [wayfinder:grilling]
status: closed
assignee: camercey@gmail.com
blocked_by: []
---

## Question

The plugin will be specced and implemented with agent help; the agent must be able to test its own code, covering both desktop and mobile paths, in a sandbox. What architecture guarantees that?

## Resolution

**The sync engine is pure TypeScript behind ports.** Two ports isolate every environment dependency:

- `VaultPort` — implemented by an Obsidian vault-adapter wrapper in production, by an in-memory fake in tests
- `RemotePort` — implemented by a Filen SDK client in production, by an in-memory fake in tests

All sync logic — reconcile, 3-way merge, rename pairing, delete semantics, first-link bootstrap — runs headless under vitest with the fakes. This covers the large majority of correctness risk with zero Obsidian involved, and is what an implementing agent runs on every change.

**The bundler is the mobile-safety gate:** building with `esbuild --platform=browser` makes any Node API sneaking into the bundle a build failure, enforcing the [002](002-platform-targets.md) constraint mechanically.

What this ticket does **not** settle — the integration harness (driving real Obsidian in CI, mobile emulation fidelity, testing against a real Filen account) — is a frontier research ticket ([018](018-research-agent-test-harness.md)). True on-device iOS/Android verification remains a HITL task for the user.
