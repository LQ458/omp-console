/**
 * One pane's content: the app's session view for a connected session, the home screen for an empty pane, or the
 * connection state (opening, failed) in between. A pane that is not visible (zoomed away, off the phone's page)
 * renders a one-line stub instead, so its transcript DOM is released while its connection stays up.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneId } from "../../lib/pane-layout";
import { BACKGROUND_PANE_MS } from "./throttled-source";
import { usePaneContext, usePaneState, usePoolSnapshot } from "./context";

/** Panes narrower than these get the compact header (see panes.css); the window-level layout mode is unchanged. */
const NARROW_PX = 900;
const TINY_PX = 560;

type Width = "wide" | "narrow" | "tiny";

function widthClass(px: number): Width {
	if (px < TINY_PX) return "tiny";
	return px < NARROW_PX ? "narrow" : "wide";
}

function useWidthClass(): [(el: HTMLElement | null) => void, Width] {
	const [width, setWidth] = useState<Width>("wide");
	const observer = useRef<ResizeObserver | null>(null);
	const ref = useCallback((el: HTMLElement | null) => {
		observer.current?.disconnect();
		observer.current = null;
		if (!el) return;
		setWidth(widthClass(el.clientWidth));
		const next = new ResizeObserver(entries => {
			const entry = entries[entries.length - 1];
			if (entry) setWidth(widthClass(entry.contentRect.width));
		});
		next.observe(el);
		observer.current = next;
	}, []);
	useEffect(() => () => observer.current?.disconnect(), []);
	return [ref, width];
}

export interface PaneFrameProps {
	paneId: PaneId;
	/** False while Dockview hides the pane (zoom) or the phone page is another pane. */
	visible: boolean;
}

export function PaneFrame({ paneId, visible }: PaneFrameProps): ReactNode {
	const { model, pool, renderSession, renderEmpty, titleOf } = usePaneContext();
	const state = usePaneState(model);
	const poolSnap = usePoolSnapshot(pool);
	const [ref, width] = useWidthClass();
	const pane = state.panes.find(candidate => candidate.id === paneId);
	if (pane === undefined) return null;

	const focused = state.focusedId === paneId;
	const multi = state.panes.length > 1;
	const key = pane.sessionId;
	const client = key === null ? undefined : poolSnap.clients.get(key);
	const error = key === null ? undefined : poolSnap.errors.get(key);

	let content: ReactNode;
	if (!visible) {
		content = <div className="pn-stub">{key === null ? "empty pane" : titleOf(key)}</div>;
	} else if (key === null) {
		content = renderEmpty(paneId);
	} else if (client !== undefined) {
		content = renderSession({
			paneId,
			sessionKey: key,
			client,
			focused,
			multi,
			throttleMs: focused ? 0 : BACKGROUND_PANE_MS,
			onClose: () => model.close(paneId),
			onRejoin: () => pool.rejoin(key),
		});
	} else if (error !== undefined) {
		content = (
			<div className="pn-note" role="alert">
				<p className="pn-note-title">Could not open {titleOf(key)}</p>
				<p className="pn-note-body">{error}</p>
				<div className="pn-note-actions">
					<button type="button" className="sh-btn sh-btn-primary" onClick={() => pool.rejoin(key)}>
						Retry
					</button>
					<button type="button" className="sh-btn" onClick={() => model.close(paneId)}>
						Close pane
					</button>
				</div>
			</div>
		);
	} else {
		content = (
			<div className="pn-note" role="status">
				<span className="sh-banner-dot" />
				<p className="pn-note-body">Opening {titleOf(key)}…</p>
			</div>
		);
	}

	return (
		<div
			ref={ref}
			className="pn-frame"
			data-pane={paneId}
			data-focused={focused ? "true" : "false"}
			data-multi={multi ? "true" : "false"}
			data-width={width}
			onPointerDownCapture={() => model.focus(paneId)}
			onFocusCapture={() => model.focus(paneId)}
		>
			<div className="pn-content" key={`${paneId}:${key ?? "empty"}:${visible ? "visible" : "stub"}`}>
				{content}
			</div>
		</div>
	);
}
