import type { Workspace } from "@omp-console/protocol";
import { ArrowRightLeft, BookOpen, FolderGit2, FolderPlus, ListChecks, Plus, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { DeckApi } from "../../lib/api";
import { shortenPath } from "../../lib/format";
import { recordUsage } from "../../lib/journal";
import { useSystemTheme } from "../../lib/theme";
import { PALETTE_HUES, workspaceColor } from "../../lib/workspace-color";
import { gitSummary, groupWorkspaces, ruleCounts } from "../../lib/workspaces";
import { OmpEquivalent } from "../catalog/OmpEquivalent";
import { RulesEditor } from "./RulesEditor";
import { colorStyle } from "./WorkspaceChip";
import { useWorkspaces } from "./WorkspaceProvider";

export type WorkspacesApi = Pick<
	DeckApi,
	"startWorkspaceSession" | "readRuleFile" | "writeRuleFile" | "setWorkspaceColor"
>;

export interface WorkspacesPanelProps {
	api: WorkspacesApi;
	/** Session the user is looking at; enables "Start from current session" (handoff). */
	currentSessionId?: string;
	/** Workspace of that session, to avoid offering a handoff into itself. */
	currentWorkspaceId?: string;
	/** Row to expand first (from the header chip). */
	initialWorkspaceId?: string;
	onOpenSession(sessionId: string): void;
}

const KIND_ICON = { knowledge: BookOpen, project: FolderGit2, scratch: FolderPlus } as const;

export function WorkspacesPanel({
	api,
	currentSessionId,
	currentWorkspaceId,
	initialWorkspaceId,
	onOpenSession,
}: WorkspacesPanelProps): ReactNode {
	const { workspaces, loaded, error, colorOf, refresh } = useWorkspaces();
	const theme = useSystemTheme();
	const [selectedId, setSelectedId] = useState<string | null>(initialWorkspaceId ?? null);
	const [rulesFor, setRulesFor] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const rulesWorkspace = rulesFor === null ? undefined : workspaces.find(w => w.id === rulesFor);
	if (rulesWorkspace) {
		return <RulesEditor api={api} workspace={rulesWorkspace} onBack={() => setRulesFor(null)} onSaved={() => void refresh()} />;
	}

	const start = async (workspace: Workspace, handoff: boolean): Promise<void> => {
		setBusy(`${workspace.id}:${handoff ? "handoff" : "new"}`);
		setActionError(null);
		try {
			const summary = await api.startWorkspaceSession(
				workspace.id,
				handoff && currentSessionId !== undefined ? { handoffFromSessionId: currentSessionId } : {},
			);
			recordUsage({
				feature: "6.workspaces",
				action: handoff ? "start-handoff" : "start",
				outcome: "ok",
				via: "direct",
				screen: "workspaces",
				detail: workspace.kind,
			});
			void refresh();
			onOpenSession(summary.id);
		} catch (err) {
			recordUsage({ feature: "6.workspaces", action: handoff ? "start-handoff" : "start", outcome: "error", via: "direct", screen: "workspaces", detail: workspace.kind });
			setActionError(err instanceof Error ? err.message : "could not start the session");
		} finally {
			setBusy(null);
		}
	};

	const setHue = async (workspace: Workspace, hue: number | null): Promise<void> => {
		setActionError(null);
		try {
			await api.setWorkspaceColor(workspace.id, hue);
			recordUsage({ feature: "7.look", action: hue === null ? "colour-auto" : "colour-override", outcome: "ok", via: "direct", screen: "workspaces" });
			await refresh();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : "could not save the colour");
		}
	};

	if (!loaded) {
		return (
			<div className="ws-empty" role="status">
				{error ? `Workspaces unavailable: ${error}` : "Loading workspaces…"}
			</div>
		);
	}

	const groups = groupWorkspaces(workspaces);
	return (
		<div className="ws-panel">
			{actionError && (
				<div className="dk-notice dk-notice-err ws-notice" role="alert">
					<span>{actionError}</span>
				</div>
			)}
			{groups.length === 0 && <div className="ws-empty">Set up a Notes folder or Project folders under Settings → Advanced → Optional features.</div>}
			{groups.map(group => (
				<section key={group.kind} className="ws-group" aria-label={group.label}>
					<h3 className="dk-section-title">
						{group.label}
						<span className="dk-section-meta">{group.workspaces.length}</span>
					</h3>
					<ul className="ws-list">
						{group.workspaces.map(workspace => {
							const color = colorOf(workspace.id);
							const Icon = KIND_ICON[workspace.kind];
							const open = selectedId === workspace.id;
							const counts = ruleCounts(workspace.rules);
							return (
								<li key={workspace.id} className="ws-item" data-open={open ? "true" : "false"} style={color ? colorStyle(color) : undefined}>
									<button
										type="button"
										className="ws-item-head"
										aria-expanded={open}
										onClick={() => setSelectedId(open ? null : workspace.id)}
									>
										<span className="ws-swatch" aria-hidden="true">
											<Icon size={13} />
										</span>
										<span className="ws-item-main">
											<span className="ws-item-name">{workspace.name}</span>
											<span className="ws-item-sub" title={workspace.root}>
												{shortenPath(workspace.root)}
											</span>
											<span className="ws-item-git">{gitSummary(workspace.git)}</span>
										</span>
										<span className="ws-item-live" title="live sessions" data-live={workspace.liveSessions > 0 ? "true" : "false"}>
											{workspace.liveSessions} live
										</span>
									</button>
									{open && (
										<div className="ws-item-body">
											<div className="ws-row-actions">
												<button
													type="button"
													className="sh-btn sh-btn-primary"
													disabled={busy !== null}
													onClick={() => void start(workspace, false)}
												>
													<Plus size={13} /> New session here
												</button>
												{currentSessionId !== undefined && currentWorkspaceId !== workspace.id && (
													<button
														type="button"
														className="sh-btn"
														disabled={busy !== null}
														onClick={() => void start(workspace, true)}
														title="Open a new session with a summary of this one as the first message"
													>
														<ArrowRightLeft size={13} /> Continue in a new session
													</button>
												)}
												<button type="button" className="sh-btn" onClick={() => setRulesFor(workspace.id)}>
													<ListChecks size={13} /> Rules
													<span className="ws-muted">
														{counts.private}p · {counts.shared}s
													</span>
												</button>
											</div>
											<div className="ws-colour" role="group" aria-label={`colour for ${workspace.name}`}>
												<span className="ws-colour-label">Colour</span>
												<button
													type="button"
													className="ws-hue ws-hue-auto"
													data-on={workspace.hueOverride === undefined ? "true" : "false"}
													onClick={() => void setHue(workspace, null)}
													title="automatic"
													aria-label="automatic colour"
												>
													<RotateCcw size={10} />
												</button>
												{PALETTE_HUES.map(hue => {
													const swatch = workspaceColor({ id: workspace.id, kind: workspace.kind, name: workspace.name, hueOverride: hue }, theme, []);
													return (
														<button
															key={hue}
															type="button"
															className="ws-hue"
															data-on={workspace.hueOverride === hue ? "true" : "false"}
															style={{ background: swatch.accent }}
															onClick={() => void setHue(workspace, hue)}
															title={`hue ${hue}`}
															aria-label={`hue ${hue}`}
														/>
													);
												})}
											</div>
											<OmpEquivalent text={`omp --cwd ${shortenPath(workspace.root)}`} actionId="workspace.open" />
											{currentSessionId !== undefined && currentWorkspaceId !== workspace.id && (
												<OmpEquivalent text="/handoff" actionId="context.handoff" />
											)}
										</div>
									)}
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</div>
	);
}
