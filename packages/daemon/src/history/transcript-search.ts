import * as fs from "node:fs/promises";
import type { SessionSummary, TranscriptSearchHit, TranscriptSearchResponse } from "@omp-console/protocol";
import { findCaseInsensitiveMatch } from "./search-text";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_HITS = 50;
const SEARCH_BUDGET_MS = 3_000;
const SNIPPET_CONTEXT = 72;

interface TranscriptEntry {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	createdAt?: unknown;
	customType?: unknown;
	message?: unknown;
	content?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const parts: string[] = [];
	for (const part of value) {
		if (isObject(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function messageText(entry: TranscriptEntry): string | undefined {
	if (entry.type === "custom_message" && entry.customType === "collab-prompt") {
		return textContent(entry.content);
	}
	if (entry.type !== "message" || !isObject(entry.message)) return undefined;
	if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
	return textContent(entry.message.content);
}

function entryTime(entry: TranscriptEntry, fallback: number): number {
	const raw = entry.timestamp ?? entry.createdAt;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function makeHit(session: SessionSummary, entry: TranscriptEntry, text: string, query: string): TranscriptSearchHit | undefined {
	const match = findCaseInsensitiveMatch(text, query);
	if (match === null) return undefined;
	const start = Math.max(0, match.start - SNIPPET_CONTEXT);
	const end = Math.min(text.length, match.end + SNIPPET_CONTEXT);
	return {
		sessionId: session.id,
		title: session.title ?? session.id,
		snippet: text.slice(start, end),
		matchStart: match.start - start,
		matchEnd: match.end - start,
		at: entryTime(entry, session.lastActivityAt),
		...(typeof entry.id === "string" && entry.id !== "" ? { entryId: entry.id } : {}),
	};
}


/**
 * Scans trusted, already-listed session files newest-first. `resolveFile` must enforce the daemon's session-store
 * boundary before a path is read.
 */
export async function searchTranscriptFiles(
	sessions: readonly SessionSummary[],
	query: string,
	resolveFile: (file: string) => Promise<string>,
	now = Date.now,
	signal?: AbortSignal,
): Promise<TranscriptSearchResponse> {
	const deadline = now() + SEARCH_BUDGET_MS;
	const unique = new Map<string, SessionSummary>();
	for (const session of sessions) {
		if (!session.hidden && session.sessionFile && !unique.has(session.id)) unique.set(session.id, session);
	}
	const newestFirst = [...unique.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	const results: TranscriptSearchHit[] = [];
	const buffer = new Uint8Array(64 * 1024);
	let scannedSessions = 0;
	let truncated = false;

	for (const session of newestFirst) {
		if (signal?.aborted || results.length >= MAX_HITS || now() >= deadline) {
			truncated = true;
			break;
		}
		let file: string;
		try {
			file = await resolveFile(session.sessionFile!);
		} catch {
			continue;
		}

		let sessionHits: TranscriptSearchHit[] = [];
		let sessionHitOverflow = false;
		let complete = false;
		try {
			const handle = await fs.open(file, "r");
			try {
				const info = await handle.stat();
				if (!info.isFile()) {
					complete = true;
				} else {
					const start = Math.max(0, info.size - MAX_FILE_BYTES);
					const decoder = new TextDecoder();
					let pending = "";
					let position = start;
					let skipFirstLine = start > 0;
					const visitLine = (line: string): void => {
						if (skipFirstLine) {
							skipFirstLine = false;
							return;
						}
						if (!line.startsWith("{")) return;
						let parsed: unknown;
						try {
							parsed = JSON.parse(line);
						} catch {
							return;
						}
						if (!isObject(parsed)) return;
						const entry = parsed as TranscriptEntry;
						const content = messageText(entry);
						if (content === undefined) return;
						const hit = makeHit(session, entry, content, query);
						if (hit === undefined) return;
						if (sessionHits.length === MAX_HITS) {
							sessionHits.shift();
							sessionHitOverflow = true;
						}
						sessionHits.push(hit);
					};

					while (position < info.size) {
						if (now() >= deadline || signal?.aborted) break;
						const length = Math.min(buffer.byteLength, info.size - position);
						const { bytesRead } = await handle.read(buffer, 0, length, position);
						if (bytesRead === 0) break;
						position += bytesRead;
						if (now() >= deadline || signal?.aborted) break;
						pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: position < info.size });
						let newline = pending.indexOf("\n");
						while (newline !== -1) {
							visitLine(pending.slice(0, newline));
							pending = pending.slice(newline + 1);
							newline = pending.indexOf("\n");
						}
					}
					if (position >= info.size && !signal?.aborted && now() < deadline) {
						pending += decoder.decode();
						if (pending !== "") visitLine(pending);
						complete = true;
					}
				}
			} finally {
				await handle.close();
			}
		} catch {
			continue;
		}
		if (!complete) {
			truncated = true;
			break;
		}
		scannedSessions++;
		const orderedSessionHits = sessionHits.reverse();
		const availableHits = MAX_HITS - results.length;
		results.push(...orderedSessionHits.slice(0, availableHits));
		if (sessionHitOverflow || orderedSessionHits.length > availableHits) {
			truncated = true;
			break;
		}
	}
	if (!truncated && results.length >= MAX_HITS && scannedSessions < newestFirst.length) truncated = true;
	return { results, truncated, scannedSessions };
}
