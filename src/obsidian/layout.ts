/**
 * Where Obsen's own files live inside a vault.
 *
 * Two values are derived rather than written down, and both matter:
 *
 * - **`configDir`** is `Vault#configDir`, never the literal `.obsidian` — a vault can
 *   be opened with `--config-dir`, and hardcoding the default is one of the things
 *   Obsidian's own lint rules reject (spec §1.3).
 * - **`pluginDir`** is what the *manifest* reports, not `plugins/obsen`. BRAT installs
 *   from a repository name, so the beta of this plugin can perfectly well sit in
 *   `plugins/obsen-beta` — and excluding the wrong folder would sync this device's
 *   Sync State to every other one.
 *
 * Everything else here is a path spelled out once so the Exclusion List (spec §2.1)
 * and the `StorePort` adapter cannot drift apart.
 */
export type ObsenLayout = {
	/** `Vault#configDir` — usually `.obsidian`. */
	readonly configDir: string;
	/** Obsen's installed folder, e.g. `.obsidian/plugins/obsen`. */
	readonly pluginDir: string;
	/** Sync State (spec §3.1). */
	readonly stateFile: string;
	/** Its atomic-write sibling — the spec names this one explicitly. */
	readonly stateTmpFile: string;
	/** Shadow Store entries, one per unique last-synced content (spec §3.4). */
	readonly shadowDir: string;
	/** The opt-in rolling verbose log (spec §8.7). */
	readonly logsDir: string;
	/**
	 * Scratch space for atomic writes into the vault. One folder rather than a sibling
	 * per target: leftovers from a crash are then findable in a single place, and the
	 * Exclusion List needs one entry instead of a wildcard that would have to guess at
	 * names living next to real notes.
	 */
	readonly tmpDir: string;
};

/** The subset of Obsidian's `PluginManifest` this needs; `dir` is optional there too. */
export type ManifestLocation = { id: string; dir?: string | undefined };

export function obsenLayout(configDir: string, manifest: ManifestLocation): ObsenLayout {
	const pluginDir = manifest.dir ?? `${configDir}/plugins/${manifest.id}`;
	return {
		configDir,
		pluginDir,
		stateFile: `${pluginDir}/sync-state.json`,
		stateTmpFile: `${pluginDir}/sync-state.json.tmp`,
		shadowDir: `${pluginDir}/shadow`,
		logsDir: `${pluginDir}/logs`,
		tmpDir: `${pluginDir}/tmp`,
	};
}

/**
 * Whether a vault-relative path is the config dir or something inside it — the one
 * question that decides whether a path is reachable through Obsidian's Vault API at
 * all, and therefore which half of the `VaultPort` adapter handles it.
 */
export function isConfigPath(configDir: string, path: string): boolean {
	return path === configDir || path.startsWith(`${configDir}/`);
}
