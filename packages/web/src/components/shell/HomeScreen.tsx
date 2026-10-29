import { Activity, Layers, Moon, RefreshCw, Settings, ShieldAlert, WifiOff } from "lucide-react";
import type { BriefLine, OvernightState, SessionSummary } from "@omp-console/protocol";
import type { ReactNode } from "react";

import { useEffect, useState } from "react";
import type { DeckApi, DeckApiError } from "../../lib/api";
import { basename } from "../../lib/native-path";
import type { LayoutMode } from "../../lib/layout";
import { AgendaStrip } from "../agenda/AgendaStrip";
import { ReturnBrief } from "../brief/ReturnBrief";
import { SetupChecklist } from "../setup/SetupChecklist";
import { OmpMark } from "./OmpMark";
import { overnightPhaseLabel } from "../../lib/overnight";

const OPENED_OVERNIGHT_REPORTS_KEY = "omp-console.overnight.reports.opened";
const SETUP_DISMISSED_KEY = "omp-console.setup.dismissed";

function readSetupDismissed(): boolean {
	try {
		return localStorage.getItem(SETUP_DISMISSED_KEY) === "true";
	} catch {
		return false;
	}
}

interface MorningReport {
	session: SessionSummary;
	state: OvernightState;
}

function readOpenedReports(): Set<string> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(OPENED_OVERNIGHT_REPORTS_KEY) ?? "[]");
		return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

function reportPreview(report: string): string {
	return report.split("\n").map(line => line.trim()).find(line => line !== "" && !line.startsWith("#"))?.replace(/^[-*]\s*/, "") ?? "Open to read the full morning report.";
}

function localDeadline(deadline: string): string {
	const date = new Date(deadline);
	if (Number.isNaN(date.getTime())) return deadline;
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export type HomeState = "not-authorized" | "unreachable" | "connecting" | "idle";

/** Which card the home screen shows. Authorization wins over reachability: retrying cannot fix it. */
export function homeState(authFailed: boolean, listError: DeckApiError | null, sessionsLoaded: boolean): HomeState {
	if (authFailed) return "not-authorized";
	if (listError) return "unreachable";
	return sessionsLoaded ? "idle" : "connecting";
}

export interface HomeScreenProps {
	state: HomeState;
	mode: LayoutMode;
	liveCount: number;
	/** A link in the address bar could not be joined. */
	linkError: string | null;
	onRetry(): void;
	onOpenSessions(): void;
	onOpenSessionList(): void;
	onOpenStatus(): void;
	onOpenSettings(): void;
	/** Optional features returned by the daemon capability endpoint; omitted values stay hidden. */
	librarianEnabled?: boolean;
	agendaEnabled?: boolean;
	overnightEnabled?: boolean;
	existingSessionCount?: number;
	setupApi?: Pick<DeckApi, "setup" | "getClaudeImportSummary">;
	/** Return brief and today's agenda; shown only once the daemon answers. */
	api: Pick<DeckApi, "brief" | "agendaToday">;
	overnightSessions: readonly SessionSummary[];
	loadOvernightState(sessionKey: string): Promise<OvernightState>;
	onOpenOvernight(sessionId: string, cwd: string): void;
	canOpenSession(sessionId: string, line?: BriefLine): boolean;
	onOpenSession(sessionId: string, line?: BriefLine): void;

}
/** Shown when no session is open: reachability and authorization problems, or a prompt to pick one. */
export function HomeScreen({
	state,
	mode,
	liveCount,
	linkError,
	onRetry,
	onOpenSessions,
	onOpenSessionList,
	onOpenStatus,
	onOpenSettings,
	api,
	librarianEnabled = false,
	agendaEnabled = false,
	overnightEnabled = false,
	existingSessionCount = 0,
	setupApi,
	canOpenSession,
	onOpenSession,
	overnightSessions,
	loadOvernightState,
	onOpenOvernight,
}: HomeScreenProps): ReactNode {
	const [openedReports, setOpenedReports] = useState(readOpenedReports);
	const [morningReports, setMorningReports] = useState<MorningReport[]>([]);
	const [setupDismissed, setSetupDismissed] = useState(readSetupDismissed);

	useEffect(() => {
		if (!overnightEnabled || state !== "idle" || overnightSessions.length === 0) {
			setMorningReports([]);
			return;
		}
		let active = true;
		void Promise.all(overnightSessions.map(async session => {
			try {
				const overnight = await loadOvernightState(session.id);
				return overnight.report ? { session, state: overnight } : null;
			} catch {
				return null;
			}
		})).then(results => {
			if (active) setMorningReports(results.filter((item): item is MorningReport => item !== null));
		});
		return () => {
			active = false;
		};
	}, [state, overnightEnabled, overnightSessions, loadOvernightState]);

	const visibleReports = overnightEnabled ? morningReports.filter(item => !openedReports.has(item.session.id)) : [];
	const openMorningReport = (item: MorningReport): void => {
		const next = new Set(openedReports);
		next.add(item.session.id);
		setOpenedReports(next);
		try {
			localStorage.setItem(OPENED_OVERNIGHT_REPORTS_KEY, JSON.stringify([...next]));
		} catch {
			// The report still opens; a blocked store only means the card may return after reload.
		}
		onOpenOvernight(item.session.id, item.session.cwd);
	};
	const dismissSetup = (): void => {
		setSetupDismissed(true);
		try {
			localStorage.setItem(SETUP_DISMISSED_KEY, "true");
		} catch {
			// Keep the checklist dismissed for this render when local storage is unavailable.
		}
	};
	return (
		<div className="sh-connect" data-state={state}>
			<div className="sh-ambient" />
			<div className="sh-connect-top">
				<div className="sh-brand">
					<OmpMark />
					<span>omp console</span>
				</div>
				<div className="dk-home-actions">
					{mode === "phone" && (
						<button type="button" className="dk-tap" onClick={onOpenSessions} aria-label="sessions" title="sessions">
							<Layers size={20} />
						</button>
					)}
					<button type="button" className="dk-tap" onClick={onOpenStatus} aria-label="status" title="status">
						<Activity size={mode === "phone" ? 20 : 15} />
					</button>
					<button type="button" className="dk-tap" onClick={onOpenSettings} aria-label="settings" title="settings">
						<Settings size={mode === "phone" ? 20 : 15} />
					</button>
				</div>
			</div>
			{state === "idle" && visibleReports.length > 0 && (
				<div className="dk-morning-reports" aria-label="Morning reports">
					{visibleReports.map(item => (
						<button
							type="button"
							key={item.session.id}
							className="dk-morning-report-card"
							aria-label={`Open morning report for ${item.session.title || item.session.cwd}`}
							onClick={() => openMorningReport(item)}
						>
							<Moon size={17} aria-hidden="true" />
							<span>
								<strong>Morning report · {item.session.title?.trim() || basename(item.session.cwd) || "Session"}</strong>
								<small>{overnightPhaseLabel(item.state.phase)} · deadline {localDeadline(item.state.policy.deadline)}</small>
							</span>
							<small>{reportPreview(item.state.report ?? "")}</small>
						</button>
					))}
				</div>
			)}
			<div key={state} className="sh-connect-card dk-home-card dk-content-enter" role={state === "idle" ? undefined : "alert"} aria-busy={state === "connecting"}>
				{state === "not-authorized" && (
					<>
						<ShieldAlert size={28} className="dk-home-icon dk-home-icon-err" />
						<h1 className="sh-connect-title">Not authorized</h1>
						<p className="sh-connect-sub">
							The daemon refused this device. Open omp console on the Mac it runs on, or through your tailnet address:
							the daemon only trusts those.
						</p>
						<button type="button" className="dk-wide-btn" onClick={onRetry}>
							<RefreshCw size={16} />
							Try again
						</button>
					</>
				)}
				{state === "unreachable" && (
					<>
						<WifiOff size={28} className="dk-home-icon dk-home-icon-warn" />
						<h1 className="sh-connect-title">Daemon unreachable</h1>
						<p className="sh-connect-sub">
							omp console cannot reach its daemon. Check that it is running and that this device is on the tailnet. Retrying
							every 3 s.
						</p>
						<button type="button" className="dk-wide-btn" onClick={onRetry}>
							<RefreshCw size={16} />
							Retry now
						</button>
					</>
				)}
				{state === "connecting" && (
					<>
						<span className="sh-banner-dot dk-home-pulse" />
						<h1 className="sh-connect-title">Connecting to the daemon…</h1>
						<div className="dk-home-skeleton" aria-hidden="true">
							<span className="dk-skeleton" />
							<span className="dk-skeleton" />
							<span className="dk-skeleton" />
						</div>
					</>
				)}
				{state === "idle" && (
					<>
						<h1 className="sh-connect-title">{liveCount === 0 && existingSessionCount === 0 ? "Welcome to omp console" : "Pick a session"}</h1>
						<p className="sh-connect-sub">
							{liveCount === 0
								? existingSessionCount === 0
									? "omp console lets you start and manage omp sessions from a browser."
									: "No live sessions. Open an existing session or start a new one."
								: `${liveCount} live session${liveCount === 1 ? "" : "s"} running. Open one to watch or prompt it.`}
						</p>
						{(mode === "phone" || liveCount === 0) && (
							<button type="button" className="dk-wide-btn dk-wide-btn-primary" onClick={existingSessionCount > 0 ? onOpenSessionList : onOpenSessions}>
								<Layers size={16} />
								{liveCount === 0 && existingSessionCount === 0 ? "Start your first session" : "Open sessions"}
							</button>
						)}
					</>
				)}
				{linkError && <div className="sh-connect-error">{linkError}</div>}
			</div>
			{state === "idle" && setupApi && !setupDismissed && (
				<SetupChecklist api={setupApi} onStartSession={onOpenSessions} onOpenExistingSessions={onOpenSessionList} onDismiss={dismissSetup} />
			)}
			{state === "idle" && (
				<>
					{librarianEnabled && <ReturnBrief api={api} canOpenSession={canOpenSession} onOpenSession={onOpenSession} homeVisible />}
					{agendaEnabled && <AgendaStrip api={api} canOpenSession={canOpenSession} onOpenSession={onOpenSession} />}
				</>
			)}
		</div>
	);
}
