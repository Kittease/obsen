import { isConfigPath } from "./layout";

/**
 * `VaultPort.isWritablePath` (spec §5.8): can this device actually hold that name?
 *
 * A `false` becomes a **Skip-and-Surface** — the path is reported and never retried,
 * and above all never auto-renamed, because a name Obsen invented would break every
 * wikilink pointing at the original and would then propagate as a content change.
 *
 * "This device" means Obsidian as much as the filesystem, and the Obsidian half is
 * what makes this list longer than the spec's three examples. Two additions, each
 * standing in for a silent failure:
 *
 * - A **dot-prefixed name** is legal on every filesystem Obsidian runs on and invisible
 *   to its Vault API. The file would download fine, be missing from the next local
 *   scan, and read as a local deletion to propagate back to Filen.
 * - A name Obsidian's own **`normalizePath()`** would rewrite — a backslash, a `.` or
 *   `..` segment, a leading or trailing slash. Spec §1.3 asks for `normalizePath()` on
 *   remote-derived paths, and this is the honest way to honour it: applying it would
 *   quietly turn `a\b.md` into `a/b.md` — Obsen inventing a rename, which spec §5.8
 *   forbids outright — while refusing the name reports it and changes nothing.
 *
 * Both turn silent data loss into one Skip-and-Surface row a user can act on.
 *
 * Windows is taken as a flag rather than sniffed here, so the rules stay a pure
 * function the tests can run both ways on one machine.
 */
export type WritablePathCheck = (path: string) => boolean;

/** Illegal on Windows; legal, if unusual, everywhere else Obsidian runs. */
const WINDOWS_ILLEGAL = /[<>:"|?*\\]/;

/**
 * Reserved device names, with or without an extension, any case — `CON.md` is as
 * unopenable as `CON`. `COM0`/`LPT0` are in the range: modern Windows reserves them too.
 */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** Control characters: no platform here can hold them and every one of them mangles. */
// eslint-disable-next-line no-control-regex -- the control range is the point of the pattern
const CONTROL = /[\u0000-\u001f\u007f]/;

export function createWritablePathCheck(params: {
	configDir: string;
	windows: boolean;
}): WritablePathCheck {
	const { configDir, windows } = params;

	return (path: string): boolean => {
		if (path === "") return false;
		if (CONTROL.test(path)) return false;

		// Inside the config dir something up the chain always starts with a dot, and the
		// adapter reaches those files through Obsidian's `DataAdapter` rather than its
		// Vault API — so the hidden-name rule below simply does not apply there.
		const hiddenNamesRefused = !isConfigPath(configDir, path);

		return path.split("/").every((segment) => {
			// An empty segment is a leading, trailing or doubled slash; `.` and `..` are
			// path arithmetic. `normalizePath()` would collapse all four away.
			if (segment === "" || segment === "." || segment === "..") return false;
			if (segment.includes("\\")) return false;
			if (hiddenNamesRefused && segment.startsWith(".")) return false;
			if (!windows) return true;
			if (WINDOWS_ILLEGAL.test(segment)) return false;
			if (segment.endsWith(".") || segment.endsWith(" ")) return false;
			return !WINDOWS_RESERVED.test(segment);
		});
	};
}
