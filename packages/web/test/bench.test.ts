import { describe, expect, it } from "bun:test";
import { isBenchRequested } from "../src/lib/bench";
import {
	BenchRecorder,
	type BenchHost,
	percentile,
	type ScrollSurface,
	summarizeFrames,
	summarizeLatencies,
} from "../src/lib/bench-bridge";

class FakeHost implements BenchHost {
	time = 0;
	surface: (ScrollSurface & { scrollTop: number }) | null = null;
	longTasks = 0;
	#frames: ((frameTime: number) => void)[] = [];
	#paints: (() => void)[] = [];
	traced: { id: number; receivedAt: number; paintedAt: number }[] = [];

	now(): number {
		return this.time;
	}
	raf(callback: (frameTime: number) => void): () => void {
		this.#frames.push(callback);
		return () => {
			this.#frames = this.#frames.filter(cb => cb !== callback);
		};
	}
	afterNextPaint(callback: () => void): () => void {
		this.#paints.push(callback);
		return () => {};
	}
	trace(id: number, receivedAt: number, paintedAt: number): void {
		this.traced.push({ id, receivedAt, paintedAt });
	}
	observeLongTasks(): () => number {
		const base = this.longTasks;
		return () => this.longTasks - base;
	}
	scroller(): ScrollSurface | null {
		return this.surface;
	}

	/** Advances the clock one frame, runs rAF callbacks, then the paint that follows them. */
	frame(dt: number): void {
		this.time += dt;
		const callbacks = this.#frames;
		this.#frames = [];
		for (const callback of callbacks) callback(this.time);
		const paints = this.#paints;
		this.#paints = [];
		for (const paint of paints) paint();
	}
}

function frameTimes(deltas: readonly number[]): number[] {
	const out = [0];
	for (const delta of deltas) out.push(out[out.length - 1]! + delta);
	return out;
}

describe("frame statistics", () => {
	it("counts only intervals above 1.5x the refresh interval as dropped", () => {
		const deltas = Array(97).fill(16.667);
		deltas.push(25.1, 24.9, 50);
		const stats = summarizeFrames(frameTimes(deltas));
		expect(stats.frames).toBe(100);
		expect(stats.refreshMs).toBeCloseTo(16.667, 3);
		expect(stats.droppedFrames).toBe(2); // 25.1 and 50; 24.9 is under 25.0005
		expect(stats.droppedPct).toBe(2);
	});

	it("does not let a run that is slow from its first frame redefine the refresh interval", () => {
		const slow = Array(100).fill(33.3);
		expect(summarizeFrames(frameTimes(slow)).droppedFrames).toBe(0);
		const hinted = summarizeFrames(frameTimes(slow), 16.667);
		expect(hinted.refreshMs).toBeCloseTo(16.667, 3);
		expect(hinted.droppedFrames).toBe(100);
		expect(hinted.droppedPct).toBe(100);
	});

	it("reports zero frames without dividing by zero", () => {
		expect(summarizeFrames([5])).toEqual({ frames: 0, droppedFrames: 0, droppedPct: 0, refreshMs: 0 });
	});

	it("uses nearest-rank percentiles", () => {
		const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(percentile(sorted, 50)).toBe(50);
		expect(percentile(sorted, 95)).toBe(95);
		expect(summarizeLatencies([9, 1, 5])).toEqual({ n: 3, p50: 5, p95: 9, max: 9 });
		expect(summarizeLatencies([])).toEqual({ n: 0, p50: 0, p95: 0, max: 0 });
	});
});

describe("BenchRecorder token-to-paint", () => {
	it("pairs each received frame with the first paint after the commit that contains it", () => {
		const host = new FakeHost();
		const recorder = new BenchRecorder(host);
		recorder.frameReceived(); // before start: ignored
		recorder.start();
		host.frame(16.667);

		recorder.frameReceived(); // A at t=16.667
		host.time += 4;
		recorder.frameReceived(); // B at t=20.667
		host.time += 2;
		recorder.committed(); // commit at 22.667 contains A and B
		host.time += 1;
		recorder.frameReceived(); // C arrives after the commit: needs the next commit
		host.frame(9.0); // paint at 32.667
		host.frame(16.667);
		recorder.committed();
		host.frame(16.667); // paint at 66.0

		const result = recorder.stop();
		expect(result.tokenToPaintMs.n).toBe(3);
		expect(result.tokenToPaintMs.max).toBeCloseTo(66.001 - 23.667, 2); // C waited for the second commit
		expect(result.tokenToPaintMs.p50).toBeCloseTo(16, 2); // A: received 16.667, painted 32.667
		const b = host.traced.find(t => Math.abs(t.receivedAt - 20.667) < 0.01);
		expect(b?.paintedAt).toBeCloseTo(32.667, 3); // B shares A's paint
		expect(host.traced).toHaveLength(3);
	});

	it("ignores frames and paints that land outside a run", () => {
		const host = new FakeHost();
		const recorder = new BenchRecorder(host);
		recorder.start();
		host.frame(16);
		recorder.frameReceived();
		recorder.committed();
		const result = recorder.stop();
		host.frame(16); // the paint callback fires after stop
		recorder.frameReceived();
		expect(result.tokenToPaintMs.n).toBe(0);
		expect(host.traced).toHaveLength(0);
	});

	it("reports long tasks seen during the run only", () => {
		const host = new FakeHost();
		host.longTasks = 4;
		const recorder = new BenchRecorder(host);
		recorder.start();
		host.longTasks += 3;
		expect(recorder.stop().longTasks).toBe(3);
	});
});

describe("BenchRecorder scroll driver", () => {
	function surface(scrollHeight = 10_000, clientHeight = 1_000): ScrollSurface & { scrollTop: number } {
		return { scrollTop: 0, scrollHeight, clientHeight };
	}

	async function drive(
		host: FakeHost,
		recorder: BenchRecorder,
		options: Parameters<BenchRecorder["scroll"]>[0],
		onFrame?: () => void,
	): ReturnType<BenchRecorder["scroll"]> {
		const promise = recorder.scroll(options);
		for (let i = 0; i < 400; i++) {
			host.frame(16.667);
			onFrame?.();
		}
		return promise;
	}

	it("scrolls down across the whole range in the requested time and stops", async () => {
		const host = new FakeHost();
		host.surface = surface();
		const report = await drive(host, new BenchRecorder(host), { durationMs: 2_000, direction: "down" });
		expect(host.surface.scrollTop).toBeGreaterThan(8_900);
		expect(host.surface.scrollTop).toBeLessThanOrEqual(9_300);
		expect(report.durationMs).toBeGreaterThanOrEqual(2_000);
		expect(report.durationMs).toBeLessThan(2_050);
	});

	it("scrolls up from where it is, covers an explicit distance, and bounces back to the start", async () => {
		const host = new FakeHost();
		host.surface = surface();
		host.surface.scrollTop = 9_000;
		await drive(host, new BenchRecorder(host), { durationMs: 1_000, direction: "up" });
		expect(host.surface.scrollTop).toBeLessThan(300);

		host.surface.scrollTop = 2_000;
		const part = await drive(host, new BenchRecorder(host), { durationMs: 1_000, distancePx: 3_000 });
		expect(host.surface.scrollTop).toBeGreaterThan(4_900);
		expect(host.surface.scrollTop).toBeLessThan(5_200);
		expect(part.distancePx).toBeGreaterThan(2_900);

		host.surface.scrollTop = 0;
		const report = await drive(host, new BenchRecorder(host), { durationMs: 2_000, direction: "bounce" });
		expect(host.surface.scrollTop).toBeLessThan(300);
		expect(report.distancePx).toBeGreaterThan(17_000);
	});

	it("keeps scroll corrections the list makes while the driver runs", async () => {
		const host = new FakeHost();
		host.surface = surface();
		let corrected = false;
		await drive(host, new BenchRecorder(host), { durationMs: 2_000, direction: "down" }, () => {
			if (!corrected && host.surface!.scrollTop > 4_000) {
				corrected = true;
				host.surface!.scrollTop += 120; // anchor compensation after a measurement above the viewport
			}
		});
		expect(corrected).toBe(true);
		expect(host.surface.scrollTop).toBeGreaterThan(9_000); // an absolute-position driver would end at 9000
	});

	it("resolves immediately when there is no transcript on the page", async () => {
		const host = new FakeHost();
		const report = await new BenchRecorder(host).scroll({ durationMs: 1_000 });
		expect(report.distancePx).toBe(0);
	});
});

describe("isBenchRequested", () => {
	it("is true only when the query carries a bench key", () => {
		expect(isBenchRequested("?bench")).toBe(true);
		expect(isBenchRequested("?x=1&bench=1")).toBe(true);
		expect(isBenchRequested("")).toBe(false);
		expect(isBenchRequested("?benchmark=1")).toBe(false);
	});
});
