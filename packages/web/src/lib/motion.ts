export type MotionLevel = "off" | "calm" | "lively";
export type SwipeResolution = "archive" | "reveal" | "reset";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const SHEET_DISTANCE_RATIO = 0.3;
const SHEET_DISMISS_VELOCITY = 0.5;
const ROW_ARCHIVE_DISTANCE_RATIO = 0.45;
const ROW_REVEAL_DISTANCE_PX = 36;
const ROW_FLICK_VELOCITY = 0.5;
const ROW_REVEAL_VELOCITY = 0.25;
const CALM_DECAY_MS = 320;
const LIVELY_DECAY_MS = 440;
const STOP_VELOCITY = 0.02;
const NOOP = (): void => {};

/** Reduced motion always overrides an explicit motion preference. */
export function resolveMotionLevel(preference: string | undefined, prefersReducedMotion: boolean): MotionLevel {
	if (prefersReducedMotion) return "off";
	if (preference === "off" || preference === "lively") return preference;
	return "calm";
}

/** Reads the selected motion level at the point an interaction starts. */
export function motionLevel(): MotionLevel {
	const preference = typeof document === "undefined" ? undefined : document.documentElement.dataset.motion;
	const reduced = typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;
	return resolveMotionLevel(preference, reduced);
}

export function shouldDismissSheetDrag(distancePx: number, velocityPxPerMs: number, sheetExtentPx: number): boolean {
	return distancePx > sheetExtentPx * SHEET_DISTANCE_RATIO || velocityPxPerMs > SHEET_DISMISS_VELOCITY;
}

/** A leftward row gesture either archives, reveals the action rail, or springs back. */
export function resolveSessionRowSwipe(distancePx: number, velocityPxPerMs: number, rowWidthPx: number): SwipeResolution {
	if (distancePx <= 0 || rowWidthPx <= 0) return "reset";
	// A flick archives only after a real swipe (30% of the row); a short fast twitch never archives.
	if (distancePx > rowWidthPx * ROW_ARCHIVE_DISTANCE_RATIO || (velocityPxPerMs > ROW_FLICK_VELOCITY && distancePx > rowWidthPx * 0.3)) return "archive";
	if (distancePx > ROW_REVEAL_DISTANCE_PX || velocityPxPerMs > ROW_REVEAL_VELOCITY) return "reveal";
	return "reset";
}

export function decayDisplacement(initialVelocity: number, elapsedMs: number, timeConstantMs: number): number {
	if (elapsedMs <= 0 || timeConstantMs <= 0) return 0;
	return initialVelocity * timeConstantMs * (1 - Math.exp(-elapsedMs / timeConstantMs));
}

export function decayVelocity(initialVelocity: number, elapsedMs: number, timeConstantMs: number): number {
	if (timeConstantMs <= 0) return 0;
	return initialVelocity * Math.exp(-Math.max(0, elapsedMs) / timeConstantMs);
}

/** Starts an exponential pan decay. Motion-off applies no post-release animation. */
export function startPanInertia(
	velocityX: number,
	velocityY: number,
	onFrame: (deltaX: number, deltaY: number) => void,
	level: MotionLevel = motionLevel(),
): () => void {
	if (level === "off" || (Math.abs(velocityX) < STOP_VELOCITY && Math.abs(velocityY) < STOP_VELOCITY)) return NOOP;
	if (typeof window === "undefined") return NOOP;

	const timeConstant = level === "lively" ? LIVELY_DECAY_MS : CALM_DECAY_MS;
	let startedAt: number | null = null;
	let previousX = 0;
	let previousY = 0;
	let frameId = 0;
	let running = true;
	const tick = (now: number): void => {
		if (!running) return;
		startedAt ??= now;
		const elapsed = now - startedAt;
		const nextX = decayDisplacement(velocityX, elapsed, timeConstant);
		const nextY = decayDisplacement(velocityY, elapsed, timeConstant);
		onFrame(nextX - previousX, nextY - previousY);
		previousX = nextX;
		previousY = nextY;
		if (Math.abs(decayVelocity(velocityX, elapsed, timeConstant)) < STOP_VELOCITY && Math.abs(decayVelocity(velocityY, elapsed, timeConstant)) < STOP_VELOCITY) {
			running = false;
			frameId = 0;
			return;
		}
		frameId = window.requestAnimationFrame(tick);
	};
	frameId = window.requestAnimationFrame(tick);
	return () => {
		if (!running) return;
		running = false;
		if (frameId !== 0) window.cancelAnimationFrame(frameId);
	};
}
