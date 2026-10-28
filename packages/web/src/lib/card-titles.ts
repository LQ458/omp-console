/**
 * Session titles as the session list shows them (librarian card titles), shared with headers and pane tabs so a
 * session is called the same thing everywhere. The list publishes what it loaded; the last set is kept in storage so
 * a phone that opens straight into a session (list sheet never mounted) still names it.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "omp-console.cardTitles";
const USER_STORAGE_KEY = "omp-console.cardTitles.user";
/** Titles kept in storage; the list shows far fewer recent sessions than this. */
const STORED_LIMIT = 400;

let titles: ReadonlyMap<string, string> = readStored(STORAGE_KEY);
/** Titles the user set (rename), by session id: these win over omp's own session title everywhere. */
let userTitles: ReadonlyMap<string, string> = readStored(USER_STORAGE_KEY);
/** Renames saved here but not yet in the list's cards (it polls every 30 s): kept until a card confirms them. */
const pendingRenames = new Map<string, { title: string | null; at: number }>();
const PENDING_RENAME_MS = 120_000;
const listeners = new Set<() => void>();

function readStored(storageKey: string): ReadonlyMap<string, string> {
	try {
		const raw = globalThis.localStorage?.getItem(storageKey);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (!Array.isArray(parsed)) return new Map();
		const entries = parsed.filter(
			(pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string",
		);
		return new Map(entries);
	} catch {
		return new Map();
	}
}

/** A peer card is keyed `<machine>:<id>`; panes know the raw id. Both find the same title. */
function rawId(key: string): string {
	const colon = key.indexOf(":");
	return colon === -1 ? key : key.slice(colon + 1);
}

function sameMap(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
	return left.size === right.size && [...left].every(([id, title]) => right.get(id) === title);
}

function store(storageKey: string, map: ReadonlyMap<string, string>): void {
	try {
		globalThis.localStorage?.setItem(storageKey, JSON.stringify([...map]));
	} catch {
		// Storage full or blocked: titles still apply for this page.
	}
}

/** Replaces the known titles with the list's latest cards (most recent first). */
export function publishCardTitles(cards: ReadonlyArray<{ sessionId: string; title: string; titleSource?: string }>): void {
	const next = new Map<string, string>();
	const nextUser = new Map<string, string>();
	for (const card of cards) {
		const title = card.title.trim();
		if (!title || next.size >= STORED_LIMIT) continue;
		next.set(card.sessionId, title);
		if (card.titleSource === "user") nextUser.set(rawId(card.sessionId), title);
	}
	// A list loaded before a rename must not undo it: pending renames win until a card agrees or they expire.
	const now = Date.now();
	for (const [id, pending] of pendingRenames) {
		const confirmed = (nextUser.get(id) ?? null) === pending.title;
		if (confirmed || now - pending.at > PENDING_RENAME_MS) {
			pendingRenames.delete(id);
			continue;
		}
		if (pending.title === null) nextUser.delete(id);
		else nextUser.set(id, pending.title);
	}
	if (sameMap(next, titles) && sameMap(nextUser, userTitles)) return;
	titles = next;
	userTitles = nextUser;
	store(STORAGE_KEY, titles);
	store(USER_STORAGE_KEY, userTitles);
	for (const listener of listeners) listener();
}

/** A rename just saved (pane header or list): applies at once, before the list's next poll. Empty clears it. */
export function rememberUserTitle(sessionId: string, title: string | null): void {
	const id = rawId(sessionId);
	const next = new Map(userTitles);
	const text = title?.trim();
	pendingRenames.set(id, { title: text || null, at: Date.now() });
	if (text) next.set(id, text);
	else next.delete(id);
	if (sameMap(next, userTitles)) return;
	userTitles = next;
	store(USER_STORAGE_KEY, userTitles);
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useCardTitle(sessionId: string | undefined): string | undefined {
	return useSyncExternalStore(
		subscribe,
		() => (sessionId ? titles.get(sessionId) ?? findByRawId(sessionId) : undefined),
		() => undefined,
	);
}

function findByRawId(sessionId: string): string | undefined {
	for (const [key, title] of titles) if (rawId(key) === sessionId) return title;
	return undefined;
}

/** The title the user gave this session, if any. */
export function useUserTitle(sessionId: string | undefined): string | undefined {
	const read = (): string | undefined => (sessionId ? userTitles.get(rawId(sessionId)) : undefined);
	return useSyncExternalStore(subscribe, read, read);
}

const PROMPT_TITLE_CHARS = 80;

/** The first user prompt, one line, as a last-resort name for a session nobody titled yet. */
export function firstPromptTitle(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.map(part => (part.type === "text" ? part.text : ""))
						.join(" ");
		const line = text.replace(/\s+/g, " ").trim();
		if (line) return line.length > PROMPT_TITLE_CHARS ? `${line.slice(0, PROMPT_TITLE_CHARS - 1)}…` : line;
	}
	return undefined;
}

/** Name for a session: the user's own title, then omp's title, then the list's title, then its first prompt. */
export function sessionDisplayTitle(parts: {
	userTitle?: string;
	headerTitle?: string | null;
	sessionName?: string | null;
	cardTitle?: string;
	promptTitle?: string;
}): string {
	for (const candidate of [parts.userTitle, parts.headerTitle, parts.sessionName, parts.cardTitle, parts.promptTitle]) {
		const text = candidate?.trim();
		if (text) return text;
	}
	return "session";
}
