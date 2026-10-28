import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { useEffect, useMemo, useState } from "react";
import { useProgressSeen } from "../../lib/agent-activity";
import { type AgentGraph, type AgentSummary, buildAgentGraph, summarizeAgents } from "../../lib/agent-graph";

/** Wall clock that re-renders its consumer every `intervalMs` while mounted. */
export function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

export interface LiveAgentGraph {
	graph: AgentGraph;
	summary: AgentSummary;
	now: number;
}

/** The session's agent tree from guest frames, re-derived every second so stall flags and durations stay live. */
export function useAgentGraph(
	agents: readonly AgentSnapshot[],
	progress: ReadonlyMap<string, SubagentProgressPayload>,
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>,
	mainWorking: boolean,
): LiveAgentGraph {
	const now = useNow(1000);
	const progressSeenAt = useProgressSeen(progress, now);
	const graph = useMemo(
		() => buildAgentGraph({ agents, progress, lifecycle, progressSeenAt, now, mainWorking }),
		[agents, progress, lifecycle, progressSeenAt, now, mainWorking],
	);
	const summary = useMemo(() => summarizeAgents(graph.nodes), [graph]);
	return { graph, summary, now };
}
