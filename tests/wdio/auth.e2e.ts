import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import { AUTH_SECRET_ID } from "../../src/obsidian/secrets.ts";

/**
 * Credentials in real Obsidian (spec §9, layer 3): `SecretStorage` as it actually
 * behaves, and the startup restore that makes a restart not re-prompt.
 *
 * What only this layer can answer:
 *
 * - **Whether the secret id is legal.** Obsidian validates it and throws; the spec's
 *   `obsen:filen-auth` is not a legal id, and nothing but the real API says so.
 * - **Whether the Auth Config really stays out of the vault.** The unit suite can check
 *   what Obsen *writes*; only a real vault on a real disk can be searched for what
 *   ended up in it.
 * - **Whether the secret survives a restart** and is loaded by the time
 *   `onLayoutReady` runs the restore.
 *
 * The login *network* call is not here: it belongs to the real-remote suite (layer 4,
 * `tests/remote/auth.test.ts`), which has the test account. What this suite exercises
 * is everything on either side of it.
 */

/** A synthetic Auth Config: the right shape, with keys that unlock nothing. */
const AUTH = JSON.stringify({
	email: "someone@example.test",
	apiKey: "e2e-api-key",
	masterKeys: ["e2e-master-key"],
	publicKey: "e2e-public-key",
	privateKey: "e2e-private-key",
	authVersion: 2,
	baseFolderUUID: "e2e-base-folder",
	userId: 1,
});

describe("credentials in real Obsidian", () => {
	let configDir: string;

	before(async () => {
		configDir = await obsidianPage.getConfigDir();
	});

	afterEach(async () => {
		await browser.executeObsidian(({ app }, id) => {
			// `deleteSecret` is real and undocumented — the same call the plugin's logout
			// makes. Leaving a secret behind would carry into the next spec.
			(app.secretStorage as unknown as { deleteSecret(id: string): boolean }).deleteSecret(id);
		}, AUTH_SECRET_ID);
	});

	it("accepts Obsen's secret id and rejects the one the spec wrote", async () => {
		const result = await browser.executeObsidian(({ app }, id) => {
			const attempt = (candidate: string): string | null => {
				try {
					app.secretStorage.setSecret(candidate, "probe");
					return null;
				} catch (error) {
					return error instanceof Error ? error.name : String(error);
				}
			};
			return { ours: attempt(id), spec: attempt("obsen:filen-auth") };
		}, AUTH_SECRET_ID);

		expect(result.ours).toBe(null);
		// Spec §8.1 names the secret `obsen:filen-auth`; Obsidian's own id rule is
		// `/^[a-z0-9-]+$/`, so the colon throws. This is the assertion behind the
		// implementation using the same name with a dash.
		expect(result.spec).not.toBe(null);
	});

	it("keeps the Auth Config out of every file in the vault", async () => {
		const found = await browser.executeObsidian(
			async ({ app }, id, auth) => {
				app.secretStorage.setSecret(id, auth);
				const apiKey = (JSON.parse(auth) as { apiKey: string }).apiKey;

				// Walk the whole vault, hidden paths included: `data.json` is the file spec
				// §8.1 forbids the keys from reaching, but so is every other one.
				const hits: string[] = [];
				const walk = async (folder: string): Promise<void> => {
					const { files, folders } = await app.vault.adapter.list(folder);
					for (const file of files) {
						const content = await app.vault.adapter.read(file);
						if (content.includes(apiKey)) hits.push(file);
					}
					for (const child of folders) await walk(child);
				};
				await walk("");
				return hits;
			},
			AUTH_SECRET_ID,
			AUTH,
		);

		expect(found).toEqual([]);
	});

	it("restores the session across a restart, without asking Filen", async () => {
		await browser.executeObsidian(
			({ app }, id, auth) => {
				app.secretStorage.setSecret(id, auth);
			},
			AUTH_SECRET_ID,
			AUTH,
		);

		await browser.reloadObsidian();

		// Polled rather than read once: Obsidian 1.13 loads secrets asynchronously behind
		// a platform secure-storage adapter, so `onLayoutReady` can genuinely run first —
		// which is why the plugin also restores on the store's `changed` event. Reading
		// the state once made this test pass or fail depending on which won the race.
		await browser.waitUntil(
			async () =>
				(await browser.executeObsidian(({ plugins }) => plugins.obsen.session?.state.status)) ===
				"logged-in",
			{ timeout: 10_000, timeoutMsg: "the session was never restored after a restart" },
		);

		const restored = await browser.executeObsidian(({ plugins }) => ({
			state: plugins.obsen.session?.state ?? null,
			apiKey: plugins.obsen.filen?.config.apiKey ?? null,
			layoutReady: plugins.obsen.app.workspace.layoutReady,
		}));

		expect(restored.state).toEqual({ status: "logged-in", email: "someone@example.test" });
		expect(restored.apiKey).toBe("e2e-api-key");
		expect(restored.layoutReady).toBe(true);
	});

	it("starts logged out, and stays loaded, when the secret is unreadable", async () => {
		await browser.executeObsidian(
			({ app }, id) => {
				app.secretStorage.setSecret(id, "not an auth config");
			},
			AUTH_SECRET_ID,
		);

		await browser.reloadObsidian();

		const state = await browser.executeObsidian(({ plugins }) => ({
			session: plugins.obsen.session?.state ?? null,
			hasPorts: plugins.obsen.ports !== null,
		}));

		// Spec §8.1: eviction and corruption both degrade to the logged-out state — never
		// a plugin that failed to load.
		expect(state.session).toEqual({ status: "logged-out" });
		expect(state.hasPorts).toBe(true);
	});

	it("clears the secret on logout and keeps the Sync State", async () => {
		const after = await browser.executeObsidian(
			async ({ app, plugins }, id, auth, dir) => {
				app.secretStorage.setSecret(id, auth);
				plugins.obsen.session!.restore();
				await plugins.obsen.ports!.store.writeState('{"schemaVersion":1,"files":{}}');

				plugins.obsen.session!.logOut();

				return {
					secret: app.secretStorage.getSecret(id),
					ids: app.secretStorage.listSecrets(),
					state: plugins.obsen.session!.state,
					apiKey: plugins.obsen.filen?.config.apiKey ?? null,
					syncState: await plugins.obsen.ports!.store.readState(),
					dataJson: (await app.vault.adapter.exists(`${dir}/plugins/obsen/data.json`))
						? await app.vault.adapter.read(`${dir}/plugins/obsen/data.json`)
						: null,
				};
			},
			AUTH_SECRET_ID,
			AUTH,
			configDir,
		);

		expect(after.secret).toBe(null);
		expect(after.ids).not.toContain(AUTH_SECRET_ID);
		expect(after.state).toEqual({ status: "logged-out" });
		// The SDK does not empty its config, it replaces it with an anonymous one — so
		// what "dropped" looks like is the key being gone, not the field.
		expect(after.apiKey).not.toBe("e2e-api-key");
		// Logging out is not unlinking (spec §8.2): a re-login resumes rather than
		// re-hashing the vault.
		expect(after.syncState).toBe('{"schemaVersion":1,"files":{}}');
		if (after.dataJson !== null) expect(after.dataJson).not.toContain("e2e-api-key");
	});
});

describe("the settings tab in real Obsidian", () => {
	afterEach(async () => {
		await browser.executeObsidian(({ app, plugins }, id) => {
			(app.secretStorage as unknown as { deleteSecret(id: string): boolean }).deleteSecret(id);
			plugins.obsen.settingsTab?.hide();
			plugins.obsen.settings.link = null;
		}, AUTH_SECRET_ID);
	});

	it("shows the login form when logged out", async () => {
		const form = await browser.executeObsidian(({ plugins }) => {
			const tab = plugins.obsen.settingsTab!;
			tab.display();
			return {
				names: [...tab.containerEl.querySelectorAll(".setting-item-name")].map((el) =>
					el.textContent?.trim(),
				),
				types: [...tab.containerEl.querySelectorAll("input")].map((el) => el.type),
			};
		});

		expect(form.names).toContain("Email");
		expect(form.names).toContain("Password");
		expect(form.names).toContain("My account has 2FA");
		// No code field until the switch says there is one.
		expect(form.names).not.toContain("Two-factor code");
		expect(form.types).toContain("password");
	});

	it("reveals the code field without losing what was typed", async () => {
		const after = await browser.executeObsidian(({ plugins }) => {
			const tab = plugins.obsen.settingsTab!;
			tab.display();
			const inputs = [...tab.containerEl.querySelectorAll("input")];
			const email = inputs.find((input) => input.type === "email")!;
			const password = inputs.find((input) => input.type === "password")!;
			// Typed, as Obsidian's own text component reports it.
			for (const [input, value] of [
				[email, "someone@example.test"],
				[password, "hunter2"],
			] as const) {
				input.value = value;
				input.dispatchEvent(new Event("input"));
			}

			// Obsidian's toggle is `<label class="checkbox-container">` with a `change`
			// listener on the label. A programmatic `.click()` on the checkbox inside it
			// fires `click` and no `change` while the tab is detached from the document,
			// so the event Obsidian actually listens for is dispatched directly.
			const toggle = inputs.find((input) => input.type === "checkbox")!;
			toggle.checked = true;
			toggle.dispatchEvent(new Event("change", { bubbles: true }));

			const redrawn = [...tab.containerEl.querySelectorAll("input")];
			return {
				names: [...tab.containerEl.querySelectorAll(".setting-item-name")].map((el) =>
					el.textContent?.trim(),
				),
				values: redrawn.filter((input) => input.type !== "checkbox").map((input) => input.value),
			};
		});

		// Spec §8.2's no-dead-end rule, in its cheaper form: the switch redraws the form,
		// and the redraw is fed from the draft rather than from the DOM it just emptied.
		expect(after.names).toContain("Two-factor code");
		expect(after.values).toContain("someone@example.test");
		expect(after.values).toContain("hunter2");
	});

	it("submits the form, and puts the failure under it", async () => {
		const after = await browser.executeObsidian(async ({ plugins }) => {
			const tab = plugins.obsen.settingsTab!;
			tab.display();
			// Submitted empty on purpose: `filenLogin` refuses an empty email or password
			// without contacting Filen, so this drives the tab's whole submit path — button
			// → session → failure → message → re-enabled button — with no network in a
			// layer-3 suite. What a *real* login does is layer 4's (tests/remote/auth).
			tab.containerEl.querySelector<HTMLElement>("button.mod-cta")?.click();
			await new Promise((resolve) => setTimeout(resolve, 100));

			const button = tab.containerEl.querySelector("button.mod-cta");
			// Not named `error`: WebdriverIO reads a returned object with an `error` key as
			// a WebDriver protocol error and throws its value at the test.
			return {
				warning: tab.containerEl.querySelector(".mod-warning")?.textContent ?? null,
				buttonText: button?.textContent ?? null,
				disabled: button?.hasAttribute("disabled") ?? null,
				state: plugins.obsen.session!.state.status,
			};
		});

		expect(after.warning).toBe("Enter an email address and a password");
		// Back to a form the user can use, not a spinner that never resolves.
		expect(after.buttonText).toBe("Log in");
		expect(after.disabled).toBe(false);
		expect(after.state).toBe("logged-out");
	});

	it("warns before logging out of a linked vault, and abandons it on cancel", async () => {
		const outcome = await browser.executeObsidian(
			async ({ app, plugins }, id, auth) => {
				app.secretStorage.setSecret(id, auth);
				plugins.obsen.session!.restore();
				// What ticket 031 will write when a folder is picked; here it is only what
				// makes logging out worth a warning (spec §8.2).
				plugins.obsen.settings.link = { folderUuid: "linked-folder-uuid" };

				const tab = plugins.obsen.settingsTab!;
				tab.display();
				[...tab.containerEl.querySelectorAll("button")]
					.find((button) => button.textContent === "Log out")
					?.click();
				await new Promise((resolve) => setTimeout(resolve, 100));

				const modal = document.querySelector(".modal-container");
				const body = modal?.textContent ?? "";
				[...(modal?.querySelectorAll("button") ?? [])]
					.find((button) => button.textContent === "Cancel")
					?.click();
				// Obsidian removes a closed modal on the next frames, not synchronously.
				await new Promise((resolve) => setTimeout(resolve, 500));

				return {
					body,
					state: plugins.obsen.session!.state.status,
					secret: app.secretStorage.getSecret(id) === null ? null : "kept",
					modalsLeft: document.querySelectorAll(".modal-container").length,
				};
			},
			AUTH_SECRET_ID,
			AUTH,
		);

		expect(outcome.body).toContain("Sync stops until you log in again");
		// Cancel is not a quiet yes: the session and the secret both survive it.
		expect(outcome.state).toBe("logged-in");
		expect(outcome.secret).toBe("kept");
		expect(outcome.modalsLeft).toBe(0);
	});

	it("logs out of a linked vault once the warning is confirmed", async () => {
		const outcome = await browser.executeObsidian(
			async ({ app, plugins }, id, auth) => {
				app.secretStorage.setSecret(id, auth);
				plugins.obsen.session!.restore();
				plugins.obsen.settings.link = { folderUuid: "linked-folder-uuid" };

				const tab = plugins.obsen.settingsTab!;
				tab.display();
				[...tab.containerEl.querySelectorAll("button")]
					.find((button) => button.textContent === "Log out")
					?.click();
				await new Promise((resolve) => setTimeout(resolve, 100));

				[...document.querySelectorAll<HTMLButtonElement>(".modal-container button")]
					.find((button) => button.textContent === "Log out")
					?.click();
				await new Promise((resolve) => setTimeout(resolve, 100));

				return {
					state: plugins.obsen.session!.state.status,
					secret: app.secretStorage.getSecret(id),
					// The vault stays linked: logging out is not unlinking (spec §8.2).
					link: plugins.obsen.settings.link,
					text: tab.containerEl.textContent ?? "",
				};
			},
			AUTH_SECRET_ID,
			AUTH,
		);

		expect(outcome.state).toBe("logged-out");
		expect(outcome.secret).toBe(null);
		expect(outcome.link).toEqual({ folderUuid: "linked-folder-uuid" });
		// And the tab followed the session back to the login form.
		expect(outcome.text).toContain("Email");
	});

	it("shows the account and a way out once logged in", async () => {
		const view = await browser.executeObsidian(
			({ app, plugins }, id, auth) => {
				app.secretStorage.setSecret(id, auth);
				plugins.obsen.session!.restore();
				const tab = plugins.obsen.settingsTab!;
				tab.display();
				return {
					text: tab.containerEl.textContent ?? "",
					buttons: [...tab.containerEl.querySelectorAll("button")].map((el) =>
						el.textContent?.trim(),
					),
				};
			},
			AUTH_SECRET_ID,
			AUTH,
		);

		expect(view.text).toContain("Logged in as someone@example.test");
		expect(view.buttons).toContain("Log out");
	});

	it("redraws itself when the session changes underneath it", async () => {
		const text = await browser.executeObsidian(
			({ app, plugins }, id, auth) => {
				const tab = plugins.obsen.settingsTab!;
				tab.display();
				app.secretStorage.setSecret(id, auth);
				// Not a click: the point is that the tab follows the session rather than its
				// own buttons — which is what makes ticket 037's status updates land here too.
				plugins.obsen.session!.restore();
				return tab.containerEl.textContent ?? "";
			},
			AUTH_SECRET_ID,
			AUTH,
		);

		expect(text).toContain("Logged in as someone@example.test");
	});
});
