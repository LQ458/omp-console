import type { HistoryEdge, HistoryNode, Workspace } from "@omp-console/protocol";
import { Clock3, ExternalLink, GitBranch, RefreshCw, Search, Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { recordUsage } from "../../lib/journal";
import { edgeLabel, HISTORY_LANE_HEIGHT, historyWorkspaceKey, historyWorkspaceLabel, layoutHistory, rankHistoryNodes } from "../../lib/history";
import type { HistoryLayout } from "../../lib/history";
import { relTime } from "../../lib/format";
import "./history.css";

export interface HistoryPanelProps {
	api: DeckApi;
	onOpenSession?(sessionId: string): void;
}

export function HistoryPanel({ api, onOpenSession }: HistoryPanelProps): ReactNode {
	const [nodes, setNodes] = useState<HistoryNode[]>([]);
	const [edges, setEdges] = useState<HistoryEdge[]>([]);
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [query, setQuery] = useState("");
	const [workspace, setWorkspace] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
		setLoading(true);
		setError(null);
		try {
			const [history, workspaceResponse] = await Promise.all([
				api.history({ workspace: workspace || undefined, q: query.trim() || undefined, limit: 200 }, signal),
				api.listWorkspaces(signal).catch(() => ({ workspaces: [] as Workspace[] })),
			]);
			setNodes(history.nodes);
			setEdges(history.edges);
			setWorkspaces(workspaceResponse.workspaces);
			setSelectedId(current => (current && history.nodes.some(node => node.sessionId === current) ? current : history.nodes[0]?.sessionId ?? null));
		} catch (err) {
			if (signal?.aborted) return;
			setError(err instanceof Error ? err.message : "History could not be loaded.");
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, [api, query, workspace]);

	useEffect(() => {
		const controller = new AbortController();
		const timer = window.setTimeout(() => void load(controller.signal), query.trim() === "" ? 0 : 180);
		recordUsage({ feature: "12.history", action: "open", outcome: "ok", via: "direct", screen: "history" });
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [load, query, workspace]);

	const visibleNodes = useMemo(() => rankHistoryNodes(nodes, query), [nodes, query]);
	const layout = useMemo(() => layoutHistory(visibleNodes, edges, workspaces), [visibleNodes, edges, workspaces]);
	const selected = visibleNodes.find(node => node.sessionId === selectedId) ?? visibleNodes[0];
	const workspaceOptions = useMemo(() => {
		const ids = new Set([...workspaces.map(item => item.id), ...nodes.map(historyWorkspaceKey)]);
		return [...ids].filter(id => id !== "unassigned").sort((a, b) => historyWorkspaceLabel(a, workspaces).localeCompare(historyWorkspaceLabel(b, workspaces)));
	}, [nodes, workspaces]);
	const workspaceRoots = useMemo(() => new Map(workspaces.map(item => [item.id, item.root])), [workspaces]);

	const regenerate = async (node: HistoryNode): Promise<void> => {
		if (busy !== null) return;
		setBusy(node.sessionId);
		try {
			await api.regenerateKeyPoints(node.sessionId);
			setMessage("Key points regeneration requested.");
			recordUsage({ feature: "12.history", action: "regenerate", outcome: "ok", via: "direct", screen: "history", sessionId: node.sessionId });
			await load();
		} catch (err) {
			setMessage(err instanceof Error ? err.message : "Key points could not be regenerated.");
			recordUsage({ feature: "12.history", action: "regenerate", outcome: "error", via: "direct", screen: "history", sessionId: node.sessionId });
		} finally {
			setBusy(null);
		}
	};

	const openCopy = async (node: HistoryNode): Promise<void> => {
		const root = node.workspaceId ? workspaceRoots.get(node.workspaceId) : undefined;
		if (!node.sessionFile || !root) {
			setMessage("This session has no saved file or workspace root to open as a copy.");
			return;
		}
		try {
			const started = await api.createSession({ cwd: root, forkFrom: { sessionFile: node.sessionFile } });
			onOpenSession?.(started.id);
			setMessage("Opened a copy; the terminal session is unchanged.");
			recordUsage({ feature: "12.history", action: "fork", outcome: "ok", via: "direct", screen: "history", sessionId: node.sessionId });
		} catch (err) {
			setMessage(err instanceof Error ? err.message : "Session copy could not be opened.");
			recordUsage({ feature: "12.history", action: "fork", outcome: "error", via: "direct", screen: "history", sessionId: node.sessionId });
		}
	};

	return (
		<div className="hi-panel">
			<div className="hi-head"><div><div className="hi-kicker"><Clock3 size={13} aria-hidden /> Session memory</div><h3>History</h3><p>Real fork, handoff, move, and plan-run relations only; inferred dependencies are not drawn.</p></div><button type="button" className="hi-icon-btn" onClick={() => void load()} disabled={loading} title="refresh history" aria-label="refresh history"><RefreshCw size={14} className={loading ? "hi-spin" : undefined} aria-hidden /></button></div>
			<div className="hi-filters"><label className="hi-search"><Search size={13} aria-hidden /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search titles and key points…" aria-label="search history" /></label><select value={workspace} onChange={event => setWorkspace(event.target.value)} aria-label="filter history by workspace"><option value="">All workspaces</option>{workspaceOptions.map(id => <option key={id} value={id}>{historyWorkspaceLabel(id, workspaces)}</option>)}</select></div>
			{message ? <div className="hi-message" role="status">{message}</div> : null}
			{error ? <div className="hi-error" role="alert">{error}</div> : null}
			{loading && nodes.length === 0 ? <div className="hi-empty">Loading history…</div> : null}
			{layout.nodes.length > 0 ? <HistoryGraph layout={layout} selectedId={selected?.sessionId ?? null} onSelect={setSelectedId} /> : !loading ? <div className="hi-empty">No sessions match this history filter.</div> : null}
			<div className="hi-legend"><span><i className="hi-dot hi-dot-fork" /> fork</span><span><i className="hi-dot hi-dot-handoff" /> handoff</span><span><i className="hi-dot hi-dot-move" /> move</span><span><i className="hi-dot hi-dot-plan" /> plan run</span></div>
			{selected ? (
				<KeyPointCard
					node={selected}
					busy={busy === selected.sessionId}
					canOpenCopy={Boolean(selected.sessionFile && selected.workspaceId && workspaceRoots.has(selected.workspaceId))}
					onOpen={
						onOpenSession
							? () => {
									onOpenSession(selected.sessionId);
									recordUsage({ feature: "12.history", action: "open-session", outcome: "ok", via: "direct", screen: "history", sessionId: selected.sessionId });
								}
							: undefined
					}
					onOpenCopy={() => void openCopy(selected)}
					onRegenerate={() => void regenerate(selected)}
				/>
			) : null}
		</div>
	);
}

function HistoryGraph({ layout, selectedId, onSelect }: { layout: HistoryLayout; selectedId: string | null; onSelect(id: string): void }): ReactNode {
	const positions = new Map(layout.nodes.map(item => [item.node.sessionId, item]));
	const scroller = useRef<HTMLDivElement>(null);
	// Open at the newest end of the timeline; later layout changes (search, filter) jump there again.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el) el.scrollLeft = el.scrollWidth;
	}, [layout.width]);
	return (
		<div className="hi-graph-wrap" aria-label="history timeline">
			<div className="hi-lanes">{layout.lanes.map(lane => <div className="hi-lane" key={lane.id} style={laneStyle(lane.hue)}><span>{lane.label}</span></div>)}</div>
			<div className="hi-scroll" ref={scroller}>
				<svg className="hi-graph" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="session history graph">
					{layout.lanes.map((lane, index) => <line key={`lane:${lane.id}`} x1="0" x2={layout.width} y1={index * HISTORY_LANE_HEIGHT + HISTORY_LANE_HEIGHT / 2} y2={index * HISTORY_LANE_HEIGHT + HISTORY_LANE_HEIGHT / 2} className="hi-lane-line" />)}
					{layout.edges.map((edge, index) => {
						const from = positions.get(edge.from);
						const to = positions.get(edge.to);
						if (!from || !to) return null;
						return <line key={`${edge.from}:${edge.to}:${edge.kind}:${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`hi-edge hi-edge-${edge.kind}`}><title>{edgeLabel(edge.kind)}</title></line>;
					})}
					{layout.nodes.map(item => <g className={selectedId === item.node.sessionId ? "hi-node hi-node-selected" : "hi-node"} key={item.node.sessionId} transform={`translate(${item.x},${item.y})`} onClick={() => onSelect(item.node.sessionId)} tabIndex={0} role="button" aria-label={`open ${item.node.title}`}><circle r={selectedId === item.node.sessionId ? 10 : 8} style={nodeStyle(item.lane.hue)} /><text y="-14" textAnchor="middle">{clipLabel(item.node.title)}</text><title>{item.node.title}</title></g>)}
				</svg>
			</div>
		</div>
	);
}

/** One column is HISTORY_STEP wide; 16 characters of the 10 px label fit it. */
function clipLabel(title: string): string {
	return title.length > 16 ? `${title.slice(0, 15)}…` : title;
}

function laneStyle(hue: number | undefined): CSSProperties {
	return hue === undefined ? {} : { borderLeftColor: `hsl(${hue} var(--history-hue-saturation) var(--history-hue-lightness))` };
}

function nodeStyle(hue: number | undefined): CSSProperties {
	return hue === undefined ? {} : { fill: `hsl(${hue} var(--history-hue-saturation) var(--history-hue-lightness))` };
}

function KeyPointCard({ node, busy, canOpenCopy, onOpen, onOpenCopy, onRegenerate }: { node: HistoryNode; busy: boolean; canOpenCopy: boolean; onOpen?: () => void; onOpenCopy(): void; onRegenerate(): void }): ReactNode {
	const points = node.keyPoints;
	return (
		<section className="hi-card" aria-label="history key points">
			<div className="hi-card-head"><div><span className="hi-card-kicker"><GitBranch size={12} aria-hidden /> {relTime(node.lastActivityAt)}</span><h4>{node.title}</h4></div><span className="hi-session-id">{node.sessionId.slice(0, 8)}</span></div>
			{points ? <div className="hi-points"><Point label="Goal" value={points.goal} /><PointList label="Decisions" values={points.decisions} /><PointList label="Files" values={points.files} /><Point label="Outcome" value={points.outcome} /><PointList label="Open questions" values={points.openQuestions} /></div> : <div className="hi-no-points">No key points yet. Generate a card from the session transcript.</div>}
			<div className="hi-card-actions"><button type="button" className="hi-btn hi-btn-primary" onClick={() => onOpen?.()} disabled={!onOpen}><ExternalLink size={13} aria-hidden /> Open</button><button type="button" className="hi-btn" onClick={onOpenCopy} disabled={!canOpenCopy} title="Opens a copy; the terminal session is unchanged.">Open a copy</button><button type="button" className="hi-btn" onClick={onRegenerate} disabled={busy}><Sparkles size={13} aria-hidden /> {busy ? "Generating…" : "Regenerate"}</button></div>
		</section>
	);
}

function Point({ label, value }: { label: string; value: string | undefined }): ReactNode {
	if (!value) return null;
	return <div className="hi-point"><strong>{label}</strong><p>{value}</p></div>;
}

function PointList({ label, values }: { label: string; values: string[] }): ReactNode {
	if (values.length === 0) return null;
	return <div className="hi-point"><strong>{label}</strong><ul>{values.map(value => <li key={value}>{value}</li>)}</ul></div>;
}
