import type { CreateSessionRequest, SessionSummary } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import type { DeckApi } from "../../lib/api";
import type { GuestClient } from "../../lib/client";
import { ContextPanel } from "./ContextPanel";
import { GoalPanel } from "./GoalPanel";
import { PlanPanel } from "./PlanPanel";
import { SessionTreePanel } from "./SessionTreePanel";
import { StatsPanel } from "./StatsPanel";
import { TodoEditor } from "./TodoEditor";
import "./session-ops.css";

export interface SessionOpsPanelProps {
	api: DeckApi;
	sessionId: string | null;
	summary?: SessionSummary;
	entries: readonly SessionEntry[];
	client: GuestClient | null;
	readOnly: boolean;
	onFork(request: CreateSessionRequest): Promise<void> | void;
}

export function SessionOpsPanel({ api, sessionId, summary, entries, client, readOnly, onFork }: SessionOpsPanelProps): ReactNode {
	const operationSessionId = readOnly ? null : sessionId;
	return (
		<div className="so-panel">
			<PlanPanel entries={entries} client={client} sessionId={sessionId} readOnly={readOnly} />
			<GoalPanel api={api} sessionId={operationSessionId} summary={summary} entries={entries} />
			<TodoEditor key={operationSessionId ?? "no-session"} api={api} sessionId={operationSessionId} entries={entries} />
			<ContextPanel api={api} sessionId={operationSessionId} />
			<StatsPanel api={api} sessionId={operationSessionId} />
			<SessionTreePanel api={api} sessionId={operationSessionId} summary={summary} onFork={onFork} />
		</div>
	);
}
