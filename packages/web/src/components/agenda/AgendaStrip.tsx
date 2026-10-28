import type { AgendaItem, AgendaToday } from "@omp-console/protocol";
import { OMP_CONSOLE_SESSION_URL_PREFIX } from "@omp-console/protocol";
import { CalendarDays } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import "./agenda.css";

export interface AgendaStripProps {
	api: Pick<DeckApi, "agendaToday">;
	canOpenSession(sessionId: string): boolean;
	onOpenSession(sessionId: string): void;
}

const AgendaStartSessionContext = createContext<((item: AgendaItem) => void) | null>(null);

export function AgendaStartSessionProvider({
	children,
	onStartSession,
}: {
	children: ReactNode;
	onStartSession(item: AgendaItem): void;
}): ReactNode {
	return <AgendaStartSessionContext.Provider value={onStartSession}>{children}</AgendaStartSessionContext.Provider>;
}

function agendaSessionId(item: AgendaItem): string | null {
	if (item.sessionId) return item.sessionId;
	if (!item.url?.startsWith(OMP_CONSOLE_SESSION_URL_PREFIX)) return null;
	const id = item.url.slice(OMP_CONSOLE_SESSION_URL_PREFIX.length);
	try {
		return decodeURIComponent(id);
	} catch {
		return null;
	}
}

export function agendaShouldShow(today: AgendaToday | null): boolean {
	return today?.available === true;
}

export function agendaTaskPrompt(item: AgendaItem): string {
	const due = item.due === undefined ? "not set" : new Date(item.due).toISOString();
	return `Task from my agenda: ${item.title}\n${item.notes ?? ""}\nDue: ${due}`;
}

export interface AgendaTaskRowProps {
	item: AgendaItem;
	canOpenSession(sessionId: string): boolean;
	onOpenSession(sessionId: string): void;
	onStartSession?(item: AgendaItem): void;
}

/** "Overdue · Oct 22", "Today 13:30", "Tomorrow", "Mon Oct 27"; a time only when the task has one (not midnight). */
export function agendaDueLabel(due: number | undefined, now: number = Date.now()): { text: string; overdue: boolean } | null {
	if (due === undefined) return null;
	const date = new Date(due);
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const dayMs = 24 * 60 * 60 * 1000;
	const days = Math.floor((new Date(due).setHours(0, 0, 0, 0) - start.getTime()) / dayMs);
	const timed = date.getHours() !== 0 || date.getMinutes() !== 0;
	const time = timed ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
	const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	if (days < 0 || (days === 0 && timed && due < now)) {
		return { text: days < 0 ? `Overdue · ${day}` : `Overdue · ${time}`, overdue: true };
	}
	if (days === 0) return { text: timed ? `Today ${time}` : "Today", overdue: false };
	if (days === 1) return { text: timed ? `Tomorrow ${time}` : "Tomorrow", overdue: false };
	const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
	return { text: `${weekday} ${day}${timed ? ` ${time}` : ""}`, overdue: false };
}

export function AgendaTaskRow({ item, canOpenSession, onOpenSession, onStartSession }: AgendaTaskRowProps): ReactNode {
	const sessionId = agendaSessionId(item);
	const due = agendaDueLabel(item.due);
	const dueLabel = due && (
		<span className={due.overdue ? "dk-agenda-due dk-agenda-due-late" : "dk-agenda-due"}>{due.text}</span>
	);
	return (
		<li>
			{sessionId !== null ? (
				<button
					type="button"
					disabled={!canOpenSession(sessionId)}
					onClick={() => onOpenSession(sessionId)}
					aria-label={`Open session: ${item.title}${due ? ` (${due.text})` : ""}`}
					title={item.title}
				>
					<span className="dk-agenda-title">{item.title}</span>
					{dueLabel}
					<span className="dk-agenda-action">Open session</span>
				</button>
			) : (
				<button
					type="button"
					disabled={onStartSession === undefined}
					onClick={() => onStartSession?.(item)}
					aria-label={`Start session: ${item.title}${due ? ` (${due.text})` : ""}`}
					title={item.title}
				>
					<span className="dk-agenda-title">{item.title}</span>
					{dueLabel}
					<span className="dk-agenda-action">Start session</span>
				</button>
			)}
		</li>
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "The request failed.";
}

export function AgendaStrip({ api, canOpenSession, onOpenSession }: AgendaStripProps): ReactNode {
	const onStartSession = useContext(AgendaStartSessionContext);
	const [today, setToday] = useState<AgendaToday | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [request, setRequest] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		let inFlight = false;
		setLoading(true);
		setError(null);
		const load = (): void => {
			if (inFlight) return;
			inFlight = true;
			void api
				.agendaToday(controller.signal)
				.then(result => {
					if (controller.signal.aborted) return;
					setToday(result);
					setError(null);
				})
				.catch((reason: unknown) => {
					if (!controller.signal.aborted) setError(errorText(reason));
				})
				.finally(() => {
					inFlight = false;
					if (!controller.signal.aborted) setLoading(false);
				});
		};
		load();
		const interval = window.setInterval(load, 10_000);
		return () => {
			window.clearInterval(interval);
			controller.abort();
		};
	}, [api, request]);

	if (today !== null && !agendaShouldShow(today)) return null;
	const items = today?.items ?? [];
	return (
		<section className="dk-agenda dk-content-enter" aria-label="Today's agenda" aria-busy={today === null && loading}>
			<header className="dk-agenda-head">
				<CalendarDays size={15} />
				<strong>Today</strong>
				<span>{items.length}</span>
			</header>
			{today === null && loading ? (
				<div className="dk-agenda-skeleton dk-content-enter" role="status" aria-label="Loading agenda">
					<span className="dk-skeleton" />
					<span className="dk-skeleton" />
				</div>
			) : error ? (
				<div className="dk-agenda-error dk-content-enter" role="alert" title={error}>
					<span>Agenda could not be loaded: {error}</span>
					<button type="button" className="sh-btn" onClick={() => setRequest(value => value + 1)}>Retry</button>
				</div>
			) : items.length === 0 ? (
				<p className="dk-agenda-empty dk-content-enter">
					Nothing on today&apos;s agenda. Start a session from the sessions list when work comes up.
				</p>
			) : (
				<ul className="dk-content-enter">
					{items.map(item => (
						<AgendaTaskRow
							key={item.uid}
							item={item}
							canOpenSession={canOpenSession}
							onOpenSession={onOpenSession}
							onStartSession={onStartSession ?? undefined}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
