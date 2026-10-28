import type { AgentSnapshot, SessionEntry, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { GuestClient } from "../../lib/client";
import type { DeckApi } from "../../lib/api";
import type { TranscriptProps } from "../transcript/Transcript";
import { AgentDrawer } from "./AgentDrawer";
import { AgentsSheet, type SheetTools } from "./AgentsSheet";
import { OPEN_AGENT_EVENT, type OpenAgentDetail } from "./graph-events";
import { useAgentGraph } from "./use-agent-graph";
import "./agents.css";

/**
 * The session's agent overlays: the graph/tree sheet (when open) and the agent drawer (when an agent is
 * selected). They share one derived graph that ticks every second, so stall flags and outcomes stay live without
 * re-rendering the whole session view. The drawer is memoized and gets only primitives from the graph, so the tick
 * does not re-render its transcript.
 */
export function AgentsOverlay(props: {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Host `isStreaming` of the session. */
	working: boolean;
	api: DeckApi;
	client: GuestClient;
	readOnly: boolean;
	phone: boolean;
	sheetOpen: boolean;
	selectedId: string | null;
	/** Daemon session id of this session; absent for a manually joined link (no "Change model" then). */
	sessionId: string | undefined;
	host: TranscriptProps["host"];
	/** Main transcript: message edges and the plan graph are read from it. */
	entries: readonly SessionEntry[];
	onSelect(id: string | null): void;
	onCloseSheet(): void;
}): ReactNode {
	const { agents, progress, lifecycle, working, api, client, readOnly, phone, sheetOpen, selectedId, sessionId, host, entries, onSelect } = props;
	const { graph, summary } = useAgentGraph(agents, progress, lifecycle, working);
	const drawerAgent = selectedId === null ? undefined : agents.find(agent => agent.id === selectedId);
	const drawerNode = drawerAgent ? graph.nodes.find(node => node.id === drawerAgent.id) : undefined;
	const closeDrawer = useCallback(() => onSelect(null), [onSelect]);

	// `omp-console:open-agent` (the draft run view, other panels) opens an agent's drawer.
	useEffect(() => {
		const onOpen = (event: Event): void => {
			const agentId = (event as CustomEvent<OpenAgentDetail>).detail?.agentId;
			if (typeof agentId === "string") onSelect(agentId);
		};
		window.addEventListener(OPEN_AGENT_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_AGENT_EVENT, onOpen);
	}, [onSelect]);

	const tools = useMemo<SheetTools>(
		() => ({ api, client, sessionId, readOnly, agents, entries, progress, lifecycle }),
		[api, client, sessionId, readOnly, agents, entries, progress, lifecycle],
	);

	const [windowRoot, setWindowRoot] = useState<HTMLDivElement | null>(null);
	const drawer = drawerAgent ? (
		<>
			<div className="ag-drawer-backdrop" onClick={closeDrawer} />
			<AgentDrawer
				api={api}
				agent={drawerAgent}
				status={drawerNode?.status}
				stalled={drawerNode?.stalled}
				progress={progress.get(drawerAgent.id)}
				lifecycle={lifecycle.get(drawerAgent.id)}
				client={client}
				readOnly={readOnly}
				host={host}
				sessionId={sessionId}
				onClose={closeDrawer}
			/>
		</>
	) : null;

	return (
		<div className="ag-overlay" data-sheet={sheetOpen ? "true" : "false"}>
			{sheetOpen ? (
				<AgentsSheet
					graph={graph}
					summary={summary}
					selectedId={selectedId}
					phone={phone}
					tools={tools}
					onSelect={onSelect}
					onClose={props.onCloseSheet}
					onWindowRootChange={setWindowRoot}
				/>
			) : null}
			{drawer !== null ? (windowRoot ? createPortal(drawer, windowRoot) : drawer) : null}
		</div>
	);
}
