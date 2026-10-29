/**
 * "Needs you": which sessions are blocked on the person, for the sticky bar at the top of the app.
 *
 * Sources of truth: the connected session's live guest (an ask arrives and clears on the socket, so
 * it is faster than the poll), and the daemon's polled `SessionSummary` list for every other
 * session. The session whose ask form is already on screen in the composer is left out of the bar:
 * a second copy of the same question would add a tap target that does nothing new.
 */
import type { SessionState, SessionSummary } from "@omp-console/protocol";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { basename } from "./native-path";

export type NeedsYouKind = "ask" | "approval";

export interface NeedsYouItem {
	sessionId: string;
	title: string;
	kind: NeedsYouKind;
	/** The question when known (only for the connected session); empty otherwise. */
	question: string;
	state: SessionState;
	/** When the session was last active: the bar lists the longest-waiting session first. */
	since: number;
}

/** What the page knows about the connected session. */
export interface OpenSessionView {
	/** Daemon id of the connected session; null for none or a manually joined link. */
	sessionId: string | null;
	/** The guest is live: its ask state is current and the composer can answer. */
	live: boolean;
	/** The guest may answer (not a read-only link). */
	canAnswer: boolean;
	/** Pending ask of the connected session. */
	ask: CollabUiRequest | null;
}

const AFFIRMATIVE = /^(approve|allow|yes|accept|proceed|continue|run|ok|okay|grant|confirm)\b/i;
const NEGATIVE = /^(deny|reject|no|decline|block|don'?t|do not|abort|skip|refuse)\b/i;
const APPROVAL_TITLE = /\b(approv\w*|permission|allow|grant|authori[sz]\w*)\b/i;

function optionLabels(request: CollabUiRequest): string[] {
	if (request.kind !== "select") return [];
	return request.options.map(option => (typeof option === "string" ? option : option.label).trim());
}

/** A select that offers an affirmative and a negative choice (or says it asks permission) is an approval. */
export function classifyAsk(request: CollabUiRequest): NeedsYouKind {
	if (request.kind !== "select") return "ask";
	const labels = optionLabels(request);
	const yes = labels.some(label => AFFIRMATIVE.test(label));
	const no = labels.some(label => NEGATIVE.test(label));
	if (yes && no) return "approval";
	if (yes && APPROVAL_TITLE.test(request.title)) return "approval";
	return "ask";
}

function isAwaiting(session: SessionSummary): boolean {
	return session.awaitingAnswer || session.state === "asking";
}

function titleOf(session: SessionSummary): string {
	const title = session.title?.trim();
	if (title) return title;
	return basename(session.cwd) || "session";
}

export function selectNeedsYou(live: readonly SessionSummary[], open: OpenSessionView): NeedsYouItem[] {
	const items: NeedsYouItem[] = [];
	for (const session of live) {
		const isOpen = session.id === open.sessionId;
		let awaiting = isAwaiting(session);
		let ask: CollabUiRequest | null = null;
		if (isOpen && open.live) {
			ask = open.ask;
			awaiting = ask !== null;
			// Composer shows it and the guest can answer: nothing to add in the bar.
			if (awaiting && open.canAnswer) continue;
		}
		if (!awaiting || session.state === "stopped" || session.state === "crashed") continue;
		const kind = ask ? classifyAsk(ask) : (session.pendingKind ?? "ask");
		items.push({
			sessionId: session.id,
			title: titleOf(session),
			kind,
			question: ask?.title ?? session.pendingQuestion ?? "",
			state: session.state,
			since: session.lastActivityAt,
		});
	}
	return items.sort((a, b) => a.since - b.since);
}
