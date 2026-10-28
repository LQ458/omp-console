/**
 * In-app alerts ("turn finished", "needs your answer", "worker crashed") for sessions other than
 * the one on screen.
 *
 * Two sources feed the same store and share a replace key: the page's own `notificationSignals`
 * (poll and live guest) and the service worker's `omp-console:push` message (a push that arrived while the
 * page was visible; the OS notification is already shown silently). The same `${sessionId}:${reason}`
 * tag replaces the earlier alert, so a signal and the push for one event show one toast.
 */
import type { PushPayload, PushReason } from "@omp-console/protocol";
import type { NotifySignal } from "./notifications";

export type AlertLevel = "info" | "warning" | "error";

export interface AlertInput {
	/** Replace key. */
	tag: string;
	sessionId: string;
	title: string;
	body: string;
	level: AlertLevel;
	/** How long the alert stays up. */
	ttlMs: number;
}

export interface Alert extends AlertInput {
	id: number;
}

export const MAX_ALERTS = 3;
const TTL_MS: Record<AlertLevel, number> = { info: 6_000, warning: 10_000, error: 15_000 };

export class AlertStore {
	#alerts: readonly Alert[] = [];
	#nextId = 1;
	readonly #listeners = new Set<() => void>();

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): readonly Alert[] {
		return this.#alerts;
	}

	/** Shows an alert; an existing one with the same tag is replaced and moves to the newest slot. */
	push(input: AlertInput): Alert {
		const alert: Alert = { ...input, id: this.#nextId++ };
		this.#alerts = [...this.#alerts.filter(a => a.tag !== input.tag), alert].slice(-MAX_ALERTS);
		this.#emit();
		return alert;
	}

	dismiss(id: number): void {
		if (!this.#alerts.some(a => a.id === id)) return;
		this.#alerts = this.#alerts.filter(a => a.id !== id);
		this.#emit();
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}

/** Background sessions only: the open session already shows its own state. */
export function alertFromSignal(signal: NotifySignal, openSessionId: string | null): AlertInput | null {
	if (signal.sessionId === openSessionId) return null;
	const asking = signal.reason === "needs-answer";
	return {
		tag: signal.tag,
		sessionId: signal.sessionId,
		title: signal.title,
		body: asking ? "Needs your answer" : "Turn finished",
		level: asking ? "warning" : "info",
		ttlMs: TTL_MS[asking ? "warning" : "info"],
	};
}

function levelFor(reason: PushReason): AlertLevel {
	if (reason === "worker-crashed") return "error";
	if (reason === "turn-finished") return "info";
	return "warning";
}

/**
 * A push received while the page is visible. For the open session, finishing a turn or asking is
 * already on screen; a crash is not, so it always shows.
 */
export function alertFromPush(payload: PushPayload, openSessionId: string | null): AlertInput | null {
	if (payload.sessionId === openSessionId && payload.reason !== "worker-crashed") return null;
	const level = levelFor(payload.reason);
	return {
		tag: payload.tag,
		sessionId: payload.sessionId,
		title: payload.title,
		body: payload.body,
		level,
		ttlMs: TTL_MS[level],
	};
}
