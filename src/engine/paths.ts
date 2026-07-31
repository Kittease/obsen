import type { EngineConstants } from "./constants";
import { ENGINE_CONSTANTS } from "./constants";

/**
 * Path arithmetic on vault-relative NFC paths, `/`-separated.
 *
 * Deliberately not `path-browserify`: the engine's paths are already normalized by
 * the ports (spec §5.8), and what it needs is three total functions, not a
 * filesystem-flavoured library.
 */

/**
 * The normalization every port owes the engine. Cheap enough to re-apply where a
 * path arrives from persistence rather than from a port (see the Sync State
 * loader), which is the one place the boundary guarantee doesn't cover.
 */
export function toNfc(path: string): string {
	return path.normalize("NFC");
}

/** The containing folder, or `null` for a vault-root path. */
export function parentPath(path: string): string | null {
	const cut = path.lastIndexOf("/");
	return cut <= 0 ? null : path.slice(0, cut);
}

/** Every folder a path lives under, shallowest first, excluding the vault root. */
export function ancestorPaths(path: string): string[] {
	const ancestors: string[] = [];
	for (let cut = path.indexOf("/"); cut > 0; cut = path.indexOf("/", cut + 1)) {
		ancestors.push(path.slice(0, cut));
	}
	return ancestors;
}

/** Folder depth, for "parents first" and "deepest first" orderings. */
export function pathDepth(path: string): number {
	let depth = 0;
	for (let cut = path.indexOf("/"); cut >= 0; cut = path.indexOf("/", cut + 1)) depth += 1;
	return depth;
}

/** Lowercased extension including the dot, or `""` for a name without one. */
export function fileExtension(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Whether a path is eligible for Three-Way Merge (spec §3.4). Snapshotted into
 * each Sync State record when written, so widening the allowlist later needs no
 * migration.
 */
export function isMergeable(path: string, constants: EngineConstants = ENGINE_CONSTANTS): boolean {
	return constants.mergeableExtensions.includes(fileExtension(path));
}
