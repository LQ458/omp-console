/** Window events that connect the workspace and quick-ask panels to buttons elsewhere (sidebar, header chip, shortcuts). */

export const OPEN_WORKSPACES_EVENT = "omp-console:open-workspaces";
export const OPEN_QUICK_ASK_EVENT = "omp-console:open-quick-ask";

export type WorkspacesTab = "workspaces" | "actions" | "moves";

export interface OpenWorkspacesDetail {
	tab: WorkspacesTab;
	/** Workspace row to expand. */
	workspaceId?: string;
}

export function openWorkspaces(detail: Partial<OpenWorkspacesDetail> = {}, target: EventTarget = window): void {
	target.dispatchEvent(
		new CustomEvent<OpenWorkspacesDetail>(OPEN_WORKSPACES_EVENT, { detail: { tab: detail.tab ?? "workspaces", workspaceId: detail.workspaceId } }),
	);
}

/** Null for a malformed detail. */
export function parseOpenWorkspacesEvent(event: Event): OpenWorkspacesDetail | null {
	const detail: unknown = event instanceof CustomEvent ? event.detail : null;
	if (typeof detail !== "object" || detail === null) return null;
	const raw = detail as Record<string, unknown>;
	const tab = raw.tab === "actions" || raw.tab === "moves" || raw.tab === "workspaces" ? raw.tab : "workspaces";
	return { tab, workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : undefined };
}

export function openQuickAsk(target: EventTarget = window): void {
	target.dispatchEvent(new CustomEvent(OPEN_QUICK_ASK_EVENT));
}
