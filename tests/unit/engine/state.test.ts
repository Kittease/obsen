import { describe, expect, it } from "vitest";

import {
	emptyState,
	flushState,
	loadState,
	serializeState,
	SYNC_STATE_SCHEMA_VERSION,
	type FileRecord,
} from "../../../src/engine/state.ts";
import { FakeStore } from "../../fakes/fake-store.ts";

/**
 * Spec §3.1 and §3.3: the Sync State schema and its envelope guards. The stakes of
 * the guards are asymmetric — a wrongly *trusted* state file can delete files,
 * while a wrongly discarded one costs a Re-Bootstrap (redundant hashing, a rare
 * spurious Conflict Copy). These tests hold that asymmetry in place.
 */

const ROOT = "root-uuid";

const record = (overrides: Partial<FileRecord> = {}): FileRecord => ({
	lastSyncedHash: "a".repeat(128),
	size: 12,
	localMtime: 1_737_000_000_000,
	remoteUuid: "file-uuid",
	mergeable: true,
	...overrides,
});

const stored = (body: unknown): string => JSON.stringify(body);

describe("serialization", () => {
	it("round-trips a state through the store", async () => {
		const state = emptyState(ROOT);
		state.files.set("Notes/Idea.md", record());

		const store = new FakeStore();
		await flushState(store, state);
		const loaded = await loadState(store, ROOT);

		expect(loaded.reset).toBeNull();
		expect(loaded.state.remoteRoot).toBe(ROOT);
		expect(loaded.state.files.get("Notes/Idea.md")).toEqual(record());
	});

	it("writes the spec's document shape, with paths sorted", () => {
		const state = emptyState(ROOT);
		state.files.set("b.md", record());
		state.files.set("a.md", record());

		const document = JSON.parse(serializeState(state)) as Record<string, unknown>;

		expect(document.schemaVersion).toBe(SYNC_STATE_SCHEMA_VERSION);
		expect(document.remoteRoot).toBe(ROOT);
		// Sorted keys keep the file's diff quiet across runs that changed nothing.
		expect(Object.keys(document.files as object)).toEqual(["a.md", "b.md"]);
	});

	it("normalizes stored paths to NFC", async () => {
		// "é" as e + combining acute: what an APFS-era state file can hold. The ports
		// hand the engine NFC only, so a decomposed key would silently never match.
		const decomposed = "Café.md";
		const store = new FakeStore(
			stored({
				schemaVersion: 1,
				remoteRoot: ROOT,
				files: { [decomposed]: record() },
			}),
		);

		const loaded = await loadState(store, ROOT);

		expect([...loaded.state.files.keys()]).toEqual(["Café.md"]);
	});
});

describe("envelope guards (spec §3.3)", () => {
	it("treats a missing state as First Link, not as an error", async () => {
		const loaded = await loadState(new FakeStore(), ROOT);

		expect(loaded.reset).toBe("missing");
		expect(loaded.state.files.size).toBe(0);
		expect(loaded.state.remoteRoot).toBe(ROOT);
	});

	it("re-bootstraps on unparseable state", async () => {
		const loaded = await loadState(new FakeStore("{ this is not json"), ROOT);

		expect(loaded.reset).toBe("corrupt");
		expect(loaded.state.files.size).toBe(0);
	});

	it("re-bootstraps on a newer schema — a downgrade must not guess", async () => {
		const store = new FakeStore(
			stored({ schemaVersion: 2, remoteRoot: ROOT, files: { "a.md": record() } }),
		);

		const loaded = await loadState(store, ROOT);

		expect(loaded.reset).toBe("future-schema");
		expect(loaded.state.files.size).toBe(0);
	});

	it("re-bootstraps when the remote root changed — a genuine re-link", async () => {
		const store = new FakeStore(
			stored({ schemaVersion: 1, remoteRoot: "other-folder", files: { "a.md": record() } }),
		);

		const loaded = await loadState(store, ROOT);

		expect(loaded.reset).toBe("root-changed");
		expect(loaded.state.files.size).toBe(0);
	});

	it.each([
		["a record that is not an object", { "a.md": "nope" }],
		["a missing field", { "a.md": { size: 1, localMtime: 1, remoteUuid: "u", mergeable: true } }],
		["a field of the wrong type", { "a.md": record({ size: "12" as unknown as number }) }],
	])("re-bootstraps on %s", async (_label, files) => {
		const store = new FakeStore(stored({ schemaVersion: 1, remoteRoot: ROOT, files }));

		const loaded = await loadState(store, ROOT);

		// Dropping the one bad record and trusting the rest would be a guess about
		// which half of a damaged file is true; Re-Bootstrap never loses data.
		expect(loaded.reset).toBe("corrupt");
		expect(loaded.state.files.size).toBe(0);
	});

	it("keeps state that is merely empty", async () => {
		const store = new FakeStore(stored({ schemaVersion: 1, remoteRoot: ROOT, files: {} }));

		const loaded = await loadState(store, ROOT);

		expect(loaded.reset).toBeNull();
	});

	it("survives a store that throws on read", async () => {
		const store = new FakeStore();
		store.readState = () => Promise.reject(new Error("adapter exploded"));

		const loaded = await loadState(store, ROOT);

		expect(loaded.reset).toBe("unreadable");
	});
});
