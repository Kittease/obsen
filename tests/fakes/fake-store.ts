import type { StorePort } from "../../src/engine/ports.ts";

/**
 * In-memory {@link StorePort}.
 *
 * `writeState` takes a whole document in one call, so tearing is impossible here
 * by construction — atomicity is the *production adapter's* contract (tmp+rename),
 * verified against real Obsidian in ticket 029. What this fake can police is the
 * engine's side of the bargain: every document handed to it must be complete and
 * parseable, which {@link writeState} asserts on the spot.
 */
export class FakeStore implements StorePort {
	state: string | null = null;
	readonly shadow = new Map<string, Uint8Array>();

	/** Every document written, in order — the flush cadence is observable. */
	readonly writes: string[] = [];

	constructor(initialState?: string) {
		this.state = initialState ?? null;
	}

	readState(): Promise<string | null> {
		return Promise.resolve(this.state);
	}

	writeState(json: string): Promise<void> {
		JSON.parse(json); // a partial document reaching the port is a bug, not a test failure later
		this.state = json;
		this.writes.push(json);
		return Promise.resolve();
	}

	readShadow(hash: string): Promise<Uint8Array | null> {
		return Promise.resolve(this.shadow.get(hash) ?? null);
	}

	writeShadow(hash: string, data: Uint8Array): Promise<void> {
		this.shadow.set(hash, data);
		return Promise.resolve();
	}

	deleteShadow(hash: string): Promise<void> {
		this.shadow.delete(hash);
		return Promise.resolve();
	}
}
