import { afterEach, describe, expect, it, vi } from "bun:test";
import { BACKGROUND_PANE_MS, type SnapshotSource, ThrottledSource } from "../src/components/panes/throttled-source";

class FakeSource implements SnapshotSource<number> {
	value = 0;
	#listeners = new Set<() => void>();
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	getSnapshot(): number {
		return this.value;
	}
	emit(value: number): void {
		this.value = value;
		for (const listener of this.#listeners) listener();
	}
	get listenerCount(): number {
		return this.#listeners.size;
	}
}

function rig(intervalMs: number): { source: FakeSource; throttled: ThrottledSource<number>; seen: number[]; stop: () => void } {
	const source = new FakeSource();
	const throttled = new ThrottledSource<number>(source);
	throttled.setInterval(intervalMs);
	const seen: number[] = [];
	const stop = throttled.subscribe(() => seen.push(throttled.getSnapshot()));
	return { source, throttled, seen, stop };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ThrottledSource", () => {
	it("background panes render at most 4 times a second however fast frames arrive", () => {
		vi.useFakeTimers();
		const { source, seen } = rig(BACKGROUND_PANE_MS);
		expect(BACKGROUND_PANE_MS).toBe(250);
		// 100 frames/s for 2 s.
		for (let i = 1; i <= 200; i++) {
			source.emit(i);
			vi.advanceTimersByTime(10);
		}
		vi.advanceTimersByTime(BACKGROUND_PANE_MS);
		// One leading publish, then one per 250 ms window: 2 s is 8 windows.
		expect(seen.length).toBeGreaterThanOrEqual(8);
		expect(seen.length).toBeLessThanOrEqual(10);
		expect(seen[seen.length - 1]).toBe(200); // never left behind by more than one window
	});

	it("shows the first change at once, then folds changes inside the window into one publish at its end", () => {
		vi.useFakeTimers();
		const { source, seen } = rig(250);
		source.emit(1);
		expect(seen).toEqual([1]);
		source.emit(2);
		source.emit(3);
		vi.advanceTimersByTime(249);
		expect(seen).toEqual([1]);
		vi.advanceTimersByTime(1);
		expect(seen).toEqual([1, 3]);
	});

	it("goes quiet when nothing changes: no timer-driven publishes", () => {
		vi.useFakeTimers();
		const { source, seen } = rig(250);
		source.emit(1);
		vi.advanceTimersByTime(5_000);
		expect(seen).toEqual([1]);
		source.emit(2); // a new burst after a quiet period is leading-edge again
		expect(seen).toEqual([1, 2]);
	});

	it("the focused pane (interval 0) publishes every change", () => {
		const { source, seen } = rig(0);
		source.emit(1);
		source.emit(2);
		source.emit(3);
		expect(seen).toEqual([1, 2, 3]);
	});

	it("gaining focus publishes the pending state immediately instead of waiting out the window", () => {
		vi.useFakeTimers();
		const { source, throttled, seen } = rig(250);
		source.emit(1);
		source.emit(2);
		expect(seen).toEqual([1]);
		throttled.setInterval(0);
		expect(seen).toEqual([1, 2]);
		vi.advanceTimersByTime(1_000);
		expect(seen).toEqual([1, 2]); // the cancelled window does not publish again
	});

	it("catches up on what happened before the first subscriber and stops listening with the last", () => {
		vi.useFakeTimers();
		const source = new FakeSource();
		const throttled = new ThrottledSource<number>(source);
		throttled.setInterval(250);
		source.emit(7); // nobody is subscribed yet
		const seen: number[] = [];
		const stop = throttled.subscribe(() => seen.push(throttled.getSnapshot()));
		expect(throttled.getSnapshot()).toBe(7);
		expect(source.listenerCount).toBe(1);
		source.emit(8);
		source.emit(9);
		stop();
		expect(source.listenerCount).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(seen).toEqual([8]); // the pending trailing publish died with the subscription
	});
});
