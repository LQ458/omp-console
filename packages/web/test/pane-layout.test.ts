import { describe, expect, it } from "bun:test";
import {
	CURRENT_LAYOUT,
	type DockGrid,
	type DockNode,
	type KeyLike,
	type LayoutStorage,
	listLayouts,
	neighbourOf,
	normalizeLayoutName,
	PaneModel,
	paneKeyAction,
	parseSavedLayout,
	readLayout,
	rectsFromDock,
	paneRecoveryStatus,
	staleSessions,
	writeLayout,
} from "../src/lib/pane-layout";

function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
	return { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...partial };
}

const leaf = (id: string, size: number): DockNode => ({ type: "leaf", data: { views: [id] }, size });
const branch = (size: number, ...data: DockNode[]): DockNode => ({ type: "branch", data, size });

/** A grid of 1000x800: A on the left (full height), B over C on the right. */
function threePaneDock(): DockGrid {
	return {
		grid: {
			width: 1000,
			height: 800,
			orientation: "HORIZONTAL",
			root: branch(1000, leaf("A", 400), branch(600, leaf("B", 500), leaf("C", 300))),
		},
		panels: { A: {}, B: {}, C: {} },
	};
}

class MemoryStorage implements LayoutStorage {
	readonly #map = new Map<string, string>();
	get length(): number {
		return this.#map.size;
	}
	key(index: number): string | null {
		return [...this.#map.keys()][index] ?? null;
	}
	getItem(key: string): string | null {
		return this.#map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.#map.set(key, value);
	}
	removeItem(key: string): void {
		this.#map.delete(key);
	}
}

describe("paneKeyAction", () => {
	it("maps the kitty split bindings on Command", () => {
		expect(paneKeyAction(key({ key: "d" }))).toEqual({ kind: "split", axis: "right" });
		expect(paneKeyAction(key({ key: "D", shiftKey: true }))).toEqual({ kind: "split", axis: "down" });
		expect(paneKeyAction(key({ key: "ArrowLeft", altKey: true }))).toEqual({ kind: "focus", direction: "left" });
		expect(paneKeyAction(key({ key: "ArrowDown", shiftKey: true }))).toEqual({ kind: "move", direction: "down" });
		expect(paneKeyAction(key({ key: "w" }))).toEqual({ kind: "close" });
		expect(paneKeyAction(key({ key: "Enter", shiftKey: true }))).toEqual({ kind: "zoom" });
	});

	it("leaves every other chord to the page", () => {
		expect(paneKeyAction(key({ key: "d", metaKey: false }))).toBeNull();
		expect(paneKeyAction(key({ key: "d", ctrlKey: true }))).toBeNull();
		expect(paneKeyAction(key({ key: "k" }))).toBeNull();
		expect(paneKeyAction(key({ key: "w", shiftKey: true }))).toBeNull();
		expect(paneKeyAction(key({ key: "d", altKey: true }))).toBeNull();
		expect(paneKeyAction(key({ key: "Enter" }))).toBeNull();
		expect(paneKeyAction(key({ key: "ArrowLeft" }))).toBeNull();
		expect(paneKeyAction(key({ key: "ArrowLeft", altKey: true, shiftKey: true }))).toBeNull();
	});
});

describe("focus geometry", () => {
	it("derives pane rectangles from nested serialized splits", () => {
		const rects = rectsFromDock(threePaneDock())!;
		expect(rects.get("A")).toEqual({ left: 0, top: 0, width: 400, height: 800 });
		expect(rects.get("B")).toEqual({ left: 400, top: 0, width: 600, height: 500 });
		expect(rects.get("C")).toEqual({ left: 400, top: 500, width: 600, height: 300 });
	});

	it("rejects a leaf without a pane id", () => {
		const bad: DockGrid = { ...threePaneDock(), grid: { ...threePaneDock().grid, root: branch(1000, { type: "leaf", data: { views: [] }, size: 1000 }) } };
		expect(rectsFromDock(bad)).toBeNull();
	});

	it("picks the neighbour that overlaps most, and stops at the edge", () => {
		const rects = rectsFromDock(threePaneDock())!;
		expect(neighbourOf(rects, "A", "right")).toBe("B"); // overlaps 500 of A's 800 rows vs 300 for C
		expect(neighbourOf(rects, "C", "left")).toBe("A");
		expect(neighbourOf(rects, "B", "down")).toBe("C");
		expect(neighbourOf(rects, "C", "up")).toBe("B");
		expect(neighbourOf(rects, "A", "left")).toBeNull();
		expect(neighbourOf(rects, "A", "up")).toBeNull();
		expect(neighbourOf(rects, "B", "right")).toBeNull();
	});

	it("takes the nearest pane, not any pane in that direction", () => {
		const row: DockGrid = {
			grid: { width: 900, height: 400, orientation: "HORIZONTAL", root: branch(900, leaf("A", 300), leaf("B", 300), leaf("C", 300)) },
			panels: { A: {}, B: {}, C: {} },
		};
		const rects = rectsFromDock(row)!;
		expect(neighbourOf(rects, "A", "right")).toBe("B");
		expect(neighbourOf(rects, "C", "left")).toBe("B");
	});

	it("does not treat a diagonal pane as a neighbour", () => {
		const rects = new Map([
			["A", { left: 0, top: 0, width: 100, height: 100 }],
			["B", { left: 100, top: 100, width: 100, height: 100 }],
		]);
		expect(neighbourOf(rects, "A", "right")).toBeNull();
		expect(neighbourOf(rects, "A", "down")).toBeNull();
	});

	it("with two equally overlapping neighbours, goes back to the one focused most recently", () => {
		const rects = new Map([
			["A", { left: 0, top: 0, width: 400, height: 800 }],
			["B", { left: 400, top: 0, width: 600, height: 400 }],
			["C", { left: 400, top: 400, width: 600, height: 400 }],
		]);
		expect(neighbourOf(rects, "A", "right", ["A", "C", "B"])).toBe("C");
		expect(neighbourOf(rects, "A", "right", ["A", "B", "C"])).toBe("B");
		// Never focused: the nearest center, then order, decides.
		expect(neighbourOf(rects, "A", "right")).toBe("B");
		// Geometry still beats recency: C is the most recent but overlaps A far less.
		rects.set("B", { left: 400, top: 0, width: 600, height: 600 });
		rects.set("C", { left: 400, top: 600, width: 600, height: 200 });
		expect(neighbourOf(rects, "A", "right", ["A", "C", "B"])).toBe("B");
	});
});

describe("PaneModel", () => {
	it("starts with one empty focused pane", () => {
		const model = new PaneModel();
		const state = model.getSnapshot();
		expect(state.panes).toHaveLength(1);
		expect(state.panes[0]!.sessionId).toBeNull();
		expect(state.focusedId).toBe(state.panes[0]!.id);
	});

	it("opens in the focused pane, or focuses the pane that already shows the session", () => {
		const model = new PaneModel();
		const first = model.open("s1");
		const second = model.split("right");
		model.open("s2");
		expect(model.getSnapshot().panes.map(p => p.sessionId)).toEqual(["s1", "s2"]);
		expect(model.getSnapshot().focusedId).toBe(second);
		// s1 is already visible: focus moves there and nothing is replaced.
		expect(model.open("s1")).toBe(first);
		expect(model.getSnapshot().focusedId).toBe(first);
		expect(model.getSnapshot().panes.map(p => p.sessionId)).toEqual(["s1", "s2"]);
	});

	it("opens a duplicate view in a new split, sharing one session id", () => {
		const model = new PaneModel();
		model.open("s1");
		const added = model.open("s1", "down");
		const { panes, focusedId } = model.getSnapshot();
		expect(panes.map(p => p.sessionId)).toEqual(["s1", "s1"]);
		expect(focusedId).toBe(added);
		expect(panes[1]!.placement).toEqual({ reference: panes[0]!.id, axis: "down" });
		expect(model.sessionIds()).toEqual(["s1"]);
	});

	it("returns focus to the previously focused pane when the focused one closes", () => {
		const model = new PaneModel();
		const a = model.getSnapshot().focusedId;
		const b = model.split("right");
		const c = model.split("down");
		model.focus(a);
		model.focus(c);
		model.close(c);
		expect(model.getSnapshot().focusedId).toBe(a);
		expect(model.getSnapshot().panes.map(p => p.id)).toEqual([a, b]);
	});

	it("closing the last pane empties it instead of removing it", () => {
		const model = new PaneModel();
		model.open("s1");
		const id = model.getSnapshot().focusedId;
		model.close();
		const state = model.getSnapshot();
		expect(state.panes).toEqual([{ id, sessionId: null }]);
		expect(state.focusedId).toBe(id);
	});

	it("re-anchors a pane split off a pane that closes, and never reuses ids", () => {
		const model = new PaneModel();
		const a = model.getSnapshot().focusedId;
		const b = model.split("right");
		const c = model.split("down"); // placed below b
		model.close(b);
		expect(model.getSnapshot().panes.find(p => p.id === c)!.placement).toEqual({ reference: a, axis: "down" });
		const d = model.split("right");
		expect(new Set([a, b, c, d]).size).toBe(4);
	});

	it("zoom toggles for several panes, clears on split, and ignores a lone pane", () => {
		const model = new PaneModel();
		model.toggleZoom();
		expect(model.getSnapshot().zoomed).toBe(false);
		model.split("right");
		model.toggleZoom();
		expect(model.getSnapshot().zoomed).toBe(true);
		model.split("down");
		expect(model.getSnapshot().zoomed).toBe(false);
		model.toggleZoom();
		model.close();
		expect(model.getSnapshot().zoomed).toBe(false);
	});

	it("moves focus by geometry and leaves zoom first", () => {
		const model = new PaneModel(undefined, (() => {
			const ids = ["A", "B", "C"];
			return () => ids.shift()!;
		})());
		model.split("right");
		model.split("down");
		const rects = rectsFromDock(threePaneDock())!;
		model.focus("A");
		model.toggleZoom();
		expect(model.focusDirection(rects, "right")).toBe(true);
		expect(model.getSnapshot()).toMatchObject({ focusedId: "B", zoomed: false });
		expect(model.focusDirection(rects, "up")).toBe(false);
		expect(model.getSnapshot().focusedId).toBe("B");
	});

	it("returns to the stacked neighbour it was in last when two overlap equally", () => {
		const ids = ["A", "B", "C"];
		const model = new PaneModel(undefined, () => ids.shift()!);
		model.split("right");
		model.split("down");
		const even: DockGrid = {
			grid: {
				width: 1000,
				height: 800,
				orientation: "HORIZONTAL",
				root: branch(1000, leaf("A", 400), branch(600, leaf("B", 400), leaf("C", 400))),
			},
			panels: { A: {}, B: {}, C: {} },
		};
		const rects = rectsFromDock(even)!;
		model.focus("C");
		model.focus("A");
		expect(model.focusDirection(rects, "right")).toBe(true);
		expect(model.getSnapshot().focusedId).toBe("C");
		model.focus("B");
		model.focus("A");
		model.focusDirection(rects, "right");
		expect(model.getSnapshot().focusedId).toBe("B");
	});

	it("moving a pane swaps session assignments with the neighbour and focus follows the session", () => {
		const model = new PaneModel(undefined, (() => {
			const ids = ["A", "B", "C"];
			return () => ids.shift()!;
		})());
		model.open("s-a");
		model.split("right");
		model.open("s-b");
		model.split("down");
		model.open("s-c");
		const rects = rectsFromDock(threePaneDock())!;
		model.focus("A");
		expect(model.moveDirection(rects, "right")).toBe(true);
		const byId = Object.fromEntries(model.getSnapshot().panes.map(p => [p.id, p.sessionId]));
		expect(byId).toEqual({ A: "s-b", B: "s-a", C: "s-c" });
		expect(model.getSnapshot().focusedId).toBe("B");
		expect(model.moveDirection(rects, "right")).toBe(false);
	});

	it("drops sessions that are no longer live without touching the others", () => {
		const model = new PaneModel();
		model.open("gone");
		model.split("right");
		model.open("alive");
		model.dropSessions(id => id === "alive");
		expect(model.getSnapshot().panes.map(p => p.sessionId)).toEqual([null, "alive"]);
	});
});

describe("layout persistence", () => {
	function populated(): PaneModel {
		const model = new PaneModel();
		model.open("s1");
		model.split("right");
		model.open("s2");
		model.split("down");
		return model;
	}

	it("round-trips panes, focus and a matching grid through storage", () => {
		const model = populated();
		const ids = model.getSnapshot().panes.map(p => p.id);
		const dock: DockGrid = {
			grid: { width: 100, height: 100, orientation: "HORIZONTAL", root: branch(100, leaf(ids[0]!, 50), branch(50, leaf(ids[2]!, 50), leaf(ids[1]!, 50))) },
			panels: Object.fromEntries(ids.map(id => [id, {}])),
		};
		const storage = new MemoryStorage();
		expect(writeLayout(storage, CURRENT_LAYOUT, model.toSaved(dock))).toBe(true);
		const restored = readLayout(storage, CURRENT_LAYOUT)!;
		expect(restored.panes).toEqual([...model.getSnapshot().panes]);
		expect(restored.focusedId).toBe(model.getSnapshot().focusedId);
		expect(restored.dock).toEqual(dock);
		const reopened = new PaneModel(restored);
		expect(reopened.getSnapshot().panes).toEqual(model.getSnapshot().panes);
		// Ids continue after the restored ones.
		expect(ids).not.toContain(reopened.split("right"));
	});

	it("drops a saved grid that does not describe exactly the saved panes", () => {
		const model = populated();
		const stale = threePaneDock(); // panels A, B, C: not this model's ids
		expect(model.toSaved(stale).dock).toBeUndefined();
		const text = JSON.stringify({ ...model.toSaved(), dock: stale });
		expect(parseSavedLayout(text)!.dock).toBeUndefined();
	});

	it("rejects text that is not a layout this version wrote", () => {
		const valid = JSON.parse(JSON.stringify(populated().toSaved()));
		expect(parseSavedLayout(null)).toBeNull();
		expect(parseSavedLayout("{")).toBeNull();
		expect(parseSavedLayout(JSON.stringify({ ...valid, v: 2 }))).toBeNull();
		expect(parseSavedLayout(JSON.stringify({ ...valid, panes: [] }))).toBeNull();
		expect(parseSavedLayout(JSON.stringify({ ...valid, panes: [valid.panes[0], valid.panes[0]] }))).toBeNull();
		expect(parseSavedLayout(JSON.stringify({ ...valid, panes: [{ id: 3, sessionId: null }] }))).toBeNull();
	});

	it("falls back to the first pane for an unknown focus and drops dangling placements", () => {
		const parsed = parseSavedLayout(
			JSON.stringify({
				v: 1,
				focusedId: "zz",
				panes: [
					{ id: "p1", sessionId: "s1" },
					{ id: "p2", sessionId: null, placement: { reference: "gone", axis: "right" } },
				],
			}),
		)!;
		expect(parsed.focusedId).toBe("p1");
		expect(parsed.panes[1]!.placement).toBeUndefined();
	});

	it("never restores a joined-room pane, whose link is a secret that is not stored", () => {
		const parsed = parseSavedLayout(JSON.stringify({ v: 1, focusedId: "p1", panes: [{ id: "p1", sessionId: "link:3" }] }))!;
		expect(parsed.panes[0]!.sessionId).toBeNull();
	});

	it("lists menu layouts without the auto-saved one and skips corrupt entries", () => {
		const storage = new MemoryStorage();
		const layout = populated().toSaved();
		writeLayout(storage, CURRENT_LAYOUT, layout);
		writeLayout(storage, "study", layout);
		writeLayout(storage, "two repos + kb", layout);
		storage.setItem("omp-console-layout:broken", "not json");
		storage.setItem("omp-console-theme", "dark");
		expect(listLayouts(storage)).toEqual(["study", "two repos + kb"]);
	});

	it("rejects layout names that are empty or reserved", () => {
		expect(normalizeLayoutName("  study   mode ")).toBe("study mode");
		expect(normalizeLayoutName("   ")).toBeNull();
		expect(normalizeLayoutName(CURRENT_LAYOUT)).toBeNull();
	});

	it("loads a saved layout over the current panes with fresh ids and no zoom", () => {
		const model = populated();
		model.toggleZoom();
		const other = new PaneModel();
		other.open("x");
		model.load(other.toSaved());
		const state = model.getSnapshot();
		expect(state.panes.map(p => p.sessionId)).toEqual(["x"]);
		expect(state.zoomed).toBe(false);
		const added = model.split("right");
		expect(state.panes.map(p => p.id)).not.toContain(added);
	});
});

describe("staleSessions", () => {
	const live = new Set(["a", "b"]);

	it("the first list empties restored panes whose session no longer exists", () => {
		expect(staleSessions(["a", "gone"], live, new Set(), true)).toEqual(new Set(["gone"]));
	});

	it("keeps a previously live pane when the session disappears from the live list", () => {
		expect(staleSessions(["a", "stopped"], live, new Set(["a", "stopped"]), false)).toEqual(new Set());
	});

	it("keeps restored sessions found in recent history", () => {
		expect(staleSessions(["gone"], live, new Set(), true, new Set(["gone"]))).toEqual(new Set());
	});

	it("never drops a joined room", () => {
		expect(staleSessions(["link:1"], live, new Set(["link:1"]), true)).toEqual(new Set());
	});
});

describe("pane recovery window", () => {
	it("shows a known session reconnecting for 60 seconds, then stopped", () => {
		expect(paneRecoveryStatus(1_000, 61_000)).toBe("reconnecting");
		expect(paneRecoveryStatus(1_000, 61_001)).toBe("stopped");
	});

	it("does not classify a session that was never live", () => {
		expect(paneRecoveryStatus(undefined, 61_001)).toBeNull();
	});
});
