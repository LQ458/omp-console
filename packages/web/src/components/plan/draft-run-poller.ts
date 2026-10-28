import type { DraftRun } from "@omp-console/protocol";
import { isRunActive } from "../../lib/draft";

export const RUN_POLL_MS = 1000;

export interface PollerTimers {
	/** `setInterval` semantics: calls `fn` every `ms` until cleared. */
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const REAL_TIMERS: PollerTimers = {
	set: (fn, ms) => setInterval(fn, ms),
	clear: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface DraftRunPollerOptions {
	list(): Promise<readonly DraftRun[]>;
	onRuns(runs: readonly DraftRun[]): void;
	/** A failed list call, or null when the next one succeeds. */
	onError(error: unknown): void;
	intervalMs?: number;
	timers?: PollerTimers;
}

/**
 * Keeps a session's draft runs fresh: one list call now, then one every `intervalMs` for as long as any run is
 * active, and none after that. At most one call is in flight (a slow daemon does not pile requests up), a failed call
 * does not stop the polling of a live run, and `stop()` leaves no timer behind.
 */
export class DraftRunPoller {
	readonly #options: DraftRunPollerOptions;
	readonly #timers: PollerTimers;
	#timer: unknown = null;
	#inFlight = false;
	#stopped = false;

	constructor(options: DraftRunPollerOptions) {
		this.#options = options;
		this.#timers = options.timers ?? REAL_TIMERS;
	}

	/** Whether the interval is running (a run is active). */
	get polling(): boolean {
		return this.#timer !== null;
	}

	async refresh(): Promise<void> {
		if (this.#inFlight || this.#stopped) return;
		this.#inFlight = true;
		try {
			const runs = await this.#options.list();
			if (this.#stopped) return;
			this.#options.onRuns(runs);
			this.#options.onError(null);
			this.#sync(runs.some(run => isRunActive(run)));
		} catch (error) {
			if (!this.#stopped) this.#options.onError(error);
		} finally {
			this.#inFlight = false;
		}
	}

	stop(): void {
		this.#stopped = true;
		this.#sync(false);
	}

	#sync(active: boolean): void {
		if (active && this.#timer === null) {
			this.#timer = this.#timers.set(() => void this.refresh(), this.#options.intervalMs ?? RUN_POLL_MS);
		} else if (!active && this.#timer !== null) {
			this.#timers.clear(this.#timer);
			this.#timer = null;
		}
	}
}
