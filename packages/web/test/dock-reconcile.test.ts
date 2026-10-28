import { describe, expect, it, vi } from "bun:test";
import type { DockviewApi } from "dockview-react";
import { reconcile } from "../src/components/panes/DockPanes";
import { type DockGrid, PaneModel } from "../src/lib/pane-layout";

interface FakePanel {
	id: string;
	api: { setActive(): void };
}

interface AddCall {
	id: string;
	position?: { referencePanel: FakePanel; direction: string };
}

/** The slice of DockviewApi `reconcile` drives, recording what the grid would see. */
class FakeDock {
	panels: FakePanel[] = [];
	groups: { header: { hidden: boolean } }[] = [];
	added: AddCall[] = [];
	removed: string[] = [];
	loaded: unknown[] = [];
	maximized = false;
	activePanel: FakePanel | undefined;
	failLoad = false;
	cleared = 0;

	getPanel(id: string): FakePanel | undefined {
		return this.panels.find(panel => panel.id === id);
	}
	addPanel(options: AddCall): FakePanel {
		this.added.push(options);
		const panel: FakePanel = { id: options.id, api: { setActive: () => (this.activePanel = panel) } };
		this.panels.push(panel);
		this.groups.push({ header: { hidden: false } });
		this.activePanel = panel;
		return panel;
	}
	removePanel(panel: FakePanel): void {
		this.removed.push(panel.id);
		this.panels = this.panels.filter(candidate => candidate !== panel);
		this.groups.pop();
	}
	fromJSON(data: unknown): void {
		if (this.failLoad) throw new Error("unreadable grid");
		this.loaded.push(data);
		const grid = data as DockGrid;
		this.panels = Object.keys(grid.panels).map(id => ({ id, api: { setActive: () => {} } }));
		this.groups = this.panels.map(() => ({ header: { hidden: false } }));
	}
	clear(): void {
		this.cleared++;
		this.panels = [];
		this.groups = [];
	}
	hasMaximizedGroup(): boolean {
		return this.maximized;
	}
	maximizeGroup(): void {
		this.maximized = true;
	}
	exitMaximizedGroup(): void {
		this.maximized = false;
	}
	asApi(): DockviewApi {
		return this as unknown as DockviewApi;
	}
}

describe("reconcile (model to Dockview)", () => {
	it("adds a split pane beside or below the pane it was split from", () => {
		const model = new PaneModel();
		const dock = new FakeDock();
		reconcile(dock.asApi(), model);
		const first = model.getSnapshot().focusedId;
		const right = model.split("right");
		const below = model.split("down");
		reconcile(dock.asApi(), model);
		expect(dock.added.map(call => call.id)).toEqual([first, right, below]);
		expect(dock.added[0]!.position).toBeUndefined();
		expect(dock.added[1]!.position).toMatchObject({ direction: "right" });
		expect(dock.added[1]!.position!.referencePanel.id).toBe(first);
		expect(dock.added[2]!.position).toMatchObject({ direction: "below" });
		expect(dock.added[2]!.position!.referencePanel.id).toBe(right);
	});

	it("does not re-add panes that are already in the grid, and removes closed ones", () => {
		const model = new PaneModel();
		const dock = new FakeDock();
		const first = model.getSnapshot().focusedId;
		const second = model.split("right");
		reconcile(dock.asApi(), model);
		reconcile(dock.asApi(), model);
		expect(dock.added).toHaveLength(2);
		model.close(second);
		reconcile(dock.asApi(), model);
		expect(dock.removed).toEqual([second]);
		expect(dock.panels.map(panel => panel.id)).toEqual([first]);
	});

	it("hides every tab strip, leaves Dockview's active panel alone on focus, and mirrors zoom both ways", () => {
		const model = new PaneModel();
		const dock = new FakeDock();
		const first = model.getSnapshot().focusedId;
		model.split("right");
		reconcile(dock.asApi(), model);
		expect(dock.groups.every(group => group.header.hidden)).toBe(true);
		const activeBefore = dock.activePanel?.id;
		// Re-activating re-opens the panel in Dockview (content detached and re-attached: a white flash per click).
		model.focus(first);
		reconcile(dock.asApi(), model);
		expect(dock.activePanel?.id).toBe(activeBefore);
		model.toggleZoom();
		reconcile(dock.asApi(), model);
		expect(dock.maximized).toBe(true);
		model.toggleZoom();
		reconcile(dock.asApi(), model);
		expect(dock.maximized).toBe(false);
	});

	it("applies a saved grid once, then only reconciles the difference", () => {
		const source = new PaneModel();
		const a = source.getSnapshot().focusedId;
		const b = source.split("right");
		const grid: DockGrid = {
			grid: {
				width: 100,
				height: 100,
				orientation: "HORIZONTAL",
				root: {
					type: "branch",
					size: 100,
					data: [
						{ type: "leaf", size: 50, data: { views: [a] } },
						{ type: "leaf", size: 50, data: { views: [b] } },
					],
				},
			},
			panels: { [a]: {}, [b]: {} },
		};
		const model = new PaneModel(source.toSaved(grid));
		const dock = new FakeDock();
		reconcile(dock.asApi(), model);
		expect(dock.loaded).toEqual([grid]);
		expect(dock.added).toHaveLength(0);
		reconcile(dock.asApi(), model);
		expect(dock.loaded).toHaveLength(1);
	});

	it("rebuilds from placements when Dockview rejects the saved grid", () => {
		const source = new PaneModel();
		const a = source.getSnapshot().focusedId;
		const b = source.split("down");
		const grid: DockGrid = {
			grid: {
				width: 100,
				height: 100,
				orientation: "VERTICAL",
				root: {
					type: "branch",
					size: 100,
					data: [
						{ type: "leaf", size: 50, data: { views: [a] } },
						{ type: "leaf", size: 50, data: { views: [b] } },
					],
				},
			},
			panels: { [a]: {}, [b]: {} },
		};
		const model = new PaneModel(source.toSaved(grid));
		const dock = new FakeDock();
		dock.failLoad = true;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			reconcile(dock.asApi(), model);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
		expect(dock.cleared).toBe(1);
		expect(dock.added.map(call => call.id)).toEqual([a, b]);
		expect(dock.added[1]!.position).toMatchObject({ direction: "below" });
	});
});
