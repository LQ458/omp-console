import type { CreateSessionRequest, DaemonHealth, SessionSummary } from "@omp-console/protocol";
import type {
	AgentSnapshot,
	SessionEntry,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { ShieldAlert, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { DeckApi, DeckApiError } from "../../lib/api";
import type { GuestClient } from "../../lib/client";
import { fmtAge, fmtBytes } from "../../lib/format";
import { SessionOpsPanel } from "../session-ops/SessionOpsPanel";
import { type HealthRow, healthRows } from "../../lib/health";
import { useGuestSnapshot } from "../../lib/use-guest";
import { AgentStatusSection } from "../agents/AgentStatusSection";
import { Sheet } from "./Sheet";

const NO_ENTRIES: readonly SessionEntry[] = [];
const TICK_MS = 1_000;

/** Wall clock that re-renders its consumer every second while mounted (last-event ages). */
function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), intervalMs);
		return () => window.clearInterval(id);
	}, [intervalMs]);
	return now;
}

export interface StatusSheetProps {
	onClose(): void;
	api: DeckApi;
	client: GuestClient | null;
	selectedId: string | null;
	sessions: readonly SessionSummary[];
	health: DaemonHealth | null;
	listError: DeckApiError | null;
	onFork(request: CreateSessionRequest): Promise<void> | void;
}

/** Goal, todo and health panels. Entries update live with the guest; health follows the 3 s poll. */
export function StatusSheet(props: StatusSheetProps): ReactNode {
	return props.client ? (
		<GuestStatus {...props} client={props.client} />
	) : (
		<StatusBody {...props} entries={NO_ENTRIES} />
	);
}

function GuestStatus(props: StatusSheetProps & { client: GuestClient }): ReactNode {
	const snap = useGuestSnapshot(props.client);
	return (
		<StatusBody
			{...props}
			entries={snap.entries}
			agents={snap.agents}
			progress={snap.progress}
			lifecycle={snap.lifecycle}
			working={snap.working}
			readOnly={snap.readOnly}
		/>
	);
}

interface StatusBodyProps extends StatusSheetProps {
	entries: readonly SessionEntry[];
	/** Only for a connected session; the agents section is omitted without them. */
	agents?: readonly AgentSnapshot[];
	progress?: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle?: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Host `isStreaming`; the main agent shows idle (never stalled) while it is false. */
	working?: boolean;
	readOnly?: boolean;
}

function StatusBody({ onClose, entries, agents, progress, lifecycle, working = false, readOnly = false, selectedId, sessions, health, listError, api, client, onFork }: StatusBodyProps): ReactNode {
	const now = useNow(TICK_MS);
	const summary = selectedId === null ? undefined : sessions.find(s => s.id === selectedId);
	const rows = useMemo(() => healthRows(health, sessions, now), [health, sessions, now]);
	return (
		<Sheet title="Status" windowKind="status" onClose={onClose}>
			<SessionOpsPanel api={api} sessionId={selectedId} summary={summary} entries={entries} client={client} readOnly={readOnly} onFork={onFork} />

			{agents && progress && lifecycle && (
				<AgentStatusSection agents={agents} progress={progress} lifecycle={lifecycle} working={working} />
			)}

			<section className="dk-status-section" aria-label="health">
				<h3 className="dk-section-title">
					Health
					{health && (
						<span className="dk-section-meta">
							{health.workers.length} worker{health.workers.length === 1 ? "" : "s"} · {health.guests} guest
							{health.guests === 1 ? "" : "s"}
						</span>
					)}
				</h3>
				{listError && (
					<div className="dk-notice dk-notice-err" role="alert">
						{listError.kind === "auth" ? <ShieldAlert size={14} /> : <WifiOff size={14} />}
						<span>{listError.kind === "auth" ? "Daemon refused this device." : "Daemon unreachable; showing the last report."}</span>
					</div>
				)}
				{health === null ? (
					<p className="dk-hint">Health not reported yet.</p>
				) : rows.length === 0 ? (
					<p className="dk-hint">No workers running.</p>
				) : (
					<ul className="dk-health-list">
						{rows.map(row => (
							<HealthCard key={row.sessionId} row={row} current={row.sessionId === selectedId} />
						))}
					</ul>
				)}
			</section>
		</Sheet>
	);
}


function HealthCard({ row, current }: { row: HealthRow; current: boolean }): ReactNode {
	const level = row.state === "crashed" ? "crashed" : row.stalled ? "stalled" : "ok";
	return (
		<li className="dk-health-card" data-level={level} data-current={current ? "true" : "false"}>
			<div className="dk-health-head">
				<span className="dk-health-name">{row.title}</span>
				{current && <span className="dk-health-here">open</span>}
				<span className="dk-health-state" data-level={level}>
					{row.stalled ? "stalled" : row.state}
				</span>
			</div>
			<dl className="dk-health-grid">
				<div>
					<dt>Restarts</dt>
					<dd>{row.restarts}</dd>
				</div>
				<div>
					<dt>Memory</dt>
					<dd>{fmtBytes(row.rssBytes)}</dd>
				</div>
				<div>
					<dt>Last event</dt>
					<dd>{fmtAge(row.lastEventAgeMs)}</dd>
				</div>
			</dl>
		</li>
	);
}
