import type { EventRef } from "obsidian";

/**
 * Obsen's one door to Obsidian's `SecretStorage` (spec §8.1).
 *
 * The API is three methods, and each of them behaves in a way the published types do
 * not say. All three were read out of the shipped app bundles (1.11.4 and 1.13.4):
 *
 * - **`setSecret` validates the id** against `/^[a-z0-9-]+$/`, 64 characters max, and
 *   throws otherwise — so {@link AUTH_SECRET_ID} cannot be the spec's literal
 *   `obsen:filen-auth`.
 * - **`deleteSecret` exists** in both versions and is in none of the published types.
 *   Logging out has to actually remove the secret, so this uses it — declared optional,
 *   with a fallback, because an undocumented method is one a future build may drop.
 * - **`setSecret` can throw** *"Secure storage is not available."* on a platform with no
 *   secure-storage backend (1.13 picks one per platform and may pick none). A login
 *   that cannot be saved is a real state, and the user is told rather than left to
 *   discover it at the next restart.
 *
 * Nothing here knows what the secret *is*: the Auth Config's shape and validation live
 * in `filen/auth.ts`, so this file stays the storage boundary and only that.
 */

/**
 * The slice of `SecretStorage` Obsen uses. Assigning the real `app.secretStorage` to it
 * (`main.ts`, in `onload`) is the compile-time proof it is a slice — the same trick
 * `createObsidianPorts` plays on the Vault API and `createFilenRemote` on the SDK.
 */
export interface SecretStorageApi {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	listSecrets(): string[];
	/** Present since 1.11.4, published in no `.d.ts` — hence optional, hence the fallback. */
	deleteSecret?: ((id: string) => boolean) | undefined;
	/**
	 * 1.13 loads secrets asynchronously and announces it with `changed`; 1.11.4 reads
	 * them from local storage before any plugin runs and is not an `Events` at all —
	 * hence optional, and feature-tested rather than version-tested.
	 */
	on?: ((name: "changed", callback: () => void) => EventRef) | undefined;
	/** The counterpart to `on`, and present exactly when it is. */
	offref?: ((ref: EventRef) => void) | undefined;
}

/**
 * Where the Auth Config lives. Spec §8.1 writes it `obsen:filen-auth`; Obsidian's own
 * id rule rejects the colon, so the same name is spelled with a dash. Namespaced with
 * the plugin id because the store is one flat, vault-wide keyspace shared with every
 * other plugin.
 */
export const AUTH_SECRET_ID = "obsen-filen-auth";

/** The platform has no secure storage to write to — see the file comment. */
export class SecretUnavailableError extends Error {
	constructor(cause: unknown) {
		super(
			"Obsidian could not open secure storage on this device, so the login cannot be saved",
			{ cause },
		);
		this.name = "SecretUnavailableError";
	}
}

/** One secret, by name: everything the rest of the plugin may do with `SecretStorage`. */
export interface SecretStore {
	/** The stored value, or `null` for absent, evicted, or emptied. */
	read(): string | null;
	/** @throws {SecretUnavailableError} when the platform cannot store secrets. */
	write(value: string): void;
	clear(): void;
}

export function createSecretStore(storage: SecretStorageApi, id: string): SecretStore {
	return {
		read() {
			let stored: string | null;
			try {
				stored = storage.getSecret(id);
			} catch {
				// A store that will not load is the logged-out state, not a crash on the
				// startup path (spec §8.1). Obsidian has already logged its own reason.
				return null;
			}
			// An empty secret is what `clear()` leaves behind where `deleteSecret` is
			// missing, so absent and empty have to mean the same thing everywhere.
			return stored === null || stored === "" ? null : stored;
		},

		write(value) {
			try {
				storage.setSecret(id, value);
			} catch (error) {
				throw new SecretUnavailableError(error);
			}
		},

		clear() {
			if (storage.deleteSecret !== undefined) {
				storage.deleteSecret(id);
				return;
			}
			// No way to remove an entry: blank it, and never let the blank be read as a
			// session. Wrapped because a device with no secure storage has nothing to
			// clear either, and logging out must not fail.
			try {
				storage.setSecret(id, "");
			} catch {
				/* nothing stored, nothing to clear */
			}
		},
	};
}
