/**
 * Prompt history and drafts, per session.
 *
 * - History: the prompts sent in a session, oldest first, last {@link HISTORY_LIMIT} kept. Up/Down in an empty
 *   composer walks it ({@link HistoryCursor}).
 * - Draft: the unsent text of a session's composer. It survives switching panes and sessions and reloads, so
 *   a half-written prompt is not lost when the pane is reused.
 *
 * Both live in `localStorage` under the session's key. Storage that is missing or refuses a write (private mode,
 * quota) falls back to memory for the life of the page, so the feature degrades instead of failing.
 */
import { browserStorage, type KeyValueStorage } from "./storage";

export const HISTORY_LIMIT = 100;
/** A prompt longer than this is not kept in history (it would crowd out the quota; the draft path still holds it). */
export const MAX_HISTORY_ENTRY_CHARS = 8_000;

const HISTORY_PREFIX = "omp-console-prompts:";
/** Composer text per session; distinct from the draft plan (`omp-console-plan-draft:`, draft.ts). */
const DRAFT_PREFIX = "omp-console-composer-draft:";

const PROMPT_USE_PREFIX = "omp-console-prompt-uses:";
const PROMPT_USE_LIMIT = HISTORY_LIMIT;
const PROMPT_USE_COUNT_LIMIT = 100_000;
const EMPTY_ENTRIES: readonly string[] = [];
const EMPTY_PROMPT_USES: readonly PromptUse[] = [];

export interface PromptUse {
	key: string;
	count: number;
	at: number;
}

/** The canonical key shared by prompt history counts and phone-action ranking. */
export function normalizePromptUse(text: string): string {
	return text
		.normalize("NFKC")
		.trim()
		.replace(/\s+/gu, " ")
		.replace(/[.!?…。！？,，;；:：]+$/u, "")
		.trim()
		.toLowerCase();
}

/** A bounded local key; usage storage never duplicates the prompt text. */
export function promptUseKey(text: string): string {
	const normalized = normalizePromptUse(text);
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < normalized.length; index++) {
		const character = normalized.charCodeAt(index);
		first = Math.imul(first ^ character, 0x01000193);
		second = Math.imul(second ^ character, 0x85ebca6b);
	}
	return `v1-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

function isPromptUse(value: unknown): value is PromptUse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.key === "string" &&
		/^v1-[0-9a-z]+-[0-9a-z]+$/u.test(candidate.key) &&
		Number.isSafeInteger(candidate.count) &&
		typeof candidate.count === "number" &&
		candidate.count > 0 &&
		typeof candidate.at === "number" &&
		Number.isFinite(candidate.at);
}

export class PromptHistory {
	readonly #storage: KeyValueStorage | undefined;
	readonly #limit: number;
	/** Used only for keys whose storage read or write failed. */
	readonly #memory = new Map<string, string>();
	readonly #entryCache = new Map<string, readonly string[]>();
	readonly #promptUseCache = new Map<string, readonly PromptUse[]>();

	constructor(storage: KeyValueStorage | undefined, limit = HISTORY_LIMIT) {
		this.#storage = storage;
		this.#limit = limit;
	}

	entries(sessionKey: string): readonly string[] {
		const cached = this.#entryCache.get(sessionKey);
		if (cached !== undefined) return cached;
		const raw = this.#read(HISTORY_PREFIX + sessionKey);
		if (raw === null) {
			this.#entryCache.set(sessionKey, EMPTY_ENTRIES);
			return EMPTY_ENTRIES;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			const entries = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
			this.#entryCache.set(sessionKey, entries);
			return entries;
		} catch {
			this.#entryCache.set(sessionKey, EMPTY_ENTRIES);
			return EMPTY_ENTRIES;
		}
	}

	/** Bounded, timestamped counts for sent prompts; records contain hashes, never prompt text. */
	promptUses(sessionKey: string): readonly PromptUse[] {
		const cached = this.#promptUseCache.get(sessionKey);
		if (cached !== undefined) return cached;
		const raw = this.#read(PROMPT_USE_PREFIX + sessionKey);
		if (raw === null) {
			this.#promptUseCache.set(sessionKey, EMPTY_PROMPT_USES);
			return EMPTY_PROMPT_USES;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			const uses = Array.isArray(parsed) ? parsed.filter(isPromptUse).slice(-PROMPT_USE_LIMIT) : [];
			this.#promptUseCache.set(sessionKey, uses);
			return uses;
		} catch {
			this.#promptUseCache.set(sessionKey, EMPTY_PROMPT_USES);
			return EMPTY_PROMPT_USES;
		}
	}

	push(sessionKey: string, prompt: string): void {
		const text = prompt.trim();
		if (text === "" || text.length > MAX_HISTORY_ENTRY_CHARS) return;
		const key = promptUseKey(text);
		const uses = [...this.promptUses(sessionKey)];
		const existingIndex = uses.findIndex(use => use.key === key);
		const at = Date.now();
		if (existingIndex >= 0) {
			const existing = uses[existingIndex]!;
			uses[existingIndex] = { key, count: Math.min(existing.count + 1, PROMPT_USE_COUNT_LIMIT), at };
		} else {
			if (uses.length >= PROMPT_USE_LIMIT) {
				let oldestIndex = 0;
				for (let index = 1; index < uses.length; index++) {
					if (uses[index]!.at < uses[oldestIndex]!.at) oldestIndex = index;
				}
				uses.splice(oldestIndex, 1);
			}
			uses.push({ key, count: 1, at });
		}
		this.#promptUseCache.set(sessionKey, uses);
		this.#write(PROMPT_USE_PREFIX + sessionKey, JSON.stringify(uses));

		const entries = this.entries(sessionKey);
		if (entries[entries.length - 1] !== text) {
			const next = [...entries, text].slice(-this.#limit);
			this.#entryCache.set(sessionKey, next);
			this.#write(HISTORY_PREFIX + sessionKey, JSON.stringify(next));
		}
		if (typeof window !== "undefined") window.dispatchEvent(new Event(PROMPT_HISTORY_CHANGED_EVENT));
	}

	loadDraft(sessionKey: string): string {
		return this.#read(DRAFT_PREFIX + sessionKey) ?? "";
	}

	/** An empty draft removes the stored one. */
	saveDraft(sessionKey: string, text: string): void {
		const key = DRAFT_PREFIX + sessionKey;
		if (text === "") this.#remove(key);
		else this.#write(key, text);
	}

	/** Drops cached state after another same-origin tab changes local history. */
	invalidateStorageKey(key: string | null): void {
		if (key === null) {
			this.#entryCache.clear();
			this.#promptUseCache.clear();
			this.#memory.clear();
			return;
		}
		this.#memory.delete(key);
		if (key.startsWith(HISTORY_PREFIX)) this.#entryCache.delete(key.slice(HISTORY_PREFIX.length));
		if (key.startsWith(PROMPT_USE_PREFIX)) this.#promptUseCache.delete(key.slice(PROMPT_USE_PREFIX.length));
	}

	#read(key: string): string | null {
		if (this.#memory.has(key)) return this.#memory.get(key) ?? null;
		try {
			return this.#storage?.getItem(key) ?? null;
		} catch {
			return null;
		}
	}

	#write(key: string, value: string): void {
		try {
			if (this.#storage) {
				this.#storage.setItem(key, value);
				this.#memory.delete(key);
				return;
			}
		} catch {
			// fall through to memory
		}
		this.#memory.set(key, value);
	}

	#remove(key: string): void {
		this.#memory.delete(key);
		try {
			this.#storage?.removeItem(key);
		} catch {
			// nothing stored that we could remove
		}
	}
}

/** The page's history: prompts and drafts of every session, in `localStorage`. */
export const promptHistory = new PromptHistory(browserStorage());

export const PROMPT_HISTORY_CHANGED_EVENT = "omp-console:prompt-history-changed";
if (typeof window !== "undefined") {
	window.addEventListener("storage", event => {
		if (
			event.key !== null &&
			!event.key.startsWith(HISTORY_PREFIX) &&
			!event.key.startsWith(PROMPT_USE_PREFIX)
		) {
			return;
		}
		promptHistory.invalidateStorageKey(event.key);
		window.dispatchEvent(new Event(PROMPT_HISTORY_CHANGED_EVENT));
	});
}

export interface CaretLines {
	/** No line break before the caret. */
	onFirstLine: boolean;
	/** No line break after the caret. */
	onLastLine: boolean;
}

export function caretLines(text: string, caret: number): CaretLines {
	return { onFirstLine: !text.slice(0, caret).includes("\n"), onLastLine: !text.slice(caret).includes("\n") };
}

/**
 * Walks a session's history from the composer, shell style: Up in an empty composer shows the newest prompt, Up
 * again an older one, Down returns toward the newest and finally to the empty composer. Browsing ends as soon as
 * the text differs from the entry shown (the user edited it), after which the arrows move the caret as usual.
 * In a multi-line entry the arrows first move the caret and step only from its first (Up) or last (Down) line.
 */
export class HistoryCursor {
	#index: number | null = null;

	get browsing(): boolean {
		return this.#index !== null;
	}

	/** Forget the position: a prompt was sent, or the composer was cleared or retargeted. */
	reset(): void {
		this.#index = null;
	}

	/** The text to show, or null when the key is not a history step and should move the caret instead. */
	step(direction: "up" | "down", text: string, entries: readonly string[], lines: CaretLines): string | null {
		if (this.#index === null) {
			if (direction === "down" || text !== "" || entries.length === 0) return null;
			this.#index = entries.length - 1;
			return entries[this.#index]!;
		}
		if (entries[this.#index] !== text) {
			this.#index = null;
			return null;
		}
		if (direction === "up") {
			if (!lines.onFirstLine || this.#index === 0) return null;
			this.#index -= 1;
			return entries[this.#index]!;
		}
		if (!lines.onLastLine) return null;
		if (this.#index === entries.length - 1) {
			this.#index = null;
			return "";
		}
		this.#index += 1;
		return entries[this.#index]!;
	}
}
