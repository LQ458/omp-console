import { setBenchHooks } from "./bench";

/**
 * `?bench` instrumentation (rubric criteria #4 scroll smoothness and #5 token-to-pixel).
 *
 * This module is loaded only by the `?bench` entry path. The normal app reaches it through the
 * small callback bridge in `bench.ts`, which stays in the initial bundle.
 *
 * Definitions below match the scroll and token-to-paint rubric: a dropped frame is an in-page requestAnimationFrame
 * delta greater than 1.5x the display refresh interval. Token-to-paint here is the web leg only: from the moment a
 * token/entry frame reaches the page to the first paint after the React commit that contains it. The daemon-emit leg is
 * measured by `packages/web/bench` on one clock.
 */

export interface LatencyStats {
	n: number;
	p50: number;
	p95: number;
	max: number;
}

export interface BenchResult {
	/** Frame intervals logged between `start()` and `stop()`. */
	frames: number;
	/** Intervals longer than 1.5x `refreshMs`. */
	droppedFrames: number;
	droppedPct: number;
	/** Display refresh interval the threshold was derived from. */
	refreshMs: number;
	/** Frame received -> next paint after the commit containing it. */
	tokenToPaintMs: LatencyStats;
	/** Main-thread tasks over 50 ms (Chromium only; 0 where the Long Tasks API is missing). */
	longTasks: number;
}

export type ScrollDirection = "down" | "up" | "bounce";

export interface ScrollOptions {
	durationMs: number;
	direction?: ScrollDirection;
	/** Distance to cover in px (default: to the end of the scrollable range in that direction). */
	distancePx?: number;
}

export interface ScrollReport {
	direction: ScrollDirection;
	durationMs: number;
	/** Absolute distance travelled in px. */
	distancePx: number;
}

/** The scrolling surface the driver moves. */
export interface ScrollSurface {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

/** Browser services the recorder needs; faked in tests. */
export interface BenchHost {
	now(): number;
	/** Runs `callback` with the frame start time; returns a cancel function. */
	raf(callback: (frameTime: number) => void): () => void;
	/** Runs `callback` once the next frame has been painted; returns a cancel function. */
	afterNextPaint(callback: () => void): () => void;
	/** Records a user-timing mark/measure pair for DevTools and tracing. */
	trace(id: number, receivedAt: number, paintedAt: number): void;
	/** Starts counting long tasks; the returned function stops and yields the count. */
	observeLongTasks(): () => number;
	scroller(): ScrollSurface | null;
}

const DROP_FACTOR = 1.5;
/** Quantile of frame intervals taken as "the refresh interval": robust to a janky run. */
const REFRESH_QUANTILE = 25;
const CALIBRATION_FRAMES = 45;
const MAX_PENDING = 20_000;

/** Nearest-rank percentile of an ascending array; 0 for an empty one. */
export function percentile(sortedAscending: readonly number[], p: number): number {
	if (sortedAscending.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sortedAscending.length);
	return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1]!;
}

export function summarizeLatencies(samples: readonly number[]): LatencyStats {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		n: sorted.length,
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		max: round(sorted[sorted.length - 1] ?? 0),
	};
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function intervals(frameTimes: readonly number[]): number[] {
	const out: number[] = [];
	for (let i = 1; i < frameTimes.length; i++) out.push(frameTimes[i]! - frameTimes[i - 1]!);
	return out;
}

/** Refresh interval estimate from frame timestamps: the 25th percentile of their intervals. */
export function estimateRefreshMs(frameTimes: readonly number[]): number {
	const sorted = intervals(frameTimes).sort((a, b) => a - b);
	return percentile(sorted, REFRESH_QUANTILE);
}

/**
 * Dropped-frame statistics from rAF timestamps. `refreshHintMs` (an earlier idle calibration) caps
 * the run's own estimate so a run that is janky from the first frame cannot hide its own drops.
 */
export function summarizeFrames(
	frameTimes: readonly number[],
	refreshHintMs?: number,
): Pick<BenchResult, "frames" | "droppedFrames" | "droppedPct" | "refreshMs"> {
	const deltas = intervals(frameTimes);
	const own = estimateRefreshMs(frameTimes);
	const refreshMs =
		refreshHintMs !== undefined && refreshHintMs > 0 ? Math.min(own || refreshHintMs, refreshHintMs) : own;
	if (deltas.length === 0 || refreshMs <= 0) {
		return { frames: deltas.length, droppedFrames: 0, droppedPct: 0, refreshMs: round(refreshMs) };
	}
	const limit = refreshMs * DROP_FACTOR;
	const droppedFrames = deltas.filter(delta => delta > limit).length;
	return {
		frames: deltas.length,
		droppedFrames,
		droppedPct: round((droppedFrames / deltas.length) * 100),
		refreshMs: round(refreshMs),
	};
}

interface PendingFrame {
	id: number;
	receivedAt: number;
}

export class BenchRecorder {
	readonly #host: BenchHost;
	#running = false;
	#frameTimes: number[] = [];
	#stopRaf: (() => void) | null = null;
	#stopLongTasks: (() => number) | null = null;
	#pending: PendingFrame[] = [];
	#latencies: number[] = [];
	#seq = 0;
	#calibratedRefreshMs: number | undefined;

	constructor(host: BenchHost) {
		this.#host = host;
	}

	/** Logs idle frames to learn the display refresh interval before any run starts. */
	calibrate(): void {
		const times: number[] = [];
		const step = (frameTime: number): void => {
			times.push(frameTime);
			if (times.length >= CALIBRATION_FRAMES) {
				const estimate = estimateRefreshMs(times);
				if (estimate > 0) this.#calibratedRefreshMs = estimate;
				return;
			}
			this.#host.raf(step);
		};
		this.#host.raf(step);
	}

	start(): void {
		if (this.#running) this.stop();
		this.#running = true;
		this.#frameTimes = [];
		this.#latencies = [];
		this.#pending = [];
		this.#stopLongTasks = this.#host.observeLongTasks();
		const step = (frameTime: number): void => {
			this.#frameTimes.push(frameTime);
			this.#stopRaf = this.#host.raf(step);
		};
		this.#stopRaf = this.#host.raf(step);
	}

	stop(): BenchResult {
		this.#running = false;
		this.#stopRaf?.();
		this.#stopRaf = null;
		const longTasks = this.#stopLongTasks?.() ?? 0;
		this.#stopLongTasks = null;
		const result: BenchResult = {
			...summarizeFrames(this.#frameTimes, this.#calibratedRefreshMs),
			tokenToPaintMs: summarizeLatencies(this.#latencies),
			longTasks,
		};
		this.#pending = [];
		return result;
	}

	/** A token/entry frame reached the page. */
	frameReceived(): void {
		if (!this.#running) return;
		if (this.#pending.length >= MAX_PENDING) this.#pending.shift();
		this.#pending.push({ id: ++this.#seq, receivedAt: this.#host.now() });
	}

	/** React committed; everything received so far is on screen after the next paint. */
	committed(): void {
		if (!this.#running || this.#pending.length === 0) return;
		const batch = this.#pending;
		this.#pending = [];
		this.#host.afterNextPaint(() => {
			if (!this.#running) return;
			const paintedAt = this.#host.now();
			for (const frame of batch) {
				this.#latencies.push(paintedAt - frame.receivedAt);
				this.#host.trace(frame.id, frame.receivedAt, paintedAt);
			}
		});
	}

	/**
	 * Scripted scroll from the current position at constant velocity: `distancePx` (default: all the
	 * way to the end in that direction) over `durationMs`, applied incrementally per frame so the
	 * list's own scroll corrections are kept. `bounce` travels `distancePx` down, then back up.
	 */
	scroll(options: ScrollOptions): Promise<ScrollReport> {
		const direction = options.direction ?? "down";
		const durationMs = Math.max(1, options.durationMs);
		const surface = this.#host.scroller();
		const { promise, resolve } = Promise.withResolvers<ScrollReport>();
		if (surface === null) {
			resolve({ direction, durationMs: 0, distancePx: 0 });
			return promise;
		}
		const remaining =
			direction === "up"
				? surface.scrollTop
				: Math.max(0, surface.scrollHeight - surface.clientHeight - surface.scrollTop);
		const travel = options.distancePx ?? remaining;
		const legs = direction === "bounce" ? 2 : 1;
		const velocity = (travel * legs) / durationMs;
		const startedAt = this.#host.now();
		let last = startedAt;
		let travelled = 0;
		const step = (): void => {
			const now = this.#host.now();
			const elapsed = now - startedAt;
			const dt = now - last;
			last = now;
			const goingDown = direction === "down" || (direction === "bounce" && elapsed < durationMs / 2);
			const dy = velocity * dt * (goingDown ? 1 : -1);
			const before = surface.scrollTop;
			surface.scrollTop = Math.max(0, before + dy);
			travelled += Math.abs(surface.scrollTop - before);
			if (elapsed >= durationMs) {
				resolve({ direction, durationMs: round(elapsed), distancePx: Math.round(travelled) });
				return;
			}
			this.#host.raf(step);
		};
		this.#host.raf(step);
		return promise;
	}
}

export interface DeckBench {
	start(): void;
	stop(): BenchResult;
	scroll(options: ScrollOptions): Promise<ScrollReport>;
}

declare global {
	interface Window {
		__deckBench?: DeckBench;
	}
}

let active: BenchRecorder | null = null;


function benchFrameReceived(): void {
	active?.frameReceived();
}

function benchCommitted(): void {
	active?.committed();
}

export function browserBenchHost(): BenchHost {
	const channel = new MessageChannel();
	const waiting: (() => void)[] = [];
	channel.port1.onmessage = () => {
		const callback = waiting.shift();
		callback?.();
	};
	return {
		now: () => performance.now(),
		raf: callback => {
			const id = requestAnimationFrame(callback);
			return () => cancelAnimationFrame(id);
		},
		afterNextPaint: callback => {
			// rAF runs before the frame is painted; a message posted from it is delivered after.
			const id = requestAnimationFrame(() => {
				waiting.push(callback);
				channel.port2.postMessage(null);
			});
			return () => cancelAnimationFrame(id);
		},
		trace: (id, receivedAt, paintedAt) => {
			performance.mark(`omp-console:rx:${id}`, { startTime: receivedAt });
			performance.mark(`omp-console:paint:${id}`, { startTime: paintedAt });
			performance.measure("omp-console:token-to-paint", `omp-console:rx:${id}`, `omp-console:paint:${id}`);
			performance.clearMarks(`omp-console:rx:${id}`);
			performance.clearMarks(`omp-console:paint:${id}`);
			performance.clearMeasures("omp-console:token-to-paint");
		},
		observeLongTasks: () => {
			let count = 0;
			let observer: PerformanceObserver | null = null;
			try {
				observer = new PerformanceObserver(list => {
					count += list.getEntries().length;
				});
				observer.observe({ type: "longtask" });
			} catch {
				observer = null; // Long Tasks API unsupported (Safari)
			}
			return () => {
				observer?.disconnect();
				return count;
			};
		},
		scroller: () => document.querySelector<HTMLElement>("[data-deck-scroller]"),
	};
}

/** Installs `window.__deckBench` and the hooks. Call only when `isBenchRequested(location.search)`. */
export function installBench(host: BenchHost = browserBenchHost()): DeckBench {
	const recorder = new BenchRecorder(host);
	recorder.calibrate();
	active = recorder;
	setBenchHooks({ frameReceived: benchFrameReceived, committed: benchCommitted });
	const bench: DeckBench = {
		start: () => recorder.start(),
		stop: () => recorder.stop(),
		scroll: options => recorder.scroll(options),
	};
	window.__deckBench = bench;
	return bench;
}
