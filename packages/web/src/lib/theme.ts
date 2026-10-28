import { useSyncExternalStore } from "react";
import {
	CUSTOM_ACCENT_KEY,
	type CustomAccent,
	DEFAULT_CUSTOM_ACCENT,
	MOTION_KEY,
	type MotionLevel,
	PALETTE_KEY,
	type Palette,
	readStoredCustomAccent,
	readStoredMotion,
	readStoredPalette,
	readStoredThemePreference,
	THEME_KEY,
} from "./storage";

export type SystemTheme = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const STORAGE_KEYS = new Set([THEME_KEY, PALETTE_KEY, CUSTOM_ACCENT_KEY, MOTION_KEY]);
const listeners = new Set<() => void>();

function readSystemTheme(): SystemTheme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

let preference: ThemePreference = readStoredThemePreference();
let resolved: SystemTheme = preference === "system" ? readSystemTheme() : preference;
let palette: Palette = readStoredPalette();
let motion: MotionLevel = readStoredMotion();
let customAccent: CustomAccent = readStoredCustomAccent();

function emit(): void {
	for (const listener of listeners) listener();
}

function updateThemeColor(): void {
	if (typeof document === "undefined" || typeof getComputedStyle !== "function") return;
	const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
	if (!panel) return;
	for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = panel;
}

function applyThemeSettings(): void {
	resolved = preference === "system" ? readSystemTheme() : preference;
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.dataset.theme = resolved;
	root.dataset.palette = palette;
	root.dataset.motion = motion;
	root.style.colorScheme = resolved;
	root.style.setProperty("--accent-custom-h", String(customAccent.hue));
	root.style.setProperty("--accent-custom-c", String(customAccent.chroma));
	updateThemeColor();
}

function writeStorage(key: string, value: string): void {
	try {
		globalThis.localStorage.setItem(key, value);
	} catch {
		// Persistence is best-effort; the in-memory preference still applies.
	}
}

/** Reads and applies persisted settings before React renders. */
export function applyStoredThemeSettings(): void {
	preference = readStoredThemePreference();
	palette = readStoredPalette();
	motion = readStoredMotion();
	customAccent = readStoredCustomAccent();
	applyThemeSettings();
}

if (typeof window !== "undefined") {
	applyThemeSettings();
	window.matchMedia(DARK_SCHEME_QUERY).addEventListener("change", () => {
		if (preference === "system") {
			applyThemeSettings();
			emit();
		}
	});
	window.addEventListener("storage", event => {
		if (event.key !== null && !STORAGE_KEYS.has(event.key)) return;
		preference = readStoredThemePreference();
		palette = readStoredPalette();
		motion = readStoredMotion();
		customAccent = readStoredCustomAccent();
		applyThemeSettings();
		emit();
	});
}

export function customAccentFromHex(value: string): CustomAccent {
	const hex = /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_CUSTOM_ACCENT.hex;
	const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
	const linear = (channel: number): number =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	const r = linear(red);
	const g = linear(green);
	const b = linear(blue);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const axisB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const hue = ((Math.atan2(axisB, a) * (180 / Math.PI)) % 360 + 360) % 360;
	return { hex, hue, chroma: Math.hypot(a, axisB) };
}

export function setThemePreference(next: ThemePreference): void {
	preference = next;
	writeStorage(THEME_KEY, next);
	applyThemeSettings();
	emit();
}

export function setPalettePreference(next: Palette): void {
	palette = next;
	writeStorage(PALETTE_KEY, next);
	applyThemeSettings();
	emit();
}

export function setMotionPreference(next: MotionLevel): void {
	motion = next;
	writeStorage(MOTION_KEY, next);
	applyThemeSettings();
	emit();
}

export function setCustomAccent(next: CustomAccent): void {
	customAccent = next;
	writeStorage(CUSTOM_ACCENT_KEY, JSON.stringify(next));
	applyThemeSettings();
	emit();
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

/** Reader for the active resolved theme. Reflects system default and overrides. */
export function useSystemTheme(): SystemTheme {
	return useSyncExternalStore(
		subscribe,
		() => resolved,
		() => "dark" as SystemTheme,
	);
}

/** Reader + writer for the theme preference (powers the appearance toggle). */
export function useThemePreference(): {
	preference: ThemePreference;
	resolved: SystemTheme;
	setPreference: (next: ThemePreference) => void;
} {
	const currentPreference = useSyncExternalStore(
		subscribe,
		() => preference,
		() => "system" as ThemePreference,
	);
	const currentResolved = useSyncExternalStore(
		subscribe,
		() => resolved,
		() => "dark" as SystemTheme,
	);
	return { preference: currentPreference, resolved: currentResolved, setPreference: setThemePreference };
}

export function usePalettePreference(): { palette: Palette; setPalette: (next: Palette) => void } {
	const current = useSyncExternalStore(subscribe, () => palette, () => "deck" as Palette);
	return { palette: current, setPalette: setPalettePreference };
}

export function useMotionPreference(): { motion: MotionLevel; setMotion: (next: MotionLevel) => void } {
	const current = useSyncExternalStore(subscribe, () => motion, () => "calm" as MotionLevel);
	return { motion: current, setMotion: setMotionPreference };
}

export function useCustomAccent(): { customAccent: CustomAccent; setCustomAccent: (next: CustomAccent) => void } {
	const current = useSyncExternalStore(subscribe, () => customAccent, () => DEFAULT_CUSTOM_ACCENT);
	return { customAccent: current, setCustomAccent };
}
