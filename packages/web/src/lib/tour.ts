import { openPanel } from "./palette";

export const TOUR_SEEN_KEY = "omp-console:tour-seen";

export interface TourStep {
	id: string;
	title: string;
	body: string;
	target: string;
	fallbackTarget?: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
	{
		id: "sessions",
		title: "Your sessions",
		body: "Your agent sessions live here, grouped by what needs you.",
		target: "sessions",
	},
	{
		id: "new-session",
		title: "Start a session",
		body: "Click + and choose the folder of the project you want help with: the one you would open in your editor.",
		target: "new-session",
	},
	{
		id: "work-with-agent",
		title: "Work with your agent",
		body: "Type what you want done. The agent works while you watch; you can steer or stop it.",
		target: "main-pane",
	},
	{
		id: "settings",
		title: "Open Settings",
		body: "Sign-in, model and devices live in Settings.",
		target: "settings",
	},
	{
		id: "pair-phone",
		title: "Pair your phone",
		body: "Pair your phone in Settings → Devices to follow sessions away from the computer.",
		target: "settings",
		fallbackTarget: "help",
	},
];

export type TourStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): TourStorage | undefined {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

export function hasSeenTour(storage: TourStorage | undefined = browserStorage()): boolean {
	try {
		return storage?.getItem(TOUR_SEEN_KEY) === "1";
	} catch {
		return false;
	}
}

export function markTourSeen(storage: TourStorage | undefined = browserStorage()): void {
	try {
		storage?.setItem(TOUR_SEEN_KEY, "1");
	} catch {
		// A blocked store only means the tour can appear again on a later visit.
	}
}

export function finishTour(onClose: () => void, storage?: TourStorage): void {
	markTourSeen(storage);
	onClose();
}

export interface TourEscapeEvent {
	key: string;
	preventDefault(): void;
	stopPropagation(): void;
}

export function handleTourEscape(event: TourEscapeEvent, finish: () => void): boolean {
	if (event.key !== "Escape") return false;
	event.preventDefault();
	event.stopPropagation();
	finish();
	return true;
}

export interface AutoTourConditions {
	paired: boolean;
	seen: boolean;
	surfaceReady: boolean;
	checklistOpen: boolean;
	modalOpen: boolean;
}

export function shouldAutoShowTour(conditions: AutoTourConditions): boolean {
	return conditions.paired && !conditions.seen && conditions.surfaceReady && !conditions.checklistOpen && !conditions.modalOpen;
}

export function nextTourStep(index: number, stepCount = TOUR_STEPS.length): number {
	if (stepCount <= 0) return 0;
	return Math.min(Math.max(index, 0) + 1, stepCount - 1);
}

export function previousTourStep(index: number, stepCount = TOUR_STEPS.length): number {
	if (stepCount <= 0) return 0;
	return Math.max(Math.min(index, stepCount - 1) - 1, 0);
}

export interface TourRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface TourViewport {
	width: number;
	height: number;
}

export interface TourCardSize {
	width: number;
	height: number;
}

export interface TourLayout {
	card: { left: number; top: number };
	spotlight: TourRect | null;
	viewport: TourViewport;
}

function clamp(value: number, minimum: number, maximum: number): number {
	if (maximum < minimum) return Math.max(0, maximum);
	return Math.min(maximum, Math.max(minimum, value));
}

function centeredCard(viewport: TourViewport, size: TourCardSize, margin: number): { left: number; top: number } {
	const maxLeft = Math.max(0, viewport.width - size.width);
	const maxTop = Math.max(0, viewport.height - size.height);
	return {
		left: clamp((viewport.width - size.width) / 2, Math.min(margin, maxLeft), maxLeft),
		top: clamp((viewport.height - size.height) / 2, Math.min(margin, maxTop), maxTop),
	};
}

function clippedSpotlight(rect: TourRect | null, viewport: TourViewport, padding: number): TourRect | null {
	if (rect === null || rect.width <= 0 || rect.height <= 0) return null;
	const left = Math.max(0, rect.left);
	const top = Math.max(0, rect.top);
	const right = Math.min(viewport.width, rect.left + rect.width);
	const bottom = Math.min(viewport.height, rect.top + rect.height);
	if (right <= left || bottom <= top) return null;
	const paddedLeft = Math.max(0, left - padding);
	const paddedTop = Math.max(0, top - padding);
	const paddedRight = Math.min(viewport.width, right + padding);
	const paddedBottom = Math.min(viewport.height, bottom + padding);
	return { left: paddedLeft, top: paddedTop, width: paddedRight - paddedLeft, height: paddedBottom - paddedTop };
}

function overlaps(a: TourRect, b: TourRect): boolean {
	return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

export function positionTourCard(
	target: TourRect | null,
	viewport: TourViewport,
	card: TourCardSize,
	phone: boolean,
): TourLayout {
	const margin = 16;
	const gap = 16;
	const size = {
		width: Math.min(Math.max(0, card.width), Math.max(0, viewport.width - margin * 2)),
		height: Math.min(Math.max(0, card.height), Math.max(0, viewport.height - margin * 2)),
	};
	const center = centeredCard(viewport, size, margin);
	const visible = clippedSpotlight(target, viewport, 8);
	if (visible === null) return { card: center, spotlight: null, viewport };

	const unpadded: TourRect = {
		left: Math.max(0, target?.left ?? 0),
		top: Math.max(0, target?.top ?? 0),
		width: Math.max(0, Math.min(viewport.width, (target?.left ?? 0) + (target?.width ?? 0)) - Math.max(0, target?.left ?? 0)),
		height: Math.max(0, Math.min(viewport.height, (target?.top ?? 0) + (target?.height ?? 0)) - Math.max(0, target?.top ?? 0)),
	};
	if (phone) return { card: center, spotlight: overlaps({ ...center, ...size }, unpadded) ? null : visible, viewport };

	const candidates = [
		{ left: unpadded.left + unpadded.width + gap, top: unpadded.top + (unpadded.height - size.height) / 2 },
		{ left: unpadded.left + (unpadded.width - size.width) / 2, top: unpadded.top + unpadded.height + gap },
		{ left: unpadded.left - size.width - gap, top: unpadded.top + (unpadded.height - size.height) / 2 },
		{ left: unpadded.left + (unpadded.width - size.width) / 2, top: unpadded.top - size.height - gap },
	];
	const placement = candidates.find(candidate =>
		candidate.left >= margin && candidate.top >= margin &&
		candidate.left + size.width <= viewport.width - margin &&
		candidate.top + size.height <= viewport.height - margin,
	);
	if (placement !== undefined) return { card: placement, spotlight: visible, viewport };
	return { card: center, spotlight: overlaps({ ...center, ...size }, unpadded) ? null : visible, viewport };
}

function visibleTarget(element: HTMLElement): boolean {
	if (!element.isConnected || element.hidden || element.inert || element.getClientRects().length === 0) return false;
	for (let ancestor: HTMLElement | null = element; ancestor !== null; ancestor = ancestor.parentElement) {
		if (ancestor.hidden || ancestor.inert || ancestor.getAttribute("aria-hidden") === "true") return false;
		const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
		if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0)) return false;
	}
	return true;
}

export function resolveTourTarget(
	id: string,
	root: Pick<Document, "querySelectorAll"> | null = typeof document === "undefined" ? null : document,
): HTMLElement | null {
	if (root === null) return null;
	const selector = `[data-tour="${id.replace(/["\\]/g, "\\$&")}"]`;
	return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(visibleTarget) ?? null;
}

export function resolveTourStepTarget(
	step: Pick<TourStep, "target" | "fallbackTarget">,
	root: Pick<Document, "querySelectorAll"> | null = typeof document === "undefined" ? null : document,
): HTMLElement | null {
	return resolveTourTarget(step.target, root) ??
		(step.fallbackTarget === undefined ? null : resolveTourTarget(step.fallbackTarget, root));
}

export function requestTourReplay(target: EventTarget = globalThis): void {
	openPanel({ panel: "tour" }, target);
}
