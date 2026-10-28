/** What the pane host needs from the app, and the React bindings for the pane model and the guest pool. */
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { GuestClient } from "../../lib/client";
import type { GuestPool, PoolSnapshot } from "../../lib/guest-pool";
import type { PaneId, PaneModel, PaneState } from "../../lib/pane-layout";

/** Everything the app's session view needs for one pane. */
export interface PaneSessionArgs {
	paneId: PaneId;
	/** Pool key: a daemon session id or a `link:` key. */
	sessionKey: string;
	client: GuestClient;
	/** This pane has keyboard focus. Only it sets the window title; the others render at a reduced rate. */
	focused: boolean;
	/** More than one pane is on screen: show the focus border. */
	multi: boolean;
	/** 0 for the focused pane; background panes batch updates (see `throttled-source.ts`). */
	throttleMs: number;
	/** Closes this pane (the sole pane returns to the home screen). */
	onClose(): void;
	/** Reconnects this pane's session after it ended. */
	onRejoin(): void;
}

export interface PaneContextValue {
	model: PaneModel;
	pool: GuestPool<GuestClient>;
	renderSession(args: PaneSessionArgs): ReactNode;
	/** The home screen shown in a pane with no session. */
	renderEmpty(paneId: PaneId): ReactNode;
	/** Short label for a pool key: session title, else its folder. */
	titleOf(sessionKey: string): string;
}

export const PaneContext = createContext<PaneContextValue | null>(null);

export function usePaneContext(): PaneContextValue {
	const value = useContext(PaneContext);
	if (value === null) throw new Error("pane components must render inside <PaneHost>");
	return value;
}

export function usePaneState(model: PaneModel): PaneState {
	const subscribe = useCallback((listener: () => void) => model.subscribe(listener), [model]);
	const getSnapshot = useCallback(() => model.getSnapshot(), [model]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePoolSnapshot(pool: GuestPool<GuestClient>): PoolSnapshot<GuestClient> {
	const subscribe = useCallback((listener: () => void) => pool.subscribe(listener), [pool]);
	const getSnapshot = useCallback(() => pool.getSnapshot(), [pool]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
