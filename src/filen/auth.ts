import type { AuthVersion, FilenSDKConfig } from "@filen/sdk";

import { errorMessage } from "../engine/errors";

/**
 * Login and the **Auth Config** (spec §8.1): the one place credentials are handled,
 * and the boundary that decides what leaves memory.
 *
 * Three rules this module exists to keep:
 *
 * - **Nothing the user types is persisted.** `sdk.login()` writes its result onto
 *   `sdk.config`, leaving the email there and the literal string `"redacted"` where
 *   the password and 2FA code were. Obsen builds the Auth Config field by field
 *   instead of copying that object, so no field — including one a later SDK adds —
 *   can ride along into storage.
 * - **A failed login says *why*.** The settings form has three different right answers
 *   (reveal the 2FA field, say the password was refused, say the network was) and only
 *   Filen's own error code can tell them apart.
 * - **Nothing identifying is ever put in a message.** The SDK's own errors can quote
 *   the request, and the request carries the account, so the error this module raises
 *   carries a shape and keeps the original as `cause`.
 */

/**
 * What a logged-in session is made of: the SDK's derived credential material, minus
 * everything the user typed. `email` is here because the settings tab shows it and a
 * re-login prefills it — it is account-identifying, never a secret in itself, and it
 * lives under the same secret as the keys.
 */
export type AuthConfig = {
	email: string;
	apiKey: string;
	masterKeys: string[];
	publicKey: string;
	privateKey: string;
	authVersion: AuthVersion;
	/** The account's root folder — where the folder picker (ticket 031) starts. */
	baseFolderUUID: string;
	userId: number;
};

/** What the login form collects. Never stored, never logged. */
export type Credentials = { email: string; password: string; twoFactorCode?: string };

/** Why a login did not produce a session — one case per thing the form should do next. */
export type LoginFailure =
	/** The form has no email or no password yet; Filen was not contacted. */
	| "incomplete"
	/** The account has 2FA and no code was sent: reveal the field and let them re-submit. */
	| "two-factor-required"
	/** A code was sent and refused: the field stays, the message changes. */
	| "two-factor-rejected"
	/** Filen refused the email/password pair. */
	| "credentials-rejected"
	/** Filen could not be reached — "check your password" would be bad advice. */
	| "unreachable"
	/** Anything else, including a login that succeeded without a usable Auth Config. */
	| "unknown";

/**
 * A login that produced no session. `failure` is the whole payload: what a *user* is
 * told about each one is the settings UI's business (`ui/login-feedback.ts`), and the
 * message here is a terse technical one for a console — never the SDK's own, which can
 * quote the request, and the request carries the account.
 */
export class LoginError extends Error {
	constructor(
		readonly failure: LoginFailure,
		options: { cause?: unknown } = {},
	) {
		super(`Filen login failed: ${failure}`, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "LoginError";
	}
}

/**
 * The slice of `FilenSDK` this module uses — the whole auth dependency, in one place a
 * fake can stand in for. `hmacKey` is a field rather than a method because dropping it
 * is the only way to clear it (see {@link dropFilenAuth}).
 */
export interface FilenAuthApi {
	config: FilenSDKConfig;
	hmacKey: unknown;
	login(params: { email: string; password: string; twoFactorCode?: string }): Promise<void>;
	init(params?: FilenSDKConfig): void;
}

/**
 * Runs one login and answers with the Auth Config it derived.
 *
 * The SDK is left authenticated on success — it is the same client the `RemotePort`
 * will be built on — and untouched on failure.
 */
export async function filenLogin(sdk: FilenAuthApi, credentials: Credentials): Promise<AuthConfig> {
	const email = credentials.email.trim();
	const password = credentials.password;
	const twoFactorCode = credentials.twoFactorCode?.trim() ?? "";
	if (email === "" || password === "") throw new LoginError("incomplete");

	try {
		// Omitted rather than passed as `""`: the SDK substitutes its placeholder code for
		// any falsy value, so the two are the same call — but only by accident.
		await sdk.login({ email, password, ...(twoFactorCode === "" ? {} : { twoFactorCode }) });
	} catch (error) {
		throw loginError(error, twoFactorCode !== "");
	}

	const auth = authConfigOf(sdk.config);
	// A login Filen answered without the material a session is made of. Rare enough to
	// have no known cause, and a session built on it would fail later and less clearly.
	if (auth === null) throw new LoginError("unknown");
	return auth;
}

/** Re-authenticates a client from a stored Auth Config — the startup restore path. */
export function restoreFilenAuth(sdk: FilenAuthApi, auth: AuthConfig): void {
	// `connectToSocket: false` deliberately: Obsen drives `sdk.socket.connect()` itself
	// (spec §7), so the SDK's own connection would be a second, unmanaged one.
	sdk.init({ ...auth, connectToSocket: false });
}

/**
 * Drops the client: `init()` with no argument returns the SDK to Filen's anonymous
 * config and rebuilds every sub-client from it.
 *
 * The second line is not redundant. `init()` leaves `hmacKey` alone, and it is derived
 * from the private key and cached forever — so logging out and into a *different*
 * account would inherit the first account's key. Keeping the SDK instance (rather than
 * constructing a fresh one) is what lets everything already holding a reference to it
 * stay valid across a logout.
 */
export function dropFilenAuth(sdk: FilenAuthApi): void {
	sdk.init();
	sdk.hmacKey = null;
}

export function serializeAuthConfig(auth: AuthConfig): string {
	return JSON.stringify(auth);
}

/**
 * A stored Auth Config, or `null` for anything that is not one.
 *
 * Everything unreadable degrades to the logged-out state (spec §8.1): the secret can be
 * missing because it was never written, evicted (expected on iOS), or written by a
 * version of Obsen that stored something else. A half-valid config would fail later,
 * further from the cause, and with sync already believing it was linked.
 */
export function parseAuthConfig(stored: string | null): AuthConfig | null {
	if (stored === null || stored === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	return authConfigOf(parsed);
}

/**
 * What `init()` with no argument installs in every field. Filen's anonymous config is
 * a *complete* one — same fields as a real session, every value this string — so
 * "are the fields there" would call a logged-out client logged in. An API key and a
 * folder UUID are the two that could never legitimately be this.
 */
const ANONYMOUS = "anonymous";

/** The Auth Config inside an SDK config, or `null` when it is not all there. */
function authConfigOf(config: FilenSDKConfig): AuthConfig | null {
	const { email, apiKey, masterKeys, publicKey, privateKey, authVersion, baseFolderUUID, userId } =
		config;
	if (!isFilled(email) || !isFilled(apiKey) || !isFilled(publicKey) || !isFilled(privateKey)) {
		return null;
	}
	if (!isFilled(baseFolderUUID) || typeof userId !== "number") return null;
	if (apiKey === ANONYMOUS || baseFolderUUID === ANONYMOUS) return null;
	if (!Array.isArray(masterKeys) || masterKeys.length === 0) return null;
	if (!masterKeys.every(isFilled)) return null;
	if (authVersion !== 1 && authVersion !== 2 && authVersion !== 3) return null;

	return {
		email,
		apiKey,
		masterKeys: [...masterKeys],
		publicKey,
		privateKey,
		authVersion,
		baseFolderUUID,
		userId,
	};
}

function isFilled(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

/** Filen's own error codes, which are the only thing that tells these failures apart. */
const TWO_FACTOR_REQUIRED = /^enter_2fa$/;
const TWO_FACTOR_REJECTED = /2fa/i;
const CREDENTIALS_REJECTED = /password|credential|email|account_not_found/i;
const UNREACHABLE = /ERR_NETWORK|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|ERR_INTERNET/i;

function loginError(error: unknown, sentCode: boolean): LoginError {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	const message = errorMessage(error);
	// The original travels as `cause` and nowhere else: a developer can read it in the
	// console, and nothing renders it.
	return new LoginError(classify(code, message, sentCode), { cause: error });
}

function classify(code: string, message: string, sentCode: boolean): LoginFailure {
	if (TWO_FACTOR_REQUIRED.test(code)) return sentCode ? "two-factor-rejected" : "two-factor-required";
	if (TWO_FACTOR_REJECTED.test(code)) return "two-factor-rejected";
	if (CREDENTIALS_REJECTED.test(code)) return "credentials-rejected";
	// The network never reaches the API, so it has no Filen code to carry — axios puts
	// its own on the error, and everything else says so only in the message.
	if (UNREACHABLE.test(code) || UNREACHABLE.test(message) || /network/i.test(message)) {
		return "unreachable";
	}
	return "unknown";
}
