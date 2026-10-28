import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { TranscriptSearchHit } from "@omp-console/protocol";
import type { OfflineCachedTranscript } from "./offline-cache/types";
import { findCaseInsensitiveMatch } from "./search-text";

export interface OfflineSearchCandidate {
	sessionId: string;
	title: string;
	lastActivityAt: number;
}

const MAX_CANDIDATES = 100;
const MAX_HITS = 50;
const SNIPPET_CONTEXT = 72;

function textFromContent(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.filter(part => part.type === "text" && part.text !== undefined).map(part => part.text!).join("\n");
}

function searchableText(entry: SessionEntry): string | null {
	if (entry.type === "message") {
		if (entry.message.role !== "user" && entry.message.role !== "assistant") return null;
		return textFromContent(entry.message.content);
	}
	if (entry.type === "custom_message" && entry.customType === "collab-prompt") return textFromContent(entry.content);
	return null;
}

function entryTime(entry: SessionEntry, fallback: number): number {
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** Searches cached transcripts for the supplied session keys, without loading or exposing tool output. */
export async function searchOfflineTranscripts(
	query: string,
	candidates: readonly OfflineSearchCandidate[],
	loadTranscript: (sessionId: string) => Promise<OfflineCachedTranscript | null>,
	signal?: AbortSignal,
): Promise<TranscriptSearchHit[]> {
	const needle = query.trim();
	if (needle === "" || signal?.aborted) return [];
	const unique = new Map<string, OfflineSearchCandidate>();
	for (const candidate of candidates) {
		if (!unique.has(candidate.sessionId)) unique.set(candidate.sessionId, candidate);
	}
	const newestFirst = [...unique.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, MAX_CANDIDATES);
	const results: TranscriptSearchHit[] = [];
	for (const candidate of newestFirst) {
		if (signal?.aborted || results.length >= MAX_HITS) break;
		const cached = await loadTranscript(candidate.sessionId);
		if (cached === null) continue;
		for (const entry of cached.entries.slice().reverse()) {
			if (signal?.aborted || results.length >= MAX_HITS) break;
			const text = searchableText(entry);
			if (text === null) continue;
			const match = findCaseInsensitiveMatch(text, needle);
			if (match === null) continue;
			const matchStart = match.start;
			const matchEnd = match.end;
			const start = Math.max(0, matchStart - SNIPPET_CONTEXT);
			const end = Math.min(text.length, matchEnd + SNIPPET_CONTEXT);
			results.push({
				sessionId: candidate.sessionId,
				title: cached.metadata.title || candidate.title,
				snippet: text.slice(start, end),
				matchStart: matchStart - start,
				matchEnd: matchEnd - start,
				at: entryTime(entry, candidate.lastActivityAt),
				...(entry.id === "" ? {} : { entryId: entry.id }),
			});
		}
	}
	return results;
}
