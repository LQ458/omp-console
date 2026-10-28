import type { SessionTranscriptMessage, SessionTranscriptResponse } from "@omp-console/protocol";

const MAX_TAIL_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_RESPONSE_CHARS = 500_000;

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

function messageFromEntry(entry: unknown): SessionTranscriptMessage | undefined {
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

/** Reads a bounded tail without starting or modifying the session's agent. */
export async function readSessionTranscript(sessionFile: string): Promise<SessionTranscriptResponse> {
	const file = Bun.file(sessionFile);
	const start = Math.max(0, file.size - MAX_TAIL_BYTES);
	let text = await file.slice(start).text();
	if (start > 0) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline < 0) return { messages: [], truncated: true };
		text = text.slice(firstNewline + 1);
	}

	const parsed: SessionTranscriptMessage[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const message = messageFromEntry(JSON.parse(line) as unknown);
			if (message?.text.trim()) parsed.push(message);
		} catch {
			// Incomplete JSONL records are skipped; other valid transcript entries remain readable.
		}
	}

	let truncated = start > 0 || parsed.length > MAX_MESSAGES;
	const messages: SessionTranscriptMessage[] = [];
	let remaining = MAX_RESPONSE_CHARS;
	for (const message of parsed.slice(-MAX_MESSAGES)) {
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const text = message.text.slice(0, Math.min(MAX_MESSAGE_CHARS, remaining));
		if (text.length < message.text.length) truncated = true;
		messages.push({ role: message.role, text });
		remaining -= text.length;
	}
	return { messages, truncated };
}
