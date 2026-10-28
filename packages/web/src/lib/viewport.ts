/**
 * On-screen keyboard handling.
 *
 * iOS Safari (and the installed Home Screen app) do not resize the layout viewport when the
 * keyboard opens: the visual viewport shrinks and may be panned (`offsetTop > 0`) over the layout
 * viewport, which leaves a bottom-docked composer behind the keyboard. The app root is therefore
 * sized to the visual viewport (`--viewport-height`) and shifted by its offset (`--viewport-top`).
 * Android WebViews that resize the layout viewport report `offsetTop = 0` and a visual height equal
 * to the layout height, which makes the same math a no-op.
 */

/** Inset above this many px counts as an open keyboard (browser toolbars collapsing stay below it). */
export const KEYBOARD_MIN_INSET_PX = 120;

export interface ViewportMetrics {
	/** `window.innerHeight`: the layout viewport. */
	layoutHeight: number;
	/** `visualViewport.height`. */
	visualHeight: number;
	/** `visualViewport.offsetTop`. */
	visualOffsetTop: number;
}

export interface ViewportLayout {
	/** Height of the app root: the visible area. */
	height: number;
	/** Shift of the app root from the top of the layout viewport. */
	top: number;
	/** Pixels at the bottom of the layout viewport covered by the keyboard. */
	keyboardInset: number;
	keyboardOpen: boolean;
}

function finiteOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

export function computeViewport(metrics: ViewportMetrics): ViewportLayout {
	const layoutHeight = Math.max(0, finiteOr(metrics.layoutHeight, 0));
	const height = Math.min(layoutHeight, Math.max(0, finiteOr(metrics.visualHeight, layoutHeight)));
	const top = Math.max(0, finiteOr(metrics.visualOffsetTop, 0));
	const keyboardInset = Math.max(0, Math.round(layoutHeight - height - top));
	return { height, top, keyboardInset, keyboardOpen: keyboardInset >= KEYBOARD_MIN_INSET_PX };
}

/** The slice of `window` the tracker uses. */
export interface ViewportTarget {
	innerHeight: number;
	visualViewport: {
		height: number;
		offsetTop: number;
		addEventListener(type: "resize" | "scroll", listener: () => void): void;
		removeEventListener(type: "resize" | "scroll", listener: () => void): void;
	} | null;
	scrollTo(x: number, y: number): void;
}

export interface ViewportRoot {
	style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
	dataset: DOMStringMap;
}

/** Writes the metrics into CSS variables on `root`; returns the unsubscribe function. */
export function trackViewport(target: ViewportTarget, root: ViewportRoot): () => void {
	const vv = target.visualViewport;
	if (!vv) return () => {};
	const apply = (): void => {
		const layout = computeViewport({
			layoutHeight: target.innerHeight,
			visualHeight: vv.height,
			visualOffsetTop: vv.offsetTop,
		});
		root.style.setProperty("--viewport-height", `${layout.height}px`);
		root.style.setProperty("--viewport-top", `${layout.top}px`);
		root.style.setProperty("--keyboard-inset", `${layout.keyboardInset}px`);
		if (layout.keyboardOpen) root.dataset.keyboard = "open";
		else delete root.dataset.keyboard;
		// Safari pans the page to reveal the focused field; the root is already shifted by `top`.
		if (layout.top > 0) target.scrollTo(0, 0);
	};
	apply();
	vv.addEventListener("resize", apply);
	vv.addEventListener("scroll", apply);
	return () => {
		vv.removeEventListener("resize", apply);
		vv.removeEventListener("scroll", apply);
		root.style.removeProperty("--viewport-height");
		root.style.removeProperty("--viewport-top");
		root.style.removeProperty("--keyboard-inset");
		delete root.dataset.keyboard;
	};
}
