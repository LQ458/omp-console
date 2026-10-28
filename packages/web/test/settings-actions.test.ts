import { describe, expect, it } from "bun:test";
import { MOTION_KEY, readStoredMotion, readStoredThemePreference, THEME_KEY } from "../src/lib/storage";
import { handleGlobalSettingsShortcut, NATIVE_MENU_ACTION_EVENT, registerNativeMenuActions } from "../src/lib/settings-actions";
import { setMotionPreference, setThemePreference } from "../src/lib/theme";

class MemoryStorage {
	readonly data = new Map<string, string>();
	getItem(key: string): string | null {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.data.set(key, value);
	}
	removeItem(key: string): void {
		this.data.delete(key);
	}
}

function keyboardEvent(overrides: Partial<Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">> = {}): {
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "preventDefault">;
	wasPrevented(): boolean;
} {
	let prevented = false;
	return {
		event: {
			key: overrides.key ?? ",",
			metaKey: overrides.metaKey ?? false,
			ctrlKey: overrides.ctrlKey ?? false,
			altKey: overrides.altKey ?? false,
			shiftKey: overrides.shiftKey ?? false,
			isComposing: overrides.isComposing ?? false,
			preventDefault: () => {
				prevented = true;
			},
		},
		wasPrevented: () => prevented,
	};
}

describe("global settings shortcut", () => {
	it("opens on Command-comma and Control-comma but leaves other key presses alone", () => {
		let opens = 0;
		const command = keyboardEvent({ metaKey: true });
		expect(handleGlobalSettingsShortcut(command.event, () => opens++)).toBe(true);
		expect(command.wasPrevented()).toBe(true);

		const control = keyboardEvent({ ctrlKey: true });
		expect(handleGlobalSettingsShortcut(control.event, () => opens++)).toBe(true);
		expect(control.wasPrevented()).toBe(true);

		for (const event of [
			keyboardEvent(),
			keyboardEvent({ metaKey: true, shiftKey: true }),
			keyboardEvent({ ctrlKey: true, altKey: true }),
			keyboardEvent({ metaKey: true, isComposing: true }),
		]) {
			expect(handleGlobalSettingsShortcut(event.event, () => opens++)).toBe(false);
			expect(event.wasPrevented()).toBe(false);
		}
		expect(opens).toBe(2);
	});
});

describe("native menu action bridge", () => {
	it("applies appearance and motion through the shared persisted preference setters", () => {
		const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const storage = new MemoryStorage();
		Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
		const target = new EventTarget();
		let opens = 0;
		let sidebarToggles = 0;
		const unregister = registerNativeMenuActions({ openSettings: () => opens++, toggleSidebar: () => sidebarToggles++ }, target);
		try {
			target.dispatchEvent(new CustomEvent(NATIVE_MENU_ACTION_EVENT, { detail: { type: "appearance", preference: "dark" } }));
			target.dispatchEvent(new CustomEvent(NATIVE_MENU_ACTION_EVENT, { detail: { type: "motion", level: "lively" } }));
			target.dispatchEvent(new CustomEvent(NATIVE_MENU_ACTION_EVENT, { detail: { type: "open-settings" } }));
			target.dispatchEvent(new CustomEvent(NATIVE_MENU_ACTION_EVENT, { detail: { type: "toggle-sidebar" } }));
			target.dispatchEvent(new CustomEvent(NATIVE_MENU_ACTION_EVENT, { detail: { type: "appearance", preference: "neon" } }));

			expect(readStoredThemePreference(storage)).toBe("dark");
			expect(readStoredMotion(storage)).toBe("lively");
			expect(storage.getItem(THEME_KEY)).toBe("dark");
			expect(storage.getItem(MOTION_KEY)).toBe("lively");
			expect(opens).toBe(1);
			expect(sidebarToggles).toBe(1);
		} finally {
			unregister();
			setThemePreference("system");
			setMotionPreference("calm");
			if (previousStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
			else Object.defineProperty(globalThis, "localStorage", previousStorage);
		}
	});
});
