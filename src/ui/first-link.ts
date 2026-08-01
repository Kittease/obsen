import { type App, Modal, Notice, Setting } from "obsidian";

import type { SyncEngine } from "../engine/engine";
import { type Plan, PlanCancelledError, type PlanProgress } from "../engine/plan";
import type { RunSummary } from "../engine/status";
import type { Link } from "../link";
import type { VaultLink } from "../obsidian/data";
import { AnsweringModal, ask } from "./answering-modal";
import { confirm } from "./confirm";
import { folderLabel } from "./folder-picker";

/**
 * The First Link flow (spec §8.4): explain → scan → preview → confirm.
 *
 * The shape exists to answer one question before anything moves: *what will linking
 * these two folders actually do?* So the first three steps write nothing at all — the
 * scan is the engine's plan-only entry point, the preview is that plan rendered, and
 * Cancel at any point leaves both sides exactly as they were. Only step 4 syncs, and it
 * syncs the plan the user just read rather than re-deciding behind them.
 *
 * Step 4 is also deliberately *not* modal: the Run is an ordinary one, the modal closes,
 * and Obsidian stays usable while it happens. A vault is not a wizard.
 */

/**
 * Spec §8.4 requires this in two places — here and in linked-state settings — because
 * the failure it prevents is silent, permanent and not the user's fault: two sync
 * engines on one folder on one device will fight over every file.
 */
export const DUAL_ENGINE_CAUTION =
	"Don't also sync this folder with the Filen desktop app on this device — one sync engine per folder per device.";

/**
 * Runs the whole flow for a folder the picker just returned. Resolves when the user has
 * either backed out or started the Run; the Run itself is not awaited.
 *
 * Whatever happens, the candidate is left staged only if it became the real link.
 */
export async function runFirstLink(app: App, link: Link, folder: VaultLink): Promise<boolean> {
	const explained = await confirm(app, {
		title: "Link this vault to Filen",
		body: [
			`Obsen will compare this vault with ${folderLabel(folder.path)} on Filen and show you exactly what the first sync would do.`,
			"Nothing is uploaded, downloaded or deleted in this step. You can cancel while it runs, and again once you have seen the preview.",
		],
		cta: "Scan",
	});
	if (!explained) return false;

	let engine: SyncEngine;
	try {
		engine = await link.stage(folder);
	} catch (error) {
		console.error("Obsen: could not prepare the first link", error);
		new Notice("Obsen could not prepare the first sync. Check the console for details.");
		return false;
	}

	const plan = await scan(app, engine);
	if (plan === null) {
		link.discard();
		return false;
	}

	const confirmed = await preview(app, { plan, folder });
	if (!confirmed) {
		link.discard();
		return false;
	}

	// Not awaited: the Run is an ordinary non-blocking one, and the tally arrives as a
	// notice whenever it finishes (spec §8.4 step 4, §8.6).
	void link
		.commit(plan)
		.then((summary) => new Notice(tally(summary), 10_000))
		.catch((error: unknown) => {
			console.error("Obsen: the first sync failed to start", error);
			new Notice("Obsen: the first sync could not start. Check the console for details.");
		});
	return true;
}

// ---- step 2: the scan ----

/** The dry run, with progress and a Cancel; `null` when it was cancelled or failed. */
async function scan(app: App, engine: SyncEngine): Promise<Plan | null> {
	const modal = new ScanModal(app);
	modal.open();
	try {
		const plan = await engine.plan({
			onProgress: (progress) => modal.report(progress),
			cancelled: () => modal.cancelled,
		});
		// A Cancel that lands in the same tick the plan resolves still means no: showing a
		// preview to someone who just backed out would be the one dead end this flow avoids.
		return modal.cancelled ? null : plan;
	} catch (error) {
		// Cancel is not a failure and says nothing: the user just closed the thing they
		// opened, and both sides are untouched either way.
		if (error instanceof PlanCancelledError) return null;
		console.error("Obsen: the first-link scan failed", error);
		new Notice("Obsen could not read your Filen folder. Check your connection and try again.");
		return null;
	} finally {
		modal.close();
	}
}

class ScanModal extends Modal {
	/** Read by the planner between steps; the whole Cancel mechanism (spec §8.4 step 2). */
	cancelled = false;
	private statusEl: HTMLElement | null = null;

	override onOpen(): void {
		this.setTitle("Scanning");
		this.contentEl.createEl("p", {
			text: "Comparing this vault with Filen. Nothing is being changed.",
			cls: "setting-item-description",
		});
		this.statusEl = this.contentEl.createEl("p", { text: sentence({ phase: "listing" }) });
		new Setting(this.contentEl).addButton((button) =>
			button.setButtonText("Cancel").onClick(() => {
				this.close();
			}),
		);
	}

	override onClose(): void {
		// Closing *is* cancelling — Escape and the close button included. A scan that has
		// already resolved closes this modal itself, and the flag is read no more.
		this.cancelled = true;
		this.contentEl.empty();
		this.statusEl = null;
	}

	report(progress: PlanProgress): void {
		if (this.statusEl !== null) this.statusEl.setText(sentence(progress));
	}
}

function sentence(progress: PlanProgress): string {
	switch (progress.phase) {
		case "listing":
			return "Listing your Filen folder…";
		case "scanning":
			return "Looking through this vault…";
		case "hashing":
			return `Checking local files… ${progress.done}/${progress.total}`;
	}
}

// ---- step 3: the preview ----

function preview(app: App, options: { plan: Plan; folder: VaultLink }): Promise<boolean> {
	return ask((resolve) => new PreviewModal(app, options, resolve));
}

class PreviewModal extends AnsweringModal<boolean> {
	constructor(
		app: App,
		private readonly options: { plan: Plan; folder: VaultLink },
		resolve: (confirmed: boolean) => void,
	) {
		super(app, resolve);
	}

	protected override get fallback(): boolean {
		return false;
	}

	override onOpen(): void {
		const { plan, folder } = this.options;
		const { counts } = plan;
		this.setTitle("Preview the first sync");
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `This vault and ${folderLabel(folder.path)} on Filen, as they are right now.`,
		});

		const rows: [number, string][] = [
			[counts.upload, "uploaded to Filen"],
			[counts.download, "downloaded into this vault"],
			[counts.identical, "already identical — paired, not transferred"],
			[counts.conflict, "kept as a conflict copy, because both sides differ"],
			[counts.skipped, "skipped — Obsen cannot sync these on this device"],
		];
		const listed = rows.filter(([count]) => count > 0);
		if (listed.length === 0) {
			this.contentEl.createEl("p", { text: "Both sides already match. Linking changes nothing." });
		} else {
			const list = this.contentEl.createEl("ul", { cls: "obsen-preview-counts" });
			for (const [count, what] of listed) {
				list.createEl("li", { text: `${count} ${count === 1 ? "file" : "files"} ${what}` });
			}
		}

		// Named only when the whole set fits (spec §8.4): the engine caps the list, and a
		// truncated one would read as "these are the conflicts" while hiding the rest.
		if (counts.conflict > 0 && plan.conflictPaths.length === counts.conflict) {
			this.contentEl.createEl("p", { cls: "setting-item-description", text: "Conflicts:" });
			const conflicts = this.contentEl.createEl("ul", { cls: "obsen-preview-conflicts" });
			for (const path of plan.conflictPaths) conflicts.createEl("li", { text: path });
		}

		// The First-Link rules, in the one place they matter: before anything has happened.
		this.contentEl.createEl("p", {
			text: "Nothing is deleted on either side. Files that already match are paired silently, and where both sides hold a different version, both are kept — the Filen version arrives as a conflict copy next to yours.",
		});
		this.contentEl.createDiv({ cls: "obsen-callout", text: DUAL_ENGINE_CAUTION });

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Start sync")
					.setCta()
					.onClick(() => {
						this.answer(true);
						this.close();
					}),
			);
	}
}

// ---- step 4: what the Run reports ----

/** The completion notice: the tallies the Run actually achieved, never the plan's. */
function tally(summary: RunSummary): string {
	if (summary.outcome === "offline") {
		return "Obsen: Filen could not be reached. Sync will pick up where it left off.";
	}
	const parts: string[] = [];
	const add = (count: number, one: string, many: string): void => {
		if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
	};
	add(summary.uploaded, "file uploaded", "files uploaded");
	add(summary.downloaded, "file downloaded", "files downloaded");
	add(summary.identical, "file already in sync", "files already in sync");
	add(summary.conflicts, "conflict copy", "conflict copies");
	add(summary.skips.length, "file skipped", "files skipped");
	add(summary.failures.length, "file failed", "files failed");
	if (parts.length === 0) return "Obsen: linked. Both sides already matched.";
	return `Obsen: first sync done — ${parts.join(", ")}.`;
}
