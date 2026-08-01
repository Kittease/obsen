import { describe, expect, it } from "vitest";

import {
	AUTH_SECRET_ID,
	createSecretStore,
	SecretUnavailableError,
} from "../../../src/obsidian/secrets.ts";
import { FakeSecretStorage } from "../../fakes/fake-secret-storage.ts";

/**
 * The `SecretStorage` boundary (spec §8.1): the only place Obsen's credentials are
 * written, and the only file in the plugin that knows the secret's name.
 */

describe("the Auth Config secret id", () => {
	it("is one Obsidian will accept", () => {
		// Obsidian validates with exactly this rule and throws otherwise. The spec writes
		// the id as `obsen:filen-auth`; a colon is not in that character class, so the
		// implementation uses the same name with a dash (see `secrets.ts`).
		expect(AUTH_SECRET_ID).toMatch(/^[a-z0-9-]+$/);
		expect(AUTH_SECRET_ID.length).toBeLessThanOrEqual(64);
	});

	it("is namespaced to this plugin, since the store is shared with every other one", () => {
		expect(AUTH_SECRET_ID.startsWith("obsen-")).toBe(true);
	});
});

describe("the secret store", () => {
	it("round-trips what it wrote", () => {
		const storage = new FakeSecretStorage();
		const store = createSecretStore(storage, AUTH_SECRET_ID);

		store.write('{"apiKey":"k"}');

		expect(store.read()).toBe('{"apiKey":"k"}');
		expect(storage.listSecrets()).toEqual([AUTH_SECRET_ID]);
	});

	it("reads nothing stored as nothing", () => {
		expect(createSecretStore(new FakeSecretStorage(), AUTH_SECRET_ID).read()).toBe(null);
	});

	it("removes the secret on clear", () => {
		const storage = new FakeSecretStorage();
		const store = createSecretStore(storage, AUTH_SECRET_ID);
		store.write("secret");

		store.clear();

		expect(store.read()).toBe(null);
		expect(storage.listSecrets()).toEqual([]);
	});

	it("still clears where `deleteSecret` does not exist", () => {
		const storage = new FakeSecretStorage(false);
		const store = createSecretStore(storage, AUTH_SECRET_ID);
		store.write("secret");

		store.clear();

		// The entry survives as an empty string — the API has no other way — and an empty
		// secret reads as no secret everywhere Obsen looks at one.
		expect(store.read()).toBe(null);
		expect(storage.getSecret(AUTH_SECRET_ID)).toBe("");
	});

	it("clears a secret that is not there without complaining", () => {
		const store = createSecretStore(new FakeSecretStorage(), AUTH_SECRET_ID);

		expect(() => {
			store.clear();
		}).not.toThrow();
	});

	it("says so when the platform has no secure storage, rather than losing the session quietly", () => {
		const storage = new FakeSecretStorage();
		storage.unavailable = true;
		const store = createSecretStore(storage, AUTH_SECRET_ID);

		expect(() => {
			store.write("secret");
		}).toThrow(SecretUnavailableError);
	});

	it("survives a storage that cannot even be read", () => {
		const store = createSecretStore(
			{
				getSecret: () => {
					throw new Error("Failed to load secrets");
				},
				setSecret: () => undefined,
				listSecrets: () => [],
			},
			AUTH_SECRET_ID,
		);

		// Spec §8.1: a secret that cannot be read is the logged-out state, never a crash
		// on the startup path.
		expect(store.read()).toBe(null);
	});
});
