import type { AdapterApi, AdapterStat } from "./api";
import { toArrayBuffer } from "./bytes";

/**
 * Write-then-rename, the one way this plugin replaces a file without a reader ever
 * seeing half of it (spec §1.1, §3.1). Shared by both adapters because both need it and
 * both would otherwise need the same fallback.
 *
 * That fallback is the whole reason this is more than two calls: POSIX `rename`
 * clobbers an occupied destination and not every platform Obsidian runs on promises
 * that. Removing the destination first narrows the failure window to *absence* — which
 * the next Run repairs — rather than to a truncated file, which it might not notice.
 *
 * The scratch file is cleaned up on the paths that can leave one behind; a crash still
 * can, which is why the scratch folder is on the Exclusion List rather than being
 * assumed empty.
 */
export async function writeThenRename(params: {
	adapter: AdapterApi;
	scratch: string;
	destination: string;
	data: Uint8Array;
}): Promise<void> {
	const { adapter, scratch, destination } = params;
	await adapter.writeBinary(scratch, toArrayBuffer(params.data));
	try {
		await adapter.rename(scratch, destination);
	} catch (renameFailed) {
		if (!(await adapter.exists(destination))) {
			await adapter.remove(scratch).catch(() => undefined);
			throw renameFailed;
		}
		await adapter.remove(destination);
		await adapter.rename(scratch, destination);
	}
}

/** The engine's `Stat`, from the adapter's — `null` for a folder or for nothing at all. */
export function fileStat(stat: AdapterStat | null): { size: number; mtime: number } | null {
	return stat === null || stat.type !== "file" ? null : { size: stat.size, mtime: stat.mtime };
}
