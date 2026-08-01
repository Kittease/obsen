import { afterEach, describe, expect, it } from "vitest";

import { sha512Hex } from "../../../src/engine/hash.ts";
import { ShadowStore } from "../../../src/engine/shadow.ts";
import { encodeUtf8 } from "../../../src/engine/text.ts";
import { FakeStore } from "../../fakes/fake-store.ts";

/**
 * The Shadow Store (spec §3.4): where Ancestors come from.
 *
 * Its two hard rules are that a stored entry always hashes back to its own name — an
 * entry that does not is *no Ancestor*, never a wrong one — and that compression is an
 * optimization, so an environment without `CompressionStream` (iOS < 16.4) stores raw
 * and keeps working.
 */

const PROSE = "# Note\n\n".concat("Markdown compresses well, which is the whole point.\n".repeat(50));

async function shadow(): Promise<{ store: FakeStore; shadow: ShadowStore; hash: string }> {
	const store = new FakeStore();
	return { store, shadow: new ShadowStore(store, sha512Hex), hash: await sha512Hex(encodeUtf8(PROSE)) };
}

/** Hides a global the way an older webview would, for the length of one test. */
function withoutGlobal(name: string): void {
	const globals = globalThis as unknown as Record<string, unknown>;
	const original = globals[name];
	delete globals[name];
	restore.push(() => {
		globals[name] = original;
	});
}

const restore: (() => void)[] = [];

afterEach(() => {
	while (restore.length > 0) restore.pop()!();
});

describe("storing and reading Ancestors", () => {
	it("round-trips content byte for byte", async () => {
		const { shadow: entries, hash } = await shadow();
		const data = encodeUtf8(PROSE);

		await entries.write(hash, data);

		expect(await entries.read(hash)).toEqual(data);
	});

	it("compresses Markdown, and says so in the entry's header", async () => {
		const { store, shadow: entries, hash } = await shadow();

		await entries.write(hash, encodeUtf8(PROSE));

		const blob = store.shadow.get(hash)!;
		expect(blob[0]).toBe(1); // deflate
		expect(blob.length).toBeLessThan(PROSE.length / 2);
	});

	it("stores raw where CompressionStream does not exist, and still reads back", async () => {
		withoutGlobal("CompressionStream");
		const { store, shadow: entries, hash } = await shadow();

		await entries.write(hash, encodeUtf8(PROSE));

		expect(store.shadow.get(hash)![0]).toBe(0); // raw
		expect(await entries.read(hash)).toEqual(encodeUtf8(PROSE));
	});

	it("reads a raw entry written by a device that could not compress", async () => {
		const { store, shadow: entries, hash } = await shadow();
		const raw = new Uint8Array([0, ...encodeUtf8(PROSE)]);
		store.shadow.set(hash, raw);

		expect(await entries.read(hash)).toEqual(encodeUtf8(PROSE));
	});

	it("reports an absent entry as no Ancestor", async () => {
		const { shadow: entries } = await shadow();

		expect(await entries.read("0".repeat(128))).toBeNull();
	});

	it("survives a store that cannot read", async () => {
		const { store, shadow: entries, hash } = await shadow();
		store.readShadow = () => Promise.reject(new Error("disk is gone"));

		// No Ancestor means a Conflict Copy, which is a fine outcome; a thrown error
		// mid-Run would not be.
		expect(await entries.read(hash)).toBeNull();
	});
});

describe("corrupt entries are no Ancestor at all", () => {
	it("rejects content that does not hash to its own name", async () => {
		const { store, shadow: entries, hash } = await shadow();
		await entries.write(hash, encodeUtf8(PROSE));
		store.shadow.set(hash, new Uint8Array([0, ...encodeUtf8("not what was stored")]));

		expect(await entries.read(hash)).toBeNull();
	});

	it("rejects an entry whose compressed body is damaged", async () => {
		const { store, shadow: entries, hash } = await shadow();
		await entries.write(hash, encodeUtf8(PROSE));
		const blob = store.shadow.get(hash)!;
		blob.set([0xff, 0xff, 0xff], Math.floor(blob.length / 2));

		expect(await entries.read(hash)).toBeNull();
	});

	it("rejects an entry with an encoding this version does not know", async () => {
		const { store, shadow: entries, hash } = await shadow();
		store.shadow.set(hash, new Uint8Array([9, 1, 2, 3]));

		expect(await entries.read(hash)).toBeNull();
	});

	it("rejects a deflate entry when the platform cannot inflate it", async () => {
		const { store, shadow: entries, hash } = await shadow();
		await entries.write(hash, encodeUtf8(PROSE));
		expect(store.shadow.get(hash)![0]).toBe(1);

		withoutGlobal("DecompressionStream");

		expect(await entries.read(hash)).toBeNull();
	});
});

describe("mark and sweep", () => {
	it("deletes entries no record references any more, and keeps the ones that do", async () => {
		const { store, shadow: entries } = await shadow();
		const kept = await sha512Hex(encodeUtf8("kept"));
		const dropped = await sha512Hex(encodeUtf8("dropped"));
		await entries.write(kept, encodeUtf8("kept"));
		await entries.write(dropped, encodeUtf8("dropped"));

		await entries.sweep(new Set([kept]), [kept, dropped]);

		expect([...store.shadow.keys()]).toEqual([kept]);
	});

	it("collects what this Run wrote but nothing ended up referencing", async () => {
		const { store, shadow: entries } = await shadow();
		const orphan = await sha512Hex(encodeUtf8("written, then the op failed"));
		await entries.write(orphan, encodeUtf8("written, then the op failed"));

		// The candidate list is what the state referenced *before* the Run; an entry
		// written during it has to be swept on the store's own say-so.
		await entries.sweep(new Set(), []);

		expect(store.shadow.size).toBe(0);
	});

	it("keeps sweeping after one deletion fails", async () => {
		const { store, shadow: entries } = await shadow();
		const first = await sha512Hex(encodeUtf8("a"));
		const second = await sha512Hex(encodeUtf8("b"));
		await entries.write(first, encodeUtf8("a"));
		await entries.write(second, encodeUtf8("b"));
		const real = store.deleteShadow.bind(store);
		store.deleteShadow = (hash) =>
			hash === first ? Promise.reject(new Error("locked")) : real(hash);

		await entries.sweep(new Set(), []);

		expect([...store.shadow.keys()]).toEqual([first]);
	});
});
