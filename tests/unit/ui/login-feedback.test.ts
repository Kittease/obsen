import { describe, expect, it } from "vitest";

import { LoginError, type LoginFailure } from "../../../src/filen/auth.ts";
import { loginFeedback } from "../../../src/ui/login-feedback.ts";

/**
 * Spec §8.2's no-dead-end rule, at the one place it is decided: a login that fails
 * because the account has 2FA must reveal the code field rather than leave the user
 * re-typing a password that was right all along.
 */

const failing = (failure: LoginFailure): LoginError => new LoginError(failure);

describe("loginFeedback", () => {
	it("flips the two-factor switch when Filen asks for a code", () => {
		expect(loginFeedback(failing("two-factor-required")).revealTwoFactor).toBe(true);
	});

	it.each([
		"incomplete",
		"two-factor-rejected",
		"credentials-rejected",
		"unreachable",
		"unknown",
	] as const)("leaves the switch alone for %s", (failure) => {
		// A rejected code means the field is already showing; anything else means guessing
		// at 2FA would send the user hunting for a code their account does not use.
		expect(loginFeedback(failing(failure)).revealTwoFactor).toBe(false);
	});

	it("says what to do next, never just that it failed", () => {
		expect(loginFeedback(failing("credentials-rejected")).message).toBe(
			"Filen refused that email and password",
		);
		expect(loginFeedback(failing("unreachable")).message).toMatch(/connection/);
	});

	it("never renders the error's own message, which comes from the SDK's side", () => {
		const error = new LoginError("credentials-rejected", { cause: new Error("secret detail") });

		expect(loginFeedback(error).message).not.toContain("secret detail");
		expect(loginFeedback(error).message).not.toBe(error.message);
	});

	it("sends only the unexplained to the console", () => {
		expect(loginFeedback(failing("credentials-rejected")).unexpected).toBe(false);
		expect(loginFeedback(failing("unknown")).unexpected).toBe(true);
	});

	it("has an answer for something that is not a login failure at all", () => {
		const feedback = loginFeedback(new TypeError("undefined is not a function"));

		expect(feedback.unexpected).toBe(true);
		expect(feedback.revealTwoFactor).toBe(false);
		// Never the raw message: a thrown value from anywhere can quote anything.
		expect(feedback.message).not.toContain("undefined is not a function");
	});
});
