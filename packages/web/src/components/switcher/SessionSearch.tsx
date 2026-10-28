import type { CardsResponse, HistoryNode, TranscriptSearchHit } from "@omp-console/protocol";
import { Bookmark, BookmarkCheck, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { relTime } from "../../lib/format";
import type { Machine } from "../../lib/machines";
import { sessionKey } from "../../lib/machines";
import type { SessionCardView } from "../../lib/cards";
import { offlineTranscriptCache } from "../../lib/offline-cache/cache";
import { searchOfflineTranscripts } from "../../lib/offline-search";
import type { OfflineSearchCandidate } from "../../lib/offline-search";
import type { SessionSummary } from "@omp-console/protocol";
import { findCaseInsensitiveMatch } from "../../lib/search-text";

interface SessionSearchProps {
	api: Pick<DeckApi, "history" | "searchTranscripts" | "cachedGet">;
	machines: readonly Machine[];
	cards: readonly SessionCardView[];
	archivedSessions: readonly SessionSummary[];
	pinnedIds: ReadonlySet<string>;
	onOpen(sessionId: string, entryId?: string): void;
	onTogglePin(sessionId: string, pinned: boolean): Promise<void>;
}

function keyPointSnippet(node: HistoryNode, query: string): string {
	const points = node.keyPoints;
	const candidates = [points?.goal, ...(points?.decisions ?? []), points?.outcome, ...(points?.files ?? []), ...(points?.openQuestions ?? [])]
		.filter((value): value is string => value !== undefined && value !== "");
	const needle = query.toLowerCase();
	return candidates.find(value => value.toLowerCase().includes(needle)) ?? candidates[0] ?? node.title;
}

function Match({ text, query, start, end }: { text: string; query: string; start?: number; end?: number }): ReactNode {
	const match = start === undefined || end === undefined ? findCaseInsensitiveMatch(text, query) : { start, end };
	if (match === null) return text;
	return <>{text.slice(0, match.start)}<mark>{text.slice(match.start, match.end)}</mark>{text.slice(match.end)}</>;
}

export function SessionSearch({ api, machines, cards, archivedSessions, pinnedIds, onOpen, onTogglePin }: SessionSearchProps): ReactNode {
	const [query, setQuery] = useState("");
	const [historyNodes, setHistoryNodes] = useState<HistoryNode[]>([]);
	const [transcriptHits, setTranscriptHits] = useState<TranscriptSearchHit[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pendingPins, setPendingPins] = useState<ReadonlySet<string>>(() => new Set());
	const cardsRef = useRef(cards);
	const archivedSessionsRef = useRef(archivedSessions);
	cardsRef.current = cards;
	archivedSessionsRef.current = archivedSessions;
	const searchQuery = query.trim();
	const pinned = useMemo(() => new Map(cards.map(item => [item.card.sessionId, item.card.pinned === true])), [cards]);
	const cardById = useMemo(() => new Map(cards.map(item => [item.card.sessionId, item])), [cards]);
	const cardSearchMatches = useMemo(() => {
		if (searchQuery.length < 2) return [];
		const represented = new Set([...historyNodes.map(node => node.sessionId), ...transcriptHits.map(hit => hit.sessionId)]);
		const needle = searchQuery.toLowerCase();
		return cards.filter(item =>
			!represented.has(item.card.sessionId) &&
			(item.card.title.toLowerCase().includes(needle) || item.card.cwd.toLowerCase().includes(needle)),
		).slice(0, 20);
	}, [cards, historyNodes, searchQuery, transcriptHits]);

	useEffect(() => {
		if (searchQuery.length < 2) {
			setHistoryNodes([]);
			setTranscriptHits([]);
			setLoading(false);
			setError(null);
			return;
		}
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setLoading(true);
			setError(null);
			const sources = machines.filter(machine => machine.local || machine.reachable).map(machine => ({
				machine,
				api: machine.local ? api : machine.api,
			}));
			void Promise.all(sources.map(async ({ machine, api: machineApi }) => {
				const [historyResult, transcriptResult] = await Promise.allSettled([
					machineApi.history({ q: searchQuery, limit: 40 }, controller.signal),
					machineApi.searchTranscripts(searchQuery, controller.signal),
				]);
				return {
					historyOk: historyResult.status === "fulfilled",
					transcriptOk: transcriptResult.status === "fulfilled",
					history: historyResult.status === "fulfilled" ? historyResult.value.nodes.map(node => ({
						...node,
						sessionId: sessionKey(machine, node.sessionId),
					})) : [],
					hits: transcriptResult.status === "fulfilled" ? transcriptResult.value.results.map(hit => ({
						...hit,
						sessionId: sessionKey(machine, hit.sessionId),
					})) : [],
				};
			})).then(async results => {
				if (controller.signal.aborted) return;
				const nodes = results.flatMap(result => result.history).sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 40);
				const hits = results.flatMap(result => result.hits);
				const uniqueHits = new Map<string, TranscriptSearchHit>();
				for (const hit of hits) uniqueHits.set(`${hit.sessionId}:${hit.entryId ?? hit.snippet}`, hit);
				let offlineHits: TranscriptSearchHit[] = [];
				if (results.some(result => !result.transcriptOk)) {
					let candidates: OfflineSearchCandidate[] = [
						...cardsRef.current.map(item => ({ sessionId: item.card.sessionId, title: item.card.title, lastActivityAt: item.card.lastActivityAt })),
						...archivedSessionsRef.current.map(session => ({ sessionId: session.id, title: session.title ?? session.cwd, lastActivityAt: session.lastActivityAt })),
					];
					if (candidates.length === 0) {
						const cached = await api.cachedGet<CardsResponse>("/cards?limit=1000&includeScheduled=true");
						candidates = cached?.cards.map(card => ({ sessionId: card.sessionId, title: card.title, lastActivityAt: card.lastActivityAt })) ?? [];
					}
					offlineHits = await searchOfflineTranscripts(searchQuery, candidates, sessionId => offlineTranscriptCache.load(sessionId), controller.signal);
				}
				for (const hit of offlineHits) uniqueHits.set(`${hit.sessionId}:${hit.entryId ?? hit.snippet}`, hit);
				if (!controller.signal.aborted) {
					setHistoryNodes(nodes);
					setTranscriptHits([...uniqueHits.values()].sort((a, b) => b.at - a.at).slice(0, 50));
					if (!results.some(result => result.historyOk || result.transcriptOk) && offlineHits.length === 0) setError("Search is unavailable while offline.");
				}
			}).catch((cause: unknown) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Session search failed.");
			}).finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		}, 180);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [api, machines, searchQuery]);
	const togglePin = async (sessionId: string, nextPinned: boolean): Promise<void> => {
		if (pendingPins.has(sessionId)) return;
		setPendingPins(current => new Set(current).add(sessionId));
		try {
			await onTogglePin(sessionId, nextPinned);
		} catch {
			// The sidebar owns and renders the pin failure notice.
		} finally {
			setPendingPins(current => {
				const next = new Set(current);
				next.delete(sessionId);
				return next;
			});
		}
	};


	const open = (sessionId: string, entryId?: string): void => {
		onOpen(sessionId, entryId);
		window.dispatchEvent(new CustomEvent("omp-console:open-search-result", {
			detail: { sessionId, ...(entryId === undefined ? {} : { entryId }) },
		}));
	};

	return (
		<section className="dk-session-search" aria-label="Search sessions">
			<label className="dk-session-search-input">
				<Search size={14} aria-hidden="true" />
				<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search titles, project folders, and messages…" aria-label="Search session titles, project folders, and messages" />
			</label>
			{searchQuery.length >= 2 && (
				<div className="dk-session-search-results" aria-live="polite">
					{loading && <p role="status">Searching…</p>}
					{error && <p className="dk-notice dk-notice-err" role="alert">{error}</p>}
					{cardSearchMatches.map(item => {
						const isPinned = pinned.get(item.card.sessionId) ?? pinnedIds.has(item.card.sessionId);
						return (
							<div className="dk-session-search-result" key={`card:${item.card.sessionId}`}>
								<button type="button" className="dk-session-search-open" onClick={() => open(item.card.sessionId)}>
									<strong><Match text={item.card.title} query={searchQuery} /></strong>
									<span><Match text={item.card.cwd} query={searchQuery} /></span>
									<time>{relTime(item.card.lastActivityAt)}</time>
								</button>
								<button type="button" className="dk-session-search-pin" aria-label={`${isPinned ? "Unpin" : "Pin"} ${item.card.title}`} aria-pressed={isPinned} disabled={pendingPins.has(item.card.sessionId)} onClick={() => void togglePin(item.card.sessionId, !isPinned)}>
									{isPinned ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
								</button>
							</div>
						);
					})}
					{historyNodes.map(node => {
						const isPinned = pinned.get(node.sessionId) ?? pinnedIds.has(node.sessionId);
						return (
							<div className="dk-session-search-result" key={`history:${node.sessionId}`}>
								<button type="button" className="dk-session-search-open" onClick={() => open(node.sessionId)}>
									<strong>{node.title}</strong>
									<span><Match text={keyPointSnippet(node, searchQuery)} query={searchQuery} /></span>
									{cardById.get(node.sessionId) && <span><Match text={cardById.get(node.sessionId)!.card.cwd} query={searchQuery} /></span>}
									<time>{relTime(node.lastActivityAt)}</time>
								</button>
								<button type="button" className="dk-session-search-pin" aria-label={`${isPinned ? "Unpin" : "Pin"} ${node.title}`} aria-pressed={isPinned} disabled={pendingPins.has(node.sessionId)} onClick={() => void togglePin(node.sessionId, !isPinned)}>
									{isPinned ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
								</button>
							</div>
						);
					})}
					{transcriptHits.map((hit, index) => {
						const isPinned = pinned.get(hit.sessionId) ?? pinnedIds.has(hit.sessionId);
						return (
							<div className="dk-session-search-result" key={`message:${hit.sessionId}:${hit.entryId ?? index}`}>
								<button type="button" className="dk-session-search-open" onClick={() => open(hit.sessionId, hit.entryId)}>
									<strong>{hit.title}</strong>
									<span><Match text={hit.snippet} query={searchQuery} start={hit.matchStart} end={hit.matchEnd} /></span>
									{cardById.get(hit.sessionId) && <span><Match text={cardById.get(hit.sessionId)!.card.cwd} query={searchQuery} /></span>}
									<time>{relTime(hit.at)}</time>
								</button>
								<button type="button" className="dk-session-search-pin" aria-label={`${isPinned ? "Unpin" : "Pin"} ${hit.title}`} aria-pressed={isPinned} disabled={pendingPins.has(hit.sessionId)} onClick={() => void togglePin(hit.sessionId, !isPinned)}>
									{isPinned ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
								</button>
							</div>
						);
					})}
					{!loading && !error && cardSearchMatches.length === 0 && historyNodes.length === 0 && transcriptHits.length === 0 && <p>No sessions match “{searchQuery}”.</p>}
				</div>
			)}
		</section>
	);
}
