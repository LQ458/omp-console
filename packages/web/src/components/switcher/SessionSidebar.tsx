import type { SessionRecipeInput, SessionRecipeSource } from "@omp-console/protocol";
import type { BriefLine, CardsResponse, CreateSessionRequest, DaemonHealth, ListSessionsResponse, SessionCard, SessionSummary, SessionTranscriptResponse } from "@omp-console/protocol";
import { ChevronDown, ChevronRight, FolderGit2, PanelLeftClose, Plus, RotateCcw, Search, ShieldAlert, Trash2, TriangleAlert, Undo2, WifiOff, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReturnBrief } from "../brief/ReturnBrief";
import { NewSessionPicker } from "../newsession/NewSessionPicker";
import { RecipeEditor } from "../newsession/RecipeEditor";
import { DeckApi, DeckApiError } from "../../lib/api";
import {
	isMachineNetworkError,
	machineForSessionKey,
	machineIdForSessionKey,
	sessionIdForSessionKey,
	sessionKey,
	type Machine,
} from "../../lib/machines";
import type { SessionCardView } from "../../lib/cards";
import type { SleepCandidateRetry } from "../../lib/switcher";
import { mergeSessionCards, renameCardOptimistically, undoCardTitleOptimistically } from "../../lib/cards";
import { relTime } from "../../lib/format";
import { motionLevel } from "../../lib/motion";
import { publishCardTitles, rememberUserTitle } from "../../lib/card-titles";
import { openQuickAsk, openWorkspaces } from "../workspaces/events";
import { openPanel } from "../../lib/palette";
import { SessionCardList } from "./SessionCardList";
import "./switcher.css";
import { SessionSearch } from "./SessionSearch";
import { offlineTranscriptCache } from "../../lib/offline-cache/cache";

/** How long the archive confirmation (with its Undo) stays before it leaves by itself. */
const ARCHIVE_TOAST_MS = 8000;
const ARCHIVE_TOAST_EXIT_MS = 200;
const EMPTY_CARDS: CardsResponse = { cards: [], topics: [], pending: 0, decisionBackend: "luna" };

export type SessionSidebarApi = Pick<
	DeckApi,
	| "cards"
	| "setCardTitle"
	| "undoCardTitle"
	| "brief"
	| "sessionTranscript"
	| "claudeImportSummary"
	| "newSessionSuggestions"
	| "browseNewSession"
	| "pathSuggestions"
	| "getOvernightTemplate"
	| "getOvernightPreflight"
	| "listSessions"
	| "archiveSession"
	| "restoreSession"
	| "trashSession"
	| "sessionOpV3"
	| "sleepSession"
	| "listPinnedSessions"
	| "setPinned"
	| "listRecipes"
	| "startRecipe"
	| "recipeSource"
	| "history"
	| "searchTranscripts"
	| "cachedGet"
	| "createRecipe"
>;

interface RecipeEditorState {
	source: SessionRecipeSource;
	machineId: string;
	machineName: string;
	api: Pick<DeckApi, "createRecipe">;
}

interface ReadOnlyTranscriptView {
	session: SessionSummary;
	loading: boolean;
	response?: SessionTranscriptResponse;
	error?: string;
}

function newPathFromHash(hash: string): string | null {
	const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
	return params.has("new") ? (params.get("new") ?? "") : null;
}

function clearNewPathFromHash(): void {
	const params = new URLSearchParams(window.location.hash.slice(1));
	if (!params.has("new")) return;
	params.delete("new");
	const hash = params.toString();
	window.history.replaceState(
		window.history.state,
		"",
		`${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`,
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "The request failed.";
}
function summaryFromCard(item: SessionCardView): SessionSummary {
	if (item.summary) return item.summary;
	return {
		id: item.card.sessionId,
		title: item.card.title,
		cwd: item.card.cwd,
		...(item.card.sessionFile === undefined ? {} : { sessionFile: item.card.sessionFile }),
		state: "stopped",
		createdAt: item.card.lastActivityAt,
		lastActivityAt: item.card.lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	};
}

export interface SessionSidebarProps {
	sessions: ListSessionsResponse | null;
	health: DaemonHealth | null;
	listError: DeckApiError | null;
	/** Bumped by the app to open the new-session picker (the desktop home screen's start button). */
	composeRequest?: number;
	authFailed: boolean;
	selectedId: string | null;
	busy: boolean;
	actionError: string | null;
	/** The create/resume request that can be retried after freeing the offered worker slot. */
	sleepCandidateRetry?: SleepCandidateRetry | null;
	/** Set when the last resume failed on a saved model omp can no longer use; offers resuming on the default model. */
	resumeModelRetry?: { missingModel: string } | null;
	onRetryResumeOnDefault?(): void;
	librarianEnabled?: boolean;
	quickAskEnabled?: boolean;
	overnightEnabled?: boolean;
	api?: SessionSidebarApi;
	machines?: readonly Machine[];
	onMachineReachable?(machineId: string): void;
	onMachineUnreachable?(machineId: string): void;
	/** `newPane`: Cmd/Ctrl-click, show the session in a new split instead of the focused pane. */
	onSelect(id: string, newPane?: boolean): void;
	/** Resolve on success; reject on failure (the row's feedback shows it). The switcher also reports the error. */
	onResume(session: SessionSummary, newPane?: boolean): void | Promise<void>;
	onFork(session: SessionSummary): void | Promise<void>;
	onStop(id: string): void | Promise<void>;
	onCreate(request: CreateSessionRequest, machineId?: string): void;
	/** `sheet`: shown inside the phone sheet (touch-sized rows, actions always visible). */
	variant?: "inline" | "sheet";
	/** Stops the running turn of a streaming session (opens it first when it is not connected). */
	onStopTurn?(id: string): void;
	/** Collapses the sidebar to its rail (inline variant only). */
	onHide?(): void;
	/** Only show live sessions with at least one connected guest. */
	showLiveSharedSessions?: boolean;
	onClearLiveSharedSessions?(): void;
	touch?: boolean;
}

export async function sleepCandidateAndContinue(
	api: Pick<DeckApi, "sleepSession">,
	retry: SleepCandidateRetry,
	onCreate: SessionSidebarProps["onCreate"],
): Promise<void> {
	await api.sleepSession(retry.candidate.id);
	onCreate(retry.request, retry.machineId);
}
export function SessionSidebar(props: SessionSidebarProps): ReactNode {
	const { sessions, health, listError, authFailed, selectedId, busy, actionError, variant = "inline" } = props;
	const localOutage = listError?.kind === "network";
	const [defaultApi] = useState(() => new DeckApi());
	const api = props.api ?? defaultApi;
	const [claudeImport, setClaudeImport] = useState<{ dir: string; found: boolean; sessionCount: number; projectCount: number } | null>(null);
	const [claudeImportError, setClaudeImportError] = useState<string | null>(null);
	const [readOnlyTranscript, setReadOnlyTranscript] = useState<ReadOnlyTranscriptView | null>(null);
	const transcriptController = useRef<AbortController | null>(null);
	const [sessionOpenError, setSessionOpenError] = useState<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setClaudeImport(null);
		setClaudeImportError(null);
		void api.claudeImportSummary(controller.signal)
			.then(setClaudeImport)
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				if (error instanceof DeckApiError && error.status === 404) return;
				setClaudeImportError(errorText(error));
			});
		return () => controller.abort();
	}, [api]);
	useEffect(() => () => transcriptController.current?.abort(), []);

	const fallbackMachines = useMemo<readonly Machine[]>(
		() => [{ id: "local", name: "Local", api: defaultApi, local: true, reachable: true }],
		[defaultApi],
	);
	const machines = props.machines ?? fallbackMachines;
	const [sleepCandidateBusy, setSleepCandidateBusy] = useState(false);
	const [sleepCandidateError, setSleepCandidateError] = useState<string | null>(null);
	const liveSharedOnly = props.showLiveSharedSessions === true;
	const [liveSharedSessionKeys, setLiveSharedSessionKeys] = useState<ReadonlySet<string>>(() => new Set());
	const [sharedFilterLoading, setSharedFilterLoading] = useState(false);
	// A new limit error replaces the old offer, so the old offer's failure text goes with it.
	useEffect(() => setSleepCandidateError(null), [props.sleepCandidateRetry]);
	const sleepAndContinue = useCallback(async (): Promise<void> => {
		const retry = props.sleepCandidateRetry;
		if (!retry || sleepCandidateBusy) return;
		const machine =
			retry.machineId === undefined
				? machines.find(candidate => candidate.local) ?? fallbackMachines[0]
				: machines.find(candidate => candidate.id === retry.machineId);
		if (!machine) {
			setSleepCandidateError("The machine that offered this sleep candidate is no longer available.");
			return;
		}
		setSleepCandidateBusy(true);
		setSleepCandidateError(null);
		try {
			await sleepCandidateAndContinue(machine.api, retry, props.onCreate);
		} catch (error) {
			setSleepCandidateError(errorText(error));
		} finally {
			setSleepCandidateBusy(false);
		}
	}, [props.sleepCandidateRetry, props.onCreate, sleepCandidateBusy, machines, fallbackMachines]);
	const [pickerPath, setPickerPath] = useState<string | null>(() =>
		typeof window === "undefined" ? null : newPathFromHash(window.location.hash),
	);
	const [composing, setComposing] = useState(() =>
		typeof window !== "undefined" && newPathFromHash(window.location.hash) !== null,
	);
	useEffect(() => {
		if (props.composeRequest) {
			setPickerPath(null);
			setComposing(true);
		}
	}, [props.composeRequest]);
	const [cardResponse, setCardResponse] = useState<CardsResponse | null>(null);
	useEffect(() => {
		if (cardResponse) publishCardTitles(cardResponse.cards);
	}, [cardResponse]);
	const [cardLoadError, setCardLoadError] = useState<string | null>(null);
	const [cardMutationError, setCardMutationError] = useState<string | null>(null);
	const [titleOverrides, setTitleOverrides] = useState<ReadonlyMap<string, string>>(() => new Map());
	const [pinError, setPinError] = useState<string | null>(null);
	const [pinOverrides, setPinOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [recipeEditor, setRecipeEditor] = useState<RecipeEditorState | null>(null);
	const [recipeError, setRecipeError] = useState<string | null>(null);
	const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>(() => sessions?.archived ?? []);
	const [peerLiveSessions, setPeerLiveSessions] = useState<SessionSummary[]>([]);
	const [peerRecentSessions, setPeerRecentSessions] = useState<SessionSummary[]>([]);
	const [archivedOpen, setArchivedOpen] = useState(false);
	const [archiveBusy, setArchiveBusy] = useState(false);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const [archiveNotice, setArchiveNotice] = useState<{ message: string; sessionIds: string[] } | null>(null);
	const [archiveNoticeLeaving, setArchiveNoticeLeaving] = useState(false);
	// The archive confirmation is a toast: it leaves by itself after a while (hovering keeps it, so Undo stays reachable).
	const [archiveNoticeHeld, setArchiveNoticeHeld] = useState(false);
	const showArchiveNotice = (notice: { message: string; sessionIds: string[] }): void => {
		setArchiveNoticeLeaving(false);
		setArchiveNoticeHeld(false);
		setArchiveNotice(notice);
	};
	const hideArchiveNotice = useCallback((): void => {
		if (archiveNotice === null || archiveNoticeLeaving) return;
		if (motionLevel() === "off") {
			setArchiveNotice(null);
			return;
		}
		setArchiveNoticeLeaving(true);
	}, [archiveNotice, archiveNoticeLeaving]);
	useEffect(() => {
		if (archiveNotice === null) {
			setArchiveNoticeHeld(false);
			setArchiveNoticeLeaving(false);
			return;
		}
		if (archiveNoticeLeaving) {
			const timer = window.setTimeout(() => setArchiveNotice(null), motionLevel() === "off" ? 0 : ARCHIVE_TOAST_EXIT_MS);
			return () => window.clearTimeout(timer);
		}
		if (archiveNoticeHeld) return;
		const timer = window.setTimeout(hideArchiveNotice, ARCHIVE_TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [archiveNotice, archiveNoticeHeld, archiveNoticeLeaving, hideArchiveNotice]);
	const archiveRevision = useRef(0);
	const live = sessions?.live ?? [];
	const recent = sessions?.recent ?? [];
	const allLive = useMemo(() => [...live, ...peerLiveSessions], [live, peerLiveSessions]);
	const allRecent = useMemo(() => [...recent, ...peerRecentSessions], [recent, peerRecentSessions]);
	const liveIds = useMemo(() => new Set(allLive.map(session => session.id)), [allLive]);
	const sessionById = useMemo(() => {
		const map = new Map<string, SessionSummary>();
		for (const session of allRecent) map.set(session.id, session);
		for (const session of allLive) map.set(session.id, session);
		return map;
	}, [allLive, allRecent]);
	// Optional card summaries enrich saved-session rows without filtering sessions outside configured roots.
	const cards = useMemo(
		() =>
			mergeSessionCards(cardResponse?.cards ?? [], allLive, allRecent, titleOverrides).map(view => {
				const pinned = pinOverrides.get(view.card.sessionId);
				if (pinned === undefined) return view;
				return {
					...view,
					card: { ...view.card, pinned },
					...(view.summary === undefined ? {} : { summary: { ...view.summary, pinned } }),
				};
			}),
		[allLive, allRecent, cardResponse, titleOverrides, pinOverrides],
	);
	const archivedIds = useMemo(() => new Set(archivedSessions.map(session => session.id)), [archivedSessions]);
	const visibleCards = useMemo(
		() => cards.filter(view =>
			!archivedIds.has(view.card.sessionId) &&
			(!liveSharedOnly || (view.live && liveSharedSessionKeys.has(view.card.sessionId))),
		),
		[archivedIds, cards, liveSharedOnly, liveSharedSessionKeys],
	);
	const pinnedKeys = useMemo(
		() => [...cards.filter(view => view.card.pinned === true).map(view => view.card.sessionId), ...archivedSessions.filter(session => session.pinned).map(session => session.id)],
		[cards, archivedSessions],
	);
	useEffect(() => {
		offlineTranscriptCache.setPinnedKeys(pinnedKeys, "pins");
	}, [pinnedKeys]);
	useEffect(() => () => offlineTranscriptCache.setPinnedKeys([], "pins"), []);
	// Peers that stopped answering, and "" for this daemon during a local outage: their rows say Offline.
	const offlineMachines = useMemo(() => {
		const ids = new Set(machines.filter(machine => !machine.local && !machine.reachable).map(machine => machine.id));
		if (listError?.kind === "network") ids.add("");
		return ids;
	}, [machines, listError]);

	useEffect(() => {
		const onHashChange = (): void => {
			const path = newPathFromHash(window.location.hash);
			if (path === null) return;
			setPickerPath(path);
			setComposing(true);
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	useEffect(() => {
		let timer: number | undefined;
		let controller: AbortController | undefined;
		let stopped = false;
		const load = async (): Promise<void> => {
			const current = new AbortController();
			controller = current;
			try {
				const revision = archiveRevision.current;
				const results = await Promise.all(
					machines.map(async machine => {
						if (!machine.local && !machine.reachable) return null;
						try {
							const machineApi = machine.local ? api : machine.api;
							const cards = props.librarianEnabled === true
								? machineApi.cards({ limit: 1000, includeScheduled: true }, current.signal)
								: Promise.resolve(EMPTY_CARDS);
							const [result, sessionsResult, pinsResult] = await Promise.all([
								cards,
								machineApi.listSessions(current.signal),
								machineApi.listPinnedSessions(current.signal).catch(() => null),
							]);
							if (!machine.local) props.onMachineReachable?.(machine.id);
							return {
								machine,
								result,
								pinnedSessionIds: pinsResult === null ? null : new Set(pinsResult.sessionIds),
								liveSessions: machine.local ? [] : sessionsResult.live.map(session => ({ ...session, id: sessionKey(machine, session.id) })),
								recentSessions: machine.local ? [] : sessionsResult.recent.map(session => ({ ...session, id: sessionKey(machine, session.id) })),
								archived: sessionsResult.archived,
								archiveFieldPresent: sessionsResult.archived !== undefined,
							};
						} catch (error) {
							if (!machine.local) {
								if (isMachineNetworkError(error)) props.onMachineUnreachable?.(machine.id);
								else props.onMachineReachable?.(machine.id);
							}
							return null;
						}
					}),
				);
				if (!stopped) {
					const available = results.filter(result => result !== null);
					const local = available.find(result => result.machine.local)?.result;
					if (local === undefined) return;
					setPinOverrides(new Map());
					const missingPeerIds = new Set<string>();
					machines.forEach((machine, index) => {
						if (!machine.local && results[index] === null) missingPeerIds.add(machine.id);
					});
					const unsupportedArchivePeers = new Set(
						available
							.filter(result => !result.machine.local && !result.archiveFieldPresent)
							.map(result => result.machine.id),
					);
					const freshPeerLive = available.flatMap(({ liveSessions }) => liveSessions);
					const freshPeerRecent = available.flatMap(({ recentSessions }) => recentSessions);
					const retainMissingPeerSessions = (current: SessionSummary[]): SessionSummary[] =>
						current.filter(session => {
							const machineId = machineIdForSessionKey(session.id);
							return machineId !== null && missingPeerIds.has(machineId);
						});
					if (revision === archiveRevision.current) {
						setPeerLiveSessions(current => [...freshPeerLive, ...retainMissingPeerSessions(current)]);
						setPeerRecentSessions(current => [...freshPeerRecent, ...retainMissingPeerSessions(current)]);
					}
					const freshCards = available.flatMap(({ machine, result, pinnedSessionIds, liveSessions, recentSessions, archived }) => {
						const summaries = new Map(
							[...liveSessions, ...recentSessions, ...(archived ?? []).map(session => ({ ...session, id: sessionKey(machine, session.id) }))]
								.map(session => [sessionIdForSessionKey(session.id), session]),
						);
						return result.cards.map(card => ({
							...card,
							sessionId: sessionKey(machine, card.sessionId),
							pinned: pinnedSessionIds?.has(card.sessionId) ?? card.pinned ?? summaries.get(card.sessionId)?.pinned ?? false,
						}));
					});
					const freshArchived = available.flatMap(({ machine, archived }) =>
						(archived ?? []).map(session => ({ ...session, id: sessionKey(machine, session.id) })),
					);
					setCardResponse(current => {
						const retainedPeerCards =
							current?.cards.filter(card => {
								const machineId = machineIdForSessionKey(card.sessionId);
								return machineId !== null && missingPeerIds.has(machineId);
							}) ?? [];
						const retainedTopics = missingPeerIds.size > 0 ? current?.topics ?? [] : [];
						return {
							cards: [...freshCards, ...retainedPeerCards],
							topics: [...new Set([...available.flatMap(({ result }) => result.topics), ...retainedTopics])],
							pending: available.reduce((sum, item) => sum + item.result.pending, 0),
							decisionBackend: local.decisionBackend,
						};
					});
					if (revision === archiveRevision.current) {
						setArchivedSessions(current => {
							const retained = current.filter(session => {
								const machineId = machineIdForSessionKey(session.id);
								return machineId !== null && (missingPeerIds.has(machineId) || unsupportedArchivePeers.has(machineId));
							});
							const unique = new Map<string, SessionSummary>();
							for (const session of [...freshArchived, ...retained]) unique.set(session.id, session);
							return [...unique.values()].sort((a, b) => (b.archivedAt ?? b.lastActivityAt) - (a.archivedAt ?? a.lastActivityAt));
						});
					}
					setCardLoadError(null);
				}
			} catch (error) {
				if (!stopped && !current.signal.aborted) setCardLoadError(errorText(error));
			} finally {
				if (!stopped) timer = window.setTimeout(() => void load(), 30_000);
			}
		};
		void load();
		return () => {
			stopped = true;
			if (timer !== undefined) window.clearTimeout(timer);
			controller?.abort();
		};
	}, [api, machines, props.librarianEnabled, props.onMachineReachable, props.onMachineUnreachable]);

	const openPicker = (): void => {
		setPickerPath(null);
		if (composing) closePicker();
		else setComposing(true);
	};

	const closePicker = (): void => {
		setComposing(false);
		setPickerPath(null);
		clearNewPathFromHash();
	};

	const summaryFor = (sessionId: string): SessionSummary | undefined =>
		sessionById.get(sessionId) ?? cards.find(view => view.card.sessionId === sessionId)?.summary;

	const canOpenSession = (sessionId: string, line?: BriefLine): boolean => {
		const session = summaryFor(sessionId);
		return (session !== undefined && (liveIds.has(sessionId) || Boolean(session.sessionFile))) || line?.sessionFile !== undefined;
	};

	// Brief, archive, and search links use the same safe path as the saved-session rows.
	const resumeQuietly = (session: SessionSummary): void => {
		if (session.cwdExists === false) {
			openReadOnlyTranscript(session);
			return;
		}
		setSessionOpenError(null);
		// The switcher decides: in place for sessions this daemon hosted, a titled copy for terminal sessions.
		const action = props.onResume(session);
		void Promise.resolve(action).catch(error => setSessionOpenError(errorText(error)));
	};

	const openSession = (sessionId: string, line?: BriefLine): void => {
		const session = summaryFor(sessionId);
		if (liveIds.has(sessionId)) {
			if (session) props.onSelect(sessionId);
		} else if (session?.sessionFile) resumeQuietly(session);
		else if (line?.sessionFile) {
			const now = Date.now();
			resumeQuietly({
				id: sessionId,
				title: line.title,
				cwd: line.cwd,
				sessionFile: line.sessionFile,
				source: "terminal",
				state: "stopped",
				createdAt: now,
				lastActivityAt: now,
				agentCount: 0,
				goalActive: false,
				awaitingAnswer: false,
			});
		}
	};


	const saveCard = (updated: SessionCard): void => {
		// A rename or undo here replaces any rename made in the pane header that the list has not seen yet.
		rememberUserTitle(updated.sessionId, updated.titleSource === "user" ? updated.title : null);
		setCardResponse(current => ({
			cards: [...(current?.cards ?? []).filter(card => card.sessionId !== updated.sessionId), updated],
			topics: current?.topics ?? [],
			pending: current?.pending ?? 0,
			decisionBackend: current?.decisionBackend ?? "luna",
		}));
	};
	const cardApiFor = (key: string): Pick<DeckApi, "setCardTitle" | "undoCardTitle"> => {
		const machine = machineForSessionKey(key, machines);
		const target = machine?.local ? api : machine?.api ?? api;
		const rawId = sessionIdForSessionKey(key);
		const reportError = (error: unknown): void => {
			if (!machine || machine.local) return;
			if (isMachineNetworkError(error)) props.onMachineUnreachable?.(machine.id);
			else props.onMachineReachable?.(machine.id);
		};
		return {
			async setCardTitle(_sessionId, title) {
				try {
					const updated = await target.setCardTitle(rawId, title);
					if (machine && !machine.local) props.onMachineReachable?.(machine.id);
					return { ...updated, sessionId: key };
				} catch (error) {
					reportError(error);
					throw error;
				}
			},
			async undoCardTitle(_sessionId) {
				try {
					const updated = await target.undoCardTitle(rawId);
					if (machine && !machine.local) props.onMachineReachable?.(machine.id);
					return { ...updated, sessionId: key };
				} catch (error) {
					reportError(error);
					throw error;
				}
			},
		};
	};

	const renameCard = async (sessionId: string, title: string): Promise<void> => {
		setCardMutationError(null);
		try {
			const api = cardApiFor(sessionId);
			if (title.trim() !== "") {
				await renameCardOptimistically(api, sessionId, title.trim(), setTitleOverrides, saveCard);
				return;
			}
			const view = cards.find(card => card.card.sessionId === sessionId);
			if (!view) throw new Error("Session card is not available to restore.");
			let current = view.card;
			while (current.titleSource === "user" && current.titleHistory.length > 0) {
				const previous = current.titleHistory.at(-1);
				if (!previous) break;
				current = await undoCardTitleOptimistically(api, sessionId, previous.title, setTitleOverrides, saveCard);
			}
			if (current.titleSource === "user") throw new Error("Generated title is not available to restore.");
		} catch (error) {
			setCardMutationError(errorText(error));
			throw error;
		}
	};

	const undoCardTitle = async (sessionId: string): Promise<void> => {
		const view = cards.find(card => card.card.sessionId === sessionId);
		const previousTitle = view?.card.titleHistory.at(-1)?.title;
		if (previousTitle === undefined) return;
		setCardMutationError(null);
		try {
			await undoCardTitleOptimistically(cardApiFor(sessionId), sessionId, previousTitle, setTitleOverrides, saveCard);
		} catch (error) {
			setCardMutationError(errorText(error));
			throw error;
		}
	};

	const sessionApiFor = (key: string): { machine: Machine | undefined; target: SessionSidebarApi | DeckApi; rawId: string } => {
		const machine = machineForSessionKey(key, machines);
		return {
			machine,
			target: machine?.local ? api : machine?.api ?? api,
			rawId: sessionIdForSessionKey(key),
		};
	};
	const reportSessionFailure = (machine: Machine | undefined, error: unknown): void => {
		if (!machine || machine.local) return;
		if (isMachineNetworkError(error)) props.onMachineUnreachable?.(machine.id);
		else props.onMachineReachable?.(machine.id);
	};
	const openReadOnlyTranscript = (session: SessionSummary): void => {
		transcriptController.current?.abort();
		const controller = new AbortController();
		transcriptController.current = controller;
		setSessionOpenError(null);
		setReadOnlyTranscript({ session, loading: true });
		const { machine, target, rawId } = sessionApiFor(session.id);
		void target.sessionTranscript(rawId, controller.signal)
			.then(response => {
				if (controller.signal.aborted) return;
				if (machine && !machine.local) props.onMachineReachable?.(machine.id);
				setReadOnlyTranscript({ session, loading: false, response });
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				reportSessionFailure(machine, error);
				setReadOnlyTranscript({ session, loading: false, error: errorText(error) });
			});
	};
	const closeReadOnlyTranscript = (): void => {
		transcriptController.current?.abort();
		transcriptController.current = null;
		setReadOnlyTranscript(null);
	};
	const refreshLiveSharedSessions = useCallback(async (): Promise<void> => {
		setSharedFilterLoading(true);
		try {
			const shared = await Promise.all(allLive.map(async session => {
				const machine = machineForSessionKey(session.id, machines);
				const target = machine?.local ? api : machine?.api ?? api;
				try {
					const result = await target.sessionOpV3(sessionIdForSessionKey(session.id), { op: "collab-status" });
					if (machine && !machine.local) props.onMachineReachable?.(machine.id);
					return "participants" in result && result.participants.some(participant => participant.role === "guest") ? session.id : null;
				} catch (error) {
					if (machine && !machine.local) {
						if (isMachineNetworkError(error)) props.onMachineUnreachable?.(machine.id);
						else props.onMachineReachable?.(machine.id);
					}
					return null;
				}
			}));
			setLiveSharedSessionKeys(new Set(shared.filter((key): key is string => key !== null)));
		} finally {
			setSharedFilterLoading(false);
		}
	}, [allLive, api, machines, props.onMachineReachable, props.onMachineUnreachable]);
	useEffect(() => {
		if (liveSharedOnly) void refreshLiveSharedSessions();
	}, [liveSharedOnly, refreshLiveSharedSessions]);

	const togglePin = async (key: string, pinned: boolean): Promise<void> => {
		const { machine, target, rawId } = sessionApiFor(key);
		setPinError(null);
		try {
			const result = await target.setPinned(rawId, pinned);
			setPinOverrides(current => new Map(current).set(key, result.pinned));
			setCardResponse(current => current === null ? current : {
				...current,
				cards: current.cards.map(card => card.sessionId === key ? { ...card, pinned: result.pinned } : card),
			});
			setPeerLiveSessions(current => current.map(session => session.id === key ? { ...session, pinned: result.pinned } : session));
			setPeerRecentSessions(current => current.map(session => session.id === key ? { ...session, pinned: result.pinned } : session));
			setArchivedSessions(current => current.map(session => session.id === key ? { ...session, pinned: result.pinned } : session));
			if (machine && !machine.local) props.onMachineReachable?.(machine.id);
		} catch (error) {
			reportSessionFailure(machine, error);
			setPinError(errorText(error));
			throw error;
		}
	};
	const openRecipeEditor = async (key: string): Promise<void> => {
		const { machine, target, rawId } = sessionApiFor(key);
		setRecipeError(null);
		try {
			const source = await target.recipeSource(rawId);
			setRecipeEditor({
				source,
				machineId: machine?.id ?? "local",
				machineName: machine?.name ?? "Local",
				api: target,
			});
			if (machine && !machine.local) props.onMachineReachable?.(machine.id);
		} catch (error) {
			reportSessionFailure(machine, error);
			setRecipeError(errorText(error));
		}
	};
	const performArchive = async (item: SessionCardView, stopIfLive: boolean): Promise<{ id: string; title: string }> => {
		const key = item.card.sessionId;
		const { machine, target, rawId } = sessionApiFor(key);
		try {
			const record = await target.archiveSession(rawId, stopIfLive ? { stopIfLive: true } : {});
			if (machine && !machine.local) props.onMachineReachable?.(machine.id);
			const base = summaryFromCard(item);
			const title = titleOverrides.get(key) ?? item.card.title;
			const archived: SessionSummary = {
				...base,
				id: key,
				title: record.title ?? title,
				cwd: record.cwd ?? base.cwd,
				...(record.sessionFile === undefined ? {} : { sessionFile: record.sessionFile }),
				state: "stopped",
				archivedAt: record.archivedAt,
			};
			archiveRevision.current++;
			setArchivedSessions(current =>
				[archived, ...current.filter(session => session.id !== key)]
					.sort((a, b) => (b.archivedAt ?? b.lastActivityAt) - (a.archivedAt ?? a.lastActivityAt)),
			);
			return { id: key, title };
		} catch (error) {
			reportSessionFailure(machine, error);
			throw error;
		}
	};
	const archiveCard = async (item: SessionCardView, stopIfLive: boolean): Promise<void> => {
		if (archiveBusy) return;
		setArchiveBusy(true);
		setArchiveError(null);
		try {
			const archived = await performArchive(item, stopIfLive);
			showArchiveNotice({ message: `Archived “${archived.title}”`, sessionIds: [archived.id] });
		} catch (error) {
			setArchiveError(errorText(error));
			throw error;
		} finally {
			setArchiveBusy(false);
		}
	};
	const archiveOlder = async (sessionIds: string[]): Promise<void> => {
		if (archiveBusy) return;
		setArchiveBusy(true);
		setArchiveError(null);
		const archived: Array<{ id: string; title: string }> = [];
		try {
			for (const sessionId of sessionIds) {
				const item = visibleCards.find(view => view.card.sessionId === sessionId);
				if (!item) continue;
				const stopIfLive = item.live && (
					item.summary?.state === "streaming" ||
					item.summary?.state === "asking" ||
					item.summary?.awaitingAnswer === true
				);
				archived.push(await performArchive(item, stopIfLive));
			}
		} catch (error) {
			setArchiveError(errorText(error));
		} finally {
			setArchiveBusy(false);
		}
		if (archived.length > 0) {
			const count = archived.length;
			showArchiveNotice({
				message: `Archived ${count} older session${count === 1 ? "" : "s"}`,
				sessionIds: archived.map(session => session.id),
			});
		}
	};
	const restoreSessionKey = async (key: string): Promise<void> => {
		const { machine, target, rawId } = sessionApiFor(key);
		try {
			await target.restoreSession(rawId);
			if (machine && !machine.local) props.onMachineReachable?.(machine.id);
		} catch (error) {
			if (!(error instanceof DeckApiError && error.kind === "not-found")) {
				reportSessionFailure(machine, error);
				throw error;
			}
		}
		archiveRevision.current++;
		setArchivedSessions(current => current.filter(session => session.id !== key));
		if (archiveNotice?.sessionIds.includes(key)) hideArchiveNotice();
	};
	const restoreArchived = async (key: string): Promise<void> => {
		if (archiveBusy) return;
		setArchiveBusy(true);
		setArchiveError(null);
		try {
			await restoreSessionKey(key);
		} catch (error) {
			setArchiveError(errorText(error));
		} finally {
			setArchiveBusy(false);
		}
	};
	// Delete is offered only for archived sessions; the daemon refuses anything else and moves the transcript to the
	// Trash rather than erasing it.
	const deleteArchived = async (session: SessionSummary): Promise<void> => {
		if (archiveBusy) return;
		const { machine, target, rawId } = sessionApiFor(session.id);
		const title = session.title?.trim() || session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "this session";
		const where = machine && !machine.local ? ` on ${machine.name}` : "";
		if (
			typeof window !== "undefined" &&
			!window.confirm(
				`Delete “${title}”${where}? It leaves omp console for good. Its transcript is moved, not erased: to the Mac's Trash, or on the VPS to omp-console's trash folder.`,
			)
		) {
			return;
		}
		setArchiveBusy(true);
		setArchiveError(null);
		try {
			await target.trashSession(rawId);
			if (machine && !machine.local) props.onMachineReachable?.(machine.id);
		} catch (error) {
			// Every failure is shown (an older daemon without delete answers 404: nothing was deleted).
			reportSessionFailure(machine, error);
			setArchiveError(errorText(error));
			setArchiveBusy(false);
			return;
		}
		archiveRevision.current++;
		setArchivedSessions(current => current.filter(item => item.id !== session.id));
		setArchiveBusy(false);
	};
	const openArchived = async (session: SessionSummary): Promise<void> => {
		if (archiveBusy || !session.sessionFile) return;
		setArchiveBusy(true);
		setArchiveError(null);
		try {
			await restoreSessionKey(session.id);
			resumeQuietly(session);
		} catch (error) {
			setArchiveError(errorText(error));
		} finally {
			setArchiveBusy(false);
		}
	};
	const undoArchive = async (): Promise<void> => {
		const notice = archiveNotice;
		if (!notice || archiveBusy) return;
		setArchiveBusy(true);
		setArchiveError(null);
		const failed: string[] = [];
		let failure: string | undefined;
		try {
			for (const sessionId of notice.sessionIds) {
				try {
					await restoreSessionKey(sessionId);
				} catch (error) {
					failed.push(sessionId);
					failure ??= errorText(error);
				}
			}
		} finally {
			setArchiveBusy(false);
		}
		if (failed.length === 0) hideArchiveNotice();
		else {
			showArchiveNotice({ ...notice, sessionIds: failed });
			setArchiveError(failure ?? "The restore request failed.");
		}
	};
	const briefMachine = selectedId === null ? machines.find(machine => machine.local) : machineForSessionKey(selectedId, machines);
	const briefApi = briefMachine?.local ? api : briefMachine?.api ?? api;
	const briefSessionKey = (id: string): string => (briefMachine ? sessionKey(briefMachine, id) : id);
	const openSearchSession = (sessionId: string): void => {
		const session = summaryFor(sessionId);
		if (session && (liveIds.has(sessionId) || session.sessionFile)) {
			if (liveIds.has(sessionId)) props.onSelect(sessionId);
			else resumeQuietly(session);
		} else props.onSelect(sessionId);
	};
	const emptySessionContent: ReactNode = (
		<>
			<span>No sessions yet. Start one with + or pick a project folder.</span>
			{claudeImport?.found && (
				<button type="button" className="dk-empty-link" onClick={() => openPanel({ panel: "claude-import" })}>
					Import your Claude Code sessions
				</button>
			)}
		</>
	);

	return (
		<nav className="dk-side" data-variant={variant} aria-label="sessions" data-tour="sessions">
			<div className="dk-side-head">
				<span className="dk-side-title">Sessions</span>
				<span className="dk-side-tools">
					{props.quickAskEnabled === true && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							title="Ask your notes (⌘J)"
							aria-label="Ask your notes"
							onClick={() => openQuickAsk()}
						>
							<Search size={14} />
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						title="Project folders"
						aria-label="Project folders"
						onClick={() => openWorkspaces()}
					>
						<FolderGit2 size={14} />
					</button>
					<button
						data-tour="new-session"
						type="button"
						className={composing ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
						title="new session"
						aria-label="new session"
						aria-expanded={composing}
						onClick={openPicker}
					>
						<Plus size={14} />
					</button>
					{props.onHide && variant === "inline" && (
						<button type="button" className="sh-btn sh-btn-icon" title="hide sessions (⌘\\)" aria-label="hide sessions" onClick={props.onHide}>
							<PanelLeftClose size={14} />
						</button>
					)}
				</span>
			</div>
			{listError?.kind === "network" ? (
				<div className="dk-notice dk-notice-warn" role="status">
					<WifiOff size={14} />
					<span>omp console is restarting / unreachable — showing the last known sessions</span>
				</div>
			) : authFailed ? (
				<div className="dk-notice dk-notice-err" role="alert">
					<ShieldAlert size={14} />
					<span>Not authorized. Open omp console from this Mac or through your tailnet address; the daemon refuses other origins.</span>
				</div>
			) : listError ? (
				<div className="dk-notice dk-notice-warn" role="status">
					<WifiOff size={14} />
					<span>Could not load saved sessions: {listError.message}</span>
				</div>
			) : null}
			{!authFailed && machines.some(machine => !machine.local && !machine.reachable) &&
				machines.filter(machine => !machine.local && !machine.reachable).map(machine => (
					<p className="dk-machine-unreachable" role="status" key={machine.id}>{machine.name} unreachable</p>
				))}
			{composing && (
				<NewSessionPicker
					api={api}
					overnightEnabled={props.overnightEnabled === true}
					machines={machines}
					initialPath={pickerPath}
					busy={busy}
					actionError={props.actionError}
					onMachineReachable={props.onMachineReachable}
					onMachineUnreachable={props.onMachineUnreachable}
					onClose={closePicker}
					onCreate={props.onCreate}
					onStartRecipe={(id, machineId) => {
						const machine = machines.find(item => item.id === machineId) ?? machines.find(item => item.local);
						if (!machine) return;
						closePicker();
						props.onSelect(sessionKey(machine, id));
					}}
				/>
			)}
			{actionError && (
				<div className="dk-notice dk-notice-err" role="alert">
					<TriangleAlert size={14} />
					<span className="dk-notice-body">
						{props.resumeModelRetry ? (
							<>
								<span>
									This session was saved with <code>{props.resumeModelRetry.missingModel}</code>, which is no longer available, so it could
									not be resumed as it was.
								</span>
								{props.onRetryResumeOnDefault && (
									<button type="button" className="dk-wide-btn" disabled={busy} onClick={props.onRetryResumeOnDefault}>
										Resume on your default model
									</button>
								)}
							</>
						) : (
							<span>{actionError}</span>
						)}
						{props.sleepCandidateRetry && (
							<button
								type="button"
								className="dk-wide-btn"
								disabled={busy || sleepCandidateBusy}
								onClick={() => void sleepAndContinue()}
							>
								Sleep '{props.sleepCandidateRetry.candidate.title}' and continue
							</button>
						)}
						{sleepCandidateError && <span role="status">{sleepCandidateError}</span>}
					</span>
				</div>
			)}
			<div className="dk-scroll" data-local-outage={localOutage ? "true" : "false"}>
				{liveSharedOnly && (
					<div className="dk-notice dk-notice-warn" role="status">
						<span>
							{sharedFilterLoading ? "Checking live rooms for connected guests…" : "Showing live sessions with connected guests."}
						</span>
						<button type="button" className="dk-wide-btn" onClick={() => props.onClearLiveSharedSessions?.()}>Show all sessions</button>
					</div>
				)}
				<SessionSearch
					api={api}
					cards={liveSharedOnly ? visibleCards : cards}
					machines={machines}
					archivedSessions={liveSharedOnly ? [] : archivedSessions}
					pinnedIds={new Set(pinnedKeys)}
					onOpen={openSearchSession}
					onTogglePin={togglePin}
				/>
				{props.librarianEnabled === true && selectedId !== null && (
					<ReturnBrief
						api={briefApi}
						canOpenSession={(id, line) => canOpenSession(briefSessionKey(id), line)}
						onOpenSession={(id, line) => openSession(briefSessionKey(id), line)}
						compact
					/>
				)}
				{cardLoadError && <div className="dk-notice dk-notice-warn" role="status">Session cards are unavailable: {cardLoadError}</div>}
				{cardMutationError && <div className="dk-notice dk-notice-err" role="alert">Title update failed: {cardMutationError}</div>}
				{archiveError && <div className="dk-notice dk-notice-err" role="alert">Archive failed: {archiveError}</div>}
				{pinError && <div className="dk-notice dk-notice-err" role="alert">Pin update failed: {pinError}</div>}
				{recipeError && <div className="dk-notice dk-notice-err" role="alert">Could not load session template source: {recipeError}</div>}
				{claudeImportError && <div className="dk-notice dk-notice-warn" role="status">Claude Code import check failed: {claudeImportError}</div>}
				{sessionOpenError && <div className="dk-notice dk-notice-err" role="alert">Could not open saved session: {sessionOpenError}</div>}
				{localOutage && cards.length === 0 ? (
					<div className="dk-empty" role="status">No last-known session list is available yet.</div>
				) : liveSharedOnly && sharedFilterLoading && visibleCards.length === 0 ? (
					<div className="dk-empty" role="status">Checking live rooms for connected guests…</div>
				) : liveSharedOnly && visibleCards.length === 0 ? (
					<div className="dk-empty" role="status">No live shared sessions with connected guests.</div>
				) : listError && sessions === null ? (
					<div className="dk-empty" role="status">Saved sessions could not be loaded. See the error above for the directory and next step.</div>
				) : sessions === null ? (
					<div className="dk-empty" role="status">Loading sessions…</div>
				) : (
					<SessionCardList
						cards={visibleCards}
						emptyContent={cards.length === 0 ? emptySessionContent : undefined}
						topics={liveSharedOnly ? [] : cardResponse?.topics ?? []}
						health={health}
						selectedId={selectedId}
						busy={busy || archiveBusy}
						actionError={archiveError ?? cardMutationError ?? props.actionError}
						onSelect={props.onSelect}
						onResume={props.onResume}
						onFork={props.onFork}
						onReadOnlyTranscript={openReadOnlyTranscript}
						onStop={props.onStop}
						onStopTurn={props.onStopTurn}
						canRename={props.librarianEnabled === true}
						overnightEnabled={props.overnightEnabled === true}
						onRename={renameCard}
						onUndoRename={undoCardTitle}
						onArchive={archiveCard}
						onArchiveAll={sessionIds => void archiveOlder(sessionIds)}
						onTogglePin={togglePin}
						onSaveRecipe={sessionId => void openRecipeEditor(sessionId)}
						touch={props.touch === true}
						uiTargetForSession={key => {
							const { target, rawId } = sessionApiFor(key);
							return { api: target, sessionId: rawId };
						}}
						refreshKey={sessions}
						offlineMachines={offlineMachines}
					/>
				)}
				{!liveSharedOnly && (
					<ArchivedSessionGroup
						sessions={archivedSessions}
						expanded={archivedOpen}
						busy={busy || archiveBusy}
						onToggle={() => setArchivedOpen(open => !open)}
						onRestore={session => void restoreArchived(session.id)}
						onOpen={session => void openArchived(session)}
						onDelete={session => void deleteArchived(session)}
					/>
				)}
			</div>
			{archiveNotice && (
				<div
					className={archiveNoticeLeaving ? "dk-archive-toast sh-toast sh-toast-info is-exiting" : "dk-archive-toast sh-toast sh-toast-info"}
					role="status"
					onPointerEnter={() => setArchiveNoticeHeld(true)}
					onPointerLeave={() => setArchiveNoticeHeld(false)}
				>
					<span className="sh-toast-msg">{archiveNotice.message}</span>
					<button type="button" className="sh-btn sh-btn-icon dk-archive-undo" aria-label="Undo archive" disabled={archiveBusy} onClick={() => void undoArchive()}>
						<Undo2 size={13} />
						Undo
					</button>
					<button type="button" className="sh-btn sh-btn-icon" aria-label="dismiss" onClick={hideArchiveNotice}>
						<X size={13} />
					</button>
				</div>
			)}
			{recipeEditor && (
				<RecipeEditor
					source={recipeEditor.source}
					machineName={recipeEditor.machineName}
					machineId={recipeEditor.machineId}
					busy={busy}
					onClose={() => setRecipeEditor(null)}
					onSave={async input => {
						await recipeEditor.api.createRecipe(input);
						setRecipeEditor(null);
					}}
				/>
			)}
			{readOnlyTranscript && (
				<div className="dk-transcript-overlay">
					<section className="dk-transcript-dialog" role="dialog" aria-modal="true" aria-labelledby="dk-transcript-title">
						<header className="dk-transcript-head">
							<div>
								<h2 id="dk-transcript-title">{readOnlyTranscript.session.title?.trim() || readOnlyTranscript.session.cwd}</h2>
								<p>This project folder no longer exists. This saved transcript is read-only.</p>
								<code>{readOnlyTranscript.session.cwd}</code>
							</div>
							<button type="button" className="sh-btn" onClick={closeReadOnlyTranscript}>Close</button>
						</header>
						{readOnlyTranscript.loading && <p role="status">Loading saved transcript…</p>}
						{readOnlyTranscript.error && <p className="dk-notice dk-notice-err" role="alert">{readOnlyTranscript.error}</p>}
						{readOnlyTranscript.response?.truncated && <p className="dk-notice dk-notice-warn" role="status">Only the recent part of this transcript is shown.</p>}
						{readOnlyTranscript.response?.messages.length === 0 && <p>No user or assistant messages were found in this saved transcript.</p>}
						{readOnlyTranscript.response && (
							<div className="dk-transcript-messages">
								{readOnlyTranscript.response.messages.map((message, index) => (
									<article className="dk-transcript-message" key={`${index}:${message.role}`}>
										<strong>{message.role === "user" ? "You" : "Assistant"}</strong>
										<pre>{message.text}</pre>
									</article>
								))}
							</div>
						)}
					</section>
				</div>
			)}
		</nav>
	);
}

interface ArchivedSessionGroupProps {
	sessions: readonly SessionSummary[];
	expanded: boolean;
	busy: boolean;
	onToggle(): void;
	onRestore(session: SessionSummary): void;
	onOpen(session: SessionSummary): void;
	onDelete(session: SessionSummary): void;
}

function ArchivedSessionGroup({ sessions, expanded, busy, onToggle, onRestore, onOpen, onDelete }: ArchivedSessionGroupProps): ReactNode {
	return (
		<section className="dk-archive-group">
			<button type="button" className="dk-section dk-section-button dk-archive-section" aria-expanded={expanded} onClick={onToggle}>
				<span>{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}Archived ({sessions.length})</span>
			</button>
			{expanded && sessions.length > 0 && (
				<ul className="dk-list">
					{sessions.map(session => {
						const folder = session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Unknown folder";
						const title = session.title?.trim() || folder;
						const archivedAt = session.archivedAt ?? session.lastActivityAt;
						return (
							<li className="dk-archived-row" key={session.id}>
								<button
									type="button"
									className="dk-archived-open"
									disabled={busy || !session.sessionFile}
									title={session.sessionFile ? "Restore and open session" : "No saved session file"}
									onClick={() => onOpen(session)}
								>
									<span className="dk-archived-title">{title}</span>
									<span className="dk-archived-meta">{folder} · archived {relTime(archivedAt)}</span>
								</button>
								<button
									type="button"
									className="sh-btn sh-btn-icon dk-archived-restore"
									aria-label={`Restore ${title}`}
									title={`Restore ${title}`}
									disabled={busy}
									onClick={() => onRestore(session)}
								>
									<RotateCcw size={12} />
									<span>Restore</span>
								</button>
								<button
									type="button"
									className="sh-btn sh-btn-icon dk-archived-delete"
									aria-label={`Delete ${title}`}
									title={`Delete ${title} (moves it to the Trash)`}
									disabled={busy}
									onClick={() => onDelete(session)}
								>
									<Trash2 size={12} />
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
