import type { FilenSDKConfig } from "@filen/sdk";

import type { FilenAuthApi } from "../../src/filen/auth.ts";

/**
 * An in-memory stand-in for the Filen SDK's auth surface, modelled on what
 * `sdk.login()` actually does in 0.4.2 — which is the only reason this fake is
 * interesting:
 *
 * - It writes the whole derived Auth Config **onto `sdk.config`**, and that object is
 *   what Obsen persists a slice of. It also leaves `email` there, and the literal
 *   strings `"redacted"` where the password and 2FA code were.
 * - It answers a missing two-factor code with the server's own `enter_2fa` code on an
 *   `APIError`-shaped object, which is how the login form knows to reveal the field
 *   rather than tell the user their password is wrong.
 * - `init()` rebuilds the client from a config — the restore path — and `init()` with
 *   no argument returns it to Filen's anonymous config, which is how logging out drops
 *   the client without dropping the object every port already holds.
 */

/** What Filen's API throws: an `Error` carrying the server's own `code`. */
export class FakeApiError extends Error {
	constructor(readonly code: string) {
		super(`fake API error: ${code}`);
		this.name = "APIError";
	}
}

/**
 * The SDK's anonymous config — what `init()` with no argument installs — field for
 * field from `@filen/sdk`'s constants, because the surprising part is that it is a
 * *complete* config: every field a real session has, filled with the string
 * `"anonymous"`. Logging out therefore does not leave blanks behind, and anything
 * validating an Auth Config by "are the fields there" would call this one valid.
 *
 * One deviation: the real config's email is a fixed anonymous address at Filen's own
 * domain. Nothing reads the value, so this uses a reserved documentation domain rather
 * than putting an address in a public repo.
 */
export const ANONYMOUS: FilenSDKConfig = {
	email: "anonymous@filen.invalid",
	password: "anonymous",
	masterKeys: ["anonymous"],
	twoFactorCode: "XXXXXX",
	publicKey: "anonymous",
	privateKey: "anonymous",
	apiKey: "anonymous",
	authVersion: 3,
	baseFolderUUID: "anonymous",
	userId: 1,
	connectToSocket: false,
	metadataCache: true,
};

export type FakeAccount = {
	email: string;
	password: string;
	/** `null` for an account without two-factor authentication. */
	twoFactorCode: string | null;
	apiKey: string;
};

export class FakeFilenAuth implements FilenAuthApi {
	config: FilenSDKConfig = { ...ANONYMOUS };
	/** Set by `_updateKeys` in the real SDK, and — the point — *not* cleared by `init()`. */
	hmacKey: Uint8Array | null = null;

	/** Logins attempted, in order: the assertion that nothing is sent twice or not at all. */
	readonly attempts: { email: string; password: string; twoFactorCode?: string }[] = [];

	/** Thrown instead of consulting the account, for the offline and unknown-failure paths. */
	fault: Error | null = null;

	/** A login Filen answers without the one field the folder picker needs. */
	omitBaseFolder = false;

	constructor(private readonly account: FakeAccount) {}

	login(params: { email: string; password: string; twoFactorCode?: string }): Promise<void> {
		this.attempts.push(params);
		if (this.fault !== null) return Promise.reject(this.fault);
		if (params.email !== this.account.email || params.password !== this.account.password) {
			return Promise.reject(new FakeApiError("email_or_password_wrong"));
		}
		if (this.account.twoFactorCode !== null && params.twoFactorCode !== this.account.twoFactorCode) {
			return Promise.reject(new FakeApiError("enter_2fa"));
		}

		this.hmacKey = new Uint8Array([1, 2, 3]);
		this.init({
			...this.config,
			email: params.email,
			// Verbatim from the SDK: it overwrites both with a placeholder rather than
			// keeping them, which is why an Auth Config picked field by field is the only
			// way to be sure neither survives.
			password: "redacted",
			twoFactorCode: "redacted",
			apiKey: this.account.apiKey,
			masterKeys: ["derived-master-key"],
			publicKey: "public-key",
			privateKey: "private-key",
			authVersion: 2,
			...(this.omitBaseFolder ? {} : { baseFolderUUID: "base-folder-uuid" }),
			userId: 4242,
		});
		return Promise.resolve();
	}

	init(params?: FilenSDKConfig): void {
		this.config = params === undefined ? { ...ANONYMOUS } : { ...ANONYMOUS, ...params };
	}
}
