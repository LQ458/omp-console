import type { AgentSnapshot, SessionEntry, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { ListTree, Network, PencilRuler, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import type { AgentGraph, AgentSummary } from "../../lib/agent-graph";
import type { DeckApi } from "../../lib/api";
import type { GuestClient } from "../../lib/client";
import { EDGE_KINDS, type EdgeKind } from "../../lib/message-edges";
import type { PlanAgent } from "../../lib/plan-graph";
import { deriveTodos } from "../../lib/todos";
import { lazyWithRecovery } from "../../lib/lazy";
import { LazyRegion } from "../shell/LazyRegion";
import { Sheet } from "../shell/Sheet";
import { AgentGraphView, type NodeMenuRequest } from "./AgentGraphView";
import { AgentSummaryRow } from "./AgentSummaryRow";
import { AgentTree } from "./AgentTree";
import { trackGraph } from "./graph-usage";
import { AgentNodeMenu, type InstructContext } from "./NodeMenu";
import { useMessageEdges } from "./use-message-edges";
import "./agents.css";
import "./graph-tools.css";
const DraftEditor = lazyWithRecovery(() => import("../plan/DraftEditor").then(({ DraftEditor: component }) => ({ default: component })));
const PlanGraphView = lazyWithRecovery(() => import("../plan/PlanGraphView").then(({ PlanGraphView: component }) => ({ default: component })));


export type AgentsTab = "tree" | "graph" | "plan" | "draft";

/** What the Graph, Plan and Draft tabs need beyond the tree: the live session and its data. */
export interface SheetTools {
	api: DeckApi;
	client: GuestClient;
	sessionId: string | undefined;
	readOnly: boolean;
	agents: readonly AgentSnapshot[];
	/** Main transcript entries (message edges and the todo board are read from them). */
	entries: readonly SessionEntry[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
}

const ALL_KINDS: ReadonlySet<EdgeKind> = new Set(EDGE_KINDS.map(item => item.kind));

/** Running subagents with whatever text describes what they were given, for matching against todo tasks. */
export function planAgentsOf(
	graph: AgentGraph,
	progress: ReadonlyMap<string, SubagentProgressPayload>,
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>,
): PlanAgent[] {
	const out: PlanAgent[] = [];
	for (const node of graph.nodes) {
		if (node.kind !== "sub" || node.status !== "running") continue;
		const p = progress.get(node.id);
		const texts = [lifecycle.get(node.id)?.description, p?.task, p?.progress.task, p?.progress.description].filter(
			(text): text is string => typeof text === "string" && text !== "",
		);
		if (texts.length > 0) out.push({ id: node.id, name: node.displayName, task: [...new Set(texts)].join(" · ") });
	}
	return out;
}

/**
 * Modal over the session: the agent tree as an indented list, as a pan/zoom graph with message edges, as the todo
 * plan graph, or as the draft editor. Phones open on the list (scrolls naturally), wider screens on the graph. Uses
 * the shell's sheet classes so it slides up on a phone and is a centred panel elsewhere, but wider than the settings
 * sheets because a tree needs the room. Without `tools` (a plain link guest) only Tree and Graph exist.
 */
export function AgentsSheet(props: {
	graph: AgentGraph;
	summary: AgentSummary;
	selectedId: string | null;
	phone: boolean;
	tools?: SheetTools;
	onSelect(id: string): void;
	onClose(): void;
	onWindowRootChange?(root: HTMLDivElement | null): void;
}): ReactNode {
	const { graph, summary, selectedId, phone, tools, onSelect, onClose, onWindowRootChange } = props;
	const [tab, setTab] = useState<AgentsTab>(phone ? "tree" : "graph");
	const [kinds, setKinds] = useState<ReadonlySet<EdgeKind>>(ALL_KINDS);
	const [menu, setMenu] = useState<NodeMenuRequest | null>(null);

	const sessionId = tools?.sessionId;
	const messageEdges = useMessageEdges({
		client: tools?.client,
		agents: tools?.agents ?? [],
		entries: tools?.entries ?? [],
		enabled: tools !== undefined && tab === "graph",
	});
	const board = useMemo(() => (tools ? deriveTodos(tools.entries) : null), [tools]);
	const planAgents = useMemo(
		() => planAgentsOf(graph, tools?.progress ?? new Map(), tools?.lifecycle ?? new Map()),
		[graph, tools?.progress, tools?.lifecycle],
	);
	const mainId = graph.nodes.find(node => node.kind === "main")?.id;
	const ctx = useMemo<InstructContext | null>(
		() =>
			tools
				? {
						api: tools.api,
						client: tools.client,
						sessionId,
						readOnly: tools.readOnly,
						mainId,
						onOpenAgent: id => onSelect(id),
					}
				: null,
		[tools, sessionId, mainId, onSelect],
	);

	const changeTab = useCallback(
		(next: AgentsTab) => {
			setTab(next);
			setMenu(null);
			if (next === "plan") trackGraph("4.3.plan-graph", "open", { sessionId });
			if (next === "draft") trackGraph("4.5.draft", "open", { sessionId });
		},
		[sessionId],
	);

	const toggleKind = useCallback(
		(kind: EdgeKind) => {
			setKinds(current => {
				const next = new Set(current);
				if (next.has(kind)) next.delete(kind);
				else next.add(kind);
				return next;
			});
			trackGraph("4.2.edges", "toggle", { detail: kind, sessionId });
		},
		[sessionId],
	);

	const menuNode = menu ? graph.nodes.find(node => node.id === menu.nodeId) : undefined;
	const tabs: ReadonlyArray<{ id: AgentsTab; label: string; icon: ReactNode; show: boolean }> = [
		{ id: "tree", label: "Tree", icon: <ListTree size={14} aria-hidden />, show: true },
		{ id: "graph", label: "Graph", icon: <Network size={14} aria-hidden />, show: true },
		{ id: "plan", label: "Plan", icon: <Workflow size={14} aria-hidden />, show: tools !== undefined },
		{ id: "draft", label: "Draft", icon: <PencilRuler size={14} aria-hidden />, show: tools !== undefined && sessionId !== undefined },
	];

	return (
		<Sheet
			title="Agents"
			onClose={onClose}
			size={phone ? "full" : "tall"}
			windowKind="agents"
			onWindowRootChange={onWindowRootChange}
			escapeEnabled={selectedId === null && menu === null}
			rootClassName="ag-sheet-root"
			sectionClassName="ag-sheet"
			wrapBody={false}
			headerAddon={
				<div className="ag-sheet-tools">
					<div className="ag-tabs" role="tablist" aria-label="agents view">
						{tabs
							.filter(item => item.show)
							.map(item => (
								<button
									key={item.id}
									type="button"
									role="tab"
									aria-selected={tab === item.id}
									className="ag-tab"
									onClick={() => changeTab(item.id)}
								>
									{item.icon} {item.label}
								</button>
							))}
					</div>
					<AgentSummaryRow summary={summary} />
				</div>
			}
		>
			<div className="ag-sheet-body" data-tab={tab}>
				{tab === "tree" ? (
					<div className="ag-sheet-scroll">
						<AgentTree graph={graph} selectedId={selectedId} onSelect={onSelect} />
					</div>
				) : tab === "graph" ? (
					<AgentGraphView
						graph={graph}
						selectedId={selectedId}
						onSelect={onSelect}
						messageEdges={tools ? messageEdges : undefined}
						visibleKinds={kinds}
						onToggleKind={tools ? toggleKind : undefined}
						onNodeMenu={ctx ? setMenu : undefined}
					/>
				) : tab === "plan" ? (
					<LazyRegion fallback={<div className="ag-sheet-scroll" role="status" aria-busy="true">Loading plan…</div>}>
						<PlanGraphView board={board} agents={planAgents} ctx={ctx} />
					</LazyRegion>
				) : tools && sessionId !== undefined ? (
					<LazyRegion fallback={<div className="ag-sheet-scroll" role="status" aria-busy="true">Loading draft…</div>}>
						<DraftEditor key={sessionId} api={tools.api} sessionId={sessionId} readOnly={tools.readOnly} />
					</LazyRegion>
				) : null}
			</div>
			{menu && menuNode && ctx ? <AgentNodeMenu node={menuNode} x={menu.x} y={menu.y} ctx={ctx} onClose={() => setMenu(null)} /> : null}
		</Sheet>
	);
}
