/**
 * Polls `GET /api/sessions/:id/drift` for one session. Only knowledge-workspace sessions are polled: the detector runs
 * there alone, so a project session never pays for the request. The poller waits for each answer before arming the
 * next tick, skips the request while the page is hidden, and drops any answer that arrives after `stop()`.
 */
import type { DriftSuggestion, WorkspaceKind } from "@omp-console/protocol";

export const DRIFT_POLL_MS = 4_000;

export function shouldPollDrift(kind: WorkspaceKind | undefined): boolean {
	return kind === "knowledge";
}

export interface DriftPollerOptions {
	api: { drift(sessionId: string, signal?: AbortSignal): Promise<DriftSuggestion | null> };
	sessionId: string;
	onResult(suggestion: DriftSuggestion | null): void;
	onError?(error: unknown): void;
	intervalMs?: number;
	isVisible?(): boolean;
	/** Arms a one-shot timer and returns its canceller. */
	schedule?(fn: () => void, ms: number): () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
}

export class DriftPoller {
	readonly #opts: DriftPollerOptions;
	#running = false;
	#cancelTimer: (() => void) | null = null;
	#abort: AbortController | null = null;

	constructor(options: DriftPollerOptions) {
		this.#opts = options;
	}

	get running(): boolean {
		return this.#running;
	}

	/** First request now, then one per interval. A second `start()` is a no-op. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		void this.#tick();
	}

	stop(): void {
		this.#running = false;
		this.#cancelTimer?.();
		this.#cancelTimer = null;
		this.#abort?.abort();
		this.#abort = null;
	}

	async #tick(): Promise<void> {
		this.#cancelTimer = null;
		if (!this.#running) return;
		const visible = this.#opts.isVisible ?? (() => true);
		if (visible()) {
			const controller = new AbortController();
			this.#abort = controller;
			try {
				const suggestion = await this.#opts.api.drift(this.#opts.sessionId, controller.signal);
				if (this.#running && !controller.signal.aborted) this.#opts.onResult(suggestion);
			} catch (err) {
				if (this.#running && !controller.signal.aborted) this.#opts.onError?.(err);
			}
			if (this.#abort === controller) this.#abort = null;
		}
		if (!this.#running) return;
		const schedule = this.#opts.schedule ?? defaultSchedule;
		this.#cancelTimer = schedule(() => void this.#tick(), this.#opts.intervalMs ?? DRIFT_POLL_MS);
	}
}
