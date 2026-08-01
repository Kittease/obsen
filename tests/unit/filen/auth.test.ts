import { describe, expect, it } from "vitest";

import {
	type AuthConfig,
	dropFilenAuth,
	filenLogin,
	LoginError,
	parseAuthConfig,
	restoreFilenAuth,
	serializeAuthConfig,
} from "../../../src/filen/auth.ts";
import { ANONYMOUS, FakeApiError, FakeFilenAuth } from "../../fakes/fake-filen-auth.ts";

/**
 * Login and the Auth Config (spec §8.1). The two properties worth failing a build over:
 * **nothing the user types is persisted**, and a login that fails says *why* precisely
 * enough for the form to do the right thing about it.
 */

const ACCOUNT = {
	email: "someone@example.test",
	password: "correct horse battery staple",
	twoFactorCode: null,
	apiKey: "api-key-from-filen",
};

const AUTH: AuthConfig = {
	email: ACCOUNT.email,
	apiKey: ACCOUNT.apiKey,
	masterKeys: ["derived-master-key"],
	publicKey: "public-key",
	privateKey: "private-key",
	authVersion: 2,
	baseFolderUUID: "base-folder-uuid",
	userId: 4242,
};

describe("filenLogin", () => {
	it("derives an Auth Config the SDK can be rebuilt from", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);

		const auth = await filenLogin(sdk, { email: ACCOUNT.email, password: ACCOUNT.password });

		expect(auth).toEqual(AUTH);
	});

	it("persists nothing the user typed", async () => {
		const sdk = new FakeFilenAuth({ ...ACCOUNT, twoFactorCode: "123456" });

		const auth = await filenLogin(sdk, {
			email: ACCOUNT.email,
			password: ACCOUNT.password,
			twoFactorCode: "123456",
		});

		// The SDK leaves `password: "redacted"` and `twoFactorCode: "redacted"` on its own
		// config. Obsen picks the Auth Config field by field rather than copying that
		// object, so neither field — nor any field a later SDK adds — can ride along.
		const stored = serializeAuthConfig(auth);
		expect(stored).not.toContain(ACCOUNT.password);
		expect(stored).not.toContain("123456");
		expect(stored).not.toContain("redacted");
		expect(auth).not.toHaveProperty("password");
		expect(auth).not.toHaveProperty("twoFactorCode");
	});

	it("sends the two-factor code only when the user supplied one", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);

		await filenLogin(sdk, { email: ACCOUNT.email, password: ACCOUNT.password, twoFactorCode: "" });

		// An empty string is the form's "the switch is off", and the SDK reads any falsy
		// code as "use the placeholder". Passing `""` through would be the same thing, but
		// only by accident — omitting it says so.
		expect(sdk.attempts).toEqual([{ email: ACCOUNT.email, password: ACCOUNT.password }]);
	});

	it("trims what the user typed, which is where a pasted code comes from", async () => {
		const sdk = new FakeFilenAuth({ ...ACCOUNT, twoFactorCode: "123456" });

		await filenLogin(sdk, {
			email: `  ${ACCOUNT.email} `,
			password: ACCOUNT.password,
			twoFactorCode: " 123456 ",
		});

		expect(sdk.attempts).toEqual([
			{ email: ACCOUNT.email, password: ACCOUNT.password, twoFactorCode: "123456" },
		]);
	});

	it("reports a missing two-factor code as its own failure, not as a bad password", async () => {
		const sdk = new FakeFilenAuth({ ...ACCOUNT, twoFactorCode: "123456" });

		const error = await filenLogin(sdk, {
			email: ACCOUNT.email,
			password: ACCOUNT.password,
		}).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(LoginError);
		expect((error as LoginError).failure).toBe("two-factor-required");
	});

	it("reports rejected credentials", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);

		const error = await filenLogin(sdk, { email: ACCOUNT.email, password: "wrong" }).catch(
			(thrown: unknown) => thrown,
		);

		expect((error as LoginError).failure).toBe("credentials-rejected");
	});

	it.each([
		["a wrong two-factor code", new FakeApiError("enter_2fa_invalid")],
		["an expired code", new FakeApiError("2fa_invalid")],
	])("reports %s as a two-factor failure of its own", async (_case, fault) => {
		const sdk = new FakeFilenAuth(ACCOUNT);
		sdk.fault = fault;

		const error = await filenLogin(sdk, {
			email: ACCOUNT.email,
			password: ACCOUNT.password,
			twoFactorCode: "000000",
		}).catch((thrown: unknown) => thrown);

		expect((error as LoginError).failure).toBe("two-factor-rejected");
	});

	it("reports a network failure as unreachable rather than as a rejection", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);
		sdk.fault = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });

		const error = await filenLogin(sdk, {
			email: ACCOUNT.email,
			password: ACCOUNT.password,
		}).catch((thrown: unknown) => thrown);

		// The distinction is the whole point: "check your password" is bad advice for a
		// phone in a lift.
		expect((error as LoginError).failure).toBe("unreachable");
	});

	it("keeps an unrecognized failure unrecognized", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);
		sdk.fault = new FakeApiError("something_new");

		const error = await filenLogin(sdk, {
			email: ACCOUNT.email,
			password: ACCOUNT.password,
		}).catch((thrown: unknown) => thrown);

		expect((error as LoginError).failure).toBe("unknown");
	});

	it("never quotes the SDK's message, which can carry the request", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);
		sdk.fault = new FakeApiError("email_or_password_wrong");

		const error = (await filenLogin(sdk, {
			email: ACCOUNT.email,
			password: ACCOUNT.password,
		}).catch((thrown: unknown) => thrown)) as LoginError;

		expect(error.message).not.toContain(ACCOUNT.email);
		expect(error.message).not.toContain(ACCOUNT.password);
		expect(error.message).not.toContain("fake API error");
		// The cause is kept for `console.error`, which is a developer's tool, not a log
		// file this plugin writes.
		expect(error.cause).toBe(sdk.fault);
	});

	it("refuses an empty email or password without asking Filen", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);

		for (const credentials of [
			{ email: "", password: ACCOUNT.password },
			{ email: ACCOUNT.email, password: "" },
			{ email: "   ", password: ACCOUNT.password },
		]) {
			const error = await filenLogin(sdk, credentials).catch((thrown: unknown) => thrown);
			expect((error as LoginError).failure).toBe("incomplete");
		}
		expect(sdk.attempts).toEqual([]);
	});

	it("fails rather than returning half an Auth Config", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);
		// A login Filen answers without a base folder is one the folder picker (ticket 031)
		// has no root for; better a failed login than a session that cannot be used.
		sdk.omitBaseFolder = true;

		const error = await filenLogin(sdk, {
			email: ACCOUNT.email,
			password: ACCOUNT.password,
		}).catch((thrown: unknown) => thrown);

		expect((error as LoginError).failure).toBe("unknown");
	});
});

describe("restoreFilenAuth / dropFilenAuth", () => {
	it("rebuilds an authenticated client from a stored Auth Config", () => {
		const sdk = new FakeFilenAuth(ACCOUNT);

		restoreFilenAuth(sdk, AUTH);

		expect(sdk.config.apiKey).toBe(AUTH.apiKey);
		expect(sdk.config.masterKeys).toEqual(AUTH.masterKeys);
		expect(sdk.config.baseFolderUUID).toBe(AUTH.baseFolderUUID);
	});

	it("leaves the socket disconnected — Obsen drives it itself (spec §7)", () => {
		const sdk = new FakeFilenAuth(ACCOUNT);

		restoreFilenAuth(sdk, AUTH);

		expect(sdk.config.connectToSocket).toBe(false);
	});

	it("drops every trace of the account, cached keys included", async () => {
		const sdk = new FakeFilenAuth(ACCOUNT);
		await filenLogin(sdk, { email: ACCOUNT.email, password: ACCOUNT.password });

		dropFilenAuth(sdk);

		// Not cleared — *replaced*, by the anonymous config the SDK falls back to.
		expect(sdk.config.apiKey).toBe(ANONYMOUS.apiKey);
		expect(sdk.config.email).toBe(ANONYMOUS.email);
		// `init()` rebuilds every sub-client but does *not* clear the HMAC key derived from
		// the private key. Logging into a second account would otherwise inherit the first
		// one's — which is why dropping it is a line of its own.
		expect(sdk.hmacKey).toBe(null);
	});
});

describe("parseAuthConfig", () => {
	it("round-trips a serialized Auth Config", () => {
		expect(parseAuthConfig(serializeAuthConfig(AUTH))).toEqual(AUTH);
	});

	it.each([
		["nothing stored", null],
		["an evicted secret", ""],
		["a non-JSON secret", "{"],
		["a JSON scalar", '"api-key"'],
		["a config with no API key", JSON.stringify({ ...AUTH, apiKey: "" })],
		["a config with no master keys", JSON.stringify({ ...AUTH, masterKeys: [] })],
		["a config whose master keys are not strings", JSON.stringify({ ...AUTH, masterKeys: [1] })],
		["a config with no email to show", JSON.stringify({ ...AUTH, email: undefined })],
		["a config from an unknown auth version", JSON.stringify({ ...AUTH, authVersion: 9 })],
		// Filen's logged-out config is a complete one — every field present, every value
		// `"anonymous"` — so it passes every check but this.
		["the SDK's own anonymous config", JSON.stringify(ANONYMOUS)],
		["an anonymous base folder", JSON.stringify({ ...AUTH, baseFolderUUID: "anonymous" })],
	])("reads %s as no session rather than a broken one", (_case, stored) => {
		// Every one of these degrades to the logged-out state (spec §8.1): eviction is
		// expected on iOS, and a half-valid config would fail later and less clearly.
		expect(parseAuthConfig(stored)).toBe(null);
	});

	it("ignores fields it does not know", () => {
		const stored = JSON.stringify({ ...AUTH, password: "leaked", somethingNew: true });

		expect(parseAuthConfig(stored)).toEqual(AUTH);
	});
});
