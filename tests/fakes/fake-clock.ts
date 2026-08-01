import type { Timers } from "../../src/engine/timers.ts";

/**
 * A {@link Timers} whose time only moves when a test says so.
 *
 * `advance` fires every timer that comes due — including timers scheduled by those
 * timers — and flushes the microtask queue between firings, so a test can `await
 * clock.advance(2_000)` and then assert on work the callback kicked off.
 */
export class FakeClock implements Timers {
	private current: number;
	private nextId = 1;
	private readonly scheduled = new Map<number, { at: number; handler: () => void }>();

	constructor(startAt = 1_700_000_000_000) {
		this.current = startAt;
	}

	now(): number {
		return this.current;
	}

	after(ms: number, handler: () => void): () => void {
		const id = this.nextId++;
		this.scheduled.set(id, { at: this.current + ms, handler });
		return () => this.scheduled.delete(id);
	}

	/** Pending timer count — a test asserting "nothing is armed" can say so directly. */
	get armed(): number {
		return this.scheduled.size;
	}

	/**
	 * Jumps to the earliest armed timer and fires it; `false` when nothing is armed.
	 *
	 * The building block for "let this Run finish" when the Run itself sleeps — a retry
	 * delay, a backoff rung — because it moves time by exactly what the engine asked for
	 * and no more, leaving `now()` meaningful to assert against.
	 */
	async advanceToNext(): Promise<boolean> {
		const next = [...this.scheduled.values()].reduce<number | null>(
			(earliest, timer) => (earliest === null ? timer.at : Math.min(earliest, timer.at)),
			null,
		);
		if (next === null) return false;
		await this.advance(next - this.current);
		return true;
	}

	async advance(ms: number): Promise<void> {
		const target = this.current + ms;
		for (;;) {
			const due = [...this.scheduled.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(([, a], [, b]) => a.at - b.at)[0];
			if (!due) break;
			const [id, timer] = due;
			this.scheduled.delete(id);
			this.current = timer.at;
			timer.handler();
			await flushMicrotasks();
		}
		this.current = target;
		await flushMicrotasks();
	}
}

/** Enough turns for a short promise chain inside a timer callback to settle. */
async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}
