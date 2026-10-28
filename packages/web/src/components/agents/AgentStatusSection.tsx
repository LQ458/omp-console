import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { fmtAge } from "../../lib/format";
import { AgentSummaryRow } from "./AgentSummaryRow";
import { useAgentGraph } from "./use-agent-graph";
import "./agents.css";

/** Status sheet section: subagent summary plus the running agents, stalled ones flagged and listed first. */
export function AgentStatusSection(props: {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	working: boolean;
}): ReactNode {
	const { graph, summary, now } = useAgentGraph(props.agents, props.progress, props.lifecycle, props.working);
	const active = graph.nodes
		.filter(node => node.kind === "sub" && node.status === "running")
		.sort((a, b) => Number(b.stalled) - Number(a.stalled) || a.lastSignalAt - b.lastSignalAt);

	return (
		<section className="dk-status-section" aria-label="agents">
			<h3 className="dk-section-title">
				Agents
				{summary.total > 0 && (
					<span className="dk-section-meta">
						{summary.running} running · {summary.total} total
					</span>
				)}
			</h3>
			{summary.total === 0 ? (
				<p className="dk-hint">No subagents in this session.</p>
			) : (
				<>
					<AgentSummaryRow summary={summary} />
					{active.length > 0 ? (
						<ul className="ag-status-list">
							{active.map(node => (
								<li key={node.id} className="ag-status-item" data-stalled={node.stalled ? "true" : "false"}>
									<span className={`ag-dot ag-dot--${node.stalled ? "parked" : "running"}`} aria-hidden />
									<span className="ag-status-name">{node.displayName}</span>
									{node.stalled ? (
										<span className="ag-chip ag-chip--stalled">
											<TriangleAlert size={10} aria-hidden /> stalled · no activity {fmtAge(now - node.lastSignalAt)}
										</span>
									) : (
										<span className="ag-status-activity">{node.activity}</span>
									)}
								</li>
							))}
						</ul>
					) : null}
				</>
			)}
		</section>
	);
}
