import type { SkipReason } from "./status";

/**
 * One way to turn an unknown thrown value into something a user or a log can read.
 * Ports reject with whatever their environment throws — an `Error`, a string, an
 * axios object — and every layer of the engine needs the same answer.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The error taxonomy (spec §5.7): the five things going wrong can *mean*, and the
 * whole vocabulary the engine's resilience rests on.
 *
 * This is a **port contract**. The engine cannot read an HTTP status or a Filen error
 * code — it must not know they exist — so each adapter classifies its own failures
 * into these kinds and the engine reacts to the kind alone. An adapter that classifies
 * nothing still works: an unrecognized failure counts as `transient`, which retries and
 * then hands the path to the next Run — the right default for a fault nobody has named,
 * since every operation here is redo-safe (spec §5.5).
 */
export type FaultKind =
	/** A blip: retry on the ladder, then requeue the path and let the Run finish. */
	| "transient"
	/** The credentials no longer work. Sync freezes until the user signs in again. */
	| "auth"
	/** The account is full. Uploads stop; downloads and deletes keep flowing. */
	| "quota"
	/**
	 * The Remote Folder itself could not be resolved. The Run is abandoned before
	 * anything is planned — an unreadable remote must never be read as "everything was
	 * deleted there" (spec §5.7).
	 */
	| "missing-root"
	/**
	 * The operation is refused and always will be — a name the platform or Filen will
	 * not take. Skip-and-Surface: reported, never retried, never auto-renamed (§5.8).
	 */
	| "rejected";

/**
 * A failure an adapter (or the engine itself) has classified. Anything else thrown at
 * the engine is read as `transient`, so this exists to say something *more* specific
 * than "it broke".
 */
export class SyncFault extends Error {
	/** For a `rejected` fault, how the skip is reported; ignored for the other kinds. */
	readonly reason: SkipReason;

	constructor(
		readonly kind: FaultKind,
		message: string,
		options: { cause?: unknown; reason?: SkipReason } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SyncFault";
		this.reason = options.reason ?? "remote-rejected";
	}
}

/** What a thrown value means, with `transient` as the default for the unrecognized. */
export function faultKind(error: unknown): FaultKind {
	return error instanceof SyncFault ? error.kind : "transient";
}

/**
 * The Attention State a fault puts sync into, or `null` for the kinds a Run absorbs on its
 * own. One table, so the planner's half of the taxonomy and the executor's cannot drift.
 *
 * `quota` is absent deliberately: it is the one Attention State that does not stop a Run,
 * so it is decided by what the Run *did*, not by the fault alone.
 */
export function attentionFor(kind: FaultKind): "auth-error" | "frozen" | null {
	if (kind === "auth") return "auth-error";
	if (kind === "missing-root") return "frozen";
	return null;
}
