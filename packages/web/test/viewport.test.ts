import { describe, expect, it } from "bun:test";
import { layoutModeFor } from "../src/lib/layout";
import {
	computeViewport,
	KEYBOARD_MIN_INSET_PX,
	trackViewport,
	type ViewportRoot,
	type ViewportTarget,
} from "../src/lib/viewport";

describe("computeViewport", () => {
	it("iOS keyboard: the layout viewport keeps its height, the visual one shrinks; the composer must sit above the keyboard", () => {
		expect(computeViewport({ layoutHeight: 852, visualHeight: 520, visualOffsetTop: 0 })).toEqual({
			height: 520,
			top: 0,
			keyboardInset: 332,
			keyboardOpen: true,
		});
	});

	it("iOS pans the visual viewport down to reveal the focused field: the app root follows it", () => {
		const layout = computeViewport({ layoutHeight: 852, visualHeight: 520, visualOffsetTop: 120 });
		expect(layout).toMatchObject({ height: 520, top: 120, keyboardInset: 212, keyboardOpen: true });
	});

	it("Android WebView that resizes the layout viewport reports no inset and leaves the app root alone", () => {
		const layout = computeViewport({ layoutHeight: 540, visualHeight: 540, visualOffsetTop: 0 });
		expect(layout).toMatchObject({ height: 540, keyboardInset: 0, keyboardOpen: false });
	});

	it("a collapsing browser toolbar is not a keyboard", () => {
		const layout = computeViewport({ layoutHeight: 852, visualHeight: 852 - (KEYBOARD_MIN_INSET_PX - 1), visualOffsetTop: 0 });
		expect(layout.keyboardOpen).toBe(false);
		expect(computeViewport({ layoutHeight: 852, visualHeight: 852 - KEYBOARD_MIN_INSET_PX, visualOffsetTop: 0 }).keyboardOpen).toBe(true);
	});

	it("pinch-zoom (visual viewport larger than layout) and bad numbers never produce negative or NaN sizes", () => {
		expect(computeViewport({ layoutHeight: 800, visualHeight: 900, visualOffsetTop: 0 })).toMatchObject({ height: 800, keyboardInset: 0 });
		const broken = computeViewport({ layoutHeight: 800, visualHeight: Number.NaN, visualOffsetTop: Number.NaN });
		expect(broken).toMatchObject({ height: 800, top: 0, keyboardInset: 0 });
	});
});

function fakeEnv(): {
	target: ViewportTarget;
	root: ViewportRoot;
	vars: Map<string, string>;
	scrolls: number;
	fire(type: "resize" | "scroll"): void;
	listeners(): number;
	vv: { height: number; offsetTop: number };
} {
	const vars = new Map<string, string>();
	const handlers = new Map<string, Set<() => void>>();
	const vv = { height: 852, offsetTop: 0 };
	const env = {
		vars,
		scrolls: 0,
		vv,
		root: {
			style: {
				setProperty: (name: string, value: string) => void vars.set(name, value),
				removeProperty: (name: string) => void vars.delete(name),
			},
			dataset: {} as DOMStringMap,
		},
		target: {
			innerHeight: 852,
			scrollTo: () => {
				env.scrolls++;
			},
			visualViewport: {
				get height() {
					return vv.height;
				},
				get offsetTop() {
					return vv.offsetTop;
				},
				addEventListener: (type: string, listener: () => void) => {
					handlers.set(type, (handlers.get(type) ?? new Set()).add(listener));
				},
				removeEventListener: (type: string, listener: () => void) => void handlers.get(type)?.delete(listener),
			},
		} satisfies ViewportTarget,
		fire: (type: "resize" | "scroll") => {
			for (const listener of [...(handlers.get(type) ?? [])]) listener();
		},
		listeners: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
	};
	return env;
}

describe("trackViewport", () => {
	it("publishes the visible height while the keyboard is open, and releases everything on teardown", () => {
		const env = fakeEnv();
		const stop = trackViewport(env.target, env.root);
		expect(env.vars.get("--viewport-height")).toBe("852px");
		expect(env.root.dataset.keyboard).toBeUndefined();

		env.vv.height = 500;
		env.vv.offsetTop = 80;
		env.fire("resize");
		expect(env.vars.get("--viewport-height")).toBe("500px");
		expect(env.vars.get("--viewport-top")).toBe("80px");
		expect(env.vars.get("--keyboard-inset")).toBe("272px");
		expect(env.root.dataset.keyboard).toBe("open");
		expect(env.scrolls).toBeGreaterThan(0); // Safari's own pan is undone; the root moves instead

		env.vv.height = 852;
		env.vv.offsetTop = 0;
		env.fire("resize");
		expect(env.root.dataset.keyboard).toBeUndefined();

		stop();
		expect(env.listeners()).toBe(0);
		expect(env.vars.size).toBe(0);
	});

	it("is a no-op where visualViewport does not exist", () => {
		const env = fakeEnv();
		const stop = trackViewport({ ...env.target, visualViewport: null }, env.root);
		stop();
		expect(env.vars.size).toBe(0);
	});
});

describe("layoutModeFor", () => {
	it("switches at 760 and 1100 px", () => {
		expect([320, 393, 759].map(layoutModeFor)).toEqual(["phone", "phone", "phone"]);
		expect([760, 820, 1099].map(layoutModeFor)).toEqual(["tablet", "tablet", "tablet"]);
		expect([1100, 1280].map(layoutModeFor)).toEqual(["desktop", "desktop"]);
	});
});
