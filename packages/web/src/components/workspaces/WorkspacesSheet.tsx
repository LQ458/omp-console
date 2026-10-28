import { FolderGit2, History, Search, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { recordUsage } from "../../lib/journal";
import { ActionsPanel } from "../safety/ActionsPanel";
import { MoveHistory } from "../safety/MoveHistory";
import { Sheet } from "../shell/Sheet";
import { OPEN_WORKSPACES_EVENT, openQuickAsk, parseOpenWorkspacesEvent, type WorkspacesTab } from "./events";
import { useWorkspaceLook } from "./WorkspaceProvider";
import { WorkspacesPanel } from "./WorkspacesPanel";

const TABS: ReadonlyArray<{ id: WorkspacesTab; label: string; Icon: typeof FolderGit2 }> = [
	{ id: "workspaces", label: "Workspaces", Icon: FolderGit2 },
	{ id: "actions", label: "Actions", Icon: ShieldCheck },
	{ id: "moves", label: "Move project", Icon: History },
];

export interface WorkspacesSheetProps {
	api: DeckApi;
	currentSessionId?: string;
	currentCwd?: string;
	initialTab?: WorkspacesTab;
	initialWorkspaceId?: string;
	onOpenSession(sessionId: string): void;
	onClose(): void;
}

/** Workspaces, "Actions in your name" (gate audit) and move history in one sheet. */
export function WorkspacesSheet({
	api,
	currentSessionId,
	currentCwd,
	initialTab = "workspaces",
	initialWorkspaceId,
	onOpenSession,
	onClose,
}: WorkspacesSheetProps): ReactNode {
	const [tab, setTab] = useState<WorkspacesTab>(initialTab);
	const current = useWorkspaceLook(currentCwd);

	const open = useCallback(
		(sessionId: string): void => {
			onClose();
			onOpenSession(sessionId);
		},
		[onClose, onOpenSession],
	);

	return (
		<Sheet title="Workspaces" onClose={onClose}>
			<div className="ws-sheet-top">
				<div className="dk-segment" role="tablist" aria-label="workspaces sections">
					{TABS.map(({ id, label, Icon }) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={tab === id}
							className="dk-segment-btn"
							data-on={tab === id ? "true" : "false"}
							onClick={() => setTab(id)}
						>
							<Icon size={15} />
							{label}
						</button>
					))}
				</div>
				<button
					type="button"
					className="sh-btn ws-ask-btn"
					onClick={() => {
						onClose();
						openQuickAsk();
					}}
				>
					<Search size={13} /> Ask your notes <kbd className="ws-kbd">⌘J</kbd>
				</button>
			</div>
			{tab === "workspaces" && (
				<WorkspacesPanel
					api={api}
					currentSessionId={currentSessionId}
					currentWorkspaceId={current?.workspace.id}
					initialWorkspaceId={initialWorkspaceId ?? current?.workspace.id}
					onOpenSession={open}
				/>
			)}
			{tab === "actions" && <ActionsPanel api={api} sessionId={currentSessionId} />}
			{tab === "moves" && <MoveHistory api={api} />}
		</Sheet>
	);
}

export interface WorkspacesHostProps {
	api: DeckApi;
	currentSessionId?: string;
	currentCwd?: string;
	onOpenSession(sessionId: string): void;
}

/** Opens the sheet on `omp-console:open-workspaces` (sidebar button, header chip). */
export function WorkspacesHost({ api, currentSessionId, currentCwd, onOpenSession }: WorkspacesHostProps): ReactNode {
	const [request, setRequest] = useState<{ tab: WorkspacesTab; workspaceId?: string } | null>(null);
	useEffect(() => {
		const handler = (event: Event): void => {
			const detail = parseOpenWorkspacesEvent(event);
			if (detail === null) return;
			recordUsage({ feature: "6.workspaces", action: "open", outcome: "ok", via: "direct", detail: detail.tab });
			setRequest({ tab: detail.tab, workspaceId: detail.workspaceId });
		};
		window.addEventListener(OPEN_WORKSPACES_EVENT, handler);
		return () => window.removeEventListener(OPEN_WORKSPACES_EVENT, handler);
	}, []);
	const close = useCallback(() => setRequest(null), []);
	if (request === null) return null;
	return (
		<WorkspacesSheet
			api={api}
			currentSessionId={currentSessionId}
			currentCwd={currentCwd}
			initialTab={request.tab}
			initialWorkspaceId={request.workspaceId}
			onOpenSession={onOpenSession}
			onClose={close}
		/>
	);
}
