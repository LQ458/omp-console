import type { ConversationMessage } from "./ports";

const TAIL_BYTES = 128 * 1024;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 6_000;
/** Enough of a reply's start for a notification's first sentence. */
const LATEST_REPLY_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function messageFromEntry(entry: unknown): ConversationMessage | undefined {
	if (!isRecord(entry)) return undefined;
	if (entry.type === "custom_message" && entry.customType === "collab-prompt") {
		const text = contentText(entry.content);
		return text === undefined ? undefined : { role: "user", text };
	}
	if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const role = entry.message.role;
	if (role !== "user" && role !== "assistant") return undefined;
	const text = contentText(entry.message.content);
	return text === undefined ? undefined : { role, text };
}

/** Keeps only the newest few user/assistant messages and at most about 6 KB of text. */
export function boundConversation(messages: readonly ConversationMessage[]): ConversationMessage[] {
	const selected = messages.slice(-MAX_MESSAGES);
	const bounded: ConversationMessage[] = [];
	let remaining = MAX_MESSAGE_CHARS;
	for (let index = selected.length - 1; index >= 0 && remaining > 0; index--) {
		const message = selected[index]!;
		const text = message.text.trim();
		if (!text) continue;
		const clipped = text.length > remaining ? text.slice(-remaining) : text;
		bounded.unshift({ role: message.role, text: clipped });
		remaining -= clipped.length;
	}
	return bounded;
}


/** Parsed entries from a bounded tail of an omp JSONL session file; a partial first or last record is skipped. */
async function readTailEntries(sessionFile: string): Promise<unknown[]> {
	const file = Bun.file(sessionFile);
	const start = Math.max(0, file.size - TAIL_BYTES);
	let text = await file.slice(start).text();
	if (start > 0) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline < 0) return [];
		text = text.slice(firstNewline + 1);
	}
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as unknown);
		} catch {
			// A partial final JSONL record is not an entry.
		}
	}
	return entries;
}

/** Reads a bounded tail of an omp JSONL session file and extracts its newest user/assistant messages. */
export async function readSessionConversation(sessionFile: string): Promise<ConversationMessage[]> {
	try {
		const messages: ConversationMessage[] = [];
		for (const entry of await readTailEntries(sessionFile)) {
			const message = messageFromEntry(entry);
			if (message) messages.push(message);
		}
		return boundConversation(messages);
	} catch {
		return [];
	}
}

/**
 * The agent's reply since the last prompt, from its start (a notification quotes its first sentence). Undefined when
 * the newest agent message has no text (it ended on a tool call) or nothing answered the last prompt yet.
 */
export async function readLatestAgentReply(sessionFile: string): Promise<string | undefined> {
	try {
		let latest: string | undefined;
		for (const entry of await readTailEntries(sessionFile)) {
			const message = isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
			if (message?.role === "assistant") latest = contentText(message.content)?.slice(0, LATEST_REPLY_CHARS);
			else if (message?.role === "user" || (isRecord(entry) && entry.customType === "collab-prompt")) latest = undefined;
		}
		return latest;
	} catch {
		return undefined;
	}
}
