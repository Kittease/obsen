import FilenSDK from "@filen/sdk";

/**
 * The isolation apparatus for the real-remote suite (spec §9 layer 4).
 *
 * The rules this file exists to enforce, all of them from the spec:
 *
 * - **A dedicated Filen test account, never a personal one.** Credentials arrive
 *   through the environment only, never a committed file, and the suite is skipped
 *   when they are absent — which is what makes it safe on fork PRs.
 * - **Per-run isolation**: everything happens under
 *   `/obsen-tests/run-<timestamp>-<random>`, so two runs — a laptop and CI, or two
 *   CI jobs — never see each other's files.
 * - **Self-cleaning, and only of its own mess.** Teardown permanently removes the
 *   run's folder and the trashed items that came out of it; a sweep at suite start
 *   does the same for whatever a crashed run left behind. Spec §9 suggests a
 *   periodic `emptyTrash()`, and this deliberately does not use it: `emptyTrash` is
 *   account-wide and irreversible, so a suite that reached for it would need the
 *   account to be provably empty — a promise no real test account keeps for long.
 *   Deleting exactly what the run created satisfies the same criterion with a blast
 *   radius of one folder.
 * - **Nothing identifying is ever logged.** No email, no account id, no API key —
 *   not in a message, not in an error, not in a failure diff.
 */

/** Where every run's sandbox lives, at the account root. */
export const TEST_ROOT = "obsen-tests";

/** A run folder older than this belonged to a run that never cleaned up. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const RUN_FOLDER = /^run-(\d+)-[0-9a-z]+$/;

export type TestCredentials = { email: string; password: string };

/**
 * The test account, or `null` when it is not configured — the suite skips itself
 * rather than failing, because a fork PR legitimately has no secrets.
 */
export function testCredentials(): TestCredentials | null {
	const email = process.env["FILEN_TEST_EMAIL"];
	const password = process.env["FILEN_TEST_PASSWORD"];
	if (!email || !password) return null;
	return { email, password };
}

/** One run's sandbox: a logged-in SDK and an empty folder of its own. */
export class RemoteSandbox {
	private constructor(
		readonly sdk: FilenSDK,
		/** The Remote Folder a `FilenRemote` under test is pointed at. */
		readonly rootUuid: string,
		/** This run's folder name under {@link TEST_ROOT}. */
		readonly name: string,
		private readonly testRootUuid: string,
	) {}

	static async open(credentials: TestCredentials, now: number): Promise<RemoteSandbox> {
		const sdk = new FilenSDK();
		try {
			// 2FA is off on the test account (spec §9), so the SDK's placeholder code is
			// what goes over the wire.
			await sdk.login(credentials);
		} catch (error) {
			// Never re-raise the SDK's message verbatim: it can quote the request, and the
			// request carries the account.
			throw new Error(`Filen login failed for the test account: ${classify(error)}`);
		}

		const baseFolderUuid = sdk.config.baseFolderUUID;
		if (!baseFolderUuid) throw new Error("Filen returned no base folder for the test account");

		const testRootUuid = await sdk.cloud().createDirectory({
			name: TEST_ROOT,
			parent: baseFolderUuid,
		});
		await sweepStaleRuns(sdk, testRootUuid, now);

		const name = runFolderName(now);
		const rootUuid = await sdk.cloud().createDirectory({ name, parent: testRootUuid });
		return new RemoteSandbox(sdk, rootUuid, name, testRootUuid);
	}

	/**
	 * Removes this run without a trace, and **checks that it worked** — "the suite
	 * leaves nothing behind" is an acceptance criterion, so it is asserted rather than
	 * hoped for.
	 */
	async close(): Promise<void> {
		const owned = await purgeRun(this.sdk, this.rootUuid);

		if ((await this.runFolders()).includes(this.name)) {
			throw new Error("teardown left this run's folder behind");
		}
		await awaitPurge(this.sdk, owned);
	}

	/** The run folders under `obsen-tests` — how a test observes the stale sweep. */
	async runFolders(): Promise<string[]> {
		const children = await this.sdk.cloud().listDirectory({ uuid: this.testRootUuid });
		return children.map((child) => child.name).sort();
	}

	/** Plants what a crashed run would have left, so the sweep has something to find. */
	async seedStaleRun(startedAt: number): Promise<string> {
		const name = runFolderName(startedAt);
		await this.sdk.cloud().createDirectory({ name, parent: this.testRootUuid });
		return name;
	}

	async sweep(now: number): Promise<void> {
		await sweepStaleRuns(this.sdk, this.testRootUuid, now);
	}
}

/**
 * Permanently removes one run folder and every trashed item that came out of it,
 * and answers with the UUIDs it considered its own.
 *
 * Trashing an item on Filen keeps its original parent, which is what makes "came out
 * of this run" decidable here rather than something the tests would have to record
 * as they went.
 */
async function purgeRun(sdk: FilenSDK, runUuid: string): Promise<Set<string>> {
	const tree = await sdk.cloud().getDirectoryTree({ uuid: runUuid, skipCache: true });
	const owned = new Set([runUuid]);
	for (const item of Object.values(tree)) if (item.type === "directory") owned.add(item.uuid);

	for (const item of await sdk.cloud().listTrash()) {
		if (!owned.has(item.parent)) continue;
		// A trashed folder takes its contents with it, so only the top of each trashed
		// subtree appears here — and deleting it is enough.
		if (item.type === "directory") await sdk.cloud().deleteDirectory({ uuid: item.uuid });
		else await sdk.cloud().deleteFile({ uuid: item.uuid });
	}

	await sdk.cloud().deleteDirectory({ uuid: runUuid });
	return owned;
}

/**
 * Waits for Filen to finish removing what {@link purgeRun} asked it to.
 *
 * Measured against the live API: permanently deleting a folder that was **not**
 * already in the trash moves it there first and clears it a few seconds later, so a
 * teardown check made immediately reports a leak that is about to fix itself. An
 * already-trashed item, by contrast, goes at once. Polling asserts the criterion
 * without asserting a latency Filen never promised.
 */
async function awaitPurge(sdk: FilenSDK, owned: Set<string>): Promise<void> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const strays = (await sdk.cloud().listTrash()).filter(
			(item) => owned.has(item.uuid) || owned.has(item.parent),
		);
		if (strays.length === 0) return;
		if (Date.now() > deadline) {
			throw new Error(
				`teardown left ${strays.length} item(s) of this run in the trash: ` +
					strays.map((item) => `${item.type} ${item.uuid}`).join(", "),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
}

/** Removes what a crashed run left behind, so the account does not accrete sandboxes. */
async function sweepStaleRuns(sdk: FilenSDK, testRootUuid: string, now: number): Promise<void> {
	const children = await sdk.cloud().listDirectory({ uuid: testRootUuid });
	for (const child of children) {
		const startedAt = Number(RUN_FOLDER.exec(child.name)?.[1]);
		if (!Number.isFinite(startedAt) || now - startedAt < STALE_AFTER_MS) continue;
		await purgeRun(sdk, child.uuid);
	}
}

function runFolderName(now: number): string {
	return `run-${now}-${crypto.randomUUID().slice(0, 8)}`;
}

/** An error's *shape*, with nothing of the account in it. */
function classify(error: unknown): string {
	if (!(error instanceof Error)) return "unknown error";
	// Filen's own codes are safe to surface and are what a reader actually needs.
	const code = /\b(ENOENT|EPERM|EACCES|enter_2fa|invalid_credentials|email_or_password_wrong)\b/.exec(
		error.message,
	);
	return code?.[0] ?? error.name;
}
