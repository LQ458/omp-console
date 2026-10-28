import { describe, expect, it } from "bun:test";
import {
	decayDisplacement,
	decayVelocity,
	resolveMotionLevel,
	resolveSessionRowSwipe,
	shouldDismissSheetDrag,
	startPanInertia,
} from "../src/lib/motion";

describe("motion preferences and gesture physics", () => {
	it("forces reduced motion off even when lively was explicitly selected", () => {
		expect(resolveMotionLevel("lively", true)).toBe("off");
		expect(resolveMotionLevel("off", false)).toBe("off");
		expect(resolveMotionLevel("lively", false)).toBe("lively");
		expect(resolveMotionLevel(undefined, false)).toBe("calm");
	});

	it("dismisses a sheet only after the distance or downward velocity threshold", () => {
		expect(shouldDismissSheetDrag(30, 0.5, 100)).toBe(false);
		expect(shouldDismissSheetDrag(30.1, 0, 100)).toBe(true);
		expect(shouldDismissSheetDrag(5, 0.51, 100)).toBe(true);
		expect(shouldDismissSheetDrag(-40, 0, 100)).toBe(false);
	});

	it("distinguishes a row reveal from a full archive swipe", () => {
		expect(resolveSessionRowSwipe(20, 0.1, 200)).toBe("reset");
		expect(resolveSessionRowSwipe(40, 0.1, 200)).toBe("reveal");
		expect(resolveSessionRowSwipe(91, 0, 200)).toBe("archive");
		// A flick archives only after a real swipe; a short fast twitch does not.
		expect(resolveSessionRowSwipe(10, 0.6, 200)).toBe("reveal");
		expect(resolveSessionRowSwipe(61, 0.6, 200)).toBe("archive");
	});

	it("computes exponential decay displacement and residual velocity", () => {
		const expected = 400 * (1 - Math.exp(-0.5));
		expect(decayDisplacement(2, 100, 200)).toBeCloseTo(expected, 8);
		expect(decayVelocity(2, 100, 200)).toBeCloseTo(2 * Math.exp(-0.5), 8);
		expect(decayDisplacement(2, 0, 200)).toBe(0);
	});

	it("forces reduced motion to skip post-release movement", () => {
		let frames = 0;
		const level = resolveMotionLevel("lively", true);
		const stop = startPanInertia(1, 1, () => { frames++; }, level);
		stop();
		expect(level).toBe("off");
		expect(frames).toBe(0);
	});
});
