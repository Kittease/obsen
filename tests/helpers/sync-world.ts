import { expect } from "vitest";

import { ENGINE_CONSTANTS } from "../../src/engine/constants.ts";
import { SyncEngine } from "../../src/engine/engine.ts";
import type { SyncScope } from "../../src/engine/scope.ts";
import type { RunSummary } from "../../src/engine/status.ts";
import type { RenameHint } from "../../src/engine/triggers.ts";
import { FakeClock } from "../fakes/fake-clock.ts";
import { FakeRemote } from "../fakes/fake-remote.ts";
import { FakeStore } from "../fakes/fake-store.ts";
import { FakeVault } from "../fakes/fake-vault.ts";

/**
 * One vault, one Remote Folder, one store and one clock — the world every headless
 * engine test runs against (spec §9 layer 1).
 *
 * Kept as a factory rather than a class so a test can destructure the fakes and go on
 * talking about `vault` and `remote` the way the scenarios read.
 */

export const REMOTE_ROOT = "remote-root-uuid";

export type SyncWorld = {
	vault: FakeVault;
	remote: FakeRemote;
	store: FakeStore;
	clock: FakeClock;
	/** Opens an engine over this world; `state` seeds the store first. */
	open(options?: { state?: string; scope?: SyncScope }): Promise<SyncEngine>;
	/**
	 * Marks paths dirty and lets the trailing debounce expire. The request must not be
	 * awaited before the clock moves — the Run it resolves from is the one the timer
	 * starts.
	 */
	dirtyRun(sync: SyncEngine, paths: string[], hints?: RenameHint[]): Promise<RunSummary>;
	/** Both sides hold exactly these paths, with identical content. */
	expectConverged(paths: Record<string, string>): void;
	/** Both sides hold the same paths with the same bytes, whatever those turn out to be. */
	expectAgreement(): void;
};

export function createWorld(): SyncWorld {
	const vault = new FakeVault();
	const remote = new FakeRemote();
	const store = new FakeStore();
	const clock = new FakeClock();

	return {
		vault,
		remote,
		store,
		clock,
		open(options = {}) {
			if (options.state !== undefined) store.state = options.state;
			return SyncEngine.open({
				vault,
				remote,
				store,
				remoteRoot: REMOTE_ROOT,
				timers: clock,
				...(options.scope ? { scope: options.scope } : {}),
			});
		},
		async dirtyRun(sync, paths, hints) {
			const summary = sync.markDirty(paths, "vault-event", hints);
			await clock.advance(ENGINE_CONSTANTS.eventDebounceMs);
			return summary;
		},
		expectConverged(paths) {
			expect(vault.paths()).toEqual(Object.keys(paths).sort());
			expect(remote.paths()).toEqual(Object.keys(paths).sort());
			for (const [path, content] of Object.entries(paths)) {
				expect(vault.text(path)).toBe(content);
				expect(remote.text(path)).toBe(content);
			}
		},
		expectAgreement() {
			expect(vault.paths()).toEqual(remote.paths());
			for (const path of vault.paths()) expect(vault.text(path)).toBe(remote.text(path));
		},
	};
}

/**
 * A power cut: once `budget` mutating port calls have gone through, every later call to
 * one of `mutators` rejects — including the state flush, so the store keeps whatever it
 * had persisted at that instant and nothing else.
 */
export class PowerCut extends Error {
	constructor() {
		super("power cut");
		this.name = "PowerCut";
	}
}

export function crashing<T extends object>(
	port: T,
	budget: { left: number },
	mutators: readonly string[],
): T {
	return new Proxy(port, {
		get(target, property, receiver): unknown {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== "function" || !mutators.includes(property as string)) return value;
			return (...args: unknown[]): unknown => {
				if (budget.left <= 0) return Promise.reject(new PowerCut());
				budget.left -= 1;
				return (value as (...rest: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}
