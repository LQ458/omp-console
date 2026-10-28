/** localStorage keys and validated preferences shared by the theme store and pre-render boot. */

export const THEME_KEY = "omp-console-theme";
/** Key written before the fork was renamed; read once and removed by {@link migrateStorageKey}. */
export const LEGACY_THEME_KEY = "omp-collab-theme";
export const PALETTE_KEY = "omp-console-palette";
export const CUSTOM_ACCENT_KEY = "omp-console-custom-accent";
export const MOTION_KEY = "omp-console-motion";

export const PALETTES = ["deck", "graphite", "ocean", "forest", "sepia", "contrast", "custom"] as const;
export type Palette = (typeof PALETTES)[number];
export const MOTION_LEVELS = ["off", "calm", "lively"] as const;
export type MotionLevel = (typeof MOTION_LEVELS)[number];

export interface CustomAccent {
	hex: string;
	hue: number;
	chroma: number;
}

export const DEFAULT_CUSTOM_ACCENT: CustomAccent = { hex: "#d946a7", hue: 344.18197813294347, chroma: 0.20707357619289016 };

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `localStorage`, or undefined where reading the property itself throws (blocked storage). */
export function browserStorage(): KeyValueStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function readItem(storage: KeyValueStorage | undefined, key: string): string | null {
	try {
		return storage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

export function readStoredThemePreference(storage: KeyValueStorage | undefined = browserStorage()): "system" | "light" | "dark" {
	migrateStorageKey(storage, LEGACY_THEME_KEY, THEME_KEY);
	const stored = readItem(storage, THEME_KEY);
	return stored === "light" || stored === "dark" ? stored : "system";
}

export function readStoredPalette(storage: KeyValueStorage | undefined = browserStorage()): Palette {
	const stored = readItem(storage, PALETTE_KEY);
	return PALETTES.find(palette => palette === stored) ?? "deck";
}

export function readStoredMotion(storage: KeyValueStorage | undefined = browserStorage()): MotionLevel {
	const stored = readItem(storage, MOTION_KEY);
	return MOTION_LEVELS.find(level => level === stored) ?? "calm";
}

export function readStoredCustomAccent(storage: KeyValueStorage | undefined = browserStorage()): CustomAccent {
	const stored = readItem(storage, CUSTOM_ACCENT_KEY);
	if (!stored) return DEFAULT_CUSTOM_ACCENT;
	try {
		const value: unknown = JSON.parse(stored);
		if (typeof value !== "object" || value === null) return DEFAULT_CUSTOM_ACCENT;
		const fields = value as Record<string, unknown>;
		const { hex, hue, chroma } = fields;
		if (
			typeof hex !== "string" ||
			!/^#[\da-f]{6}$/i.test(hex) ||
			typeof hue !== "number" ||
			!Number.isFinite(hue) ||
			hue < 0 ||
			hue >= 360 ||
			typeof chroma !== "number" ||
			!Number.isFinite(chroma) ||
			chroma < 0 ||
			chroma > 0.4
		) {
			return DEFAULT_CUSTOM_ACCENT;
		}
		return { hex: hex.toLowerCase(), hue, chroma };
	} catch {
		return DEFAULT_CUSTOM_ACCENT;
	}
}

/**
 * Moves `oldKey` to `newKey` once. A value already stored under `newKey` wins (it is newer); the old
 * key is removed either way. Storage that throws (private mode, blocked) is left alone: the caller
 * falls back to its default.
 */
export function migrateStorageKey(storage: KeyValueStorage | undefined, oldKey: string, newKey: string): void {
	if (!storage) return;
	try {
		const old = storage.getItem(oldKey);
		if (old === null) return;
		if (storage.getItem(newKey) === null) storage.setItem(newKey, old);
		storage.removeItem(oldKey);
	} catch {
		// storage unavailable: nothing to migrate
	}
}
