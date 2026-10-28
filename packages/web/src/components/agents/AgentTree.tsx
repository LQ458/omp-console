import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentGraph } from "../../lib/agent-graph";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import "./agents.css";

/** Indented list of the agent tree (pre-order), the phone-friendly view of the same graph. */
export function AgentTree(props: {
	graph: AgentGraph;
	selectedId: string | null;
	onSelect(id: string): void;
}): ReactNode {
	const { graph, selectedId, onSelect } = props;
	if (graph.nodes.length === 0) return <div className="ag-empty">No agents yet</div>;
	return (
		<ul className="ag-tree" aria-label="agent tree">
			{graph.nodes.map(node => (
				<li key={node.id} className="ag-tree-item" style={{ paddingLeft: `${Math.min(node.depth, 6) * 16}px` }}>
					<button
						type="button"
						className={selectedId === node.id ? "ag-tree-row ag-tree-row--selected" : "ag-tree-row"}
						data-status={node.status}
						data-stalled={node.stalled ? "true" : "false"}
						onClick={() => onSelect(node.id)}
					>
						<span className="ag-tree-head">
							<span className={`ag-dot ag-dot--${node.status}`} aria-hidden />
							<span className="ag-tree-name">{node.displayName}</span>
							<span className={`ag-chip ag-chip--${node.status}`}>{node.status}</span>
							{node.stalled ? (
								<span className="ag-chip ag-chip--stalled">
									<TriangleAlert size={10} aria-hidden /> stalled
								</span>
							) : null}
						</span>
						<span className="ag-tree-activity">{node.activity}</span>
						{node.tokens !== undefined || node.model ? (
							<span className="ag-tree-meta">
								{node.model ? <span className="ag-tree-model">{node.model}</span> : null}
								{node.tokens !== undefined ? <span>{fmtTokens(node.tokens)} tok</span> : null}
								{node.cost !== undefined ? <span>{fmtCost(node.cost)}</span> : null}
								{node.durationMs !== undefined ? <span>{fmtDuration(node.durationMs)}</span> : null}
							</span>
						) : null}
					</button>
				</li>
			))}
		</ul>
	);
}
