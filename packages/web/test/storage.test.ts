import { describe, expect, it } from "bun:test";
import {
	CUSTOM_ACCENT_KEY,
	DEFAULT_CUSTOM_ACCENT,
	LEGACY_THEME_KEY,
	MOTION_KEY,
	PALETTE_KEY,
	migrateStorageKey,
	readStoredCustomAccent,
	readStoredMotion,
	readStoredPalette,
	THEME_KEY,
	readStoredThemePreference,
} from "../src/lib/storage";

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

describe("migrateStorageKey", () => {
	it("carries the stored theme from the collab-era key to the deck key, once", () => {
		const storage = new MemoryStorage();
		storage.setItem(LEGACY_THEME_KEY, "light");
		migrateStorageKey(storage, LEGACY_THEME_KEY, THEME_KEY);
		expect(storage.getItem(THEME_KEY)).toBe("light");
		expect(storage.getItem(LEGACY_THEME_KEY)).toBeNull();
		migrateStorageKey(storage, LEGACY_THEME_KEY, THEME_KEY);
		expect(storage.getItem(THEME_KEY)).toBe("light");
	});

	it("never overwrites a choice already made under the new key", () => {
		const storage = new MemoryStorage();
		storage.setItem(LEGACY_THEME_KEY, "light");
		storage.setItem(THEME_KEY, "dark");
		migrateStorageKey(storage, LEGACY_THEME_KEY, THEME_KEY);
		expect(storage.getItem(THEME_KEY)).toBe("dark");
		expect(storage.getItem(LEGACY_THEME_KEY)).toBeNull();
	});

	it("leaves a fresh profile untouched and survives blocked storage", () => {
		const fresh = new MemoryStorage();
		migrateStorageKey(fresh, LEGACY_THEME_KEY, THEME_KEY);
		expect(fresh.data.size).toBe(0);
		const blocked = {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {},
			removeItem: () => {},
		};
		expect(() => migrateStorageKey(blocked, LEGACY_THEME_KEY, THEME_KEY)).not.toThrow();
		expect(() => migrateStorageKey(undefined, LEGACY_THEME_KEY, THEME_KEY)).not.toThrow();
	});
});

describe("appearance preference storage", () => {
	it("defaults to System and rejects unknown appearance choices", () => {
		const storage = new MemoryStorage();
		expect(readStoredThemePreference(storage)).toBe("system");
		storage.setItem(THEME_KEY, "light");
		expect(readStoredThemePreference(storage)).toBe("light");
		storage.setItem(THEME_KEY, "sepia");
		expect(readStoredThemePreference(storage)).toBe("system");
	});

	it("restores supported palette and motion choices, falling back for stale values", () => {
		const storage = new MemoryStorage();
		storage.setItem(PALETTE_KEY, "ocean");
		storage.setItem(MOTION_KEY, "lively");
		expect(readStoredPalette(storage)).toBe("ocean");
		expect(readStoredMotion(storage)).toBe("lively");
		const empty = new MemoryStorage();
		expect(readStoredPalette(empty)).toBe("deck");
		expect(readStoredMotion(empty)).toBe("calm");

		storage.setItem(PALETTE_KEY, "ultraviolet");
		storage.setItem(MOTION_KEY, "spring-everything");
		expect(readStoredPalette(storage)).toBe("deck");
		expect(readStoredMotion(storage)).toBe("calm");
	});

	it("restores a valid custom accent and falls back on malformed or unsafe values", () => {
		const storage = new MemoryStorage();
		storage.setItem(CUSTOM_ACCENT_KEY, JSON.stringify({ hex: "#AABBCC", hue: 210, chroma: 0.17 }));
		expect(readStoredCustomAccent(storage)).toEqual({ hex: "#aabbcc", hue: 210, chroma: 0.17 });

		for (const value of ["{", JSON.stringify({ hex: "#fff", hue: 210, chroma: 0.17 }), JSON.stringify({ hex: "#abcdef", hue: 360, chroma: 0.17 }), JSON.stringify({ hex: "#abcdef", hue: 210, chroma: 0.41 })]) {
			storage.setItem(CUSTOM_ACCENT_KEY, value);
			expect(readStoredCustomAccent(storage)).toEqual(DEFAULT_CUSTOM_ACCENT);
		}
		expect(readStoredCustomAccent(undefined)).toEqual(DEFAULT_CUSTOM_ACCENT);
	});
});
