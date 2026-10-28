import { Maximize2, PanelLeft, PictureInPicture2, X } from "lucide-react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import {
	clampSheetGeometry,
	defaultSheetGeometry,
	maximizeSheetGeometry,
	moveSheetGeometry,
	readSheetWindowState,
	resizeSheetGeometry,
	toggleMaximizeMode,
	SHEET_WINDOW_MARGIN,
	writeSheetWindowState,
	type SheetGeometry,
	type SheetViewport,
	type SheetWindowMode,
	type SheetWindowState,
} from "../../lib/sheet-window";
import { motionLevel, shouldDismissSheetDrag } from "../../lib/motion";

export interface SheetProps {
	/** Accessible name and visible heading. */
	title: string;
	onClose(): void;
	/** Return false to defer closing until the content has finished saving. */
	onCloseRequest?(): boolean;
	/** `full` fills the screen on a phone (session list); `tall` leaves the top edge visible. */
	size?: "full" | "tall";
	/** Starts the same exit transition as the close button. */
	closeRequested?: boolean;
	/** Enables desktop in-pane/float/maximize modes and stores them under this sheet kind. */
	windowKind?: string;
	/** Keep Escape available to a nested agent drawer or node menu. */
	escapeEnabled?: boolean;
	rootClassName?: string;
	sectionClassName?: string;
	bodyClassName?: string;
	wrapBody?: boolean;
	/** Optional content between the title row and the scrollable body. */
	headerAddon?: ReactNode;
	onWindowRootChange?(root: HTMLDivElement | null): void;
	children: ReactNode;
}

/** The current windowed sheet root, used by descendant menus that must escape pane clipping. */
export const SheetWindowRootContext = createContext<HTMLDivElement | null>(null);

interface SheetDrag {
	pointerId: number;
	startY: number;
	lastY: number;
	lastAt: number;
	velocity: number;
	height: number;
}

interface WindowGesture {
	pointerId: number;
	kind: "move" | "resize";
	edge: string;
	startX: number;
	startY: number;
	geometry: SheetGeometry;
	current: SheetGeometry;
	section: HTMLElement;
}

const SHEET_EXIT_MS = 200;
const RESIZE_EDGES = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

function viewportSize(): SheetViewport {
	return typeof window === "undefined" ? { width: 0, height: 0 } : { width: window.innerWidth, height: window.innerHeight };
}

function isWideViewport(): boolean {
	return typeof window !== "undefined" && window.innerWidth >= 760;
}

function supportsTopLayer(): boolean {
	return (
		typeof HTMLElement !== "undefined" &&
		typeof HTMLElement.prototype.showPopover === "function" &&
		typeof HTMLElement.prototype.hidePopover === "function"
	);
}

function initialWindowState(kind: string | undefined): SheetWindowState {
	const viewport = viewportSize();
	if (kind === undefined) return { mode: "in-pane", geometry: defaultSheetGeometry(viewport) };
	const restoreViewport = viewport.width >= 760 ? viewport : { width: 1280, height: 800 };
	return readSheetWindowState(kind, undefined, restoreViewport);
}

function sameGeometry(left: SheetGeometry, right: SheetGeometry): boolean {
	return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/**
 * A phone bottom sheet or a centered desktop panel. Session-scoped sheets can use the browser top layer on wide
 * layouts; the DOM node remains in place so pane CSS variables, selectors, and React event bubbling are preserved.
 */
export function Sheet({
	title,
	onClose,
	size = "tall",
	closeRequested = false,
	onCloseRequest,
	windowKind,
	escapeEnabled = true,
	onWindowRootChange,
	rootClassName,
	sectionClassName,
	bodyClassName,
	wrapBody = true,
	headerAddon,
	children,
}: SheetProps): ReactNode {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const dialogRef = useRef<HTMLElement | null>(null);
	const sheetDragRef = useRef<SheetDrag | null>(null);
	const windowGestureRef = useRef<WindowGesture | null>(null);
	const windowFinishFrame = useRef<number | undefined>(undefined);
	const closeTimer = useRef<number | undefined>(undefined);
	const closingRef = useRef(false);
	const onCloseRef = useRef(onClose);
	const onCloseRequestRef = useRef(onCloseRequest);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const restoreModeRef = useRef<SheetWindowMode>("float");
	const windowOffsetApplied = useRef(false);
	onCloseRef.current = onClose;
	onCloseRequestRef.current = onCloseRequest;

	const [closing, setClosing] = useState(false);
	const [sheetDragging, setSheetDragging] = useState(false);
	const [windowInteracting, setWindowInteracting] = useState(false);
	const [windowInteracted, setWindowInteracted] = useState(false);
	const [dragY, setDragY] = useState(0);
	const [viewport, setViewport] = useState<SheetViewport>(() => viewportSize());
	const [wide, setWide] = useState(() => isWideViewport());
	const [popoverFailed, setPopoverFailed] = useState(false);
	const [windowState, setWindowState] = useState<SheetWindowState>(() => initialWindowState(windowKind));
	const windowStateRef = useRef(windowState);
	windowStateRef.current = windowState;

	const canWindow = windowKind !== undefined && wide && supportsTopLayer() && !popoverFailed;
	const mode = canWindow ? windowState.mode : "in-pane";
	const windowed = mode === "float" || mode === "maximized";
	const panelGeometry = mode === "maximized" ? maximizeSheetGeometry(viewport) : windowState.geometry;

	const storeWindowState = (next: SheetWindowState): void => {
		windowStateRef.current = next;
		setWindowState(next);
		if (windowKind !== undefined) writeSheetWindowState(windowKind, next);
	};

	const chooseMode = (requested: SheetWindowMode): void => {
		if (!canWindow) return;
		let nextMode = requested;
		if (requested === "maximized") {
			if (mode === "maximized") nextMode = toggleMaximizeMode(mode, restoreModeRef.current);
			else restoreModeRef.current = mode;
		}
		if (nextMode !== "maximized") restoreModeRef.current = nextMode;
		storeWindowState({ ...windowStateRef.current, mode: nextMode });
	};

	const beginClose = useCallback((): void => {
		if (closingRef.current) return;
		if (onCloseRequestRef.current?.() === false) return;
		closingRef.current = true;
		setClosing(true);
		if (motionLevel() === "off") {
			onCloseRef.current();
			return;
		}
		closeTimer.current = window.setTimeout(() => onCloseRef.current(), SHEET_EXIT_MS);
	}, []);

	useEffect(() => {
		if (windowKind === undefined) return;
		const onResize = (): void => {
			const nextViewport = viewportSize();
			setViewport(nextViewport);
			setWide(isWideViewport());
			if (nextViewport.width < 760) return;
			const current = windowStateRef.current;
			const fits =
				current.geometry.width <= nextViewport.width - 32 &&
				current.geometry.height <= nextViewport.height - 32;
			const geometry = fits
				? clampSheetGeometry(current.geometry, nextViewport)
				: defaultSheetGeometry(nextViewport);
			if (sameGeometry(geometry, current.geometry)) return;
			storeWindowState({ ...current, geometry });
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [windowKind]);

	useEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		if (!windowed) {
			try {
				if (root.matches(":popover-open")) root.hidePopover();
			} catch {
				// Older engines have no Popover API; the sheet remains in-pane.
			}
			return;
		}
		try {
			root.showPopover();
		} catch {
			setPopoverFailed(true);
			storeWindowState({ ...windowStateRef.current, mode: "in-pane" });
		}
	}, [windowed]);

	useEffect(() => {
		if (!onWindowRootChange) return;
		onWindowRootChange(windowed ? rootRef.current : null);
		return () => onWindowRootChange(null);
	}, [onWindowRootChange, windowed]);

	useEffect(() => {
		if (!windowed) {
			windowOffsetApplied.current = false;
			return;
		}
		if (mode !== "float" || windowKind === undefined || windowOffsetApplied.current) return;
		const root = rootRef.current;
		if (root === null) return;
		const overlappingWindows = Array.from(document.querySelectorAll<HTMLDivElement>(".dk-sheet-root[data-window-kind]")).filter(
			candidate => candidate !== root && candidate.dataset.windowKind === windowKind && candidate.matches(":popover-open"),
		).length;
		if (overlappingWindows === 0) return;
		windowOffsetApplied.current = true;
		const current = windowStateRef.current;
		const offset = overlappingWindows * SHEET_WINDOW_MARGIN;
		const geometry = [
			moveSheetGeometry(current.geometry, offset, offset, viewport),
			moveSheetGeometry(current.geometry, -offset, -offset, viewport),
			moveSheetGeometry(current.geometry, offset, -offset, viewport),
			moveSheetGeometry(current.geometry, -offset, offset, viewport),
		].find(candidate => !sameGeometry(candidate, current.geometry));
		if (geometry) storeWindowState({ ...current, geometry });
	}, [mode, viewport, windowKind, windowed]);
	const bringWindowToFront = (): void => {
		if (!windowed) return;
		const root = rootRef.current;
		if (root === null) return;
		try {
			if (!root.matches(":popover-open")) return;
			root.hidePopover();
			root.showPopover();
		} catch {
			// Preserve the current layer order if this engine cannot reorder an open popover.
		}
	};

	useEffect(() => {
		const dialog = dialogRef.current;
		if (dialog === null) return;
		const active = document.activeElement;
		returnFocusRef.current = active instanceof HTMLElement ? active : null;
		dialog.focus({ preventScroll: true });
		return () => {
			const returnFocus = returnFocusRef.current;
			if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
		};
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented || !escapeEnabled) return;
			const dialog = dialogRef.current;
			const active = document.activeElement;
			const focusedInside = dialog !== null && active !== null && dialog.contains(active);
			const focusedSheet = active instanceof Element ? active.closest(".dk-sheet") : null;
			const nothingElseFocused = active === document.body || active === document.documentElement;
			if (!windowed && focusedSheet !== null && focusedSheet !== dialog) return;
			if (windowed && !focusedInside && !nothingElseFocused) return;
			event.preventDefault();
			beginClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [beginClose, escapeEnabled, windowed]);

	useEffect(() => {
		if (closeRequested) beginClose();
	}, [beginClose, closeRequested]);

	useEffect(
		() => () => {
			if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
			if (windowFinishFrame.current !== undefined) window.cancelAnimationFrame(windowFinishFrame.current);
		},
		[],
	);

	const startWindowGesture = (event: ReactPointerEvent<HTMLElement>, kind: "move" | "resize", edge: string): void => {
		if (event.button !== 0 || closingRef.current || mode !== "float") return;
		if (kind === "move" && event.target instanceof Element && event.target.closest("button")) return;
		const section = dialogRef.current;
		if (section === null) return;
		if (kind === "resize") event.preventDefault();
		const geometry = windowStateRef.current.geometry;
		windowGestureRef.current = {
			pointerId: event.pointerId,
			kind,
			edge,
			startX: event.clientX,
			startY: event.clientY,
			geometry,
			current: geometry,
			section,
		};
		const captureTarget = kind === "move" ? event.currentTarget : section;
		try {
			captureTarget.setPointerCapture(event.pointerId);
		} catch {
			windowGestureRef.current = null;
			return;
		}
		if (windowFinishFrame.current !== undefined) {
			window.cancelAnimationFrame(windowFinishFrame.current);
			windowFinishFrame.current = undefined;
		}
		setWindowInteracted(true);
		setWindowInteracting(true);
	};

	const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
		if (event.button !== 0 || closingRef.current) return;
		if (canWindow && mode === "float") {
			startWindowGesture(event, "move", "");
			return;
		}
		if (wide || event.pointerType === "mouse" || windowed) return;
		if (event.target instanceof Element && event.target.closest("button")) return;
		const section = dialogRef.current;
		if (section === null) return;
		sheetDragRef.current = {
			pointerId: event.pointerId,
			startY: event.clientY,
			lastY: event.clientY,
			lastAt: event.timeStamp,
			velocity: 0,
			height: section.getBoundingClientRect().height,
		};
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			sheetDragRef.current = null;
			return;
		}
		setSheetDragging(true);
	};

	const onHeaderDoubleClick = (event: React.MouseEvent<HTMLElement>): void => {
		if (!canWindow || (event.target instanceof Element && event.target.closest("button"))) return;
		event.preventDefault();
		if (mode !== "maximized") restoreModeRef.current = mode;
		chooseMode(toggleMaximizeMode(mode, restoreModeRef.current));
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
		const gesture = windowGestureRef.current;
		if (gesture !== null && gesture.pointerId === event.pointerId) {
			const dx = event.clientX - gesture.startX;
			const dy = event.clientY - gesture.startY;
			const next =
				gesture.kind === "move"
					? moveSheetGeometry(gesture.geometry, dx, dy, viewport)
					: resizeSheetGeometry(gesture.geometry, gesture.edge, dx, dy, viewport);
			gesture.current = next;
			if (gesture.kind === "move") {
				gesture.section.style.setProperty("--sheet-window-drag-x", `${next.x - gesture.geometry.x}px`);
				gesture.section.style.setProperty("--sheet-window-drag-y", `${next.y - gesture.geometry.y}px`);
			} else {
				gesture.section.style.setProperty("--sheet-window-live-x", `${next.x}px`);
				gesture.section.style.setProperty("--sheet-window-live-y", `${next.y}px`);
				gesture.section.style.setProperty("--sheet-window-live-width", `${next.width}px`);
				gesture.section.style.setProperty("--sheet-window-live-height", `${next.height}px`);
			}
			return;
		}
		const drag = sheetDragRef.current;
		if (drag === null || drag.pointerId !== event.pointerId) return;
		const elapsed = Math.max(1, event.timeStamp - drag.lastAt);
		drag.velocity = (event.clientY - drag.lastY) / elapsed;
		drag.lastY = event.clientY;
		drag.lastAt = event.timeStamp;
		setDragY(Math.max(0, event.clientY - drag.startY));
	};

	const finishPointer = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
		const gesture = windowGestureRef.current;
		if (gesture !== null && gesture.pointerId === event.pointerId) {
			windowGestureRef.current = null;
			const { section, current } = gesture;
			section.style.setProperty("--sheet-window-x", `${current.x}px`);
			section.style.setProperty("--sheet-window-y", `${current.y}px`);
			section.style.setProperty("--sheet-window-width", `${current.width}px`);
			section.style.setProperty("--sheet-window-height", `${current.height}px`);
			section.style.removeProperty("--sheet-window-drag-x");
			section.style.removeProperty("--sheet-window-drag-y");
			section.style.removeProperty("--sheet-window-live-x");
			section.style.removeProperty("--sheet-window-live-y");
			section.style.removeProperty("--sheet-window-live-width");
			section.style.removeProperty("--sheet-window-live-height");
			section.style.setProperty("transition", "none");
			setWindowInteracting(false);
			storeWindowState({ ...windowStateRef.current, geometry: current });
			if (windowFinishFrame.current !== undefined) window.cancelAnimationFrame(windowFinishFrame.current);
			windowFinishFrame.current = window.requestAnimationFrame(() => {
				section.style.removeProperty("transition");
				windowFinishFrame.current = undefined;
			});
			return;
		}
		const drag = sheetDragRef.current;
		if (drag === null || drag.pointerId !== event.pointerId) return;
		sheetDragRef.current = null;
		setSheetDragging(false);
		const distance = Math.max(0, event.clientY - drag.startY);
		const velocity = event.timeStamp - drag.lastAt <= 80 ? drag.velocity : 0;
		if (!cancelled && shouldDismissSheetDrag(distance, Math.max(0, velocity), drag.height)) {
			beginClose();
			return;
		}
		setDragY(0);
	};

	const classes = ["dk-sheet-root", rootClassName].filter(Boolean).join(" ");
	const sectionClasses = ["dk-sheet", sectionClassName].filter(Boolean).join(" ");
	const style = {
		"--sheet-drag-y": `${dragY}px`,
		"--sheet-window-x": `${panelGeometry.x}px`,
		"--sheet-window-y": `${panelGeometry.y}px`,
		"--sheet-window-width": `${panelGeometry.width}px`,
		"--sheet-window-height": `${panelGeometry.height}px`,
	} as CSSProperties;

	return (
		<div
			ref={rootRef}
			className={classes}
			data-exiting={closing ? "true" : undefined}
			data-windowed={windowed ? "true" : undefined}
			data-window-kind={windowKind}
			popover={windowed ? "manual" : undefined}
		>
			{!windowed && <div className="dk-sheet-backdrop" onClick={beginClose} />}
			<section
				ref={dialogRef}
				tabIndex={-1}
				className={sectionClasses}
				data-size={size}
				data-display-mode={mode}
				data-exiting={closing ? "true" : undefined}
				data-dragging={sheetDragging || (windowInteracting && windowGestureRef.current?.kind === "move") ? "true" : undefined}
				data-resizing={windowInteracting && windowGestureRef.current?.kind === "resize" ? "true" : undefined}
				data-window-interacted={windowInteracted ? "true" : undefined}
				data-motion={motionLevel()}
				style={style}
				role="dialog"
				aria-modal={!windowed && !closing}
				aria-hidden={closing}
				onPointerDownCapture={bringWindowToFront}
				onPointerMove={onPointerMove}
				onPointerUp={event => finishPointer(event, false)}
				onPointerCancel={event => finishPointer(event, true)}
				onLostPointerCapture={event => finishPointer(event, true)}
			>
				<header
					className="dk-sheet-head"
					onPointerDown={onHeaderPointerDown}
					onLostPointerCapture={event => finishPointer(event, true)}
					onDoubleClick={onHeaderDoubleClick}
				>
					<h2 className="dk-sheet-title">{title}</h2>
					<div className="dk-sheet-head-actions">
						{canWindow && (
							<div className="dk-sheet-window-controls" aria-label={`${title} window size`}>
								<button
									type="button"
									className="dk-tap dk-sheet-window-control"
									title="In pane"
									aria-label="Show in pane"
									aria-pressed={mode === "in-pane"}
									onClick={() => chooseMode("in-pane")}
								>
									<PanelLeft size={15} aria-hidden />
								</button>
								<button
									type="button"
									className="dk-tap dk-sheet-window-control"
									title="Float"
									aria-label="Float panel"
									aria-pressed={mode === "float"}
									onClick={() => chooseMode("float")}
								>
									<PictureInPicture2 size={15} aria-hidden />
								</button>
								<button
									type="button"
									className="dk-tap dk-sheet-window-control"
									title="Maximize"
									aria-label="Maximize panel"
									aria-pressed={mode === "maximized"}
									onClick={() => chooseMode("maximized")}
								>
									<Maximize2 size={15} aria-hidden />
								</button>
							</div>
						)}
						<button
							type="button"
							className="dk-tap dk-sheet-close"
							onClick={beginClose}
							aria-label={`close ${title}`}
							title={`Close ${title}`}
						>
							<X size={18} />
						</button>
					</div>
				</header>
				{headerAddon}
				<SheetWindowRootContext.Provider value={windowed ? rootRef.current : null}>
					{wrapBody ? <div className={bodyClassName ?? "dk-sheet-body"}>{children}</div> : children}
				</SheetWindowRootContext.Provider>
				{windowed && mode === "float" && (
					<div className="dk-sheet-resize-controls">
						{RESIZE_EDGES.map(edge => (
							<button
								key={edge}
								type="button"
								className="dk-sheet-resize-handle"
								data-edge={edge}
								aria-label={`Resize panel from ${edge} edge`}
								title={`Resize from ${edge}`}
								onPointerDown={event => startWindowGesture(event, "resize", edge)}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
