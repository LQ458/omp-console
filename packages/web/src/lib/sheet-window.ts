import { browserStorage, type KeyValueStorage } from "./storage";

export type SheetWindowMode = "in-pane" | "float" | "maximized";

export interface SheetGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SheetWindowState {
	mode: SheetWindowMode;
	geometry: SheetGeometry;
}

export interface SheetViewport {
	width: number;
	height: number;
}

export const SHEET_WINDOW_MIN_WIDTH = 420;
export const SHEET_WINDOW_MIN_HEIGHT = 300;
export const SHEET_WINDOW_MARGIN = 16;
const SHEET_WINDOW_HEADER_REACH = 48;
const DEFAULT_FLOAT_WIDTH = 900;
const DEFAULT_FLOAT_HEIGHT = 700;
const STORAGE_PREFIX = "omp-console.sheet-window.v1:";

export function sheetWindowStorageKey(kind: string): string {
	return `${STORAGE_PREFIX}${encodeURIComponent(kind)}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function integer(value: number): number {
	return Math.round(Number.isFinite(value) ? value : 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseGeometry(value: unknown): SheetGeometry | null {
	if (!isRecord(value)) return null;
	const { x, y, width, height } = value;
	if (
		typeof x !== "number" || !Number.isFinite(x) ||
		typeof y !== "number" || !Number.isFinite(y) ||
		typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
		typeof height !== "number" || !Number.isFinite(height) || height <= 0
	) {
		return null;
	}
	return { x, y, width, height };
}

function isMode(value: unknown): value is SheetWindowMode {
	return value === "in-pane" || value === "float" || value === "maximized";
}

export function defaultSheetGeometry(viewport: SheetViewport): SheetGeometry {
	const availableWidth = Math.max(0, viewport.width - SHEET_WINDOW_MARGIN * 2);
	const availableHeight = Math.max(0, viewport.height - SHEET_WINDOW_MARGIN * 2);
	const width = Math.min(DEFAULT_FLOAT_WIDTH, availableWidth);
	const height = Math.min(DEFAULT_FLOAT_HEIGHT, availableHeight);
	return {
		x: integer((viewport.width - width) / 2),
		y: integer((viewport.height - height) / 2),
		width,
		height,
	};
}

/** Keep the whole panel in view when it fits; otherwise keep its header reachable. */
export function clampSheetGeometry(geometry: SheetGeometry, viewport: SheetViewport): SheetGeometry {
	const maxWidth = Math.max(0, viewport.width - SHEET_WINDOW_MARGIN * 2);
	const maxHeight = Math.max(0, viewport.height - SHEET_WINDOW_MARGIN * 2);
	const minWidth = Math.min(SHEET_WINDOW_MIN_WIDTH, maxWidth);
	const minHeight = Math.min(SHEET_WINDOW_MIN_HEIGHT, maxHeight);
	const width = clamp(integer(geometry.width), minWidth, maxWidth);
	const height = clamp(integer(geometry.height), minHeight, maxHeight);
	const minX = Math.min(SHEET_WINDOW_MARGIN, Math.max(0, viewport.width - width));
	const maxX = Math.max(minX, viewport.width - width - SHEET_WINDOW_MARGIN);
	const minY = Math.min(SHEET_WINDOW_MARGIN, Math.max(0, viewport.height - SHEET_WINDOW_HEADER_REACH));
	const fullyVisibleMaxY = viewport.height - height - SHEET_WINDOW_MARGIN;
	const maxY = fullyVisibleMaxY >= minY ? fullyVisibleMaxY : Math.max(minY, viewport.height - SHEET_WINDOW_HEADER_REACH);
	return {
		x: clamp(integer(geometry.x), minX, maxX),
		y: clamp(integer(geometry.y), minY, maxY),
		width,
		height,
	};
}

export function maximizeSheetGeometry(viewport: SheetViewport): SheetGeometry {
	const x = Math.min(SHEET_WINDOW_MARGIN, Math.max(0, viewport.width));
	const y = Math.min(SHEET_WINDOW_MARGIN, Math.max(0, viewport.height));
	return {
		x,
		y,
		width: Math.max(0, viewport.width - x * 2),
		height: Math.max(0, viewport.height - y * 2),
	};
}

export function moveSheetGeometry(geometry: SheetGeometry, dx: number, dy: number, viewport: SheetViewport): SheetGeometry {
	return clampSheetGeometry({ ...geometry, x: geometry.x + dx, y: geometry.y + dy }, viewport);
}

export function resizeSheetGeometry(
	geometry: SheetGeometry,
	edge: string,
	dx: number,
	dy: number,
	viewport: SheetViewport,
): SheetGeometry {
	const west = edge.includes("w");
	const north = edge.includes("n");
	const maxWidth = Math.max(0, viewport.width - SHEET_WINDOW_MARGIN * 2);
	const maxHeight = Math.max(0, viewport.height - SHEET_WINDOW_MARGIN * 2);
	const minWidth = Math.min(SHEET_WINDOW_MIN_WIDTH, maxWidth);
	const minHeight = Math.min(SHEET_WINDOW_MIN_HEIGHT, maxHeight);
	const right = geometry.x + geometry.width;
	const bottom = geometry.y + geometry.height;
	const widthLimit = west ? right - SHEET_WINDOW_MARGIN : viewport.width - SHEET_WINDOW_MARGIN - geometry.x;
	const heightLimit = north ? bottom - SHEET_WINDOW_MARGIN : viewport.height - SHEET_WINDOW_MARGIN - geometry.y;
	const width = clamp(integer(geometry.width + (west ? -dx : dx)), minWidth, Math.max(minWidth, widthLimit));
	const height = clamp(integer(geometry.height + (north ? -dy : dy)), minHeight, Math.max(minHeight, heightLimit));
	return {
		x: west ? right - width : geometry.x,
		y: north ? bottom - height : geometry.y,
		width,
		height,
	};
}

export function toggleMaximizeMode(mode: SheetWindowMode, restoreMode: SheetWindowMode): SheetWindowMode {
	if (mode !== "maximized") return "maximized";
	return restoreMode === "maximized" ? "float" : restoreMode;
}

export function readSheetWindowState(
	kind: string,
	storage: KeyValueStorage | undefined = browserStorage(),
	viewport: SheetViewport = { width: 1280, height: 800 },
): SheetWindowState {
	const fallback: SheetWindowState = { mode: "in-pane", geometry: defaultSheetGeometry(viewport) };
	try {
		const raw = storage?.getItem(sheetWindowStorageKey(kind));
		if (raw === null || raw === undefined) return fallback;
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || parsed.version !== 1 || !isMode(parsed.mode)) return fallback;
		const geometry = parseGeometry(parsed.geometry);
		if (geometry === null) return fallback;
		const fitsViewport =
			geometry.width <= viewport.width - SHEET_WINDOW_MARGIN * 2 &&
			geometry.height <= viewport.height - SHEET_WINDOW_MARGIN * 2;
		return { mode: parsed.mode, geometry: fitsViewport ? clampSheetGeometry(geometry, viewport) : defaultSheetGeometry(viewport) };
	} catch {
		return fallback;
	}
}

export function writeSheetWindowState(
	kind: string,
	state: SheetWindowState,
	storage: KeyValueStorage | undefined = browserStorage(),
): void {
	try {
		storage?.setItem(sheetWindowStorageKey(kind), JSON.stringify({ version: 1, ...state }));
	} catch {
		// Storage is best-effort; the current panel still works for this page.
	}
}
