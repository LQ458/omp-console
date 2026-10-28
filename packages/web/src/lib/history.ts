import type { HistoryEdge, HistoryNode, Workspace } from "@omp-console/protocol";

export interface HistoryLane {
	id: string;
	label: string;
	hue?: number;
}

export interface HistoryLayoutNode {
	node: HistoryNode;
	lane: HistoryLane;
	x: number;
	y: number;
}

export interface HistoryLayout {
	lanes: HistoryLane[];
	nodes: HistoryLayoutNode[];
	edges: HistoryEdge[];
	width: number;
	height: number;
}

export function historyWorkspaceKey(node: Pick<HistoryNode, "workspaceId">): string {
	return node.workspaceId ?? "unassigned";
}

export function historyWorkspaceLabel(id: string, workspaces: readonly Workspace[] = []): string {
	if (id === "unassigned") return "Unassigned";
	return workspaces.find(workspace => workspace.id === id)?.name ?? id.replace(/^project:/, "");
}

export function historyWorkspaceHue(id: string, workspaces: readonly Workspace[] = []): number | undefined {
	return workspaces.find(workspace => workspace.id === id)?.hueOverride;
}

export function rankHistoryNodes(nodes: readonly HistoryNode[], query: string): HistoryNode[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return nodes.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId));
	return nodes
		.map(node => ({ node, score: historySearchScore(node, needle) }))
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || b.node.lastActivityAt - a.node.lastActivityAt || a.node.sessionId.localeCompare(b.node.sessionId))
		.map(item => item.node);
}

export function historySearchScore(node: HistoryNode, query: string): number {
	const needle = query.trim().toLowerCase();
	if (needle === "") return 1;
	const title = node.title.toLowerCase();
	let score = 0;
	if (title.startsWith(needle)) score = Math.max(score, 300);
	else if (title.includes(needle)) score = Math.max(score, 240);
	const points = node.keyPoints;
	if (points?.goal?.toLowerCase().includes(needle)) score = Math.max(score, 150);
	if (points?.decisions.some(value => value.toLowerCase().includes(needle))) score = Math.max(score, 130);
	if (points?.files.some(value => value.toLowerCase().includes(needle))) score = Math.max(score, 120);
	if (points?.outcome?.toLowerCase().includes(needle)) score = Math.max(score, 110);
	if (points?.openQuestions.some(value => value.toLowerCase().includes(needle))) score = Math.max(score, 100);
	return score;
}

/** Horizontal space per session and the room kept for the lane labels on the left (SVG units = CSS px). */
export const HISTORY_STEP = 120;
export const HISTORY_LEFT = 130;
export const HISTORY_LANE_HEIGHT = 100;

/**
 * One column per session in creation order (an ordinal axis: a burst of sessions on one evening stays readable next
 * to months of quiet), one row per workspace. The timeline scrolls horizontally; the newest sessions are at the end.
 */
export function layoutHistory(
	nodes: readonly HistoryNode[],
	edges: readonly HistoryEdge[],
	workspaces: readonly Workspace[] = [],
): HistoryLayout {
	const sorted = nodes.slice().sort((a, b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId));
	const laneIds = [...new Set(sorted.map(historyWorkspaceKey))].sort((a, b) => historyWorkspaceLabel(a, workspaces).localeCompare(historyWorkspaceLabel(b, workspaces)) || a.localeCompare(b));
	const lanes = laneIds.map(id => ({ id, label: historyWorkspaceLabel(id, workspaces), hue: historyWorkspaceHue(id, workspaces) }));
	const layoutNodes = sorted.map((node, rank) => {
		const lane = lanes.find(item => item.id === historyWorkspaceKey(node)) ?? lanes[0] ?? { id: "unassigned", label: "Unassigned" };
		return { node, lane, x: HISTORY_LEFT + rank * HISTORY_STEP + HISTORY_STEP / 2, y: lanes.indexOf(lane) * HISTORY_LANE_HEIGHT + HISTORY_LANE_HEIGHT / 2 };
	});
	const known = new Set(layoutNodes.map(item => item.node.sessionId));
	return {
		lanes,
		nodes: layoutNodes,
		edges: edges.filter(edge => known.has(edge.from) && known.has(edge.to)),
		width: HISTORY_LEFT + Math.max(1, sorted.length) * HISTORY_STEP + 40,
		height: Math.max(HISTORY_LANE_HEIGHT, lanes.length * HISTORY_LANE_HEIGHT),
	};
}

export function edgeLabel(kind: HistoryEdge["kind"]): string {
	return kind === "plan-run" ? "plan run" : kind;
}
