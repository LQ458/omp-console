/**
 * Workspace look (grand-list 7): hue = where (workspace), badges = what mode (see `mode-badges.ts`).
 *
 * Colours are computed here, never stored by the daemon (which keeps only an optional hue override). Every colour is
 * gamut-mapped into sRGB and emitted as a plain `#rrggbb` / `rgba()` string, so the contrast numbers the tests compute
 * are the numbers the browser renders (an `oklch()` literal would be gamut-mapped by the browser, differently).
 *
 * - `knowledge` is a fixed calm teal, `scratch` neutral grey, projects take a hue from a curated 12-hue palette.
 * - A project's preferred hue is a hash of its repo directory name; when another workspace already holds a hue within
 *   30 degrees, it takes the next palette hue that is free, and with 13 workspaces (more than 12 hues) it reuses the
 *   hue whose nearest taken neighbour is farthest away.
 * - Lightness and chroma are fixed per theme so chip text keeps >= 4.5:1 on its own chip background.
 */
import type { WorkspaceKind } from "@omp-console/protocol";
import { basename } from "./native-path";

export type WorkspaceTheme = "light" | "dark";

/** Twelve curated hues, 30 degrees apart; index 6 (195) is the knowledge teal. */
export const PALETTE_HUES: readonly number[] = [15, 45, 75, 105, 135, 165, 195, 225, 255, 285, 315, 345];
export const KNOWLEDGE_HUE = 195;
/** Two live workspaces closer than this (degrees) are told apart by moving the later one. */
export const MIN_HUE_GAP = 30;

/** Fixed OKLCH lightness/chroma per theme; hue is the only free variable. */
export const THEME_LOOK: Record<
	WorkspaceTheme,
	{ accentL: number; accentC: number; textL: number; textC: number; chipAlpha: number; tintAlpha: number }
> = {
	light: { accentL: 0.6, accentC: 0.16, textL: 0.42, textC: 0.12, chipAlpha: 0.12, tintAlpha: 0.04 },
	dark: { accentL: 0.74, accentC: 0.15, textL: 0.84, textC: 0.1, chipAlpha: 0.16, tintAlpha: 0.06 },
};

/** `--bg`, `--panel`, and `--bg-raised` surfaces across all palette/theme variants. */
export const THEME_SURFACES: Record<WorkspaceTheme, readonly Rgb[]> = {
	light: [
		[0xf2, 0xf2, 0xf3],
		[0xff, 0xff, 0xff],
		[0xff, 0xff, 0xff],
		[0xf1, 0xf2, 0xf3],
		[0xff, 0xff, 0xff],
		[0xff, 0xff, 0xff],
		[0xee, 0xf6, 0xfb],
		[0xff, 0xff, 0xff],
		[0xff, 0xff, 0xff],
		[0xf0, 0xf7, 0xf1],
		[0xff, 0xff, 0xff],
		[0xff, 0xff, 0xff],
		[0xf4, 0xee, 0xe3],
		[0xff, 0xfa, 0xf0],
		[0xff, 0xfa, 0xf0],
		[0xff, 0xff, 0xff],
		[0xff, 0xff, 0xff],
		[0xff, 0xff, 0xff],
	],
	dark: [
		[0x00, 0x00, 0x00],
		[0x09, 0x09, 0x0a],
		[0x0e, 0x0e, 0x10],
		[0x10, 0x11, 0x13],
		[0x17, 0x19, 0x1c],
		[0x1e, 0x21, 0x25],
		[0x07, 0x13, 0x1e],
		[0x0b, 0x1d, 0x2d],
		[0x10, 0x26, 0x38],
		[0x0c, 0x17, 0x11],
		[0x11, 0x22, 0x19],
		[0x17, 0x2b, 0x20],
		[0x1b, 0x15, 0x10],
		[0x24, 0x1b, 0x14],
		[0x2e, 0x23, 0x1a],
		[0x00, 0x00, 0x00],
		[0x00, 0x00, 0x00],
		[0x11, 0x11, 0x11],
	],
};

export type Rgb = readonly [number, number, number];

export interface WorkspaceColor {
	/** Degrees; null for the neutral scratch grey. */
	hue: number | null;
	/** Bars, dots and rings (non-text, >= 3:1 on every surface). */
	accent: string;
	/** Chip text; >= 4.5:1 on `chipBg` over every surface. */
	accentText: string;
	/** 4-6% wash for the composer. */
	tint: string;
	/** Chip fill: the accent at low alpha. */
	chipBg: string;
}

/** The fields of a `Workspace` the colour needs. */
export interface ColorSubject {
	id: string;
	kind: WorkspaceKind;
	name: string;
	root?: string;
	hueOverride?: number;
}

// ---- colour maths -------------------------------------------------------------------------------

function srgbEncode(linear: number): number {
	const v = Math.min(1, Math.max(0, linear));
	return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

function srgbDecode(channel: number): number {
	const v = channel / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function oklchToLinear(l: number, c: number, hueDeg: number): [number, number, number] {
	const h = (hueDeg * Math.PI) / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
	];
}

const GAMUT_EPS = 1e-4;

function inGamut(linear: readonly [number, number, number]): boolean {
	return linear.every(v => v >= -GAMUT_EPS && v <= 1 + GAMUT_EPS);
}

/** `oklch(l c h)` as 8-bit sRGB; out-of-gamut chroma is reduced (lightness and hue kept) by bisection. */
export function oklchToRgb(l: number, c: number, hueDeg: number): Rgb {
	let chroma = c;
	if (!inGamut(oklchToLinear(l, chroma, hueDeg))) {
		let lo = 0;
		let hi = c;
		for (let i = 0; i < 24; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(oklchToLinear(l, mid, hueDeg))) lo = mid;
			else hi = mid;
		}
		chroma = lo;
	}
	const [r, g, b] = oklchToLinear(l, chroma, hueDeg);
	return [Math.round(srgbEncode(r) * 255), Math.round(srgbEncode(g) * 255), Math.round(srgbEncode(b) * 255)];
}

export function rgbToHex(rgb: Rgb): string {
	return `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 2 relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
	return 0.2126 * srgbDecode(rgb[0]) + 0.7152 * srgbDecode(rgb[1]) + 0.0722 * srgbDecode(rgb[2]);
}

/** WCAG 2 contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at `alpha` over opaque `bg`, rounded to 8-bit like a compositor. */
export function blend(fg: Rgb, alpha: number, bg: Rgb): Rgb {
	return [0, 1, 2].map(i => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as unknown as Rgb;
}

function rgba(rgb: Rgb, alpha: number): string {
	return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

// ---- hue choice -----------------------------------------------------------------------------------

export function normalizeHue(hue: number): number {
	return ((hue % 360) + 360) % 360;
}

/** Shortest angular distance in degrees, 0..180. */
export function hueDistance(a: number, b: number): number {
	const d = Math.abs(normalizeHue(a) - normalizeHue(b));
	return d > 180 ? 360 - d : d;
}

/** FNV-1a, 32 bit: stable across runs and platforms. */
export function hashName(name: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}


/** The repo directory name a project's hue is seeded by. */
export function colorSeed(workspace: ColorSubject): string {
	const fromRoot = workspace.root === undefined ? "" : basename(workspace.root);
	if (fromRoot !== "") return fromRoot.toLowerCase();
	const fromId = workspace.id.slice(workspace.id.indexOf(":") + 1);
	return (fromId || workspace.name).toLowerCase();
}

function nearestTaken(hue: number, taken: readonly number[]): number {
	let nearest = 180;
	for (const t of taken) nearest = Math.min(nearest, hueDistance(hue, t));
	return nearest;
}

/**
 * Hues a project may take: the palette minus the knowledge teal and its two neighbours (in OKLCH the 30-degree steps
 * around 195 all read as "teal" at deck's lightness and chroma, so a project there looked like the knowledge workspace).
 */
export const PROJECT_HUES: readonly number[] = PALETTE_HUES.filter(hue => nearestTaken(hue, [KNOWLEDGE_HUE]) > MIN_HUE_GAP);

/**
 * Palette hue for a project: start at the hashed index, walk forward to the first hue at least `MIN_HUE_GAP` from every
 * taken hue; if none exists, the hue with the largest distance to its nearest taken neighbour (ties: first in walk order).
 */
export function pickProjectHue(seed: string, takenHues: readonly number[]): number {
	const start = hashName(seed) % PROJECT_HUES.length;
	let best = PROJECT_HUES[start]!;
	let bestGap = -1;
	for (let step = 0; step < PROJECT_HUES.length; step++) {
		const hue = PROJECT_HUES[(start + step) % PROJECT_HUES.length]!;
		const gap = nearestTaken(hue, takenHues);
		if (gap >= MIN_HUE_GAP) return hue;
		if (gap > bestGap) {
			best = hue;
			bestGap = gap;
		}
	}
	return best;
}

// ---- public colour API ------------------------------------------------------------------------------

function build(hue: number | null, theme: WorkspaceTheme): WorkspaceColor {
	const look = THEME_LOOK[theme];
	const h = hue ?? 0;
	const accentChroma = hue === null ? 0 : look.accentC;
	const textChroma = hue === null ? 0 : look.textC;
	const accent = oklchToRgb(look.accentL, accentChroma, h);
	const text = oklchToRgb(look.textL, textChroma, h);
	return {
		hue,
		accent: rgbToHex(accent),
		accentText: rgbToHex(text),
		tint: rgba(accent, look.tintAlpha),
		chipBg: rgba(accent, look.chipAlpha),
	};
}

/**
 * Colour of one workspace. `takenHues` are the hues of workspaces already coloured (see {@link assignWorkspaceColors});
 * it only matters for projects without an override.
 */
export function workspaceColor(
	workspace: ColorSubject,
	theme: WorkspaceTheme,
	takenHues: readonly number[],
): WorkspaceColor {
	if (workspace.hueOverride != null && Number.isFinite(workspace.hueOverride)) {
		return build(normalizeHue(workspace.hueOverride), theme);
	}
	if (workspace.kind === "scratch") return build(null, theme);
	if (workspace.kind === "knowledge") return build(KNOWLEDGE_HUE, theme);
	return build(pickProjectHue(colorSeed(workspace), takenHues), theme);
}

/**
 * Colours for a whole list. Order of assignment is independent of the list order: overrides first, then the knowledge
 * teal, then projects sorted by id, so a refreshed list never reshuffles hues.
 */
export function assignWorkspaceColors(
	workspaces: readonly ColorSubject[],
	theme: WorkspaceTheme,
): Map<string, WorkspaceColor> {
	const colors = new Map<string, WorkspaceColor>();
	const taken: number[] = [];
	const take = (workspace: ColorSubject): void => {
		const color = workspaceColor(workspace, theme, taken);
		colors.set(workspace.id, color);
		if (color.hue !== null) taken.push(color.hue);
	};
	const overridden = workspaces.filter(w => w.hueOverride != null);
	const rest = workspaces.filter(w => w.hueOverride == null);
	for (const w of [...overridden].sort((a, b) => a.id.localeCompare(b.id))) take(w);
	for (const w of rest.filter(w => w.kind !== "project")) take(w);
	for (const w of rest.filter(w => w.kind === "project").sort((a, b) => a.id.localeCompare(b.id))) take(w);
	return colors;
}

/** CSS custom properties applied to a session view's root (`--ws-accent`, `--ws-accent-text`, `--ws-tint`, `--ws-chip-bg`). */
export function workspaceVars(color: WorkspaceColor): Record<string, string> {
	return {
		"--ws-accent": color.accent,
		"--ws-accent-text": color.accentText,
		"--ws-tint": color.tint,
		"--ws-chip-bg": color.chipBg,
	};
}
