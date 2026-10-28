import type { GateStatusResponse } from "@omp-console/protocol";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeckApi } from "../../lib/api";
import {
	auditKinds,
	auditTime,
	filterAudit,
	type AuditFilters,
	MODE_NAMES,
	MODE_NOTE,
	MODE_TITLE,
	MODES_READ_ONLY_NOTE,
	NO_FILTERS,
	VERDICT_FILTERS,
	VERDICT_LABEL,
	type VerdictFilter,
	verdictCounts,
	verdictTone,
} from "./audit";
import "./safety.css";

export interface ActionsPanelProps {
	api: Pick<DeckApi, "gate">;
	/** Enables the "this session only" filter. */
	sessionId?: string;
}

type Load = { phase: "loading" } | { phase: "ready"; status: GateStatusResponse } | { phase: "failed"; message: string };

/** "Actions in your name": the gate's modes (read-only, with the research note) and its audit log. */
export function ActionsPanel({ api, sessionId }: ActionsPanelProps): ReactNode {
	const [load, setLoad] = useState<Load>({ phase: "loading" });
	const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			setLoad({ phase: "ready", status: await api.gate() });
		} catch (err) {
			setLoad({ phase: "failed", message: err instanceof Error ? err.message : "could not read the gate" });
		}
	}, [api]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const audit = load.phase === "ready" ? load.status.audit : [];
	const kinds = useMemo(() => auditKinds(audit), [audit]);
	const counts = useMemo(() => verdictCounts(audit), [audit]);
	const rows = useMemo(() => filterAudit(audit, filters), [audit, filters]);

	if (load.phase === "loading") return <div className="ws-empty" role="status">Reading the gate…</div>;
	if (load.phase === "failed") {
		return (
			<div className="dk-notice dk-notice-err ws-notice" role="alert">
				<ShieldAlert size={14} />
				<span>{load.message}</span>
			</div>
		);
	}
	const { status } = load;
	if (!status.installed) {
		return (
			<div className="sf-panel">
				<div className="dk-notice dk-notice-warn ws-notice" role="status">
					<ShieldAlert size={14} />
					<span>The action gate is not installed, so nothing is checking actions taken in your name.</span>
				</div>
			</div>
		);
	}

	return (
		<div className="sf-panel">
			<section aria-label="gate modes">
				<h3 className="dk-section-title">
					Gate modes
					<span className="dk-section-meta">{status.version ? `v${status.version}` : ""}</span>
				</h3>
				<ul className="sf-modes">
					{MODE_NAMES.map(name => (
						<li key={name} className="sf-mode" data-mode={status.modes[name]}>
							<ShieldCheck size={14} />
							<span className="sf-mode-name">{MODE_TITLE[name]}</span>
							<code className="sf-mode-value">{status.modes[name]}</code>
							<span className="sf-mode-note">{MODE_NOTE[status.modes[name]]}</span>
						</li>
					))}
				</ul>
				<p className="ws-muted sf-note">{MODES_READ_ONLY_NOTE}</p>
				{status.evidence && (
					<p className="sf-evidence" aria-label="research note">
						<strong>Research:</strong> {status.evidence}
					</p>
				)}
			</section>

			<section aria-label="audit log">
				<h3 className="dk-section-title">
					Audit log
					<span className="dk-section-meta">
						{rows.length} of {audit.length}
					</span>
				</h3>
				<div className="sf-filters">
					<div className="sf-chips" role="group" aria-label="verdict filter">
						{VERDICT_FILTERS.map(option => (
							<button
								key={option.id}
								type="button"
								className="sf-chip"
								data-on={filters.verdict === option.id ? "true" : "false"}
								onClick={() => setFilters({ ...filters, verdict: option.id as VerdictFilter })}
							>
								{option.label}
								{option.id !== "all" && option.id !== "attention" && <span className="sf-chip-count">{counts[option.id]}</span>}
							</button>
						))}
					</div>
					<div className="sf-filter-row">
						<select
							className="sh-input sf-select"
							value={filters.kind}
							onChange={event => setFilters({ ...filters, kind: event.target.value })}
							aria-label="action kind"
						>
							<option value="all">All kinds</option>
							{kinds.map(kind => (
								<option key={kind} value={kind}>
									{kind}
								</option>
							))}
						</select>
						<input
							className="sh-input sf-search"
							value={filters.query}
							onChange={event => setFilters({ ...filters, query: event.target.value })}
							placeholder="Search summary or target"
							aria-label="search the audit log"
							spellCheck={false}
						/>
						<button type="button" className="sh-btn sh-btn-icon" onClick={() => void refresh()} aria-label="refresh audit log" title="refresh">
							<RefreshCw size={14} />
						</button>
					</div>
					{sessionId !== undefined && (
						<label className="ws-source">
							<input
								type="checkbox"
								checked={filters.sessionId === sessionId}
								onChange={event => setFilters({ ...filters, sessionId: event.target.checked ? sessionId : null })}
							/>
							<span>This session only</span>
						</label>
					)}
				</div>
				{rows.length === 0 ? (
					<div className="ws-empty">{audit.length === 0 ? "Nothing logged yet." : "No entries match these filters."}</div>
				) : (
					<table className="sf-table">
						<thead>
							<tr>
								<th scope="col">When</th>
								<th scope="col">Verdict</th>
								<th scope="col">Kind</th>
								<th scope="col">Action</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((entry, index) => (
								<tr key={`${entry.at}:${index}`}>
									<td className="sf-when" data-label="When">
										{auditTime(entry.at, Date.now())}
									</td>
									<td data-label="Verdict">
										<span className="sf-verdict" data-tone={verdictTone(entry.verdict)}>
											{VERDICT_LABEL[entry.verdict]}
										</span>
									</td>
									<td data-label="Kind">{entry.kinds.join(", ")}</td>
									<td className="sf-action" data-label="Action">
										<span>{entry.summary}</span>
										{entry.target && <code className="sf-target">{entry.target}</code>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
		</div>
	);
}
