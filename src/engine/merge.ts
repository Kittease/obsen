/**
 * Three-Way Merge (spec §6): local and remote reconciled against their **Ancestor**.
 *
 * Line-based diff3, in-house rather than a dependency — the engine has none, and what
 * diff3 needs is one line diff and one overlap rule. The contract is asymmetric on
 * purpose: a merge that should have been a Conflict Copy silently rewrites a note,
 * while a Conflict Copy that could have merged costs the user one file to glance at.
 * Everything ambiguous therefore refuses.
 */

/**
 * Cells of the LCS table this will compute before declaring the diff not worth doing.
 * One million ≈ two 1,000-line rewrites; past that the file has been replaced rather
 * than edited, and a Conflict Copy is both cheaper and more honest than a merge.
 * Common prefixes and suffixes are stripped first, so ordinary edits never come close.
 */
const MAX_DIFF_CELLS = 1_000_000;

export type MergeFailure =
	/** Both sides changed the same lines — the case Conflict Copies exist for. */
	| "overlapping-edits"
	/** The two versions diverge too far to diff within the engine's work budget. */
	| "too-large";

export type MergeResult = { clean: true; text: string } | { clean: false; reason: MergeFailure };

/** A replacement of `base[start, end)` with `lines`; `start === end` is an insertion. */
type Hunk = { start: number; end: number; lines: string[] };

export function mergeText(base: string, local: string, remote: string): MergeResult {
	// The three cheap answers, which are also the common ones: one side changed, or
	// both landed on the same text.
	if (local === remote) return { clean: true, text: local };
	if (base === local) return { clean: true, text: remote };
	if (base === remote) return { clean: true, text: local };

	const baseLines = splitLines(base);
	const localHunks = diff(baseLines, splitLines(local));
	const remoteHunks = diff(baseLines, splitLines(remote));
	if (localHunks === null || remoteHunks === null) return { clean: false, reason: "too-large" };

	const merged: string[] = [];
	let cursor = 0;
	for (const group of groupHunks(localHunks, remoteHunks)) {
		merged.push(...baseLines.slice(cursor, group.start));
		const fromLocal = group.local.length > 0 ? render(baseLines, group.local, group) : null;
		const fromRemote = group.remote.length > 0 ? render(baseLines, group.remote, group) : null;
		// A group only ever holds hunks from both sides when they touch the same lines.
		// Identical results mean the same edit arrived twice; anything else is a Conflict.
		if (fromLocal && fromRemote && !sameLines(fromLocal, fromRemote)) {
			return { clean: false, reason: "overlapping-edits" };
		}
		merged.push(...(fromLocal ?? fromRemote ?? []));
		cursor = group.end;
	}
	merged.push(...baseLines.slice(cursor));

	return { clean: true, text: merged.join("\n") };
}

/**
 * Splitting on `\n` alone keeps every other byte inside the lines — a `\r` stays at
 * the end of its line, and joining reproduces the input exactly. A merge must never
 * be the thing that rewrites a file's line endings.
 */
function splitLines(text: string): string[] {
	return text.split("\n");
}

/** Hunks turning `from` into `to`, in `from` coordinates; `null` past the work budget. */
function diff(from: readonly string[], to: readonly string[]): Hunk[] | null {
	let head = 0;
	while (head < from.length && head < to.length && from[head] === to[head]) head += 1;
	let tail = 0;
	while (
		tail < from.length - head &&
		tail < to.length - head &&
		from[from.length - 1 - tail] === to[to.length - 1 - tail]
	) {
		tail += 1;
	}

	const source = from.slice(head, from.length - tail);
	const target = to.slice(head, to.length - tail);
	if (source.length === 0 && target.length === 0) return [];
	if (source.length === 0) return [{ start: head, end: head, lines: target }];
	if (target.length === 0) return [{ start: head, end: head + source.length, lines: [] }];
	if (source.length * target.length > MAX_DIFF_CELLS) return null;

	return hunks(source, target, head);
}

/**
 * Longest-common-subsequence alignment of two already-trimmed line runs, walked
 * forward into replacement hunks. The table is suffix-indexed — `lcs[i][j]` is the
 * alignment length of `source[i…]` against `target[j…]` — so the walk that follows
 * reads it in one direction and needs no backtracking pass.
 */
function hunks(source: readonly string[], target: readonly string[], offset: number): Hunk[] {
	const width = target.length + 1;
	const lcs = new Uint32Array((source.length + 1) * width);
	for (let i = source.length - 1; i >= 0; i -= 1) {
		for (let j = target.length - 1; j >= 0; j -= 1) {
			lcs[i * width + j] =
				source[i] === target[j]
					? lcs[(i + 1) * width + j + 1]! + 1
					: Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
		}
	}

	const found: Hunk[] = [];
	let open: Hunk | null = null;
	let i = 0;
	let j = 0;
	while (i < source.length || j < target.length) {
		if (i < source.length && j < target.length && source[i] === target[j]) {
			open = null;
			i += 1;
			j += 1;
			continue;
		}
		if (open === null) {
			open = { start: offset + i, end: offset + i, lines: [] };
			found.push(open);
		}
		// Deleting from the source is preferred on ties, which keeps a replacement one
		// hunk rather than an insertion sitting next to a deletion.
		const deleting =
			j >= target.length ||
			(i < source.length && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!);
		if (deleting) {
			i += 1;
			open.end = offset + i;
		} else {
			open.lines.push(target[j]!);
			j += 1;
		}
	}
	return found;
}

/** One side's hunks over a shared stretch of base, plus the other side's for comparison. */
type Group = { start: number; end: number; local: Hunk[]; remote: Hunk[] };

/**
 * Hunks that touch the same lines have to be judged together; hunks that do not are
 * independent edits and both apply.
 *
 * Two hunks touch when their base ranges overlap, or when they start at the same
 * line — the second clause is what catches two insertions at one point, which have
 * no length to overlap with but no defined order either.
 */
function groupHunks(local: readonly Hunk[], remote: readonly Hunk[]): Group[] {
	const all = [
		...local.map((hunk) => ({ hunk, side: "local" as const })),
		...remote.map((hunk) => ({ hunk, side: "remote" as const })),
	].sort((a, b) => a.hunk.start - b.hunk.start || a.hunk.end - b.hunk.end);

	const groups: Group[] = [];
	for (const { hunk, side } of all) {
		const open = groups[groups.length - 1];
		if (open && (hunk.start < open.end || hunk.start === open.start)) {
			open.end = Math.max(open.end, hunk.end);
			open[side].push(hunk);
			continue;
		}
		groups.push({
			start: hunk.start,
			end: hunk.end,
			local: side === "local" ? [hunk] : [],
			remote: side === "remote" ? [hunk] : [],
		});
	}
	return groups;
}

/** What one side's text looks like over the group's stretch of base. */
function render(
	base: readonly string[],
	hunksOnSide: readonly Hunk[],
	group: { start: number; end: number },
): string[] {
	const out: string[] = [];
	let cursor = group.start;
	for (const hunk of hunksOnSide) {
		out.push(...base.slice(cursor, hunk.start), ...hunk.lines);
		cursor = hunk.end;
	}
	out.push(...base.slice(cursor, group.end));
	return out;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}
