import type { ListWorkspacesResponse, Workspace } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSystemTheme } from "../../lib/theme";
import { assignWorkspaceColors, type WorkspaceColor } from "../../lib/workspace-color";
import { workspaceOf } from "../../lib/workspaces";
import "./workspaces.css";

export const WORKSPACE_POLL_MS = 20_000;

export interface WorkspaceLook {
	workspace: Workspace;
	color: WorkspaceColor;
}

export interface WorkspaceContextValue {
	workspaces: readonly Workspace[];
	/** True once the daemon answered at least once (an older daemon without the route stays false). */
	loaded: boolean;
	error: string | null;
	lookFor(cwd: string | undefined): WorkspaceLook | null;
	colorOf(workspaceId: string): WorkspaceColor | undefined;
	refresh(): Promise<void>;
}

const EMPTY: WorkspaceContextValue = {
	workspaces: [],
	loaded: false,
	error: null,
	lookFor: () => null,
	colorOf: () => undefined,
	refresh: async () => {},
};

const WorkspaceContext = createContext<WorkspaceContextValue>(EMPTY);

export interface WorkspaceApi {
	listWorkspaces(signal?: AbortSignal): Promise<ListWorkspacesResponse>;
}

/** Builds the context value for a fixed list; used by the provider and by tests and screenshots. */
export function buildWorkspaceContext(
	workspaces: readonly Workspace[],
	theme: "light" | "dark",
	state: { loaded: boolean; error: string | null; refresh(): Promise<void> },
): WorkspaceContextValue {
	const colors = assignWorkspaceColors(workspaces, theme);
	return {
		workspaces,
		loaded: state.loaded,
		error: state.error,
		refresh: state.refresh,
		colorOf: id => colors.get(id),
		lookFor(cwd) {
			if (cwd === undefined) return null;
			const workspace = workspaceOf(workspaces, cwd);
			const color = workspace === undefined ? undefined : colors.get(workspace.id);
			return workspace === undefined || color === undefined ? null : { workspace, color };
		},
	};
}

export interface WorkspaceProviderProps {
	api: WorkspaceApi;
	children: ReactNode;
}

/** Polls `GET /api/workspaces` (20 s, only while the page is visible) and exposes workspaces with their theme colours. */
export function WorkspaceProvider({ api, children }: WorkspaceProviderProps): ReactNode {
	const theme = useSystemTheme();
	const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const refresh = useCallback(async (): Promise<void> => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		try {
			const response = await api.listWorkspaces(controller.signal);
			if (controller.signal.aborted) return;
			setWorkspaces(response.workspaces);
			setLoaded(true);
			setError(null);
		} catch (err) {
			if (controller.signal.aborted) return;
			setError(err instanceof Error ? err.message : "could not load workspaces");
		}
	}, [api]);

	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => {
			if (document.visibilityState !== "hidden") void refresh();
		}, WORKSPACE_POLL_MS);
		return () => {
			window.clearInterval(timer);
			abortRef.current?.abort();
		};
	}, [refresh]);

	const value = useMemo(
		() => buildWorkspaceContext(workspaces, theme, { loaded, error, refresh }),
		[workspaces, theme, loaded, error, refresh],
	);
	return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export { WorkspaceContext };

export function useWorkspaces(): WorkspaceContextValue {
	return useContext(WorkspaceContext);
}

/** The workspace (and its colour) a working directory belongs to; null before the list loads or outside every root. */
export function useWorkspaceLook(cwd: string | undefined): WorkspaceLook | null {
	const { lookFor } = useContext(WorkspaceContext);
	return useMemo(() => lookFor(cwd), [lookFor, cwd]);
}
