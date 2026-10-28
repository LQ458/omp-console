import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentSummary } from "../../lib/agent-graph";
import { fmtCost, fmtTokens } from "../../lib/format";
import "./agents.css";

/** Running count, stalled count, and total tokens and cost across subagents (each only when reported). */
export function AgentSummaryRow({ summary }: { summary: AgentSummary }): ReactNode {
	if (summary.total === 0) return null;
	return (
		<div className="ag-summary" role="status" aria-label="subagent summary">
			<span className="ag-summary-item">
				<strong>{summary.running}</strong> running
			</span>
			<span className="ag-summary-item">
				<strong>{summary.total}</strong> total
			</span>
			{summary.stalled > 0 ? (
				<span className="ag-summary-item ag-summary-item--stalled">
					<TriangleAlert size={12} aria-hidden />
					<strong>{summary.stalled}</strong> stalled
				</span>
			) : null}
			{summary.tokens !== null ? (
				<span className="ag-summary-item">
					<strong>{fmtTokens(summary.tokens)}</strong> tok
				</span>
			) : null}
			{summary.cost !== null ? (
				<span className="ag-summary-item">
					<strong>{fmtCost(summary.cost)}</strong>
				</span>
			) : null}
		</div>
	);
}
