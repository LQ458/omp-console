import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { Network, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";
import type { AgentNode } from "../../lib/agent-graph";
import { fmtCost, fmtTokens, relTime } from "../../lib/format";
import { AgentSummaryRow } from "./AgentSummaryRow";
import { useAgentGraph } from "./use-agent-graph";
import "./agents.css";

const AgentRow = memo(function AgentRow(props: {
	node: AgentNode;
	selected: boolean;
	onSelect(id: string | null): void;
}): ReactNode {
	const { node, selected, onSelect } = props;
	return (
		<button
			type="button"
			className={selected ? "ag-row ag-row--selected" : "ag-row"}
			onClick={() => onSelect(selected ? null : node.id)}
		>
			<span className="ag-row-head">
				<span className={`ag-dot ag-dot--${node.status}`} />
				<span className="ag-row-name">{node.displayName}</span>
				{node.stalled ? (
					<span className="ag-chip ag-chip--stalled">
						<TriangleAlert size={10} aria-hidden /> stalled
					</span>
				) : null}
				<span className="ag-chip">{node.kind}</span>
			</span>
			<span className="ag-row-activity">{node.activity}</span>
			<span className="ag-row-meta">
				{node.tokens !== undefined ? <span>{fmtTokens(node.tokens)} tok</span> : null}
				{node.cost !== undefined ? <span>{fmtCost(node.cost)}</span> : null}
				<span className="ag-row-meta-when">{relTime(node.lastSignalAt)}</span>
			</span>
		</button>
	);
});

/** Memoized: the client replaces `progress`/`lifecycle` only when they change. */
export const AgentsPanel = memo(function AgentsPanel(props: {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Host `isStreaming` of the session. */
	working: boolean;
	selectedId: string | null;
	onSelect(id: string | null): void;
	/** Opens the graph/tree sheet. */
	onOpenGraph?(): void;
}): ReactNode {
	const { agents, progress, lifecycle, working, selectedId, onSelect, onOpenGraph } = props;
	const { graph, summary } = useAgentGraph(agents, progress, lifecycle, working);

	const sorted = useMemo(() => {
		const mains: AgentNode[] = [];
		const subs: AgentNode[] = [];
		for (const node of graph.nodes) (node.kind === "main" ? mains : subs).push(node);
		subs.sort((a, b) => {
			const ar = a.status === "running" ? 0 : 1;
			const br = b.status === "running" ? 0 : 1;
			if (ar !== br) return ar - br;
			return b.lastSignalAt - a.lastSignalAt;
		});
		return { mains, subs };
	}, [graph]);

	return (
		<div className="ag-panel">
			<div className="ag-heading">
				Session
				{onOpenGraph && summary.total > 0 ? (
					<button type="button" className="ag-btn ag-heading-action" onClick={onOpenGraph}>
						<Network size={13} aria-hidden />
						Graph
					</button>
				) : null}
			</div>
			{sorted.mains.map(node => (
				<AgentRow key={node.id} node={node} selected={selectedId === node.id} onSelect={onSelect} />
			))}
			<div className="ag-heading">
				Subagents
				{sorted.subs.length > 0 && <span className="ag-heading-count">{sorted.subs.length}</span>}
			</div>
			<AgentSummaryRow summary={summary} />
			{sorted.subs.map(node => (
				<AgentRow key={node.id} node={node} selected={selectedId === node.id} onSelect={onSelect} />
			))}
			{sorted.subs.length === 0 ? <div className="ag-empty">No subagents yet</div> : null}
		</div>
	);
});
