import type { Hasher } from "./hash";
import type { StorePort } from "./ports";
import type { SyncState } from "./state";

/**
 * The Shadow Store (spec §3.4): a device-local, content-addressed store of last-synced
 * text, and the only source of **Ancestors** for the Three-Way Merge.
 *
 * Two invariants carry it:
 *
 * - **An entry always hashes back to its own name.** Every read re-hashes what it
 *   decoded, so a truncated or damaged entry reads as *no Ancestor* — which costs a
 *   Conflict Copy — rather than as a wrong Ancestor, which would cost content.
 * - **The blob is written before any Sync State flush referencing its hash.** Callers
 *   own that ordering (they `write` before touching a record); a crash in between
 *   leaves an orphan blob — wasted bytes — and never a record pointing at an entry
 *   that was never stored.
 *
 * Compression is an optimization, never correctness: `CompressionStream` is absent on
 * iOS < 16.4, so entries carry a one-byte encoding header and a device that cannot
 * compress simply stores raw and reads everyone's entries just the same.
 */

const RAW = 0;
const DEFLATE = 1;

/** The Ancestors a state keeps alive: one per Mergeable record, deduplicated by content. */
export function referencedHashes(state: SyncState): Set<string> {
	const hashes = new Set<string>();
	for (const record of state.files.values()) {
		if (record.mergeable) hashes.add(record.lastSyncedHash);
	}
	return hashes;
}

export class ShadowStore {
	/**
	 * Hashes this instance has stored. `StorePort` has no listing call — the signatures
	 * are normative (spec §1.1) — so a sweep can only consider what the Sync State
	 * referenced plus what was written since.
	 *
	 * That covers the garbage a running Obsen produces: every superseded Ancestor. What
	 * it cannot reach is garbage no live process ever named — a blob written by a Run
	 * that then crashed, or the whole store after a Re-Bootstrap discarded the state
	 * that referenced it. Those leak until the `StorePort` adapter can enumerate its own
	 * `shadow/` folder (ticket 029), which is where a listing belongs.
	 */
	private readonly written = new Set<string>();

	constructor(
		private readonly store: StorePort,
		private readonly hash: Hasher,
	) {}

	/** The Ancestor for `hash`, or `null` — absent, corrupt, or unreadable all mean the same. */
	async read(hash: string): Promise<Uint8Array | null> {
		let blob: Uint8Array | null;
		try {
			blob = await this.store.readShadow(hash);
		} catch {
			return null;
		}
		if (blob === null || blob.length === 0) return null;

		const body = blob.subarray(1);
		let data: Uint8Array | null;
		if (blob[0] === RAW) data = body;
		else if (blob[0] === DEFLATE) data = await inflate(body);
		else data = null;
		if (data === null) return null;

		return (await this.hash(data)) === hash ? data : null;
	}

	async write(hash: string, data: Uint8Array): Promise<void> {
		const compressed = await deflate(data);
		const blob = new Uint8Array((compressed ?? data).length + 1);
		blob[0] = compressed ? DEFLATE : RAW;
		blob.set(compressed ?? data, 1);
		await this.store.writeShadow(hash, blob);
		this.written.add(hash);
	}

	/**
	 * Mark and sweep (spec §3.4): everything in `candidates` — the hashes the Sync State
	 * referenced before this Run, plus everything written during it — that no record
	 * references now. A failed delete is left for the next sweep; garbage collection is
	 * never worth failing a Run over.
	 */
	async sweep(referenced: ReadonlySet<string>, candidates: Iterable<string>): Promise<number> {
		const unreferenced = new Set<string>();
		for (const hash of [...candidates, ...this.written]) {
			if (!referenced.has(hash)) unreferenced.add(hash);
		}
		this.written.clear();

		let deleted = 0;
		for (const hash of unreferenced) {
			try {
				await this.store.deleteShadow(hash);
				deleted += 1;
			} catch {
				// Left behind on purpose: an entry that cannot be deleted is wasted bytes,
				// and the next Run will try again.
			}
		}
		return deleted;
	}
}

/** `null` when this platform cannot compress — the caller stores raw and moves on. */
async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
	if (typeof CompressionStream === "undefined") return null;
	try {
		return await pump(new CompressionStream("deflate"), data);
	} catch {
		return null;
	}
}

/** `null` when the body is damaged, or the platform has no inflater for it. */
async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
	if (typeof DecompressionStream === "undefined") return null;
	try {
		return await pump(new DecompressionStream("deflate"), data);
	} catch {
		return null;
	}
}

/**
 * Feeds one buffer through a transform stream and collects the result. The write is
 * deliberately not awaited before reading starts: a buffer larger than the stream's
 * internal queue would deadlock if it were.
 */
async function pump(
	transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
	data: Uint8Array,
): Promise<Uint8Array> {
	const writer = transform.writable.getWriter();
	const written = (async (): Promise<void> => {
		// `slice()` for the same reason the hasher does it: a SharedArrayBuffer-backed
		// view is rejected outright, and Mergeable files are small enough for the copy.
		await writer.write(data.slice());
		await writer.close();
	})();

	const reader = transform.readable.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.length;
		}
		await written;
	} catch (error) {
		// The writer's rejection is the same fault surfacing twice; swallowing it keeps
		// the failure to one thrown error rather than an unhandled rejection beside it.
		void written.catch(() => {});
		throw error;
	}

	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
