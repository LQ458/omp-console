/**
 * The tiled layout: Dockview draws the grid (splits, sashes, sizes), the pane model decides what is in it.
 * Dockview's tab strip, drag-and-drop and floating groups are off: every pane is its own group with its own
 * session header, and structure changes go through the model (keys, the pane bar), never through Dockview UI.
 *
 * Direction of data: model -> Dockview (`reconcile`), and from Dockview back only what the model cannot know:
 * which group the user clicked into (focus), and sash sizes (via `onLayout`, for persistence).
 */
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from "dockview-react";
import { DockviewReact } from "dockview-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DockGrid, PaneModel } from "../../lib/pane-layout";
import { PaneFrame } from "./PaneFrame";
import "dockview-react/dist/styles/dockview.css";

const PANE_COMPONENT = "pane";

function usePanelVisible(api: IDockviewPanelProps["api"]): boolean {
	const subscribe = useCallback(
		(listener: () => void) => {
			const subscription = api.onDidVisibilityChange(listener);
			return () => subscription.dispose();
		},
		[api],
	);
	const getSnapshot = useCallback(() => api.isVisible, [api]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function DockPane({ api }: IDockviewPanelProps): ReactNode {
	const visible = usePanelVisible(api);
	return <PaneFrame paneId={api.id} visible={visible} />;
}

/** Applies the model to Dockview: a saved grid first, then add what is missing and remove what is gone. */
export function reconcile(api: DockviewApi, model: PaneModel): void {
	const state = model.getSnapshot();
	const dock = model.takePendingDock();
	if (dock !== undefined) {
		try {
			api.fromJSON(dock as unknown as Parameters<DockviewApi["fromJSON"]>[0]);
		} catch (err) {
			// A grid this Dockview cannot read: fall back to rebuilding from the panes' placements.
			console.warn("omp-console: saved pane grid rejected", err);
			api.clear();
		}
	}
	const wanted = new Set(state.panes.map(pane => pane.id));
	for (const panel of [...api.panels]) if (!wanted.has(panel.id)) api.removePanel(panel);
	for (const pane of state.panes) {
		if (api.getPanel(pane.id)) continue;
		const reference = pane.placement ? api.getPanel(pane.placement.reference) : undefined;
		api.addPanel({
			id: pane.id,
			component: PANE_COMPONENT,
			title: pane.id,
			...(reference && pane.placement
				? { position: { referencePanel: reference, direction: pane.placement.axis === "right" ? "right" : "below" } }
				: {}),
		});
	}
	for (const group of api.groups) group.header.hidden = true;
	// Focus lives in the model (PaneFrame sets it on pointer and keyboard focus). Pushing it into Dockview with
	// `setActive()` made Dockview re-open the panel, detaching and re-attaching its content: the transcript lost its size
	// for a frame and re-measured, so every click into the other pane flashed white.
	const focused = api.getPanel(state.focusedId);
	if (state.zoomed && focused && !api.hasMaximizedGroup()) api.maximizeGroup(focused);
	else if (!state.zoomed && api.hasMaximizedGroup()) api.exitMaximizedGroup();
}

export interface DockHandle {
	/** Dockview's serialized grid. */
	toJSON(): DockGrid;
}

export interface DockPanesProps {
	model: PaneModel;
	/** Called with the live handle when Dockview is ready, and with null when it goes away. */
	onHandle(handle: DockHandle | null): void;
	/** The grid changed (sash drag, split, close): persist and refresh cached geometry. */
	onLayout(): void;
}

export function DockPanes({ model, onHandle, onLayout }: DockPanesProps): ReactNode {
	const [api, setApi] = useState<DockviewApi | null>(null);
	const components = useMemo(() => ({ [PANE_COMPONENT]: DockPane }), []);
	const onReady = useCallback((event: DockviewReadyEvent) => setApi(event.api), []);
	const boxRef = useRef<HTMLDivElement | null>(null);

	// Dockview applies its own resize observations on the next animation frame. WKWebView suspends
	// animation frames while the window is occluded, so a window resized then (or restored from another Space)
	// keeps panes at the old size, wider than the window. Lay out directly from the observer instead.
	useEffect(() => {
		const box = boxRef.current;
		if (!api || !box) return;
		const observer = new ResizeObserver(entries => {
			const rect = entries[entries.length - 1]?.contentRect;
			if (rect && rect.width > 0 && rect.height > 0) api.layout(Math.round(rect.width), Math.round(rect.height));
		});
		observer.observe(box);
		return () => observer.disconnect();
	}, [api]);

	useEffect(() => {
		if (!api) return;
		reconcile(api, model);
		onHandle({ toJSON: () => api.toJSON() as unknown as DockGrid });
		// Dockview events call back into the model (focus, zoom); a change made while Dockview is mid-operation
		// is applied right after it, never inside it, and a burst of changes is applied once.
		let scheduled = false;
		let disposed = false;
		const schedule = (): void => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				if (!disposed) reconcile(api, model);
			});
		};
		const subscriptions = [
			api.onDidActivePanelChange(event => {
				if (event.panel) model.focus(event.panel.id);
			}),
			api.onDidMaximizedGroupChange(event => model.setZoomed(event.isMaximized)),
			api.onDidAddGroup(group => {
				group.header.hidden = true;
			}),
			api.onDidLayoutChange(onLayout),
		];
		const unsubscribe = model.subscribe(schedule);
		return () => {
			disposed = true;
			unsubscribe();
			for (const subscription of subscriptions) subscription.dispose();
			onHandle(null);
		};
	}, [api, model, onHandle, onLayout]);

	return (
		<div ref={boxRef} className="pn-dock-box">
			<DockviewReact
				className="dockview-theme-abyss pn-dock"
				components={components}
				onReady={onReady}
				disableDnd
				disableFloatingGroups
				hideBorders
			/>
		</div>
	);
}
