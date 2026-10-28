import type { CardsResponse, CatalogCommand, HistoryNode, SessionRecipe, TranscriptSearchHit, TranscriptSearchResponse } from "@omp-console/protocol";
import { Bookmark, BookmarkCheck, Compass, Search } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { relTime } from "../../lib/format";
import { offlineTranscriptCache } from "../../lib/offline-cache/cache";
import { searchOfflineTranscripts } from "../../lib/offline-search";
import { recordUsage } from "../../lib/journal";
import {
	commandEquivalent,
	groupBySource,
	rankCommands,
	withOvernightCommand,
	SOURCE_LABEL,
	splitPaletteQuery,
} from "../../lib/palette";
import { executeCommand } from "./actions";
import { OmpEquivalent } from "./OmpEquivalent";
import { useCatalog } from "./use-catalog";
import { findCaseInsensitiveMatch } from "../../lib/search-text";
import { sessionKey } from "../../lib/machines";
import "./catalog.css";

const RESULT_LIMIT = 80;
const CLOSE_AFTER_RUN_MS = 900;

export interface CommandPaletteProps {
	api: Pick<
		DeckApi,
		"catalog" | "runCommand" | "history" | "searchTranscripts" | "listRecipes" | "startRecipe" | "listPinnedSessions" | "setPinned" | "cachedGet" | "isLocalMachine"
	> | undefined;
	sessionId: string | undefined;
	onClose(): void;
	onOpenCatalog(): void;
	overnightEnabled?: boolean;
}

type Status =
	| { kind: "ran"; text: string }
	| { kind: "terminal"; text: string; equivalent: string }
	| { kind: "error"; message: string };

type PaletteOption =
	| { kind: "recipe"; recipe: SessionRecipe }
	| { kind: "history"; node: HistoryNode }
	| { kind: "transcript"; hit: TranscriptSearchHit }
	| { kind: "command"; command: CatalogCommand };
function historySnippet(node: HistoryNode, query: string): string {
	const points = node.keyPoints;
	const candidates = [points?.goal, ...(points?.decisions ?? []), points?.outcome, ...(points?.files ?? []), ...(points?.openQuestions ?? [])]
		.filter((value): value is string => value !== undefined && value !== "");
	const needle = query.toLowerCase();
	return candidates.find(value => value.toLowerCase().includes(needle)) ?? candidates[0] ?? node.title;
}

function HighlightedText({ text, query, start, end }: { text: string; query: string; start?: number; end?: number }): ReactNode {
	const match = start === undefined || end === undefined ? findCaseInsensitiveMatch(text, query) : { start, end };
	if (match === null) return text;
	return <>{text.slice(0, match.start)}<mark>{text.slice(match.start, match.end)}</mark>{text.slice(match.end)}</>;
}

/** Cmd+K palette over every slash command the live session offers (spec 5.2). */
export function CommandPalette({ api, sessionId, onClose, onOpenCatalog, overnightEnabled = false }: CommandPaletteProps): ReactNode {
	const { catalog, loading, error } = useCatalog(api, sessionId, true);
	const [query, setQuery] = useState("");
	// -1 = the user has not chosen yet: Enter runs the top command (as before recipes and search existed), or the top
	// recipe in `start:` mode. Results arriving late never steal Enter.
	const [active, setActive] = useState(-1);
	const [status, setStatus] = useState<Status | null>(null);
	const [recipes, setRecipes] = useState<SessionRecipe[]>([]);
	const [historyNodes, setHistoryNodes] = useState<HistoryNode[]>([]);
	const [transcriptHits, setTranscriptHits] = useState<TranscriptSearchHit[]>([]);
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [recipeError, setRecipeError] = useState<string | null>(null);
	const [recipeStarting, setRecipeStarting] = useState<string | null>(null);
	const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(() => new Set());
	const [pinningIds, setPinningIds] = useState<ReadonlySet<string>>(() => new Set());
	const [pinError, setPinError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const closeTimer = useRef<number | null>(null);

	const { search, args } = splitPaletteQuery(query);
	const queryText = query.trim();
	const recipeMode = /^(?:start|recipe):\s*/i.test(queryText);
	const commandLookup = queryText.startsWith("/");
	const searchQuery = queryText.replace(/^(?:start|recipe):\s*/i, "").trim();
	const sessionSearchQuery = commandLookup || recipeMode ? "" : searchQuery;
	const shouldSearchTranscripts = sessionSearchQuery.length >= 3;
	const visibleRecipes = useMemo(() => {
		const needle = searchQuery.toLowerCase();
		return recipes.filter(recipe => needle === "" || recipe.name.toLowerCase().includes(needle));
	}, [recipes, searchQuery]);
	const ranked = useMemo(
		() => (catalog ? rankCommands(withOvernightCommand(catalog.commands, overnightEnabled), search).slice(0, RESULT_LIMIT) : []),
		[catalog, search, overnightEnabled],
	);
	const groups = useMemo(() => (search === "" ? groupBySource(ranked) : []), [ranked, search]);
	const options = useMemo<PaletteOption[]>(() => [
		...visibleRecipes.map(recipe => ({ kind: "recipe" as const, recipe })),
		...historyNodes.map(node => ({ kind: "history" as const, node })),
		...transcriptHits.map(hit => ({ kind: "transcript" as const, hit })),
		...ranked.map(item => ({ kind: "command" as const, command: item.command })),
	], [visibleRecipes, historyNodes, transcriptHits, ranked]);
	const firstCommand = visibleRecipes.length + historyNodes.length + transcriptHits.length;
	const hasSearchHits = historyNodes.length + transcriptHits.length > 0;
	// Outside `start:` mode Enter never starts a recipe (that creates a live session) unless the user arrowed to it.
	const defaultIndex = recipeMode ? 0 : ranked.length > 0 ? firstCommand : hasSearchHits ? visibleRecipes.length : -1;
	const chosen = active < 0 ? defaultIndex : active;
	const selected = chosen < 0 ? -1 : Math.min(chosen, Math.max(options.length - 1, 0));
	const selectedOption = selected < 0 ? undefined : options[selected];
	const current = selectedOption?.kind === "command" ? selectedOption.command : undefined;

	useEffect(() => {
		inputRef.current?.focus();
		recordUsage({ feature: "5.2.palette", action: "open", outcome: "ok", via: "palette" });
		return () => {
			if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
		};
	}, []);

	useEffect(() => {
		if (api === undefined) return;
		const controller = new AbortController();
		void api.listRecipes(controller.signal).then(result => setRecipes(result.recipes)).catch(() => {
			if (!controller.signal.aborted) setRecipeError("Session templates could not be loaded.");
		});
		void api.listPinnedSessions(controller.signal).then(result => setPinnedIds(new Set(result.sessionIds))).catch(() => {});
		return () => controller.abort();
	}, [api]);

	useEffect(() => {
		if (api === undefined || sessionSearchQuery.length < 2) {
			setHistoryNodes([]);
			setTranscriptHits([]);
			setSearchBusy(false);
			setSearchError(null);
			return;
		}
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setSearchBusy(true);
			setSearchError(null);
			const transcriptSearch = shouldSearchTranscripts
				? api.searchTranscripts(sessionSearchQuery, controller.signal)
				: Promise.resolve({ results: [], truncated: false, scannedSessions: 0 } satisfies TranscriptSearchResponse);
			void Promise.allSettled([
				api.history({ q: sessionSearchQuery, limit: 40 }, controller.signal),
				transcriptSearch,
			]).then(async ([historyResult, transcriptResult]) => {
				if (controller.signal.aborted) return;
				const nodes = historyResult.status === "fulfilled" ? historyResult.value.nodes : [];
				setHistoryNodes(nodes);
				if (transcriptResult.status === "fulfilled") {
					setTranscriptHits(transcriptResult.value.results);
					if (historyResult.status === "rejected" && !shouldSearchTranscripts) setSearchError("Search is unavailable.");
				} else if (shouldSearchTranscripts) {
					const cachedCards = await api.cachedGet<CardsResponse>("/cards?limit=1000&includeScheduled=true");
					const offlineHits = cachedCards === null ? [] : await searchOfflineTranscripts(
						sessionSearchQuery,
						cachedCards.cards.map(card => ({ sessionId: card.sessionId, title: card.title, lastActivityAt: card.lastActivityAt })),
						sessionId => offlineTranscriptCache.load(sessionId),
						controller.signal,
					);
					if (!controller.signal.aborted) {
						setTranscriptHits(offlineHits);
						if (historyResult.status === "rejected" && offlineHits.length === 0) setSearchError("Search is unavailable.");
					}
				}
			}).catch((error: unknown) => {
				if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "Search is unavailable.");
			}).finally(() => {
				if (!controller.signal.aborted) setSearchBusy(false);
			});
		}, 300);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [api, sessionSearchQuery, shouldSearchTranscripts]);

	useEffect(() => {
		listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [selected, options]);

	const run = async (command: CatalogCommand): Promise<void> => {
		const outcome = await executeCommand(command, args, { api, sessionId, via: "palette" });
		switch (outcome.kind) {
			case "ran":
				setStatus({ kind: "ran", text: outcome.text });
				closeTimer.current = window.setTimeout(onClose, CLOSE_AFTER_RUN_MS);
				return;
			case "filled":
			case "panel":
				onClose();
				return;
			case "terminal":
				setStatus({ kind: "terminal", text: outcome.text, equivalent: outcome.equivalent });
				return;
			case "error":
				setStatus({ kind: "error", message: outcome.message });
				return;
		}
	};

	const startRecipe = async (recipe: SessionRecipe): Promise<void> => {
		if (api === undefined || recipeStarting !== null) return;
		setRecipeStarting(recipe.id);
		setRecipeError(null);
		try {
			const session = await api.startRecipe(recipe.id, crypto.randomUUID());
			onClose();
			const key = sessionKey({ id: recipe.machineId, local: api.isLocalMachine }, session.id);
			window.location.hash = `session=${encodeURIComponent(key)}`;
		} catch (error) {
			setRecipeError(error instanceof Error ? error.message : "The session template could not be started.");
		} finally {
			setRecipeStarting(null);
		}
	};

	const togglePin = async (resultSessionId: string): Promise<void> => {
		if (api === undefined || pinningIds.has(resultSessionId)) return;
		const pinned = !pinnedIds.has(resultSessionId);
		setPinningIds(current => new Set(current).add(resultSessionId));
		setPinError(null);
		try {
			const result = await api.setPinned(resultSessionId, pinned);
			setPinnedIds(current => {
				const next = new Set(current);
				if (result.pinned) next.add(resultSessionId);
				else next.delete(resultSessionId);
				return next;
			});
		} catch (error) {
			setPinError(error instanceof Error ? error.message : "Pin update failed.");
		} finally {
			setPinningIds(current => {
				const next = new Set(current);
				next.delete(resultSessionId);
				return next;
			});
		}
	};

	const openSearchResult = (resultSessionId: string, entryId?: string): void => {
		onClose();
		window.location.hash = `session=${encodeURIComponent(resultSessionId)}`;
		window.dispatchEvent(new CustomEvent("omp-console:open-search-result", {
			detail: { sessionId: resultSessionId, ...(entryId === undefined ? {} : { entryId }) },
		}));
	};

	const activateOption = (option: PaletteOption): void => {
		switch (option.kind) {
			case "recipe":
				void startRecipe(option.recipe);
				return;
			case "history":
				openSearchResult(option.node.sessionId);
				return;
			case "transcript":
				openSearchResult(option.hit.sessionId, option.hit.entryId);
				return;
			case "command":
				void run(option.command);
				return;
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			if (options.length > 0) setActive(Math.min(selected + 1, options.length - 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (options.length > 0) setActive(Math.max(selected - 1, 0));
		} else if (event.key === "Enter" && selectedOption) {
			event.preventDefault();
			activateOption(selectedOption);
		} else if (event.key === "Escape") {
			event.preventDefault();
			recordUsage({ feature: "5.2.palette", action: "dismiss", outcome: "abandoned", via: "palette" });
			onClose();
		}
	};

	const optionId = (index: number): string => `ct-pal-option-${index}`;
	const renderItem = (command: CatalogCommand, index: number): ReactNode => (
		<li
			key={`command:${command.source}:${command.name}`}
			id={optionId(index)}
			role="option"
			aria-selected={index === selected}
			className="ct-pal-item"
			data-active={index === selected ? "true" : "false"}
			onMouseMove={() => setActive(index)}
			onMouseDown={event => event.preventDefault()}
			onClick={() => void run(command)}
		>
			<span className="ct-pal-name">/{command.name}</span>
			{command.usage && <span className="ct-pal-usage">{command.usage}</span>}
			{!command.remote && <span className="ct-badge">{command.deckControl ? `panel: ${command.deckControl}` : "terminal only"}</span>}
			{command.description && <span className="ct-pal-desc">{command.description}</span>}
		</li>
	);

	let flat = 0;
	return (
		<div className="ct-pal-root">
			<div className="ct-pal-backdrop" onClick={onClose} />
			<section className="ct-pal" role="dialog" aria-modal="true" aria-label="Command palette">
				<div className="ct-pal-search">
					<Search size={15} />
					<input
						ref={inputRef}
						className="ct-pal-input"
						role="combobox"
						aria-expanded={options.length > 0}
						aria-controls="ct-pal-results"
						aria-activedescendant={selected >= 0 && options.length > 0 ? optionId(selected) : undefined}
						aria-label="Search commands, sessions, and session templates"
						placeholder="Search commands, sessions, and session templates…"
						value={query}
						spellCheck={false}
						autoComplete="off"
						onChange={event => {
							setQuery(event.target.value);
							setActive(-1);
							setStatus(null);
						}}
						onKeyDown={onKeyDown}
					/>
				</div>
				<div id="ct-pal-results" ref={listRef} className="ct-pal-results" role="listbox" aria-label="Commands, sessions, and session templates">
					<div className="ct-pal-domain-results">
						{visibleRecipes.length > 0 && (
							<section className="ct-pal-domain-section" role="group" aria-label="Session templates">
								<h3 className="ct-pal-group" role="presentation">Session templates</h3>
								<ul className="ct-pal-domain-list">
									{visibleRecipes.map((recipe, index) => (
										<li className="ct-pal-domain-item" key={recipe.id}>
											<button
												id={optionId(index)}
												type="button"
												role="option"
												aria-selected={index === selected}
												data-active={index === selected ? "true" : "false"}
												className="ct-pal-domain-main"
												disabled={recipeStarting !== null}
												onMouseMove={() => setActive(index)}
												onMouseDown={event => event.preventDefault()}
												onClick={() => void startRecipe(recipe)}
											>
												<strong>{recipeStarting === recipe.id ? "Starting…" : `Start: ${recipe.name}`}</strong>
												<small>{recipe.cwd}</small>
											</button>
										</li>
									))}
								</ul>
							</section>
						)}
						{sessionSearchQuery.length >= 2 && (
							<section className="ct-pal-domain-section" role="group" aria-label="Session search results">
								<h3 className="ct-pal-group" role="presentation">Sessions</h3>
								{searchBusy && <p className="ct-pal-empty" role="status">Searching sessions…</p>}
								{historyNodes.map((node, index) => {
									const optionIndex = visibleRecipes.length + index;
									const snippet = historySnippet(node, sessionSearchQuery);
									return (
										<div className="ct-pal-domain-item" key={`history:${node.sessionId}`}>
											<button
												id={optionId(optionIndex)}
												type="button"
												role="option"
												aria-selected={optionIndex === selected}
												data-active={optionIndex === selected ? "true" : "false"}
												className="ct-pal-domain-main"
												onMouseMove={() => setActive(optionIndex)}
												onMouseDown={event => event.preventDefault()}
												onClick={() => openSearchResult(node.sessionId)}
											>
												<strong>{node.title}</strong>
												<small><HighlightedText text={snippet} query={sessionSearchQuery} /></small>
												<time>{relTime(node.lastActivityAt)}</time>
											</button>
											<button
												type="button"
												className="ct-pal-pin"
												aria-label={`${pinnedIds.has(node.sessionId) ? "Unpin" : "Pin"} ${node.title}`}
												aria-pressed={pinnedIds.has(node.sessionId)}
												disabled={pinningIds.has(node.sessionId)}
												onClick={() => void togglePin(node.sessionId)}
											>
												{pinnedIds.has(node.sessionId) ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
											</button>
										</div>
									);
								})}
								{transcriptHits.map((hit, index) => {
									const optionIndex = visibleRecipes.length + historyNodes.length + index;
									return (
										<div className="ct-pal-domain-item" key={`transcript:${hit.sessionId}:${hit.entryId ?? index}`}>
											<button
												id={optionId(optionIndex)}
												type="button"
												role="option"
												aria-selected={optionIndex === selected}
												data-active={optionIndex === selected ? "true" : "false"}
												className="ct-pal-domain-main"
												onMouseMove={() => setActive(optionIndex)}
												onMouseDown={event => event.preventDefault()}
												onClick={() => openSearchResult(hit.sessionId, hit.entryId)}
											>
												<strong>{hit.title}</strong>
												<small><HighlightedText text={hit.snippet} query={sessionSearchQuery} start={hit.matchStart} end={hit.matchEnd} /></small>
												<time>{relTime(hit.at)}</time>
											</button>
											<button
												type="button"
												className="ct-pal-pin"
												aria-label={`${pinnedIds.has(hit.sessionId) ? "Unpin" : "Pin"} ${hit.title}`}
												aria-pressed={pinnedIds.has(hit.sessionId)}
												disabled={pinningIds.has(hit.sessionId)}
												onClick={() => void togglePin(hit.sessionId)}
											>
												{pinnedIds.has(hit.sessionId) ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
											</button>
										</div>
									);
								})}
								{!searchBusy && historyNodes.length === 0 && transcriptHits.length === 0 && (
									<p className="ct-pal-empty">No session matches “{sessionSearchQuery}”.</p>
								)}
								{searchError && <p className="ct-error" role="alert">{searchError}</p>}
							</section>
						)}
					</div>
					<ul id="ct-pal-list" className="ct-pal-list" role="group" aria-label="Commands">
						{groups.length > 0
							? groups.map(group => (
									<Fragment key={group.source}>
										<li role="presentation" className="ct-pal-group">
											{SOURCE_LABEL[group.source]}
										</li>
										{group.items.map(item => renderItem(item.command, visibleRecipes.length + historyNodes.length + transcriptHits.length + flat++))}
									</Fragment>
								))
							: ranked.map((item, index) => renderItem(item.command, visibleRecipes.length + historyNodes.length + transcriptHits.length + index))}
						{sessionId === undefined && (
							<li role="presentation" className="ct-pal-empty">
								Open a session through the daemon to list its commands.
							</li>
						)}
						{sessionId !== undefined && loading && !catalog && (
							<li role="presentation" className="ct-pal-empty">
								Loading commands…
							</li>
						)}
						{error !== undefined && !catalog && (
							<li role="presentation" className="ct-pal-empty" data-tone="error">
								{error}
							</li>
						)}
						{catalog && ranked.length === 0 && (
							<li role="presentation" className="ct-pal-empty">
								No command matches “{search}”.
							</li>
						)}
					</ul>
				</div>
				{recipeError && <p className="ct-error" role="alert">{recipeError}</p>}
				{pinError && <p className="ct-error" role="alert">{pinError}</p>}
				<footer className="ct-pal-foot">
					{status?.kind === "ran" && (
						<p className="ct-status" role="status">
							Ran <code>{status.text}</code>
						</p>
					)}
					{status?.kind === "error" && (
						<p className="ct-error" role="alert">
							{status.message}
						</p>
					)}
					{status?.kind === "terminal" && (
						<p className="ct-status" role="status">
							Terminal only: run it in omp.
						</p>
					)}
					{status?.kind === "terminal" ? (
						<OmpEquivalent text={status.equivalent} actionId={`command:${current?.name ?? ""}`} via="palette" />
					) : (
						current && (
							<OmpEquivalent
								text={commandEquivalent(current, args)}
								hint={args === "" ? current.usage : undefined}
								actionId={`command:${current.name}`}
								via="palette"
							/>
						)
					)}
					<div className="ct-pal-links">
						<span className="ct-pal-keys">↑↓ move · Enter run · Esc close</span>
						<button
							type="button"
							className="ct-link"
							onClick={() => {
								onClose();
								onOpenCatalog();
							}}
						>
							<Compass size={12} /> What omp can do
						</button>
					</div>
				</footer>
			</section>
		</div>
	);
}
