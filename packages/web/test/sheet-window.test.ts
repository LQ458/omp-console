import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sheet } from "../src/components/shell/Sheet";
import {
	clampSheetGeometry,
	defaultSheetGeometry,
	moveSheetGeometry,
	readSheetWindowState,
	resizeSheetGeometry,
	SHEET_WINDOW_MARGIN,
	SHEET_WINDOW_MIN_HEIGHT,
	SHEET_WINDOW_MIN_WIDTH,
	toggleMaximizeMode,
	writeSheetWindowState,
} from "../src/lib/sheet-window";
import type { KeyValueStorage } from "../src/lib/storage";

class MemoryStorage implements KeyValueStorage {
	readonly values = new Map<string, string>();
	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
	removeItem(key: string): void {
		this.values.delete(key);
	}
}

const viewport = { width: 1280, height: 800 };
const geometry = { x: 160, y: 80, width: 720, height: 540 };

describe("sheet window geometry", () => {
	it("keeps a dragged panel and its header inside the viewport", () => {
		const moved = moveSheetGeometry(geometry, 900, 700, viewport);
		const clamped = clampSheetGeometry(moved, viewport);
		expect(clamped.x).toBeLessThanOrEqual(viewport.width - clamped.width);
		expect(clamped.y).toBeLessThanOrEqual(viewport.height - clamped.height);
		expect(clamped.x).toBeGreaterThanOrEqual(0);
		expect(clamped.y).toBeGreaterThanOrEqual(0);
	});

	const oversizedResizes = [
		{ edge: "se", dx: 5_000, dy: 5_000 },
		{ edge: "nw", dx: -5_000, dy: -5_000 },
		{ edge: "e", dx: 5_000, dy: 0 },
		{ edge: "w", dx: -5_000, dy: 0 },
		{ edge: "n", dx: 0, dy: -5_000 },
		{ edge: "s", dx: 0, dy: 5_000 },
	] as const;

	for (const { edge, dx, dy } of oversizedResizes) {
		it(`keeps the opposite edges fixed when ${edge} resize hits the viewport limit`, () => {
			const resized = resizeSheetGeometry(geometry, edge, dx, dy, viewport);
			if (edge.includes("w")) expect(resized.x + resized.width).toBe(geometry.x + geometry.width);
			else expect(resized.x).toBe(geometry.x);
			if (edge.includes("n")) expect(resized.y + resized.height).toBe(geometry.y + geometry.height);
			else expect(resized.y).toBe(geometry.y);
			expect(resized.width).toBeGreaterThanOrEqual(SHEET_WINDOW_MIN_WIDTH);
			expect(resized.height).toBeGreaterThanOrEqual(SHEET_WINDOW_MIN_HEIGHT);
			expect(resized.x).toBeGreaterThanOrEqual(SHEET_WINDOW_MARGIN);
			expect(resized.y).toBeGreaterThanOrEqual(SHEET_WINDOW_MARGIN);
			expect(resized.x + resized.width).toBeLessThanOrEqual(viewport.width - SHEET_WINDOW_MARGIN);
			expect(resized.y + resized.height).toBeLessThanOrEqual(viewport.height - SHEET_WINDOW_MARGIN);
		});
	}

	it("uses a centered viewport-safe starting geometry", () => {
		const start = defaultSheetGeometry({ width: 800, height: 600 });
		expect(start.x).toBeGreaterThanOrEqual(0);
		expect(start.y).toBeGreaterThanOrEqual(0);
		expect(start.x + start.width).toBeLessThanOrEqual(800);
		expect(start.y + start.height).toBeLessThanOrEqual(600);
	});
});

describe("sheet window state persistence", () => {
	it("defaults to in-pane and remembers mode and geometry independently per sheet kind", () => {
		const storage = new MemoryStorage();
		expect(readSheetWindowState("agents", storage, viewport).mode).toBe("in-pane");
		writeSheetWindowState("agents", { mode: "float", geometry }, storage);
		expect(readSheetWindowState("agents", storage, viewport)).toEqual({ mode: "float", geometry });
		expect(readSheetWindowState("status", storage, viewport).mode).toBe("in-pane");
	});

	it("clamps an offscreen restored panel and resets its size after the viewport shrinks", () => {
		const storage = new MemoryStorage();
		writeSheetWindowState("agents", { mode: "float", geometry: { ...geometry, x: 900, y: 700 } }, storage);
		const restored = readSheetWindowState("agents", storage, viewport);
		expect(restored.geometry.x + restored.geometry.width).toBeLessThanOrEqual(viewport.width);
		expect(restored.geometry.y + restored.geometry.height).toBeLessThanOrEqual(viewport.height);

		writeSheetWindowState("agents", { mode: "float", geometry: { x: 20, y: 20, width: 900, height: 700 } }, storage);
		const smaller = { width: 760, height: 520 };
		const reset = readSheetWindowState("agents", storage, smaller);
		expect(reset.mode).toBe("float");
		expect(reset.geometry).toEqual(defaultSheetGeometry(smaller));
	});

	it("restores from maximize to the previous non-maximized mode", () => {
		expect(toggleMaximizeMode("float", "float")).toBe("maximized");
		expect(toggleMaximizeMode("maximized", "float")).toBe("float");
		expect(toggleMaximizeMode("maximized", "in-pane")).toBe("in-pane");
	});

	it("keeps the unsupported/phone render as the existing in-pane bottom sheet", () => {
		const html = renderToStaticMarkup(createElement(Sheet, { title: "Agents", windowKind: "agents", onClose: () => {}, children: "Agent content" }));
		expect(html).toContain('class="dk-sheet-root"');
		expect(html).toContain('class="dk-sheet-backdrop"');
		expect(html).toContain('class="dk-sheet"');
		expect(html).not.toContain("dk-sheet-window-controls");
		expect(html).toContain("Agent content");
	});
});
