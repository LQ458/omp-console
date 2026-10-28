/**
 * Hosts the panes: keeps the guest pool in step with the model, binds the kitty-style keys, saves the layout,
 * and shows either the tiled Dockview layout (tablet, desktop) or the phone page switcher.
 *
 * The app supplies what a pane shows (`renderSession`, `renderEmpty`); this component knows nothing about
 * transcripts or composers.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { LazyRegion } from "../shell/LazyRegion";
import { lazyWithRecovery } from "../../lib/lazy";
import type { GuestClient } from "../../lib/client";
import type { GuestPool } from "../../lib/guest-pool";
import { recordUsage } from "../../lib/journal";
import type { LayoutMode } from "../../lib/layout";
import {
	CURRENT_LAYOUT,
	deleteLayout,
	type LayoutStorage,
	listLayouts,
	normalizeLayoutName,
	type PaneAction,
	type PaneId,
	type PaneModel,
	paneKeyAction,
	type Rect,
	readLayout,
	rectsFromDock,
	type SplitAxis,
	writeLayout,
} from "../../lib/pane-layout";
import { PaneBar, type PaneActions } from "./PaneBar";
import { PaneContext, type PaneContextValue, type PaneSessionArgs, usePaneState } from "./context";
import type { DockHandle } from "./DockPanes";
import { PaneFrame } from "./PaneFrame";
import { PhonePanes } from "./PhonePanes";
import "./panes.css";

const DockPanes = lazyWithRecovery(() => import("./DockPanes").then(({ DockPanes: component }) => ({ default: component })));

/** Delay between a change and the layout write; a sash drag or a burst of opens becomes one write. */
const SAVE_DELAY_MS = 400;

export interface PaneHostProps {
	model: PaneModel;
	pool: GuestPool<GuestClient>;
	mode: LayoutMode;
	storage?: LayoutStorage;
	onOpenSettings(): void;
	renderSession(args: PaneSessionArgs): ReactNode;
	renderEmpty(paneId: PaneId): ReactNode;
	titleOf(sessionKey: string): string;
	/** Whether a daemon session still exists; used to empty the panes of a named layout that outlived its sessions. */
	isLive(sessionKey: string): boolean;
}

type Via = "key" | "bar";

function record(action: string, via: Via): void {
	recordUsage({ feature: "10.panes", action, outcome: "ok", via: "direct", detail: via });
}

export function PaneHost({ model, pool, mode, storage, onOpenSettings, renderSession, renderEmpty, titleOf, isLive }: PaneHostProps): ReactNode {
	const state = usePaneState(model);
	const phone = mode === "phone";
	const handleRef = useRef<DockHandle | null>(null);
	/** Last geometry read while the grid was not zoomed: zoom hides the other panes, so their sizes are unreadable then. */
	const rectsRef = useRef<Map<PaneId, Rect> | null>(null);
	const saveTimer = useRef<Timer | undefined>(undefined);

	// The pool follows the panes. The phone shows one page at a time, so it holds one connection.
	useEffect(() => {
		pool.sync(phone ? (model.focused.sessionId === null ? [] : [model.focused.sessionId]) : model.sessionIds());
	}, [pool, model, phone, state.panes, state.focusedId]);

	const refreshRects = useCallback((): Map<PaneId, Rect> => {
		const handle = handleRef.current;
		if (handle && !model.getSnapshot().zoomed) {
			const rects = rectsFromDock(handle.toJSON());
			if (rects) rectsRef.current = rects;
		}
		const known = new Set(model.getSnapshot().panes.map(pane => pane.id));
		const cached = rectsRef.current ?? new Map<PaneId, Rect>();
		return new Map([...cached].filter(([id]) => known.has(id)));
	}, [model]);

	const saveNow = useCallback((): void => {
		if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
		saveTimer.current = undefined;
		writeLayout(storage, CURRENT_LAYOUT, model.toSaved(handleRef.current?.toJSON()));
	}, [model, storage]);

	const saveSoon = useCallback((): void => {
		if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(saveNow, SAVE_DELAY_MS);
	}, [saveNow]);

	const onLayout = useCallback((): void => {
		refreshRects();
		saveSoon();
	}, [refreshRects, saveSoon]);

	const onHandle = useCallback((handle: DockHandle | null): void => {
		handleRef.current = handle;
	}, []);

	useEffect(() => {
		const unsubscribe = model.subscribe(saveSoon);
		const flush = (): void => {
			if (saveTimer.current !== undefined) saveNow();
		};
		window.addEventListener("pagehide", flush);
		return () => {
			unsubscribe();
			window.removeEventListener("pagehide", flush);
			flush();
		};
	}, [model, saveSoon, saveNow]);

	const run = useCallback(
		(action: PaneAction, via: Via): void => {
			switch (action.kind) {
				case "split":
					model.split(action.axis);
					record(action.axis === "right" ? "split-right" : "split-down", via);
					break;
				case "close":
					model.close();
					record("close", via);
					break;
				case "zoom":
					model.toggleZoom();
					record("zoom", via);
					break;
				case "focus":
					if (model.focusDirection(refreshRects(), action.direction)) record("focus", via);
					break;
				case "move":
					if (model.moveDirection(refreshRects(), action.direction)) record("move", via);
					break;
			}
		},
		[model, refreshRects],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.isComposing) return;
			const action = paneKeyAction(event);
			if (action === null) return;
			event.preventDefault();
			run(action, "key");
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [run]);

	const actions = useMemo<PaneActions>(
		() => ({
			split: (axis: SplitAxis) => run({ kind: "split", axis }, "bar"),
			zoom: () => run({ kind: "zoom" }, "bar"),
			close: () => run({ kind: "close" }, "bar"),
			layoutNames: () => listLayouts(storage),
			saveLayout: name => {
				const normalized = normalizeLayoutName(name);
				if (normalized === null || !writeLayout(storage, normalized, model.toSaved(handleRef.current?.toJSON()))) return false;
				record("layout-save", "bar");
				return true;
			},
			loadLayout: name => {
				const saved = readLayout(storage, name);
				if (saved === null) return;
				model.load(saved);
				model.dropSessions(key => key.startsWith("link:") || isLive(key));
				record("layout-load", "bar");
			},
			deleteLayout: name => {
				deleteLayout(storage, name);
				record("layout-delete", "bar");
			},
		}),
		[run, storage, model, isLive],
	);

	const context = useMemo<PaneContextValue>(
		() => ({ model, pool, renderSession, renderEmpty, titleOf }),
		[model, pool, renderSession, renderEmpty, titleOf],
	);

	return (
		<PaneContext.Provider value={context}>
			<div className="pn-host" data-mode={mode} data-zoomed={state.zoomed ? "true" : "false"}>
				{!phone && <PaneBar actions={actions} paneCount={state.panes.length} zoomed={state.zoomed} onOpenSettings={onOpenSettings} />}
				<div className="pn-stage">
					{phone ? (
						<PhonePanes />
					) : (
						<div className="pn-dock-wrap">
							{state.panes.length > 1 ? (
								<LazyRegion
									fallback={
										<div className="pn-dock-loading" aria-busy="true">
											{state.panes.map(pane => (
												<PaneFrame
													key={pane.id}
													paneId={pane.id}
													visible={!state.zoomed || pane.id === state.focusedId}
												/>
											))}
										</div>
									}
								>
									<DockPanes model={model} onHandle={onHandle} onLayout={onLayout} />
								</LazyRegion>
							) : (
								<PaneFrame paneId={state.focusedId} visible />
							)}
						</div>
					)}
				</div>
			</div>
		</PaneContext.Provider>
	);
}
