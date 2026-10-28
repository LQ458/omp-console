import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { startPanInertia } from "../../lib/motion";
import { fitTransform, panBy, type ViewTransform, zoomAt } from "../../lib/agent-viewport";

const DRAG_THRESHOLD_PX = 4;
const LONG_PRESS_MS = 500;
export const ZOOM_STEP = 1.25;

interface Point {
	x: number;
	y: number;
}

interface Gesture {
	start: Point;
	lastAt: number;
	velocityX: number;
	velocityY: number;
	moved: boolean;
	target: Element | null;
	handled: boolean;
	longPress: number | null;
}

export interface PanZoomOptions {
	/** The pointer went down and up on `target` without moving (and was not claimed by a long press). */
	onTap?(target: Element): void;
	/** Touch held on `target`; `at` is in viewport coordinates. */
	onLongPress?(target: Element, at: Point): void;
}

export interface PanZoom {
	frameRef: RefObject<HTMLDivElement | null>;
	transform: ViewTransform;
	size: { width: number; height: number };
	fit(): void;
	zoomBy(factor: number): void;
	/** Content coordinates of a viewport point. */
	toContent(clientX: number, clientY: number): Point;
	/** Handlers for the frame element. A pointer that goes down inside `[data-no-pan]` is left to the caller. */
	bind: {
		onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
		onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void;
		onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void;
		onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void;
	};
}

/**
 * Pan (drag), zoom (wheel, pinch, buttons) and fit for an SVG canvas, the same behaviour as the agent graph. Once the
 * person pans or zooms, a resize or new content no longer snaps the view back.
 */
export function usePanZoom(content: { width: number; height: number }, options: PanZoomOptions = {}): PanZoom {
	const frameRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
	const touched = useRef(false);
	const pointers = useRef(new Map<number, Point>());
	const gesture = useRef<Gesture | null>(null);
	const inertia = useRef<(() => void) | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const transformRef = useRef(transform);
	transformRef.current = transform;
	useEffect(
		() => () => {
			inertia.current?.();
			inertia.current = null;
		},
		[],
	);

	useEffect(() => {
		const frame = frameRef.current;
		if (!frame || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(entries => {
			const box = entries[0]?.contentRect;
			if (box) setSize({ width: box.width, height: box.height });
		});
		observer.observe(frame);
		return () => observer.disconnect();
	}, []);
	const contentWidth = content.width;
	const contentHeight = content.height;

	useEffect(() => {
		if (touched.current) return;
		setTransform(fitReadable({ width: contentWidth, height: contentHeight }, size));
	}, [contentWidth, contentHeight, size]);

	const fit = useCallback(() => {
		touched.current = false;
		setTransform(fitReadable({ width: contentWidth, height: contentHeight }, size));
	}, [contentWidth, contentHeight, size]);

	const zoomAround = useCallback((factor: number, around: Point) => {
		touched.current = true;
		setTransform(current => zoomAt(current, around.x, around.y, factor));
	}, []);

	const zoomBy = useCallback(
		(factor: number) => zoomAround(factor, { x: size.width / 2, y: size.height / 2 }),
		[zoomAround, size.width, size.height],
	);

	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const onWheel = (event: WheelEvent): void => {
			event.preventDefault();
			const rect = frame.getBoundingClientRect();
			const unit = event.deltaMode === 1 ? 16 : 1;
			zoomAround(Math.exp(-event.deltaY * unit * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
		};
		frame.addEventListener("wheel", onWheel, { passive: false });
		return () => frame.removeEventListener("wheel", onWheel);
	}, [zoomAround]);

	const toContent = useCallback((clientX: number, clientY: number): Point => {
		const rect = frameRef.current?.getBoundingClientRect();
		const t = transformRef.current;
		return { x: (clientX - (rect?.left ?? 0) - t.x) / t.k, y: (clientY - (rect?.top ?? 0) - t.y) / t.k };
	}, []);

	const clearLongPress = (active: Gesture | null): void => {
		if (active?.longPress != null) {
			window.clearTimeout(active.longPress);
			active.longPress = null;
		}
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0) return;
		inertia.current?.();
		inertia.current = null;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest("[data-no-pan]")) return;
		pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.current.size === 1) {
			const start = { x: event.clientX, y: event.clientY };
			const started: Gesture = {
				start,
				lastAt: event.timeStamp,
				velocityX: 0,
				velocityY: 0,
				moved: false,
				target,
				handled: false,
				longPress: null,
			};
			const at = { x: event.clientX, y: event.clientY };
			if (target && event.pointerType !== "mouse" && optionsRef.current.onLongPress) {
				started.longPress = window.setTimeout(() => {
					started.longPress = null;
					if (started.moved || gesture.current !== started) return;
					started.handled = true;
					optionsRef.current.onLongPress?.(target, at);
				}, LONG_PRESS_MS);
			}
			gesture.current = started;
		} else if (gesture.current) {
			gesture.current.moved = true;
			gesture.current.velocityX = 0;
			gesture.current.velocityY = 0;
			clearLongPress(gesture.current);
		}
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const previous = pointers.current.get(event.pointerId);
		const active = gesture.current;
		if (!previous || !active) return;
		const next = { x: event.clientX, y: event.clientY };
		pointers.current.set(event.pointerId, next);
		if (pointers.current.size >= 2) {
			let other: Point | undefined;
			for (const [id, point] of pointers.current) if (id !== event.pointerId) other = point;
			if (!other) return;
			const before = Math.hypot(previous.x - other.x, previous.y - other.y);
			const after = Math.hypot(next.x - other.x, next.y - other.y);
			const rect = event.currentTarget.getBoundingClientRect();
			if (before > 0 && after > 0) {
				zoomAround(after / before, { x: (next.x + other.x) / 2 - rect.left, y: (next.y + other.y) / 2 - rect.top });
			}
			return;
		}
		if (!active.moved) {
			if (Math.hypot(next.x - active.start.x, next.y - active.start.y) < DRAG_THRESHOLD_PX) return;
			active.moved = true;
			clearLongPress(active);
			capturePointer(event.currentTarget, event.pointerId);
		}
		const dx = next.x - previous.x;
		const dy = next.y - previous.y;
		touched.current = true;
		const elapsed = Math.max(1, event.timeStamp - active.lastAt);
		active.velocityX = dx / elapsed;
		active.velocityY = dy / elapsed;
		active.lastAt = event.timeStamp;
		setTransform(current => panBy(current, dx, dy));
	};

	const end = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
		const active = gesture.current;
		clearLongPress(active);
		if (pointers.current.size === 1 && active && !active.moved && !active.handled && active.target && !cancelled) {
			optionsRef.current.onTap?.(active.target);
		}
		pointers.current.delete(event.pointerId);
		if (pointers.current.size === 0) {
			if (active?.moved && !cancelled) {
				inertia.current = startPanInertia(active.velocityX, active.velocityY, (dx, dy) => {
					touched.current = true;
					setTransform(current => panBy(current, dx, dy));
				});
			}
			gesture.current = null;
		}
	};

	return {
		frameRef,
		transform,
		size,
		fit,
		zoomBy,
		toContent,
		bind: {
			onPointerDown,
			onPointerMove,
			onPointerUp: event => end(event, false),
			onPointerCancel: event => end(event, true),
		},
	};
}

/** Keeps a drag going when the pointer leaves the element. A pointer the browser no longer knows (it ended already) is not an error. */
export function capturePointer(element: Element, pointerId: number): void {
	try {
		element.setPointerCapture(pointerId);
	} catch {
		// nothing to capture
	}
}

/** Below this frame width (a phone) fitting everything would shrink the text past reading. */
const NARROW_FRAME_PX = 520;
const NARROW_MIN_SCALE = 0.8;
const FIT_MARGIN = 12;

/**
 * `fitTransform`, except on a narrow frame: there the content keeps a readable scale, anchored at its top left, and
 * the rest is a pan away.
 */
export function fitReadable(content: { width: number; height: number }, view: { width: number; height: number }): ViewTransform {
	const fitted = fitTransform(content, view);
	if (view.width === 0 || view.width >= NARROW_FRAME_PX || fitted.k >= NARROW_MIN_SCALE) return fitted;
	return { k: NARROW_MIN_SCALE, x: FIT_MARGIN, y: FIT_MARGIN };
}
