import { LoginError, type LoginFailure } from "../filen/auth";

/**
 * What a failed login *says*, and what it does to the form (spec §8.2's no-dead-end
 * rule).
 *
 * Both live here rather than next to the SDK: the copy is user-facing text, which
 * belongs to the UI layer, and the reveal is the one real decision the settings tab
 * makes — worth testing in milliseconds rather than inside a real Obsidian.
 */
export type LoginFeedback = {
	/** The sentence shown under the form. */
	message: string;
	/** Whether the 2FA switch should be flipped on, revealing the code field. */
	revealTwoFactor: boolean;
	/** Whether the detail belongs in the developer console — the only place Obsen logs. */
	unexpected: boolean;
};

/**
 * One sentence per failure. Sentence case, no trailing period: these are shown inline
 * under the login form, the way Obsidian's own settings errors are. Each says what to
 * do next, because "login failed" is advice nobody can act on.
 */
const MESSAGE: Record<LoginFailure, string> = {
	incomplete: "Enter an email address and a password",
	"two-factor-required": "This account has two-factor authentication — enter your code",
	"two-factor-rejected": "Filen refused that two-factor code — codes expire quickly, try a fresh one",
	"credentials-rejected": "Filen refused that email and password",
	unreachable: "Filen could not be reached — check your connection and try again",
	unknown: "Login failed — see the developer console for details",
};

export function loginFeedback(error: unknown): LoginFeedback {
	if (!(error instanceof LoginError)) {
		// Not a login failure at all: a bug, or an environment that broke. The user gets a
		// sentence, the developer gets the object.
		return {
			message: "Something went wrong logging in — see the developer console for details",
			revealTwoFactor: false,
			unexpected: true,
		};
	}
	return {
		message: MESSAGE[error.failure],
		// Only the *required* case flips the switch. A rejected code means the field is
		// already showing, and flipping something already on would look like a bug; an
		// `unknown` failure must not guess at 2FA and send the user hunting for a code
		// their account does not use.
		revealTwoFactor: error.failure === "two-factor-required",
		unexpected: error.failure === "unknown",
	};
}
