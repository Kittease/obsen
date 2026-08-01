import FilenSDK from "@filen/sdk";
import { describe, expect, it } from "vitest";

import {
	dropFilenAuth,
	filenLogin,
	type LoginError,
	parseAuthConfig,
	restoreFilenAuth,
	serializeAuthConfig,
} from "../../src/filen/auth.ts";
import { testCredentials } from "./sandbox.ts";

/**
 * Layer 4 (spec §9): login against the real Filen account.
 *
 * What only this layer can answer is whether the Auth Config is **sufficient** — that
 * the fields Obsen picks out of `sdk.config` really do rebuild a working client, with
 * no hidden dependency on the password that was thrown away. Every other layer takes
 * that on faith, because the fakes are written to behave that way.
 *
 * It also pins the shape of a *rejected* login, which is the one thing the settings
 * form branches on and the one thing no fake can vouch for.
 *
 * Skipped without `FILEN_TEST_EMAIL` / `FILEN_TEST_PASSWORD`, which is what makes it
 * safe on fork PRs. Read `tests/remote/sandbox.ts` before pointing it at an account.
 */

const credentials = testCredentials();

describe.skipIf(credentials === null)("login against a real Filen account", () => {
	it("derives an Auth Config a fresh client can be rebuilt from", async () => {
		const auth = await filenLogin(new FilenSDK(), credentials!);

		// Round-tripped through storage, exactly as the plugin does it.
		const restored = parseAuthConfig(serializeAuthConfig(auth));
		expect(restored).not.toBe(null);

		const second = new FilenSDK();
		restoreFilenAuth(second, restored!);
		// The proof that the config is sufficient: a call only an authenticated client
		// can make, on a client that never saw the password.
		expect(await second.user().baseFolder()).toBe(auth.baseFolderUUID);
	}, 60_000);

	it("stores nothing the user typed", async () => {
		const auth = await filenLogin(new FilenSDK(), credentials!);

		const stored = serializeAuthConfig(auth);
		expect(stored).not.toContain(credentials!.password);
		expect(auth).not.toHaveProperty("password");
		// The email is the one account-identifying field kept, because the settings tab
		// shows it — and it lives under the same secret as the keys.
		expect(auth.email).toBe(credentials!.email);
	}, 60_000);

	it("leaves a dropped client unable to do anything", async () => {
		const sdk = new FilenSDK();
		await filenLogin(sdk, credentials!);

		dropFilenAuth(sdk);

		await expect(sdk.user().baseFolder()).rejects.toThrow();
	}, 60_000);

	it("classifies a wrong password as a rejection rather than a mystery", async () => {
		const error = (await filenLogin(new FilenSDK(), {
			email: credentials!.email,
			password: `${credentials!.password}-wrong`,
		}).catch((thrown: unknown) => thrown)) as LoginError;

		// If Filen ever renames this code, the settings form starts saying "see the
		// developer console" to someone who simply mistyped — and this is what says so.
		expect(error.failure).toBe("credentials-rejected");
		// Nothing identifying, in the message or anywhere near it (spec §9's rule for
		// this suite).
		expect(error.message).not.toContain(credentials!.email);
		expect(error.message).not.toContain(credentials!.password);
	}, 60_000);
});
