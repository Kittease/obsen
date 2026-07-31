/**
 * The Sync Scope predicate (spec §2, normative selection-scope contract).
 *
 * All three Reconcile inputs — Sync State, local scan, remote listing — are
 * filtered by the *same* predicate before diffing. That is what keeps out-of-scope
 * content invisible to the diff instead of reading as "missing → deleted", and it
 * is the contract protecting the post-v1 selective-sync end goal.
 *
 * v1's production predicate is "everything except the Exclusion List" (spec §2.1),
 * and it is supplied by the Obsidian adapter that knows `Vault#configDir`
 * (ticket 029). The engine only ever sees the predicate.
 */
export type SyncScope = (path: string) => boolean;

/** The engine default: everything is in scope. */
export const EVERYTHING: SyncScope = () => true;
