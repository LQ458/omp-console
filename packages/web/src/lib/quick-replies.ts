import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { browserStorage, type KeyValueStorage } from "./storage";

export const DEFAULT_QUICK_REPLIES = ["Continue", "Yes", "Try again", "Explain", "Run tests"] as const;
export const QUICK_REPLIES_STORAGE_KEY = "omp-console.quick-replies";
export const QUICK_REPLIES_CHANGED_EVENT = "omp-console:quick-replies-changed";
const EDIT_AFTER_CHARACTERS = 12;


function normalize(replies: readonly string[]): string[] {
	const seen = new Set<string>();
	const next: string[] = [];
	for (const reply of replies) {
		const trimmed = reply.trim();
		if (trimmed === "" || seen.has(trimmed)) continue;
		seen.add(trimmed);
		next.push(trimmed);
	}
	return next;
}

export function readQuickReplies(storage: KeyValueStorage | undefined = browserStorage()): string[] {
	if (storage === undefined) return [...DEFAULT_QUICK_REPLIES];
	try {
		const raw = storage.getItem(QUICK_REPLIES_STORAGE_KEY);
		if (raw === null) return [...DEFAULT_QUICK_REPLIES];
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value) || !value.every((reply): reply is string => typeof reply === "string")) {
			return [...DEFAULT_QUICK_REPLIES];
		}
		return normalize(value);
	} catch {
		return [...DEFAULT_QUICK_REPLIES];
	}
}

/** Saves a one-reply-per-line edit; false means browser storage was unavailable. */
export function writeQuickReplies(text: string, storage: KeyValueStorage | undefined = browserStorage()): boolean {
	if (storage === undefined) return false;
	try {
		storage.setItem(QUICK_REPLIES_STORAGE_KEY, JSON.stringify(normalize(text.split(/\r?\n/))));
		return true;
	} catch {
		return false;
	}
}

export function quickReplyDisposition(reply: string, generated: boolean, phoneTile = false): "send" | "edit" {
	if (phoneTile && generated) return reply.trim().endsWith("…") ? "edit" : "send";
	return generated || [...reply.trim()].length > EDIT_AFTER_CHARACTERS ? "edit" : "send";
}

/** Current-branch tail only: old assistant text is not offered after a newer user prompt or tool-only turn. */
export function latestAgentAnswerEntryId(entries: readonly SessionEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		if (entry.message.role === "user") return null;
		if (entry.message.role !== "assistant") continue;
		return entry.message.content.some(block => block.type === "text" && block.text.trim() !== "") ? entry.id : null;
	}
	return null;
}
