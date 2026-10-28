import type { ImprovementReport, JournalResponse } from "@omp-console/protocol";
import { RefreshCw, WandSparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { journal, recordUsage } from "../../lib/journal";
import { sessionOpError } from "../../lib/session-ops";
import { Markdown } from "../transcript/Markdown";
import "./session-ops.css";

export interface ImproveDeckSectionProps {
	api: DeckApi;
}

export function ImproveDeckSection({ api }: ImproveDeckSectionProps): ReactNode {
	const [report, setReport] = useState<ImprovementReport | null>(null);
	const [journalData, setJournalData] = useState<JournalResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [generating, setGenerating] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = useCallback(async (record = false): Promise<void> => {
		setLoading(true);
		setError(null);
		setNotice(null);
		const [reportResult, journalResult] = await Promise.allSettled([api.report(), api.readJournal()]);
		if (reportResult.status === "fulfilled") setReport(reportResult.value);
		if (journalResult.status === "fulfilled") setJournalData(journalResult.value);
		const failures = [reportResult, journalResult].filter(result => result.status === "rejected");
		if (failures.length > 0) setError(failures.map(result => result.status === "rejected" ? sessionOpError(result.reason) : "").join(" "));
		if (record) recordUsage({ feature: "0.7.report", action: "refresh", outcome: failures.length === 0 ? "ok" : "error", via: "direct", screen: "settings" });
		setLoading(false);
	}, [api]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const generate = async (): Promise<void> => {
		if (generating) return;
		setGenerating(true);
		setError(null);
		setNotice(null);
		try {
			await api.requestReport();
			const latest = await api.report();
			setReport(latest);
			setNotice(latest ? "Report generated." : "Generation was requested; refresh to check when the report is ready.");
			recordUsage({ feature: "0.7.report", action: "generate", outcome: "ok", via: "direct", screen: "settings" });
		} catch (cause) {
			setError(sessionOpError(cause));
			recordUsage({ feature: "0.7.report", action: "generate", outcome: "error", via: "direct", screen: "settings" });
		} finally {
			setGenerating(false);
		}
	};

	const clear = async (): Promise<void> => {
		setError(null);
		try {
			recordUsage({ feature: "0.7.report", action: "clear-journal", outcome: "ok", via: "direct", screen: "settings" });
			await journal.flush();
			await api.clearJournal();
			setJournalData({ events: [], feedback: [] });
			setConfirmClear(false);
			setNotice("Journal cleared.");
		} catch (cause) {
			setError(sessionOpError(cause));
			recordUsage({ feature: "0.7.report", action: "clear-journal", outcome: "error", via: "direct", screen: "settings" });
		}
	};

	return (
		<section className="dk-settings-section so-section" aria-label="improve omp console">
			<h3 className="dk-section-title">Improve omp console</h3>
			<p className="dk-hint">Generate a report from usage journal and feedback. Reports do not include transcripts.</p>
			<div className="so-action-row">
				<button type="button" className="dk-wide-btn so-primary" disabled={generating} onClick={() => void generate()}><WandSparkles size={15} />{generating ? "Generating…" : "Generate report"}</button>
				<button type="button" className="dk-wide-btn so-secondary" disabled={loading} onClick={() => void refresh(true)}><RefreshCw size={14} />Refresh</button>
			</div>
			<div className="so-suggestion-equivalent">omp console report API · no direct omp CLI command</div>
			{loading && <p className="dk-hint" role="status">Loading report and journal…</p>}
			{report ? (
				<article className="so-report" aria-label="latest improvement report">
					<p className="dk-hint">Generated {new Date(report.generatedAt).toLocaleString()} · {report.path}</p>
					<div className="so-report-body">
						<Markdown text={report.markdown} />
					</div>
				</article>
			) : !loading && <p className="dk-hint">No report has been generated.</p>}
			{notice && <p className="so-success" role="status">{notice}</p>}
			{error && <p className="so-error" role="alert">{error}</p>}
			<details className="so-journal-viewer">
				<summary>Usage journal {journalData ? `· ${journalData.events.length} events · ${journalData.feedback.length} feedback entries` : ""}</summary>
				{journalData ? (
					<div className="so-journal-list">
						{journalData.events.map((event, index) => (
							<div className="so-journal-row" key={`${event.at}:${index}`}>
								<strong>{event.feature} · {event.action}</strong><span>{event.outcome}</span>
								<span>{new Date(event.at).toLocaleString()}{event.screen ? ` · ${event.screen}` : ""}{event.via ? ` · ${event.via}` : ""}</span>
								{event.detail && <span>{event.detail}</span>}
							</div>
						))}
						{journalData.feedback.map((entry, index) => (
							<div className="so-journal-row" key={`feedback:${entry.at}:${index}`}>
								<strong>Feedback · {entry.feature ?? entry.screen}</strong><span>{new Date(entry.at).toLocaleString()}</span>
								<p>{entry.text}</p>
							</div>
						))}
						{journalData.events.length === 0 && journalData.feedback.length === 0 && <p className="dk-hint">No journal entries.</p>}
					</div>
				) : <p className="dk-hint">Journal is unavailable until it loads.</p>}
				{confirmClear ? (
					<div className="so-warning" role="alertdialog" aria-label="confirm journal clear">
						<p>Delete all usage events and feedback from this journal?</p>
						<div className="so-action-row">
							<button type="button" className="dk-wide-btn" onClick={() => setConfirmClear(false)}>Cancel</button>
							<button type="button" className="dk-wide-btn so-danger" onClick={() => void clear()}>Clear journal</button>
						</div>
					</div>
				) : (
					<button type="button" className="dk-wide-btn so-secondary" disabled={journalData === null || journalData.events.length + journalData.feedback.length === 0} onClick={() => setConfirmClear(true)}>Clear journal</button>
				)}
			</details>
		</section>
	);
}
