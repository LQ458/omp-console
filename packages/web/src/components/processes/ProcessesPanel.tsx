import type { ProcessInfo, ProcessPoliciesRequest } from "@omp-console/protocol";
import { HardDrive, RefreshCw, Save, Search, Square, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { recordUsage } from "../../lib/journal";
import { confirmAndStopProcess, filterProcesses, policyHours, processAction, processActionLabel, processAge, processKindLabel, processRss, totalRssBytes, type ProcessAction } from "../../lib/processes";
import { fmtBytes, relTime } from "../../lib/format";
import "./processes.css";

export interface ProcessesPanelProps {
	api: DeckApi;
	confirmAction?: (message: string) => boolean;
}

function confirmDefault(message: string): boolean {
	return typeof window === "undefined" || window.confirm(message);
}

export function ProcessesPanel({ api, confirmAction = confirmDefault }: ProcessesPanelProps): ReactNode {
	const [processes, setProcesses] = useState<ProcessInfo[]>([]);
	const [policies, setPolicies] = useState<{ idleStopAfterMs: number | null; rssWarnBytes: number }>({ idleStopAfterMs: null, rssWarnBytes: 1.5 * 1024 ** 3 });
	const [idleHours, setIdleHours] = useState("off");
	const [rssGb, setRssGb] = useState("1.5");
	const [query, setQuery] = useState("");
	const [state, setState] = useState<ProcessInfo["state"] | "all">("all");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		setError(null);
		try {
			const response = await api.processes();
			setProcesses(response.processes);
			setPolicies(response.policies);
			setIdleHours(policyHours(response.policies.idleStopAfterMs));
			setRssGb((response.policies.rssWarnBytes / 1024 ** 3).toFixed(2).replace(/\.00$/, ""));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Process inventory could not be loaded.");
		} finally {
			setLoading(false);
		}
	}, [api]);

	useEffect(() => {
		void load();
		recordUsage({ feature: "13.processes", action: "open", outcome: "ok", via: "direct", screen: "processes" });
	}, [load]);

	const visible = useMemo(() => filterProcesses(processes, query, state), [processes, query, state]);
	const total = totalRssBytes(processes);
	const overWarning = processes.filter(process => process.rssBytes > policies.rssWarnBytes);

	const stop = async (process: ProcessInfo): Promise<void> => {
		const action = processAction(process);
		if (action === null || busy !== null) return;
		const label = processActionLabel(action);
		let started = false;
		try {
			const result = await confirmAndStopProcess(process, confirmAction, async pid => {
				started = true;
				setBusy(pid);
				await api.stopProcess(pid);
			});
			if (result !== "stopped") return;
			setMessage(`${label} requested for PID ${process.pid}.`);
			recordUsage({ feature: "13.processes", action, outcome: "ok", via: "direct", screen: "processes", detail: String(process.pid) });
			await load();
		} catch (err) {
			setMessage(err instanceof Error ? err.message : `Could not ${label.toLowerCase()} PID ${process.pid}.`);
			recordUsage({ feature: "13.processes", action, outcome: "error", via: "direct", screen: "processes", detail: String(process.pid) });
		} finally {
			if (started) setBusy(null);
		}
	};

	const savePolicies = async (): Promise<void> => {
		const hours = idleHours.trim().toLowerCase() === "off" || idleHours.trim() === "" ? null : Number(idleHours);
		const gb = Number(rssGb);
		if ((hours !== null && (!Number.isFinite(hours) || hours < 0)) || !Number.isFinite(gb) || gb <= 0) {
			setMessage("Enter a non-negative idle duration or off, and an RSS warning above zero.");
			return;
		}
		const next: ProcessPoliciesRequest = { idleStopAfterMs: hours === null ? null : hours * 3_600_000, rssWarnBytes: gb * 1024 ** 3 };
		try {
			await api.setProcessPolicies(next);
			setPolicies(next);
			setMessage("Process policies saved.");
			recordUsage({ feature: "13.processes", action: "save-policies", outcome: "ok", via: "direct", screen: "processes" });
		} catch (err) {
			setMessage(err instanceof Error ? err.message : "Process policies could not be saved.");
			recordUsage({ feature: "13.processes", action: "save-policies", outcome: "error", via: "direct", screen: "processes" });
		}
	};

	return (
		<div className="pr-panel">
			<div className="pr-head"><div><div className="pr-kicker"><HardDrive size={13} aria-hidden /> Live process set</div><h3>Processes</h3><p>omp console workers are safe to stop; terminal omp sessions always require a separate confirmation.</p></div><button type="button" className="pr-icon-btn" onClick={() => void load()} disabled={loading} title="refresh processes" aria-label="refresh processes"><RefreshCw size={14} className={loading ? "pr-spin" : undefined} aria-hidden /></button></div>
			{message ? <div className="pr-message" role="status">{message}</div> : null}
			{error ? <div className="pr-error" role="alert">{error}</div> : null}
			<section className="pr-summary" aria-label="process totals"><div><span>Total tree RSS</span><strong>{fmtBytes(total)}</strong></div><div><span>Visible</span><strong>{visible.length}/{processes.length}</strong></div><div><span>Policy</span><strong>{fmtBytes(policies.rssWarnBytes)} / worker</strong></div></section>
			{overWarning.length > 0 ? <div className="pr-warning" role="alert"><TriangleAlert size={14} aria-hidden /><span>{overWarning.length} {overWarning.length === 1 ? "process tree is" : "process trees are"} over the RSS warning policy.</span></div> : null}
			<div className="pr-filters"><label className="pr-search"><Search size={13} aria-hidden /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter PID, cwd, kind…" aria-label="filter processes" /></label><select value={state} onChange={event => setState(event.target.value as ProcessInfo["state"] | "all")} aria-label="filter process state"><option value="all">All states</option><option value="active">Active</option><option value="idle">Idle</option><option value="orphan">Orphan</option></select></div>
			<section className="pr-table-wrap" aria-label="process table">
				<table className="pr-table"><thead><tr><th>Process</th><th>State</th><th>Age</th><th>Tree RSS</th><th>Session write</th><th>Action</th></tr></thead><tbody>{visible.map(process => <ProcessRow key={process.pid} process={process} busy={busy === process.pid} onStop={() => void stop(process)} />)}</tbody></table>
				{!loading && visible.length === 0 ? <div className="pr-empty">No processes match this filter.</div> : null}
			</section>
			<section className="pr-policy" aria-label="process policies"><div className="pr-section-title">Policies <span>opt-in</span></div><div className="pr-policy-grid"><label>Idle-stop omp console workers<input value={idleHours} onChange={event => setIdleHours(event.target.value)} placeholder="off" inputMode="decimal" /><small>hours, or off; never while streaming or asking</small></label><label>RSS warning<input value={rssGb} onChange={event => setRssGb(event.target.value)} inputMode="decimal" /><small>GB per process tree</small></label></div><button type="button" className="pr-btn pr-btn-primary" onClick={() => void savePolicies()}><Save size={13} aria-hidden /> Save policies</button></section>
		</div>
	);
}

function actionControl(action: ProcessAction | null, busy: boolean, onStop: () => void): ReactNode {
	if (!action) return <span className="pr-na">—</span>;
	return <button type="button" className={action === "kill" ? "pr-btn pr-btn-danger" : "pr-btn"} disabled={busy} onClick={onStop}><Square size={11} aria-hidden /> {busy ? "Sending…" : processActionLabel(action)}</button>;
}

function ProcessRow({ process, busy, onStop }: { process: ProcessInfo; busy: boolean; onStop(): void }): ReactNode {
	const action = processAction(process);
	return (
		<tr className={`pr-row pr-row-${process.state}`}>
			<td>
				<div className="pr-command"><strong>{processKindLabel(process.kind)}</strong><span>PID {process.pid} · PPID {process.ppid}</span></div>
				<code title={process.command}>{process.command}</code>
				{process.cwd ? <small title={process.cwd}>{process.cwd}</small> : null}
				<div className="pr-mobile-action">{actionControl(action, busy, onStop)}</div>
			</td>
			<td><span className={`pr-state pr-state-${process.state}`}>{process.state}</span>{process.reason ? <small>{process.reason}</small> : null}</td>
			<td>{processAge(process)}</td>
			<td>{processRss(process)}</td>
			<td>{process.lastSessionWriteAt ? relTime(process.lastSessionWriteAt) : "—"}</td>
			<td>{actionControl(action, busy, onStop)}</td>
		</tr>
	);
}
