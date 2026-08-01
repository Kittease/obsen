/**
 * Conflict Copies (spec §6.1) and the Conflict Manifest (spec §6.2) — both formats
 * v1-normative, both read by a person rather than by Obsen.
 *
 * The manifest is the *only* announcement a conflict gets: the notices policy
 * (spec §8.6) says nothing pops up, the file opens instead. So the rows have to be
 * clickable, the names have to survive both a filesystem and a wikilink, and neither
 * is ever rewritten behind the user's back — the file is theirs, and clearing it is
 * always safe.
 */

/** A normal note at the vault root, so it syncs like everything else. */
export const CONFLICT_MANIFEST_PATH = "conflicts.md";

/** Used when the Device Name is empty or sanitizes away; the shell passes a platform default. */
export const DEFAULT_DEVICE_NAME = "This device";

/** Illegal in a filename on some platform, or fatal to a wikilink, or both. */
const UNSAFE = /[\\/:*?"<>|#^[\]]/gu;

/** `[[…]]` stops at these, so a name holding one cannot be linked at all. */
const UNLINKABLE = /[[\]|#^]/u;

const MAX_COLLISION_SUFFIX = 1_000;

export type ConflictCopyOptions = {
	/** Epoch milliseconds; rendered in **local** time, to minute precision. */
	at: number;
	/** The Device Name as configured; sanitized here, never trusted raw. */
	device: string;
	/** Whether a candidate path is already spoken for — on either side, or by this Run. */
	taken: (path: string) => boolean;
};

/**
 * `<stem> (conflict <YYYY-MM-DD HHmm> <Device Name>).<ext>`, with ` 2`, ` 3`, … before
 * the extension when the name is taken.
 */
export function conflictCopyPath(path: string, options: ConflictCopyOptions): string {
	const cut = path.lastIndexOf("/");
	const folder = cut < 0 ? "" : path.slice(0, cut + 1);
	const name = path.slice(cut + 1);
	// A leading dot is part of the name, not an extension: `.gitignore` has none.
	const dot = name.lastIndexOf(".");
	const stem = dot <= 0 ? name : name.slice(0, dot);
	const extension = dot <= 0 ? "" : name.slice(dot);

	const label = `${stem} (conflict ${conflictStamp(options.at)} ${sanitizeDeviceName(options.device)})`;
	for (let nth = 1; nth <= MAX_COLLISION_SUFFIX; nth += 1) {
		const candidate = `${folder}${label}${nth === 1 ? "" : ` ${nth}`}${extension}`;
		if (!options.taken(candidate)) return candidate;
	}
	// A thousand copies of one file in one minute is not a naming problem; failing the
	// operation requeues the path and keeps both versions where they are.
	throw new Error(`Obsen: could not find a free Conflict Copy name for ${path}`);
}

/** Local time, minute precision, filename-safe — no colon (spec §6.1). */
export function conflictStamp(at: number): string {
	const when = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
	return `${date} ${pad(when.getHours())}${pad(when.getMinutes())}`;
}

/** Filename- and wikilink-safe Device Name; empty after sanitizing falls back (spec §6.1). */
export function sanitizeDeviceName(name: string): string {
	const safe = name.replace(UNSAFE, "-").replace(/^[.\s]+/u, "").replace(/[.\s]+$/u, "");
	return safe === "" ? DEFAULT_DEVICE_NAME : safe;
}

export type ConflictRow = { original: string; copy: string };

const TITLE = "# Sync conflicts";

const HEADER = `${TITLE}

Each row links a file and the conflict copy Obsen created for it. Review, merge what you need, then delete rows (or this file) — Obsen recreates it on the next conflict.
`;

const TABLE_HEAD = `| Original | Conflict copy |
| --- | --- |
`;

/**
 * The manifest with `rows` appended — one row per Conflict Copy, exactly once, during
 * the Run that created it. Copy names are unique, so duplicates cannot occur and no
 * dedup pass is needed.
 *
 * Nothing existing is ever removed or reformatted: a missing file is recreated with the
 * header, a file the user gutted keeps whatever they left and gets a fresh table to
 * append to.
 */
export function appendConflictRows(existing: string | null, rows: readonly ConflictRow[]): string {
	const table = rows.map((row) => `| ${link(row.original)} | ${link(row.copy)} |\n`).join("");
	if (existing === null || existing.trim() === "") return `${HEADER}\n${TABLE_HEAD}${table}`;

	const body = existing.endsWith("\n") ? existing : `${existing}\n`;
	const last = body.trimEnd().split("\n").at(-1) ?? "";
	// Rows go at the end, so the only question is whether a table is already there.
	return last.startsWith("|") ? `${body}${table}` : `${body}\n${TABLE_HEAD}${table}`;
}

/** A wikilink to a path, or the path as code when it cannot be one. */
function link(path: string): string {
	if (UNLINKABLE.test(path)) return `\`${path}\``;
	// Obsidian resolves `[[Folder/Note]]`; the `.md` is what it does not want to see.
	return `[[${path.endsWith(".md") ? path.slice(0, -3) : path}]]`;
}
