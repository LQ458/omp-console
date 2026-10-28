/** Pan and zoom maths for the agent graph. A transform maps content point `p` to screen `p * k + (x, y)`. */

export interface ViewTransform {
	x: number;
	y: number;
	k: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.5;

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Scale (never above 1:1) and centre the content in the viewport, with `margin` px around it. */
export function fitTransform(
	content: { width: number; height: number },
	view: { width: number; height: number },
	margin = 12,
): ViewTransform {
	if (content.width <= 0 || content.height <= 0 || view.width <= 0 || view.height <= 0) return { x: 0, y: 0, k: 1 };
	const k = clampZoom(
		Math.min(1, (view.width - margin * 2) / content.width, (view.height - margin * 2) / content.height),
	);
	return { k, x: (view.width - content.width * k) / 2, y: (view.height - content.height * k) / 2 };
}

/** Zoom by `factor` keeping the content point under screen point (px, py) where it is. */
export function zoomAt(t: ViewTransform, px: number, py: number, factor: number): ViewTransform {
	const k = clampZoom(t.k * factor);
	const ratio = k / t.k;
	return { k, x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio };
}

export function panBy(t: ViewTransform, dx: number, dy: number): ViewTransform {
	return { ...t, x: t.x + dx, y: t.y + dy };
}
