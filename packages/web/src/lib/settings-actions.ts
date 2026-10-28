import type { MotionLevel } from "./storage";
import { setMotionPreference, setThemePreference, type ThemePreference } from "./theme";

export const NATIVE_MENU_ACTION_EVENT = "omp-console:native-menu-action";

export type NativeMenuAction =
	| { type: "open-settings" }
	| { type: "appearance"; preference: ThemePreference }
	| { type: "motion"; level: MotionLevel }
	| { type: "toggle-sidebar" };

export interface NativeMenuActionHandlers {
	openSettings(): void;
	toggleSidebar(): void;
}

function isNativeMenuAction(value: unknown): value is NativeMenuAction {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	const action = value as Record<string, unknown>;
	switch (action.type) {
		case "open-settings":
		case "toggle-sidebar":
			return true;
		case "appearance":
			return action.preference === "system" || action.preference === "light" || action.preference === "dark";
		case "motion":
			return action.level === "off" || action.level === "calm" || action.level === "lively";
		default:
			return false;
	}
}

/** Registers the existing web event surface used by native menu items. */
export function registerNativeMenuActions(handlers: NativeMenuActionHandlers, target: EventTarget = window): () => void {
	const onAction = (event: Event): void => {
		const detail: unknown = (event as CustomEvent<unknown>).detail;
		if (!isNativeMenuAction(detail)) return;
		switch (detail.type) {
			case "open-settings":
				handlers.openSettings();
				break;
			case "appearance":
				setThemePreference(detail.preference);
				break;
			case "motion":
				setMotionPreference(detail.level);
				break;
			case "toggle-sidebar":
				handlers.toggleSidebar();
				break;
		}
	};
	target.addEventListener(NATIVE_MENU_ACTION_EVENT, onAction);
	return () => target.removeEventListener(NATIVE_MENU_ACTION_EVENT, onAction);
}

/** Returns true and opens global settings only for the unmodified platform shortcut. */
export function handleGlobalSettingsShortcut(
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "preventDefault">,
	openSettings: () => void,
): boolean {
	if (event.isComposing || event.altKey || event.shiftKey || event.key !== ",") return false;
	if (event.metaKey === event.ctrlKey) return false;
	event.preventDefault();
	openSettings();
	return true;
}
