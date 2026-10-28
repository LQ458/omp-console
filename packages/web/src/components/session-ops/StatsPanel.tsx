import type { SessionStatsView } from "@omp-console/protocol";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { runSessionOp, sessionOpError, statsFromResult } from "../../lib/session-ops";
import { OmpEquivalent } from "../catalog/OmpEquivalent";

const NUMBER = new Intl.NumberFormat();
const COST = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export interface StatsPanelProps {
	api: DeckApi;
	sessionId: string | null;
}

export function StatsPanel({ api, sessionId }: StatsPanelProps): ReactNode {
	const [stats, setStats] = useState<SessionStatsView | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (journalAction?: string): Promise<void> => {
		if (!sessionId) return;
		setLoading(true);
		setError(null);
		try {
			const result = journalAction
				? await runSessionOp(api, sessionId, { op: "stats" }, { feature: "1.13.usage", action: journalAction, screen: "status" })
				: await api.sessionOp(sessionId, { op: "stats" });
			setStats(statsFromResult(result));
		} catch (cause) {
			setError(sessionOpError(cause));
		} finally {
			setLoading(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		setStats(null);
		void load("load");
	}, [load]);

	return (
		<section className="dk-status-section so-section" aria-label="session usage">
			<h3 className="dk-section-title">Usage and cost</h3>
			{stats ? (
				<>
					<dl className="so-stats-grid">
						<div><dt>Input</dt><dd>{NUMBER.format(stats.tokens.input)}</dd></div>
					<div><dt>Output</dt><dd>{NUMBER.format(stats.tokens.output)}</dd></div>
					<div><dt>Cache read</dt><dd>{NUMBER.format(stats.tokens.cacheRead)}</dd></div>
					<div><dt>Cache write</dt><dd>{NUMBER.format(stats.tokens.cacheWrite)}</dd></div>
					{stats.tokens.reasoning !== undefined && <div><dt>Reasoning</dt><dd>{NUMBER.format(stats.tokens.reasoning)}</dd></div>}
					<div><dt>Total cost</dt><dd>{COST.format(stats.cost)}</dd></div>
					<div><dt>Context</dt><dd>{NUMBER.format(stats.contextTokens)} / {NUMBER.format(stats.contextWindow)}</dd></div>
					</dl>
					<h4 className="so-subheading">By agent</h4>
					{stats.byAgent.length > 0 ? (
						<ul className="so-agent-usage">
							{stats.byAgent.map(agent => <li key={agent.agentId}><span>{agent.agentId}</span><span>{NUMBER.format(agent.tokens)} tokens · {COST.format(agent.cost)}</span></li>)}
						</ul>
					) : <p className="dk-hint">No agent usage reported.</p>}
				</>
			) : <p className="dk-hint">{sessionId ? "Usage statistics are unavailable." : "Open a session to see usage."}</p>}
			{sessionId && <button type="button" className="dk-wide-btn so-secondary" disabled={loading} onClick={() => void load("refresh")}><RefreshCw size={14} />Refresh usage</button>}
			<OmpEquivalent text="/usage" actionId="1.13.usage" />
			{error && <p className="so-error" role="alert">{error}</p>}
		</section>
	);
}
