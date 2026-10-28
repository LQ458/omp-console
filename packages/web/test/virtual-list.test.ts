import { describe, expect, it } from "bun:test";
import { VirtualModel } from "../src/lib/virtual-list";

function keys(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Deterministic pseudo-random heights so the oracle comparison is reproducible. */
function heights(count: number, seed: number): number[] {
	let state = seed;
	return Array.from({ length: count }, () => {
		state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
		return 20 + (state % 900) + (state % 7) / 7;
	});
}

function measuredModel(list: readonly string[], hs: readonly number[], estimate = 100): VirtualModel {
	const model = new VirtualModel(estimate);
	model.setKeys(list);
	hs.forEach((h, i) => {
		model.setHeight(i, h);
	});
	return model;
}

describe("VirtualModel offsets", () => {
	it("agrees with brute-force prefix sums for a mix of measured and estimated items", () => {
		const list = keys("k", 777);
		const model = new VirtualModel(120);
		model.setKeys(list);
		const hs = heights(777, 7);
		const truth = list.map(() => 120);
		for (let i = 0; i < list.length; i += 3) {
			model.setHeight(i, hs[i]!);
			truth[i] = hs[i]!;
		}
		let acc = 0;
		for (let i = 0; i <= list.length; i++) {
			expect(model.offsetOf(i)).toBeCloseTo(acc, 6);
			if (i < list.length) {
				// every pixel inside item i resolves to i
				expect(model.indexAt(acc + truth[i]! / 2)).toBe(i);
				acc += truth[i]!;
			}
		}
		expect(model.totalHeight).toBeCloseTo(acc, 6);
		expect(model.indexAt(-5)).toBe(0);
		expect(model.indexAt(acc + 1e6)).toBe(list.length - 1);
	});

	it("keeps measured heights across prepends and drops those whose key is gone", () => {
		const model = measuredModel(["a", "b", "c"], [300, 50, 70]);
		model.setKeys(["x", "y", "a", "b"]);
		expect(model.heightOf(2)).toBe(300);
		expect(model.heightOf(3)).toBe(50);
		expect(model.isMeasured(0)).toBe(false);
		model.setKeys(["c"]);
		expect(model.isMeasured(0)).toBe(false);
	});
});

describe("VirtualModel windows", () => {
	it("mounts a bounded window out of 50k rows and covers the viewport plus overscan", () => {
		const n = 50_000;
		const model = new VirtualModel(90);
		model.setKeys(keys("r", n));
		const scrollTop = model.offsetOf(31_337) + 12;
		const range = model.rangeFor(scrollTop, 800, 600);
		expect(range.end - range.start).toBeLessThan(40);
		expect(model.offsetOf(range.start)).toBeLessThanOrEqual(scrollTop - 600 + 1e-6);
		expect(model.offsetOf(range.end)).toBeGreaterThanOrEqual(scrollTop + 800 + 600 - 1e-6);
	});

	it("clamps at both ends of the list", () => {
		const model = measuredModel(keys("r", 10), Array(10).fill(100));
		expect(model.rangeFor(0, 300, 200)).toEqual({ start: 0, end: 6 });
		expect(model.rangeFor(10_000, 300, 200)).toEqual({ start: 9, end: 10 });
		expect(new VirtualModel(50).rangeFor(0, 500, 100)).toEqual({ start: 0, end: 0 });
	});

	it("keeps the tail window ending at the last row while the last row grows", () => {
		const model = measuredModel(keys("r", 200), Array(200).fill(80));
		const before = model.tailRange(800, 600);
		expect(before.end).toBe(200);
		model.setHeight(199, 5_000);
		const after = model.tailRange(800, 600);
		expect(after.end).toBe(200);
		// the grown row alone exceeds viewport + overscan, so earlier rows leave the window
		expect(after.start).toBe(199);
		expect(model.totalHeight - model.offsetOf(after.start)).toBeGreaterThanOrEqual(800);
	});
});

describe("VirtualModel scroll anchoring", () => {
	it("keeps the reader on the same content when history is prepended", () => {
		const list = keys("m", 60);
		const model = measuredModel(list, heights(60, 3));
		const scrollTop = model.offsetOf(20) + 37;
		const anchor = model.captureAnchor(scrollTop)!;
		expect(anchor.key).toBe("m20");
		expect(anchor.delta).toBe(-37);

		model.setKeys([...keys("old", 25), ...list]);
		const restored = model.scrollTopForAnchor(anchor)!;
		expect(restored).toBeGreaterThan(scrollTop);
		const after = model.captureAnchor(restored)!;
		expect(after).toEqual(anchor);
	});

	it("shifts by exactly the growth of rows above the reader and ignores growth at or below", () => {
		const list = keys("m", 40);
		const model = measuredModel(list, heights(40, 11));
		const scrollTop = model.offsetOf(15) + 5;
		const anchor = model.captureAnchor(scrollTop)!;
		const grow = (index: number, by: number): void => {
			model.setHeight(index, model.heightOf(index) + by);
		};
		grow(3, 240); // above: pushes the reader down
		grow(9, -31); // above, shrinking
		expect(model.scrollTopForAnchor(anchor)!).toBeCloseTo(scrollTop + 240 - 31, 6);
		grow(15, 500); // the anchored row itself: its top does not move
		grow(30, 900); // below the reader
		expect(model.scrollTopForAnchor(anchor)!).toBeCloseTo(scrollTop + 240 - 31, 6);
	});

	it("reports a vanished anchor so the caller leaves the scroll position alone", () => {
		const model = measuredModel(["a", "b", "c"], [100, 100, 100]);
		const anchor = model.captureAnchor(150)!;
		model.setKeys(["a", "c"]);
		expect(model.scrollTopForAnchor(anchor)).toBeNull();
	});

	it("re-estimates unmeasured rows only when the measured mean drifted, and after invalidation keeps the hint", () => {
		const model = new VirtualModel(50);
		model.setKeys(keys("r", 100));
		for (let i = 0; i < 10; i++) model.setHeight(i, 200);
		expect(model.offsetOf(100)).toBeCloseTo(10 * 200 + 90 * 50, 6);
		expect(model.reestimate()).toBe(true);
		expect(model.estimate).toBe(200);
		expect(model.offsetOf(100)).toBeCloseTo(100 * 200, 6);
		expect(model.reestimate()).toBe(false);

		model.invalidate();
		expect(model.isMeasured(0)).toBe(false);
		expect(model.offsetOf(100)).toBeCloseTo(100 * 200, 6);
	});
});
