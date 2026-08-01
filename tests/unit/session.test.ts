import { describe, expect, it } from "vitest";

import { type LoginError, serializeAuthConfig } from "../../src/filen/auth.ts";
import { AUTH_SECRET_ID, createSecretStore } from "../../src/obsidian/secrets.ts";
import { Session } from "../../src/session.ts";
import { ANONYMOUS, FakeFilenAuth } from "../fakes/fake-filen-auth.ts";
import { FakeSecretStorage } from "../fakes/fake-secret-storage.ts";

/**
 * The session state machine (spec §8.1, §8.2): logged out ⇄ logged in, and the three
 * transitions between them — restore, log in, log out.
 *
 * Framework-free on purpose. Everything the settings tab does about auth is decided
 * here, so it can be decided in milliseconds against fakes instead of inside a real
 * Obsidian.
 */

const ACCOUNT = {
	email: "someone@example.test",
	password: "correct horse battery staple",
	twoFactorCode: null,
	apiKey: "api-key-from-filen",
};

function world(options: { supportsDelete?: boolean } = {}) {
	const sdk = new FakeFilenAuth(ACCOUNT);
	const storage = new FakeSecretStorage(options.supportsDelete ?? true);
	const secrets = createSecretStore(storage, AUTH_SECRET_ID);
	const changes: string[] = [];
	const session = new Session({ sdk, secrets });
	session.subscribe(() => changes.push(session.state.status));
	return { sdk, storage, secrets, session, changes };
}

const CREDENTIALS = { email: ACCOUNT.email, password: ACCOUNT.password };

describe("restore", () => {
	it("starts logged out when nothing is stored", () => {
		const { session, sdk } = world();

		expect(session.restore()).toBe(false);
		expect(session.state).toEqual({ status: "logged-out" });
		expect(sdk.config.apiKey).toBe(ANONYMOUS.apiKey);
	});

	it("re-authenticates from the stored Auth Config, without asking Filen again", async () => {
		const first = world();
		await first.session.logIn(CREDENTIALS);

		// A second plugin load over the same vault — new SDK, new session, same secret.
		const sdk = new FakeFilenAuth(ACCOUNT);
		const session = new Session({ sdk, secrets: first.secrets });

		expect(session.restore()).toBe(true);
		expect(session.state).toEqual({ status: "logged-in", email: ACCOUNT.email });
		expect(sdk.config.apiKey).toBe(ACCOUNT.apiKey);
		expect(sdk.attempts).toEqual([]);
	});

	it("degrades to logged out when the secret was evicted", () => {
		const { session, storage } = world();
		storage.setSecret(AUTH_SECRET_ID, "");

		expect(session.restore()).toBe(false);
		expect(session.state.status).toBe("logged-out");
	});

	it("degrades to logged out for a secret it cannot read, and keeps it", () => {
		const { session, storage } = world();
		storage.setSecret(AUTH_SECRET_ID, "written by some other version of obsen");

		expect(session.restore()).toBe(false);
		// Not deleted: Obsen cannot read it, which is not the same as knowing it is
		// worthless — a downgrade must not destroy what the newer version wrote. The next
		// successful login overwrites it anyway.
		expect(storage.getSecret(AUTH_SECRET_ID)).toBe("written by some other version of obsen");
	});

	it("is idempotent — a second restore is not a second session", () => {
		const { session, storage, changes } = world();
		storage.setSecret(AUTH_SECRET_ID, serializeAuthConfig(authConfig()));

		expect(session.restore()).toBe(true);
		expect(session.restore()).toBe(true);
		expect(changes).toEqual(["logged-in"]);
	});
});

describe("logIn", () => {
	it("authenticates the client and persists the Auth Config", async () => {
		const { session, sdk, storage } = world();

		const result = await session.logIn(CREDENTIALS);

		expect(result).toEqual({ persisted: true });
		expect(session.state).toEqual({ status: "logged-in", email: ACCOUNT.email });
		expect(sdk.config.apiKey).toBe(ACCOUNT.apiKey);
		expect(storage.listSecrets()).toEqual([AUTH_SECRET_ID]);
	});

	it("puts nothing the user typed into storage", async () => {
		const { session, storage } = world();

		await session.logIn({ ...CREDENTIALS, twoFactorCode: "123456" });

		const stored = storage.getSecret(AUTH_SECRET_ID) ?? "";
		expect(stored).not.toContain(ACCOUNT.password);
		expect(stored).not.toContain("123456");
	});

	it("stays logged out when Filen refuses", async () => {
		const { session, sdk, storage, changes } = world();

		const error = (await session
			.logIn({ ...CREDENTIALS, password: "wrong" })
			.catch((thrown: unknown) => thrown)) as LoginError;

		expect(error.failure).toBe("credentials-rejected");
		expect(session.state.status).toBe("logged-out");
		expect(sdk.config.apiKey).toBe(ANONYMOUS.apiKey);
		expect(storage.listSecrets()).toEqual([]);
		expect(changes).toEqual([]);
	});

	it("keeps the session usable when the device cannot store secrets", async () => {
		const { session, storage } = world();
		storage.unavailable = true;

		const result = await session.logIn(CREDENTIALS);

		// The login worked; only its persistence did not. Saying so beats both silently
		// losing the session at the next restart and pretending the login failed.
		expect(result).toEqual({ persisted: false });
		expect(session.state.status).toBe("logged-in");
	});

	it("replaces an existing session — the auth-error recovery path", async () => {
		const { session, storage } = world();
		await session.logIn(CREDENTIALS);
		const other = { email: "other@example.test", password: "hunter2" };
		storage.setSecret("some-other-plugin", "untouched");

		const sdk = new FakeFilenAuth({ ...ACCOUNT, ...other, apiKey: "second-api-key" });
		const second = new Session({ sdk, secrets: createSecretStore(storage, AUTH_SECRET_ID) });
		await second.logIn(other);

		expect(second.state).toEqual({ status: "logged-in", email: other.email });
		expect(storage.getSecret(AUTH_SECRET_ID)).toContain("second-api-key");
		expect(storage.getSecret("some-other-plugin")).toBe("untouched");
	});
});

describe("logOut", () => {
	it("clears the secret and drops the client", async () => {
		const { session, sdk, storage } = world();
		await session.logIn(CREDENTIALS);

		session.logOut();

		expect(session.state).toEqual({ status: "logged-out" });
		expect(storage.getSecret(AUTH_SECRET_ID)).toBe(null);
		// The SDK replaces a dropped session with its anonymous config rather than
		// emptying one: `"anonymous"` is what "no API key" looks like here.
		expect(sdk.config.apiKey).toBe(ANONYMOUS.apiKey);
		expect(sdk.hmacKey).toBe(null);
	});

	it("clears the secret on a build without `deleteSecret` too", async () => {
		const { session, secrets } = world({ supportsDelete: false });
		await session.logIn(CREDENTIALS);

		session.logOut();

		expect(secrets.read()).toBe(null);
	});

	it("is a no-op when already logged out", () => {
		const { session, changes } = world();

		session.logOut();

		expect(session.state.status).toBe("logged-out");
		expect(changes).toEqual([]);
	});

	it("announces every transition exactly once", async () => {
		const { session, changes } = world();

		await session.logIn(CREDENTIALS);
		session.logOut();
		await session.logIn(CREDENTIALS);

		expect(changes).toEqual(["logged-in", "logged-out", "logged-in"]);
	});

	it("stops announcing to an unsubscribed listener", async () => {
		const { session } = world();
		const seen: string[] = [];
		const unsubscribe = session.subscribe(() => seen.push(session.state.status));

		unsubscribe();
		await session.logIn(CREDENTIALS);

		expect(seen).toEqual([]);
	});
});

function authConfig() {
	return {
		email: ACCOUNT.email,
		apiKey: ACCOUNT.apiKey,
		masterKeys: ["derived-master-key"],
		publicKey: "public-key",
		privateKey: "private-key",
		authVersion: 2 as const,
		baseFolderUUID: "base-folder-uuid",
		userId: 4242,
	};
}
