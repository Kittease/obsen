import type { SecretStorageApi } from "../../src/obsidian/secrets.ts";

/**
 * Obsidian's `SecretStorage`, as it actually behaves — read out of the shipped
 * 1.11.4 and 1.13.4 app bundles rather than out of the API docs, which document
 * neither of the two things that matter here:
 *
 * - **`setSecret` validates the id** against `/^[a-z0-9-]+$/` with a 64-character cap,
 *   and throws otherwise. The spec's `obsen:filen-auth` would throw; the colon is not
 *   in that character class.
 * - **`deleteSecret` exists** (both versions) but is absent from the published
 *   TypeScript API, which is why {@link SecretStorageApi} declares it optional and the
 *   store has a fallback for a build where it is really missing.
 *
 * `unavailable` reproduces 1.13's third documented-nowhere behaviour: on a platform
 * with no secure-storage adapter, `setSecret` throws *"Secure storage is not
 * available."* — a login that works and a session that cannot be saved.
 */
export class FakeSecretStorage implements SecretStorageApi {
	private readonly secrets = new Map<string, string>();

	/** Whether the platform has a secure-storage adapter behind the API at all. */
	unavailable = false;

	constructor(
		/** Whether this build exposes the undocumented `deleteSecret`. */
		readonly supportsDelete = true,
	) {
		if (!supportsDelete) {
			// Not merely a flag: a build without it has no such property to call, which is
			// the case the store's fallback has to survive.
			this.deleteSecret = undefined;
		}
	}

	getSecret(id: string): string | null {
		return this.secrets.get(id) ?? null;
	}

	setSecret(id: string, secret: string): void {
		if (this.unavailable) throw new Error("Secure storage is not available.");
		if (!/^[a-z0-9-]+$/.test(id) || id.length > 64) throw new Error("Invalid secret ID");
		this.secrets.set(id, secret);
	}

	listSecrets(): string[] {
		return [...this.secrets.keys()];
	}

	deleteSecret?: ((id: string) => boolean) | undefined = (id) => this.secrets.delete(id);
}
