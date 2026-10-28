import type { AgendaItem, AgendaToday } from "@omp-console/protocol";
import { OMP_CONSOLE_SESSION_URL_PREFIX } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";

const AGENDA_POLL_MS = 10_000;

export interface AgendaSessionActionViewProps {
	item: AgendaItem | null;
	busy: boolean;
	message: string | null;
	error: string | null;
	onMarkDone(): void;
}

export function AgendaSessionActionView({ item, busy, message, error, onMarkDone }: AgendaSessionActionViewProps): ReactNode {
	if (item === null && message === null && error === null) return null;
	return (
		<div className="dk-agenda-session-action">
			{item !== null && (
				<button
					type="button"
					className="dk-tap dk-agenda-mark-done"
					disabled={busy}
					aria-busy={busy}
					onClick={onMarkDone}
				>
					{busy ? "Marking…" : "Mark task done"}
				</button>
			)}
			{message !== null && <span role="status">{message}</span>}
			{error !== null && <span className="dk-agenda-action-error" role="alert">{error}</span>}
		</div>
	);
}

function linkedOpenTask(today: AgendaToday, sessionId: string): AgendaItem | null {
	if (!today.available) return null;
	const url = `${OMP_CONSOLE_SESSION_URL_PREFIX}${encodeURIComponent(sessionId)}`;
	return today.items.find(item => !item.completed && (item.sessionId === sessionId || item.url === url)) ?? null;
}

export function AgendaSessionAction({
	api,
	sessionId,
}: {
	api: Pick<DeckApi, "agendaToday" | "completeAgendaTodo">;
	sessionId: string;
}): ReactNode {
	const [item, setItem] = useState<AgendaItem | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		let inFlight = false;
		const refresh = (): void => {
			if (inFlight) return;
			inFlight = true;
			void api
				.agendaToday(controller.signal)
				.then(today => {
					if (controller.signal.aborted) return;
					setItem(linkedOpenTask(today, sessionId));
					setError(null);
				})
				.catch(() => {
					// A failed poll (daemon restarting, hub slow) keeps the last known state quietly: the session header
					// is no place for a transient agenda error, and the next poll retries.
				})
				.finally(() => {
					inFlight = false;
				});
		};
		refresh();
		const interval = window.setInterval(refresh, AGENDA_POLL_MS);
		return () => {
			window.clearInterval(interval);
			controller.abort();
		};
	}, [api, sessionId]);

	const markDone = async (): Promise<void> => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			await api.completeAgendaTodo({ sessionId });
			setItem(null);
			setMessage("Task marked done.");
		} catch {
			setError("The linked task could not be marked done.");
		} finally {
			setBusy(false);
		}
	};

	return <AgendaSessionActionView item={item} busy={busy} message={message} error={error} onMarkDone={() => void markDone()} />;
}
