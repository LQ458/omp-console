/**
 * Knowledge quick-ask logic (grand-list 6): which sources a question may use, the shortcut, and how the answer's room
 * link is obtained while the hidden knowledge session is still starting.
 */
import type { QuickAskRequest, RoomLinkResponse } from "@omp-console/protocol";
import { DeckApiError } from "../../lib/api";
import type { KeyValueStorage } from "../../lib/storage";

export type QuickSource = NonNullable<QuickAskRequest["sources"]>[number];

export interface SourceOption {
	id: QuickSource;
	label: string;
	hint: string;
}

export const SOURCE_OPTIONS: readonly SourceOption[] = [
	{ id: "siyuan", label: "SiYuan", hint: "notes in your SiYuan workspace" },
	{ id: "repo", label: "Notes folder", hint: "files in the configured Notes folder" },
	{ id: "web", label: "Web", hint: "web search" },
	{ id: "history", label: "Past sessions", hint: "earlier omp sessions" },
];

const ORDER: readonly QuickSource[] = SOURCE_OPTIONS.map(o => o.id);

/** No source is selected until the user opts in to an allowed source. */
export const DEFAULT_SOURCES: readonly QuickSource[] = [];
export const SOURCES_KEY = "omp-console.quickAsk.sources";

function isSource(value: unknown): value is QuickSource {
	return typeof value === "string" && (ORDER as readonly string[]).includes(value);
}

/** Canonical order, no duplicates, unknown ids dropped. */
export function normalizeSources(sources: readonly unknown[]): QuickSource[] {
	return ORDER.filter(id => sources.includes(id));
}

export function loadSources(storage: KeyValueStorage | undefined, allowedSources: readonly QuickSource[] = DEFAULT_SOURCES): QuickSource[] {
	const allowed = normalizeSources(allowedSources);
	try {
		const raw = storage?.getItem(SOURCES_KEY);
		if (raw === null || raw === undefined) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? normalizeSources(parsed.filter(isSource)).filter(source => allowed.includes(source)) : [];
	} catch {
		return [];
	}
}

export function saveSources(storage: KeyValueStorage | undefined, sources: readonly QuickSource[]): void {
	try {
		storage?.setItem(SOURCES_KEY, JSON.stringify(sources));
	} catch {
		// storage unavailable: the choice lasts for this page only
	}
}

export function toggleSource(sources: readonly QuickSource[], id: QuickSource): QuickSource[] {
	return normalizeSources(sources.includes(id) ? sources.filter(s => s !== id) : [...sources, id]);
}

/** Why the question cannot be sent yet, or null. */
export function questionBlocker(question: string, sources: readonly QuickSource[]): string | null {
	if (question.trim() === "") return "Type a question.";
	if (sources.length === 0) return "Pick at least one source.";
	return null;
}

export interface ShortcutEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/** Cmd+J (Ctrl+J elsewhere), no other modifier. */
export function isQuickAskShortcut(event: ShortcutEvent): boolean {
	return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j";
}

export interface RoomLinkRetry {
	retries?: number;
	delayMs?: number;
	sleep?(ms: number): Promise<void>;
}

function wait(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** The room link of the answer session; a 409 means the worker is still starting, so retry a few times. */
export async function answerRoomLink(
	api: { roomLink(sessionId: string, permission: "view"): Promise<RoomLinkResponse> },
	sessionId: string,
	{ retries = 10, delayMs = 300, sleep = wait }: RoomLinkRetry = {},
): Promise<RoomLinkResponse> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await api.roomLink(sessionId, "view");
		} catch (err) {
			if (!(err instanceof DeckApiError) || err.kind !== "conflict" || attempt >= retries) throw err;
			await sleep(delayMs);
		}
	}
}
