/**
 * Notification signals: "this session needs your answer" and "this session's turn finished".
 *
 * Signals are derived from state the page already has: the live guest (`uiRequest`, `working`) for
 * the connected session and the daemon's polled `SessionSummary` list for every other one. Each
 * `${sessionId}:${reason}` fires once per occurrence: it latches when fired and re-arms when the
 * condition clears (the ask is answered, a new turn starts), so a repeated poll, a resync or two
 * sources reporting the same event never double-notify.
 *
 * Delivery: every signal reaches subscribers (the PWA wave can show an in-page toast or a service
 * worker notification from there). While the page is hidden it also calls the Android shell's
 * `window.OmpConsoleAndroid.notify(title, body, tag)`; the same tag replaces the previous notification
 * instead of stacking. The bridge cannot wake a suspended app: this only helps while the process
 * is alive (see apps/android/README.md).
 */
import type { SessionSummary } from "@omp-console/protocol";
import type { ConnectionPhase } from "./client";

export type NotifyReason = "needs-answer" | "turn-finished";

export interface NotifySignal {
	sessionId: string;
	reason: NotifyReason;
	title: string;
	body: string;
	/** `${sessionId}:${reason}`: the replace key for the Android bridge and Web Push. */
	tag: string;
	/** The page was hidden when the signal fired. */
	hidden: boolean;
	/** The Android bridge accepted the notification. */
	deliveredToAndroid: boolean;
}

/** Injected by the Android shell (apps/android); absent in browsers. */
export interface OmpConsoleAndroidBridge {
	available: true;
	version: number;
	notify(title: string, body: string, tag?: string, actions?: OmpConsoleAndroidAction[]): boolean;
}

/** One answer button on an Android notification: the shell posts `{token, value}` to `/api/push/answer` on tap. */
export interface OmpConsoleAndroidAction {
	title: string;
	value: string;
	token: string;
	url: string;
}

/** One-tap choices for a session's open question (`POST /api/push/answer-options`); null when there are none. */
export interface AnswerOptions {
	choices: string[];
	answerToken: string;
	/** What the buttons answer (the command, for an approval): shown as the notification body. */
	question?: string;
}

declare global {
	interface Window {
		OmpConsoleAndroid?: OmpConsoleAndroidBridge;
	}
}

export interface NotifyEnv {
	isHidden(): boolean;
	bridge(): OmpConsoleAndroidBridge | undefined;
	/** Answer buttons for an open question; only the Android shell renders them. */
	answerOptions?(sessionId: string, reason: NotifyReason): Promise<AnswerOptions | null>;
}

/** What the guest snapshot contributes for the connected session. */
export interface GuestView {
	phase: ConnectionPhase;
	working: boolean;
	/** Pending host-side ask: its request id and question. */
	ask: { reqId: number; title: string } | null;
}

const BODY_FINISHED = "Turn finished";
const BODY_ASKING = "Waiting for your answer";
const DEFAULT_TITLE = "omp console";

interface TauriInternals {
	invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** The Mac app (apps/mac): its `native_notify` command, shaped like the Android bridge. Absent in browsers. */
export function tauriNotifyBridge(): OmpConsoleAndroidBridge | undefined {
	if (typeof window === "undefined") return undefined;
	const invoke = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.invoke;
	if (typeof invoke !== "function") return undefined;
	return {
		available: true,
		version: 1,
		notify: (title, body) => {
			invoke("native_notify", { title, body }).catch(() => {});
			return true;
		},
	};
}

export function browserNotifyEnv(): NotifyEnv {
	const mac = tauriNotifyBridge();
	return {
		// A Mac app notifies whenever it is not frontmost (hidden with Cmd+W, or another app focused); a page notifies
		// only when it is hidden.
		isHidden: () => document.visibilityState === "hidden" || (mac !== undefined && !document.hasFocus()),
		bridge: () => window.OmpConsoleAndroid ?? mac,
		answerOptions: window.OmpConsoleAndroid === undefined ? undefined : fetchAnswerOptions,
	};
}

async function fetchAnswerOptions(sessionId: string, reason: NotifyReason): Promise<AnswerOptions | null> {
	try {
		const response = await fetch("/api/push/answer-options", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, reason }),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { choices?: unknown; answerToken?: unknown; question?: unknown };
		const choices = Array.isArray(body.choices) ? body.choices.filter((choice): choice is string => typeof choice === "string") : [];
		if (typeof body.answerToken !== "string" || choices.length === 0 || choices.length > 3) return null;
		return { choices, answerToken: body.answerToken, ...(typeof body.question === "string" && body.question !== "" ? { question: body.question } : {}) };
	} catch {
		return null;
	}
}

function isBusy(state: SessionSummary["state"]): boolean {
	return state === "streaming" || state === "asking";
}

export class NotificationSignals {
	readonly #env: NotifyEnv;
	readonly #listeners = new Set<(signal: NotifySignal) => void>();
	/** Last known "a turn is running" per session, from whichever source observed it. */
	readonly #working = new Map<string, boolean>();
	/** Fired and not yet re-armed; the value is the ask id when the source knew one. */
	readonly #latched = new Map<string, string | undefined>();
	/** Session whose live guest is the source of truth; the poll skips it (it lags the socket). */
	#guestSession: string | null = null;

	constructor(env: NotifyEnv) {
		this.#env = env;
	}

	subscribe(listener: (signal: NotifySignal) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Feeds the connected session. A connection that is not live yet (or any more) is ignored. */
	observeGuest(sessionId: string, title: string | undefined, view: GuestView): void {
		if (view.phase !== "live") return;
		this.#guestSession = sessionId;
		const wasWorking = this.#working.get(sessionId);
		this.#working.set(sessionId, view.working);
		if (wasWorking === undefined) {
			// First sight is a baseline, not an event: opening a session that is already asking stays quiet.
			if (view.ask !== null) this.#latched.set(`${sessionId}:needs-answer`, String(view.ask.reqId));
			return;
		}
		if (view.ask !== null) {
			this.#fire(sessionId, "needs-answer", title, view.ask.title || BODY_ASKING, String(view.ask.reqId));
		} else {
			this.#rearm(sessionId, "needs-answer");
		}
		if (view.working) this.#rearm(sessionId, "turn-finished");
		else if (wasWorking) this.#fire(sessionId, "turn-finished", title, BODY_FINISHED);
	}

	/** The connected session's view is gone (switched away, left); the poll takes over for it. */
	releaseGuest(sessionId: string): void {
		if (this.#guestSession === sessionId) this.#guestSession = null;
	}

	/** Feeds the daemon's live session list. The session the guest is live on is skipped. */
	observeSummaries(live: readonly SessionSummary[]): void {
		const present = new Set<string>();
		for (const session of live) {
			present.add(session.id);
			if (session.id === this.#guestSession) continue;
			const asking = session.awaitingAnswer || session.state === "asking";
			const busy = isBusy(session.state);
			const wasWorking = this.#working.get(session.id);
			this.#working.set(session.id, busy);
			if (wasWorking === undefined) {
				if (asking) this.#latched.set(`${session.id}:needs-answer`, undefined);
				continue;
			}
			if (asking) this.#fire(session.id, "needs-answer", session.title, BODY_ASKING);
			else this.#rearm(session.id, "needs-answer");
			if (busy) this.#rearm(session.id, "turn-finished");
			else if (wasWorking && session.state === "idle") {
				this.#fire(session.id, "turn-finished", session.title, BODY_FINISHED);
			}
		}
		// A session that left the list (stopped) starts from a fresh baseline if it comes back.
		for (const id of [...this.#working.keys()]) {
			if (present.has(id) || id === this.#guestSession) continue;
			this.#working.delete(id);
			this.#rearm(id, "needs-answer");
			this.#rearm(id, "turn-finished");
		}
	}

	#rearm(sessionId: string, reason: NotifyReason): void {
		this.#latched.delete(`${sessionId}:${reason}`);
	}

	#fire(sessionId: string, reason: NotifyReason, title: string | undefined, body: string, askId?: string): void {
		const tag = `${sessionId}:${reason}`;
		if (this.#latched.has(tag)) {
			// Already notified. Only a different, known ask id is a new occurrence.
			const previous = this.#latched.get(tag);
			if (askId === undefined || previous === undefined || previous === askId) return;
		}
		this.#latched.set(tag, askId);
		const heading = title !== undefined && title !== "" ? title : DEFAULT_TITLE;
		const hidden = this.#env.isHidden();
		let deliveredToAndroid = false;
		if (hidden) {
			const bridge = this.#env.bridge();
			try {
				deliveredToAndroid = bridge?.notify(heading, body, tag) === true;
			} catch {
				deliveredToAndroid = false; // a broken bridge must not break the page
			}
			// A one-tap question: re-post the same notification (same tag replaces it) with answer buttons.
			if (deliveredToAndroid && reason === "needs-answer" && this.#env.answerOptions) {
				void this.#env.answerOptions(sessionId, reason).then(options => {
					if (options === null || this.#latched.get(tag) !== askId) return;
					const url = new URL(`/#session=${encodeURIComponent(sessionId)}`, window.location.origin).href;
					const actions = options.choices.map(value => ({ title: value, value, token: options.answerToken, url }));
					try {
						bridge?.notify(heading, options.question ?? body, tag, actions);
					} catch {
						// keep the plain notification
					}
				});
			}
		}
		const signal: NotifySignal = { sessionId, reason, title: heading, body, tag, hidden, deliveredToAndroid };
		for (const listener of this.#listeners) {
			try {
				listener(signal);
			} catch {
				// one subscriber's failure must not starve the others
			}
		}
	}
}

let shared: NotificationSignals | null = null;

/** The page-wide instance the app feeds; PWA code subscribes to it. */
export function notificationSignals(): NotificationSignals {
	shared ??= new NotificationSignals(browserNotifyEnv());
	return shared;
}
