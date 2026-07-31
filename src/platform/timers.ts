import type { Timers } from "../engine/timers";

/**
 * The production {@link Timers}: the engine's clock, wired to the webview's.
 *
 * This lives outside `src/engine/` because `window` is an environment fact, and the
 * engine is not allowed to know any. `window.setTimeout` rather than the bare global
 * for Obsidian's popout-window compatibility rule.
 */
export const windowTimers: Timers = {
	now: () => Date.now(),
	after: (ms, handler) => {
		const id = window.setTimeout(handler, ms);
		return () => window.clearTimeout(id);
	},
};
