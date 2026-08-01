import {
	type AuthConfig,
	type Credentials,
	dropFilenAuth,
	filenLogin,
	parseAuthConfig,
	restoreFilenAuth,
	serializeAuthConfig,
} from "./filen/auth";
import { type SecretStore, SecretUnavailableError } from "./obsidian/secrets";

/**
 * Logged out ⇄ logged in: the state machine behind the settings tab's first two states
 * (spec §8.2), and the only thing in the plugin allowed to move between them.
 *
 * It owns three collaborators and one rule each: the SDK client is authenticated and
 * de-authenticated *here*; the secret is written and cleared *here*; and every surface
 * that draws the session subscribes rather than caching what it last saw.
 *
 * Deliberately free of `obsidian` imports. Nothing about "log in, keep the keys, log
 * out" needs a running app, and keeping it that way is what lets the whole matrix be
 * tested in milliseconds (spec §9 layer 1) instead of inside a real Obsidian.
 *
 * What is *not* here: the Sync State. Logging out keeps it (spec §8.2) — a re-login
 * resumes where sync left off rather than re-hashing a vault — which is a property of
 * this class doing nothing at all about it.
 */

export type SessionState = { status: "logged-out" } | { status: "logged-in"; email: string };

/** What `logIn` says about a login that worked. */
export type LoginResult = {
	/**
	 * Whether the Auth Config reached secure storage. `false` means this session works
	 * and will not survive a restart — the device has no secure storage (spec §8.1's
	 * eviction case, met early). Never a silent state: the settings tab says so.
	 */
	persisted: boolean;
};

/** The slice of the SDK a session needs — the same one `filen/auth.ts` operates on. */
type AuthApi = Parameters<typeof filenLogin>[0];

export class Session {
	private readonly sdk: AuthApi;
	private readonly secrets: SecretStore;
	private current: SessionState = { status: "logged-out" };
	private readonly listeners = new Set<() => void>();

	constructor(params: { sdk: AuthApi; secrets: SecretStore }) {
		this.sdk = params.sdk;
		this.secrets = params.secrets;
	}

	get state(): SessionState {
		return this.current;
	}

	/**
	 * Re-authenticates from the stored Auth Config, if there is one — the startup path
	 * (`onLayoutReady`), and the reason a restart does not re-prompt.
	 *
	 * Synchronous and network-free: `SecretStorage` reads from memory and the SDK is
	 * rebuilt from the config alone. Nothing here can fail in a way worth reporting —
	 * a missing, evicted, or unreadable secret is simply the logged-out state (spec
	 * §8.1), which is also what a first run looks like.
	 */
	restore(): boolean {
		const auth = parseAuthConfig(this.secrets.read());
		if (auth === null) return false;
		this.authenticate(auth);
		return true;
	}

	/**
	 * One login attempt. Resolves only when there is a session; rejects with a
	 * `LoginError` whose `failure` says what the form should do next.
	 *
	 * @throws {import("./filen/auth").LoginError}
	 */
	async logIn(credentials: Credentials): Promise<LoginResult> {
		const auth = await filenLogin(this.sdk, credentials);

		let persisted = true;
		try {
			this.secrets.write(serializeAuthConfig(auth));
		} catch (error) {
			// The one failure that must not undo a successful login: the credentials are
			// good and the client is authenticated, so sync can run for as long as this
			// app session lasts.
			if (!(error instanceof SecretUnavailableError)) throw error;
			persisted = false;
		}

		this.authenticate(auth);
		return { persisted };
	}

	/**
	 * Clears the secret and drops the client (spec §8.2). Sync State survives untouched
	 * — logging out is not unlinking, and a re-login resumes rather than re-bootstraps.
	 *
	 * The caller warns the user when a folder is linked; whether one is is not this
	 * class's business.
	 */
	logOut(): void {
		this.secrets.clear();
		dropFilenAuth(this.sdk);
		this.set({ status: "logged-out" });
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private authenticate(auth: AuthConfig): void {
		restoreFilenAuth(this.sdk, auth);
		this.set({ status: "logged-in", email: auth.email });
	}

	private set(state: SessionState): void {
		if (state.status === this.current.status && emailOf(state) === emailOf(this.current)) return;
		this.current = state;
		for (const listener of [...this.listeners]) listener();
	}
}

function emailOf(state: SessionState): string | null {
	return state.status === "logged-in" ? state.email : null;
}
