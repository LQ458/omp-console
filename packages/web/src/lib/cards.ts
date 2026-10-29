import type { CardStatus, SessionCard, SessionSummary, TitleSource } from "@omp-console/protocol";
import type { DeckApi } from "./api";
import { basename, pathKey } from "./native-path";

export interface SessionCardView {
	card: SessionCard;
	summary?: SessionSummary;
	live: boolean;
	status: CardStatus;
}

export interface CardGroup {
	key: string;
	label: string;
	cards: SessionCardView[];
	scheduled: boolean;
	collapsible: boolean;
}

const EMPTY_TITLE_OVERRIDES: ReadonlyMap<string, string> = new Map();


function statusFromLive(session: SessionSummary, cardStatus?: CardStatus): CardStatus {
	if (session.awaitingAnswer || session.state === "asking") return "waiting";
	if (session.state === "stopped") return "done";
	if (session.state === "crashed") return "unfinished";
	if (cardStatus === "done" && session.state !== "streaming") return "done";
	return "unfinished";
}

function fallbackCard(session: SessionSummary, live: boolean): SessionCard {
	const title = session.title?.trim() || basename(session.cwd) || session.cwd || "/";
	const titleSource: TitleSource = session.title?.trim() ? "omp" : "deck";
	return {
		sessionId: session.id,
		cwd: session.cwd,
		title,
		titleSource,
		titleHistory: [],
		status: statusFromLive(session),
		stoppedAt: undefined,
		nextStep: undefined,
		topic: undefined,
		scheduled: false,
		pinned: session.pinned ?? false,
		live,
		lastActivityAt: session.lastActivityAt,
		stale: false,
	};
}

/** Card text comes from the librarian; current session state and activity come from the live list. */
export function mergeSessionCards(
	cards: readonly SessionCard[],
	liveSessions: readonly SessionSummary[],
	recentSessions: readonly SessionSummary[],
	titleOverrides: ReadonlyMap<string, string> = EMPTY_TITLE_OVERRIDES,
): SessionCardView[] {
	const liveById = new Set<string>();
	const summaries = new Map<string, SessionSummary>();
	for (const session of recentSessions) summaries.set(session.id, session);
	for (const session of liveSessions) {
		liveById.add(session.id);
		summaries.set(session.id, session);
	}

	const byId = new Map<string, SessionCardView>();
	const summaryFromCard = (card: SessionCard): SessionSummary => ({
		id: card.sessionId,
		title: card.title,
		cwd: card.cwd,
		sessionFile: card.sessionFile,
		pinned: card.pinned ?? false,
		state: "stopped",
		createdAt: card.lastActivityAt,
		lastActivityAt: card.lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	});
	for (const card of cards) {
		// A card older than the recent list still resumes from its own session file.
		const summary = summaries.get(card.sessionId) ?? (card.sessionFile ? summaryFromCard(card) : undefined);
		const live = liveById.has(card.sessionId) || (summary === undefined && card.live);
		const status = live && summary !== undefined ? statusFromLive(summary, card.status) : card.status;
		const cardTitle = card.title.trim();
		const summaryTitle = summary?.title?.trim();
		const titleOverride = titleOverrides.get(card.sessionId);
		const title =
			titleOverride ??
			(summaryTitle && (cardTitle === "" || cardTitle.toLowerCase() === "(no messages)") ? summaryTitle : card.title);
		const mergedCard: SessionCard = {
			...card,
			...(summary === undefined ? {} : { cwd: summary.cwd, lastActivityAt: summary.lastActivityAt, live }),
			title,
			status,
			pinned: card.pinned ?? summary?.pinned ?? false,
		};
		byId.set(card.sessionId, { card: mergedCard, summary, live, status });
	}

	for (const [id, summary] of summaries) {
		if (byId.has(id)) continue;
		const live = liveById.has(id);
		const fallback = fallbackCard(summary, live);
		byId.set(id, {
			card: { ...fallback, title: titleOverrides.get(id) ?? fallback.title },
			summary,
			live,
			status: fallback.status,
		});
	}

	return [...byId.values()].sort(
		(a, b) => b.card.lastActivityAt - a.card.lastActivityAt || a.card.sessionId.localeCompare(b.card.sessionId),
	);
}

/** Scheduled sessions never appear in the normal status/topic/project-folder groups. */
export type SessionCardGrouping = "status" | "topic" | "folder";

export function groupSessionCards(
	cards: readonly SessionCardView[],
	topics: readonly string[],
	grouping: SessionCardGrouping | boolean,
	now = Date.now(),
): CardGroup[] {
	const groups: CardGroup[] = [];
	const pinned = cards.filter(item => item.card.pinned === true);
	if (pinned.length > 0) groups.push({ key: "pinned", label: "Pinned", cards: pinned, scheduled: false, collapsible: false });
	const normal = cards.filter(item => !item.card.scheduled && item.card.pinned !== true);
	const scheduled = cards.filter(item => item.card.scheduled && item.card.pinned !== true);
	const selected = typeof grouping === "boolean" ? grouping ? "topic" : "status" : grouping;

	if (selected === "folder") {
		const buckets = new Map<string, { label: string; cards: SessionCardView[] }>();
		for (const item of normal) {
			const key = pathKey(item.card.cwd);
			const bucket = buckets.get(key);
			if (bucket === undefined) buckets.set(key, { label: item.card.cwd, cards: [item] });
			else bucket.cards.push(item);
		}
		for (const { label, cards: bucket } of [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label))) {
			groups.push({ key: `folder:${label}`, label, cards: bucket, scheduled: false, collapsible: false });
		}
	} else {
		const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;
		const recent = normal.filter(item => item.card.lastActivityAt >= recentCutoff);
		const older = normal.filter(item => item.card.lastActivityAt < recentCutoff);
		if (selected === "topic") {
			const buckets = new Map<string, SessionCardView[]>();
			for (const item of recent) {
				const topic = item.card.topic?.trim() || "";
				const bucket = buckets.get(topic) ?? [];
				bucket.push(item);
				buckets.set(topic, bucket);
			}
			const topicOrder = [...topics.filter(topic => buckets.has(topic)), ...[...buckets.keys()].filter(topic => topic !== "" && !topics.includes(topic)).sort()];
			if (buckets.has("")) topicOrder.push("");
			for (const topic of topicOrder) {
				const bucket = buckets.get(topic);
				if (bucket?.length) groups.push({ key: `topic:${topic}`, label: topic || "No topic", cards: bucket, scheduled: false, collapsible: false });
			}
		} else {
			for (const [status, label] of [
				["waiting", "Waiting on you"],
				["unfinished", "Unfinished"],
				["done", "Done"],
			] as const) {
				const bucket = recent.filter(item => item.status === status);
				if (bucket.length > 0) groups.push({ key: status, label, cards: bucket, scheduled: false, collapsible: false });
			}
		}
		if (older.length > 0) groups.push({ key: "older", label: "Older", cards: older, scheduled: false, collapsible: true });
	}
	if (scheduled.length > 0) {
		groups.push({ key: "scheduled", label: "Scheduled", cards: scheduled, scheduled: true, collapsible: true });
	}
	return groups;
}

export function optimisticTitle(
	overrides: ReadonlyMap<string, string>,
	sessionId: string,
	title: string,
): Map<string, string> {
	const next = new Map(overrides);
	next.set(sessionId, title);
	return next;
}

export function rollbackOptimisticTitle(overrides: ReadonlyMap<string, string>, sessionId: string): Map<string, string> {
	const next = new Map(overrides);
	next.delete(sessionId);
	return next;
}

export const CARD_GROUP_PREVIEW_SIZE = 5;

export function visibleCardsInGroup(group: CardGroup, expanded: boolean, scheduledOpen: boolean): SessionCardView[] {
	if (group.scheduled) return scheduledOpen ? group.cards : [];
	if (group.collapsible) return expanded ? group.cards : [];
	return expanded ? group.cards : group.cards.slice(0, CARD_GROUP_PREVIEW_SIZE);
}

export function hiddenCardsInGroup(group: CardGroup): number {
	return Math.max(0, group.cards.length - CARD_GROUP_PREVIEW_SIZE);
}

type TitleOverrideSetter = (
	update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>,
) => void;


export async function renameCardOptimistically(
	api: Pick<DeckApi, "setCardTitle">,
	sessionId: string,
	title: string,
	setOverrides: TitleOverrideSetter,
	saveCard: (card: SessionCard) => void,
): Promise<SessionCard> {
	setOverrides(current => optimisticTitle(current, sessionId, title));
	try {
		const updated = await api.setCardTitle(sessionId, title);
		saveCard(updated);
		return updated;
	} finally {
		setOverrides(current => rollbackOptimisticTitle(current, sessionId));
	}
}

export async function undoCardTitleOptimistically(
	api: Pick<DeckApi, "undoCardTitle">,
	sessionId: string,
	previousTitle: string,
	setOverrides: TitleOverrideSetter,
	saveCard: (card: SessionCard) => void,
): Promise<SessionCard> {
	setOverrides(current => optimisticTitle(current, sessionId, previousTitle));
	try {
		const updated = await api.undoCardTitle(sessionId);
		saveCard(updated);
		return updated;
	} finally {
		setOverrides(current => rollbackOptimisticTitle(current, sessionId));
	}
}
