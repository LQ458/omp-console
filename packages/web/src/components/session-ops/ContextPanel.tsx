import type { ContextBreakdownView } from "@omp-console/protocol";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { contextFromResult, runSessionOp, sessionOpError } from "../../lib/session-ops";
import { OmpEquivalent } from "../catalog/OmpEquivalent";

const COMPACTION_MODES = [
	{ mode: "soft", label: "Soft", equivalent: "/compact soft" },
	{ mode: "remote", label: "Remote", equivalent: "/compact remote" },
	{ mode: "snap", label: "Snapcompact", equivalent: "/compact snapcompact" },
] as const;

export interface ContextPanelProps {
	api: DeckApi;
	sessionId: string | null;
}

export function ContextPanel({ api, sessionId }: ContextPanelProps): ReactNode {
	const [context, setContext] = useState<ContextBreakdownView | null>(null);
	const [loading, setLoading] = useState(false);
	const [confirmMode, setConfirmMode] = useState<(typeof COMPACTION_MODES)[number]["mode"] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (journalAction?: string): Promise<void> => {
		if (!sessionId) return;
		setLoading(true);
		setError(null);
		try {
			const result = journalAction
				? await runSessionOp(api, sessionId, { op: "context" }, { feature: "1.10.context", action: journalAction, screen: "status" })
				: await api.sessionOp(sessionId, { op: "context" });
			setContext(contextFromResult(result));
		} catch (cause) {
			setError(sessionOpError(cause));
		} finally {
			setLoading(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		setContext(null);
		void load("load");
	}, [load]);

	const compact = async (): Promise<void> => {
		if (!sessionId || !confirmMode) return;
		const mode = confirmMode;
		setLoading(true);
		setError(null);
		try {
			await runSessionOp(api, sessionId, { op: "compact", mode }, { feature: "1.10.context", action: `compact:${mode}`, screen: "status" });
			setConfirmMode(null);
			await load();
		} catch (cause) {
			setError(sessionOpError(cause));
			setLoading(false);
		}
	};

	return (
		<section className="dk-status-section so-section" aria-label="context and compaction">
			<h3 className="dk-section-title">Context <span className="dk-section-meta">{context ? `${context.total.toLocaleString()} / ${context.window.toLocaleString()} tokens` : ""}</span></h3>
			{context ? (
				<div className="so-context-parts">
					{context.parts.map((part, index) => {
						const width = context.total > 0 ? Math.min(100, Math.max(0, (part.tokens / context.total) * 100)) : 0;
						return (
							<div className="so-context-part" key={`${part.label}:${index}`}>
								<div className="so-context-label"><span>{part.label}</span><span>{part.tokens.toLocaleString()}</span></div>
								<div className="so-context-track" role="img" aria-label={`${part.label}: ${part.tokens} tokens`}><span style={{ width: `${width}%` }} /></div>
							</div>
						);
					})}
				</div>
			) : <p className="dk-hint">{sessionId ? "Context breakdown is unavailable." : "Open a session to inspect context."}</p>}
			{sessionId && <button type="button" className="dk-wide-btn so-secondary" disabled={loading} onClick={() => void load("refresh-context")}><RefreshCw size={14} />Refresh context</button>}
			<OmpEquivalent text="/context" actionId="1.10.context" />
			<h4 className="so-subheading">Compact context</h4>
			<div className="so-compact-options">
				{COMPACTION_MODES.map(option => (
					<div className="so-compact-option" key={option.mode}>
						<button type="button" className="dk-wide-btn" disabled={!sessionId || loading} onClick={() => setConfirmMode(option.mode)}>Compact {option.label}</button>
						<OmpEquivalent text={option.equivalent} actionId={`1.10.compact-${option.mode}`} />
					</div>
				))}
			</div>
			{confirmMode && (
				<div className="so-warning" role="alertdialog" aria-label="confirm compaction">
					<p>Compact this session with {COMPACTION_MODES.find(item => item.mode === confirmMode)?.label}? The context will be summarized or archived.</p>
					<div className="so-action-row">
						<button type="button" className="dk-wide-btn" disabled={loading} onClick={() => setConfirmMode(null)}>Cancel</button>
						<button type="button" className="dk-wide-btn so-primary" disabled={loading} onClick={() => void compact()}>{loading ? "Compacting…" : "Confirm compact"}</button>
					</div>
				</div>
			)}
			{error && <p className="so-error" role="alert">{error}</p>}
		</section>
	);
}
