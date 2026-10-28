/**
 * Responsive layout modes.
 *
 * - `phone` (< 760 px): one column; the session list is a full-height sheet opened from the header.
 * - `tablet` (760 to 1099 px): two panes with a collapsible session sidebar.
 * - `desktop` (>= 1100 px): the same two panes, rail and chips fully shown.
 *
 * The breakpoints are mirrored by the media queries in `shell/mobile.css`; change both together.
 */
import { useSyncExternalStore } from "react";

export type LayoutMode = "phone" | "tablet" | "desktop";

export const PHONE_MAX_PX = 760;
export const TABLET_MAX_PX = 1100;

export function layoutModeFor(widthPx: number): LayoutMode {
	if (widthPx < PHONE_MAX_PX) return "phone";
	if (widthPx < TABLET_MAX_PX) return "tablet";
	return "desktop";
}

function currentMode(): LayoutMode {
	return typeof window === "undefined" ? "desktop" : layoutModeFor(window.innerWidth);
}

function subscribe(listener: () => void): () => void {
	window.addEventListener("resize", listener);
	window.addEventListener("orientationchange", listener);
	return () => {
		window.removeEventListener("resize", listener);
		window.removeEventListener("orientationchange", listener);
	};
}

/** Live layout mode; re-renders only when the mode changes, not on every resize. */
export function useLayoutMode(): LayoutMode {
	return useSyncExternalStore(subscribe, currentMode, () => "desktop" as LayoutMode);
}

/** True for the installed Home Screen app (iOS `navigator.standalone`, or `display-mode: standalone`). */
export function isStandaloneDisplay(): boolean {
	if (typeof window === "undefined") return false;
	const nav = navigator as Navigator & { standalone?: boolean };
	return nav.standalone === true || (window.matchMedia?.("(display-mode: standalone)").matches ?? false);
}
