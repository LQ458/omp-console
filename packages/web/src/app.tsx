import type {
	AgendaItem,
	BriefLine,
	CollabSessionStatus,
	CreateSessionRequest,
	DaemonCapabilities,
	RoomLinkResponse,
	RoomPermission,
	SessionSummary,
	OvernightState,
} from "@omp-console/protocol";
import type { AssistantMessage, CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { type PaneSessionArgs, usePaneState, usePoolSnapshot } from "./components/panes/context";
import { PaneHost } from "./components/panes/PaneHost";
import { useThrottledGuestSnapshot } from "./components/panes/throttled-source";
import { Alerts } from "./components/shell/Alerts";
import { Banners, OfflineBanner, PaneRecoveryBanner, RestartNoticeBanner } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { NeedsYouBar } from "./components/shell/NeedsYouBar";
import { QuickReplies, latestAgentAnswerEntryId, type QuickReplyStatus } from "./components/shell/QuickReplies";
import type { UiRequestTarget } from "./components/shell/InlineUiRequest";
import { SuggestionBar } from "./components/session-ops/SuggestionBar";
import { Sheet } from "./components/shell/Sheet";
import type { SettingsScope } from "./components/shell/SettingsSheet";
import { OvernightSheet } from "./components/overnight/OvernightSheet";
import { Toasts } from "./components/shell/Toasts";
import { LazyRegion } from "./components/shell/LazyRegion";
import { lazyWithRecovery } from "./lib/lazy";
import { handleGlobalSettingsShortcut, registerNativeMenuActions } from "./lib/settings-actions";
import { MachineChip } from "./components/machines/MachineChip";
import { SpawnHost, useOpenAgentEvent } from "./components/spawn/SpawnDialog";
import { Transcript, type TranscriptScrollPosition } from "./components/transcript/Transcript";
import { copyText } from "./components/catalog/clipboard";
import { copyCommandCode, copyableMessageText, extractFencedCodeBlocks, latestTranscriptLink, openExternalLink } from "./components/transcript/clipboard";
import { DriftCard } from "./components/safety/DriftCard";
import { QuickAskHost } from "./components/workspaces/QuickAsk";
import { OPEN_QUICK_ASK_EVENT, OPEN_WORKSPACES_EVENT, openWorkspaces } from "./components/workspaces/events";
import { OPEN_SESSION_CONTROLS_EVENT, runShellKeyAction } from "./lib/key-actions";
import { KEYMAP_ACTION_EVENT, OPEN_KEYBINDINGS_EVENT, type KeymapActionDetail, openBtwPanel } from "./lib/keymap";
import { OPEN_PANEL_EVENT, insertIntoComposer, openPanel, type OpenPanelDetail } from "./lib/palette";
import { useSessionLook } from "./components/workspaces/use-session-look";
import { WorkspaceProvider } from "./components/workspaces/WorkspaceProvider";
import { WorkspacesHost } from "./components/workspaces/WorkspacesSheet";
import { AlertStore, alertFromSignal } from "./lib/alerts";
import { DeckApi, DeckApiError, type RestartNotice } from "./lib/api";
import { PairScreen } from "./components/shell/PairScreen";
import { firstPromptTitle, sessionDisplayTitle, useCardTitle, useUserTitle } from "./lib/card-titles";
import {
	createMachineSwitcherApi,
	isMachineNetworkError,
	machineForSessionKey,
	machineIdForSessionKey,
	MachineDirectory,
	sessionIdForSessionKey,
	sessionKey,
	useMachines,
} from "./lib/machines";
import { countPlanApprovals, runSessionOp } from "./lib/session-ops";
import { stopTurn } from "./lib/away";
import { GuestClient } from "./lib/client";
import { fmtDuration } from "./lib/format";
import { promptHistory } from "./lib/prompt-history";
import { limitPhoneSuggestions } from "./lib/phone-actions";
import { foreignRelayHost, parseDeepLink, watchSessionDeepLink } from "./lib/deeplink";
import { deriveGoal } from "./lib/goal";
import { GuestPool } from "./lib/guest-pool";
import { type HealthView, healthView } from "./lib/health";
import { forgetLastSession, pickRestorableSession, readLastSession, rememberLastSession } from "./lib/last-session";
import { isStandaloneDisplay, type LayoutMode, useLayoutMode } from "./lib/layout";
import { browserLifecycle } from "./lib/lifecycle";
import { selectNeedsYou } from "./lib/needs-you";
import { notificationSignals } from "./lib/notifications";
import {
	CURRENT_LAYOUT,
	type LayoutStorage,
	PaneModel,
	paneRecoveryStatus,
	readLayout,
	staleSessions,
} from "./lib/pane-layout";
import { SessionSwitcher, type SessionSwitcherApi } from "./lib/switcher";
import { handleServiceWorkerMessage } from "./lib/sw-messages";
import { useGuestSelector } from "./lib/use-guest";
import { type GuestSwitcher, useSwitcherSnapshot } from "./lib/use-switcher";
import { trackViewport } from "./lib/viewport";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";
import "./components/shell/mobile.css";

const EMPTY_PHONE_SUGGESTIONS: readonly string[] = [];

const AgentsOverlay = lazyWithRecovery(() => import("./components/agents/AgentsOverlay").then(({ AgentsOverlay: component }) => ({ default: component })));
const AgentsPanel = lazyWithRecovery(() => import("./components/agents/AgentsPanel").then(({ AgentsPanel: component }) => ({ default: component })));
const AgendaSessionAction = lazyWithRecovery(() => import("./components/agenda/AgendaSessionAction").then(({ AgendaSessionAction: component }) => ({ default: component })));
const AgendaStartSessionProvider = lazyWithRecovery(() => import("./components/agenda/AgendaStrip").then(({ AgendaStartSessionProvider: component }) => ({ default: component })));
const HomeScreen = lazyWithRecovery(() => import("./components/shell/HomeScreen").then(({ HomeScreen: component }) => ({ default: component })));
const SettingsSheet = lazyWithRecovery(() => import("./components/shell/SettingsSheet").then(({ SettingsSheet: component }) => ({ default: component })));
const SetupSheet = lazyWithRecovery(() => import("./components/setup/SetupSheet").then(({ SetupSheet: component }) => ({ default: component })));
const StatusSheet = lazyWithRecovery(() => import("./components/shell/StatusSheet").then(({ StatusSheet: component }) => ({ default: component })));
const CommandResults = lazyWithRecovery(() => import("./components/commands/CommandResults").then(({ CommandResults: component }) => ({ default: component })));
const DiscoveryHost = lazyWithRecovery(() => import("./components/catalog/DiscoveryHost").then(({ DiscoveryHost: component }) => ({ default: component })));
const HeaderBar = lazyWithRecovery(() => import("./components/shell/HeaderBar").then(({ HeaderBar: component }) => ({ default: component })));
const SessionSidebar = lazyWithRecovery(() => import("./components/switcher/SessionSidebar").then(({ SessionSidebar: component }) => ({ default: component })));
const NewSessionPicker = lazyWithRecovery(() => import("./components/newsession/NewSessionPicker").then(({ NewSessionPicker: component }) => ({ default: component })));
const ClaudeImportPanel = lazyWithRecovery(() => import("./components/migrate/ClaudeImportPanel").then(({ ClaudeImportPanel: component }) => ({ default: component })));

function LoadingPanel({ label }: { label: string }): ReactNode {
	return (
		<div className="pn-note" role="status" aria-busy="true">
			<span className="sh-banner-dot" />
			<p className="pn-note-body">Loading {label}…</p>
		</div>
	);
}

function SessionSidebarLoading(): ReactNode {
	return (
		<nav className="dk-side" aria-label="sessions" aria-busy="true">
			<div className="dk-side-head"><span className="dk-side-title">Sessions</span></div>
			<div className="dk-scroll"><LoadingPanel label="sessions" /></div>
		</nav>
	);
}

function HeaderLoading(): ReactNode {
	return (
		<header className="sh-header" aria-busy="true">
			<div className="sh-header-left"><span className="sh-brand">omp console</span></div>
			<div className="sh-header-right"><span className="sh-chip">Loading session…</span></div>
		</header>
	);
}

const NAME_KEY = "omp-console.name";
const RESTART_NOTICE_KEY = "omp-console.restart-notice-dismissed";
const PEER_REFRESH_MS = 10_000;

type SheetName = "sessions" | "status" | "settings" | "overnight" | "setup";

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "omp console";
	} catch {
		return "omp console";
	}
}

function latestCopyText(entries: readonly SessionEntry[], stream: AssistantMessage | null): string | null {
	if (stream !== null) {
		const text = copyableMessageText(stream.content);
		if (text.trim() !== "") return text;
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || (entry.message.role !== "assistant" && entry.message.role !== "user")) continue;
		const text = copyableMessageText(entry.message.content);
		if (text.trim() !== "") return text;
	}
	return null;
}

function latestAssistantText(entries: readonly SessionEntry[], stream: AssistantMessage | null): string | null {
	if (stream !== null) {
		const text = copyableMessageText(stream.content);
		if (text.trim() !== "") return text;
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const text = copyableMessageText(entry.message.content);
		if (text.trim() !== "") return text;
	}
	return null;
}

function latestCopyCode(entries: readonly SessionEntry[], stream: AssistantMessage | null): string | null {
	const text = latestAssistantText(entries, stream);
	if (text === null) return null;
	return extractFencedCodeBlocks(text).at(-1) ?? null;
}

function latestCopyCommand(entries: readonly SessionEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		for (let blockIndex = entry.message.content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = entry.message.content[blockIndex];
			if (block?.type !== "toolCall") continue;
			const command = copyCommandCode(block.name, block.arguments);
			if (command !== null) return command;
		}
	}
	return null;
}

const SIDEBAR_OPEN_KEY = "omp-console.sidebar.open";

function readSidebarOpen(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
	} catch {
		return true;
	}
}

function writeSidebarOpen(open: boolean): void {
	try {
		localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "true" : "false");
	} catch {
		// Blocked storage: the sidebar just reopens on the next load.
	}
}

function createSwitcher(api: SessionSwitcherApi): GuestSwitcher {
	return new SessionSwitcher<GuestClient>({
		api,
		createClient: (link, name) => new GuestClient(link, name),
		name: storedName(),
		lifecycle: browserLifecycle(),
	});
}

function createPool(api: SessionSwitcherApi): GuestPool<GuestClient> {
	return new GuestPool<GuestClient>({
		api,
		createClient: (link, name) => new GuestClient(link, name),
		name: storedName(),
	});
}

/** `localStorage`, or undefined where touching it throws (blocked storage). */
function layoutStorage(): LayoutStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function createPaneModel(): PaneModel {
	return new PaneModel(readLayout(layoutStorage(), CURRENT_LAYOUT) ?? undefined);
}

function folderName(cwd: string): string {
	const trimmed = cwd.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || "session";
}

/** Distinct React key per client so session-local UI state (rail, drawer) resets on a switch. */
const clientKeys = new WeakMap<GuestClient, number>();
let nextClientKey = 0;
function clientKey(client: GuestClient): number {
	let key = clientKeys.get(client);
	if (key === undefined) {
		key = nextClientKey++;
		clientKeys.set(client, key);
	}
	return key;
}

const selectPhase = (s: { phase: string }): string => s.phase;
const selectReadOnly = (s: { readOnly: boolean }): boolean => s.readOnly;
const selectAsk = (s: { uiRequest: CollabUiRequest | null }): CollabUiRequest | null => s.uiRequest;
const NO_SESSIONS: readonly SessionSummary[] = [];
const DISABLED_CAPABILITIES: DaemonCapabilities = {
	features: { librarian: false, agenda: false, quickAsk: false, peers: false, openrouterDecisions: false, computerUse: false, overnight: false },
	quickAskSources: [],
};
/** Window-level events (new agent, open agent drawer) belong to the focused pane only; the others listen to nothing. */
const ignoreOpenAgent = (): void => {};
const STOP_TURN_NOTE: Record<"idle", string> = {
	idle: "The turn had already finished.",
};

function useCoarsePointer(): boolean {
	const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
	useEffect(() => {
		const query = window.matchMedia("(pointer: coarse)");
		const update = (): void => setCoarse(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return coarse;
}

interface NeedsYouHostProps {
	client: GuestClient | null;
	selectedId: string | null;
	sessions: readonly SessionSummary[];
	onOpen(sessionId: string): void;
	touch: boolean;
	uiTargetForSession(sessionId: string): UiRequestTarget | null;
}

/** Subscribes to just the guest fields the bar depends on; its rows reload on the existing session poll. */
function NeedsYouHost({ client, selectedId, sessions, onOpen, touch, uiTargetForSession }: NeedsYouHostProps): ReactNode {
	const phase = useGuestSelector(client, selectPhase, "ended");
	const readOnly = useGuestSelector(client, selectReadOnly, false);
	const ask = useGuestSelector(client, selectAsk, null);
	const items = useMemo(
		() => selectNeedsYou(sessions, { sessionId: selectedId, live: phase === "live", canAnswer: !readOnly, ask }),
		[sessions, selectedId, phase, readOnly, ask],
	);
	return <NeedsYouBar items={items} onOpen={onOpen} touch={touch} uiTargetForSession={uiTargetForSession} refreshKey={sessions} />;
}

export function App({ initialPairCode }: { initialPairCode?: string } = {}): ReactNode {

	const [pairState, setPairState] = useState<"checking" | "paired" | "unpaired">("checking");
	const markUnpaired = useCallback(() => setPairState("unpaired"), []);
	const markPaired = useCallback(() => setPairState("paired"), []);
	const [api] = useState(() => new DeckApi({ onUnauthorized: markUnpaired }));
	const [capabilities, setCapabilities] = useState<DaemonCapabilities>(DISABLED_CAPABILITIES);
	useEffect(() => {
		let active = true;
		void api.pairStatus().then(({ paired }) => {
			if (active) setPairState(paired ? "paired" : "unpaired");
		}).catch(reason => {
			if (active) setPairState(reason instanceof DeckApiError && reason.status === 401 ? "unpaired" : "paired");
		});
		return () => {
			active = false;
		};
	}, [api]);
	// Capabilities are an authenticated route: load them once this device is paired.
	useEffect(() => {
		if (pairState !== "paired") return;
		const controller = new AbortController();
		let mounted = true;
		void api.capabilities(controller.signal).then(result => {
			if (mounted) setCapabilities(result);
		}).catch(() => {});
		return () => {
			mounted = false;
			controller.abort();
		};
	}, [api, pairState]);

	if (pairState === "checking") {
		return <main className="pair-page" role="status" aria-busy="true">Connecting to daemon…</main>;
	}
	if (pairState === "unpaired") return <PairScreen api={api} onPaired={markPaired} initialCode={initialPairCode} />;

	return (
		<WorkspaceProvider api={api}>
			<Deck api={api} capabilities={capabilities} onCapabilitiesChanged={setCapabilities} />
		</WorkspaceProvider>
	);
}

function Deck({ api, capabilities, onCapabilitiesChanged }: {
	api: DeckApi;
	capabilities: DaemonCapabilities;
	onCapabilitiesChanged: (capabilities: DaemonCapabilities) => void;
}): ReactNode {
	const [machineDirectory] = useState(() => new MachineDirectory(api));
	const machineApi = useMemo(() => createMachineSwitcherApi(machineDirectory), [machineDirectory]);
	const machineSnapshot = useMachines(machineDirectory);
	const visibleMachines = useMemo(
		() => capabilities.features.peers ? machineSnapshot.machines : [machineDirectory.local],
		[capabilities.features.peers, machineSnapshot.machines, machineDirectory],
	);
	const uiTargetForSession = useCallback((key: string): UiRequestTarget | null => {
		const machine = machineForSessionKey(key, visibleMachines);
		return machine === undefined ? null : { api: machine.api, sessionId: sessionIdForSessionKey(key) };
	}, [visibleMachines]);
	const [switcher] = useState(() => createSwitcher(machineApi));
	const [pool] = useState(() => createPool(machineApi));
	const [model] = useState(createPaneModel);
	const [alertStore] = useState(() => new AlertStore());
	// A keyboard shortcut whose control failed (model switch refused, nothing to retry, ...) says why.
	useEffect(() => {
		const onError = (event: Event): void => {
			const detail = (event as CustomEvent<{ sessionId: string; message: string }>).detail;
			alertStore.push({ tag: `${detail.sessionId}:shortcut`, sessionId: detail.sessionId, title: "Shortcut", body: detail.message, level: "warning", ttlMs: 5_000 });
		};
		window.addEventListener("omp-console:keymap-error", onError);
		return () => window.removeEventListener("omp-console:keymap-error", onError);
	}, [alertStore]);
	const snap = useSwitcherSnapshot(switcher);
	const paneState = usePaneState(model);
	const poolSnap = usePoolSnapshot(pool);
	const mode = useLayoutMode();
	const coarsePointer = useCoarsePointer();
	const touchLayout = mode !== "desktop" || coarsePointer;
	const [standalone] = useState(isStandaloneDisplay);
	const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
	useEffect(() => writeSidebarOpen(sidebarOpen), [sidebarOpen]);
	const [sheet, setSheet] = useState<SheetName | null>(null);
	const [claudeImportOpen, setClaudeImportOpen] = useState(false);
	const [overnightTarget, setOvernightTarget] = useState<{ sessionId?: string; cwd?: string; task?: string } | null>(null);
	const [settingsScope, setSettingsScope] = useState<SettingsScope>("global");
	const [settingsInitialSection, setSettingsInitialSection] = useState<"session" | "plugins">("session");
	const [collabListOnly, setCollabListOnly] = useState(false);
	const [joinOpen, setJoinOpen] = useState(false);
	const [joinLinkDraft, setJoinLinkDraft] = useState("");
	const [joinError, setJoinError] = useState<string | null>(null);
	const [agendaTask, setAgendaTask] = useState<AgendaItem | null>(null);
	const [agendaPrompt, setAgendaPrompt] = useState("");
	const [agendaSession, setAgendaSession] = useState<SessionSummary | null>(null);
	const [agendaStartBusy, setAgendaStartBusy] = useState(false);
	const [agendaStartError, setAgendaStartError] = useState<string | null>(null);
	const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
	const [restartNotice, setRestartNotice] = useState<RestartNotice | null>(null);
	const [missingSince, setMissingSince] = useState<ReadonlyMap<string, number>>(() => new Map());
	const [recoveryClock, setRecoveryClock] = useState(Date.now);
	const sessionSummaryRef = useRef(new Map<string, SessionSummary>());
	const liveSeenAtRef = useRef(new Map<string, number>());
	const transcriptScrollRef = useRef(new Map<string, TranscriptScrollPosition>());
	const reconnectNoticeRef = useRef(false);
	const restartNoticeActiveRef = useRef(false);
	/** Per live session: the session list in which its ended/failed pane was last rejoined. One retry per fresh list, so a
	 * rejoin that failed while the daemon was down is retried once it answers again (a stale list never retries). */
	const reconnectAttemptsRef = useRef(new Map<string, unknown>());

	useEffect(() => {
		const unsubscribe = browserLifecycle().subscribe(event => {
			if (event === "offline") setOffline(true);
			else if (event === "online") setOffline(false);
		});
		return unsubscribe;
	}, []);

	const loadRestartNotice = useCallback((): void => {
		void api
			.restartNotice()
			.then(notice => {
				if (!restartNoticeActiveRef.current || notice === null) return;
				let dismissed: string | null = null;
				try {
					dismissed = localStorage.getItem(RESTART_NOTICE_KEY);
				} catch {
					// The notice remains visible when storage is unavailable.
				}
				if (dismissed !== String(notice.at)) {
					setRestartNotice(current => (current?.at === notice.at ? current : notice));
				}
			})
			.catch(() => {});
	}, [api]);

	useEffect(() => {
		restartNoticeActiveRef.current = true;
		loadRestartNotice();
		const unsubscribe = browserLifecycle().subscribe(event => {
			if (event === "online" || (event === "visible" && navigator.onLine)) loadRestartNotice();
		});
		return () => {
			restartNoticeActiveRef.current = false;
			unsubscribe();
		};
	}, [loadRestartNotice]);

	useEffect(() => {
		if (snap.listError !== null) {
			reconnectNoticeRef.current = true;
			return;
		}
		if (!reconnectNoticeRef.current) return;
		reconnectNoticeRef.current = false;
		loadRestartNotice();
	}, [snap.listError, loadRestartNotice]);

	const dismissRestartNotice = useCallback((): void => {
		if (restartNotice === null) return;
		try {
			localStorage.setItem(RESTART_NOTICE_KEY, String(restartNotice.at));
		} catch {
			// Dismissal is still effective for this page.
		}
		setRestartNotice(null);
	}, [restartNotice]);

	useEffect(() => {
		if (!capabilities.features.peers) return;
		const refresh = (): void => {
			if (typeof navigator === "undefined" || navigator.onLine) void machineDirectory.refresh();
		};
		refresh();
		const unsubscribe = browserLifecycle().subscribe(event => {
			if (event === "online" || (event === "visible" && navigator.onLine)) refresh();
		});
		const timer = setInterval(() => {
			if (!document.hidden) refresh();
		}, PEER_REFRESH_MS);
		return () => {
			clearInterval(timer);
			unsubscribe();
		};
	}, [machineDirectory, capabilities.features.peers]);
	useEffect(() => () => machineDirectory.dispose(), [machineDirectory]);

	useEffect(() => {
		if (!capabilities.features.peers || !visibleMachines.some(machine => !machine.local)) return;
		void switcher.refresh();
		pool.revive();
	}, [capabilities.features.peers, visibleMachines, switcher, pool]);
	useEffect(() => {
		switcher.start();
		return () => switcher.dispose();
	}, [switcher]);

	// The pool owns the connections of every pane; a returning page revives all of them.
	useEffect(() => {
		let offlineSignal = false;
		let lastReviveAt: number | null = null;
		const unsubscribe = browserLifecycle().subscribe(event => {
			if (event === "offline") {
				offlineSignal = true;
				return;
			}
			if (event === "hidden" || offlineSignal) {
				if (event === "online") {
					offlineSignal = false;
					pool.revive();
					lastReviveAt = Date.now();
				}
				return;
			}
			const now = Date.now();
			if (lastReviveAt === null || now - lastReviveAt >= 100) {
				pool.revive();
				lastReviveAt = now;
			}
		});
		return () => {
			unsubscribe();
			pool.dispose();
		};
	}, [pool]);

	// A sessions sheet only exists on a phone; leaving that layout (rotate, resize) drops it.
	useEffect(() => {
		if (mode !== "phone") setSheet(current => (current === "sessions" ? null : current));
	}, [mode]);

	const closeSheet = useCallback(() => {
		setSheet(null);
		setOvernightTarget(null);
	}, []);

	// The workspaces sheet and quick-ask replace whatever sheet the button was pressed in (phone session list).
	useEffect(() => {
		const close = (): void => setSheet(null);
		window.addEventListener(OPEN_WORKSPACES_EVENT, close);
		window.addEventListener(OPEN_QUICK_ASK_EVENT, close);
		return () => {
			window.removeEventListener(OPEN_WORKSPACES_EVENT, close);
			window.removeEventListener(OPEN_QUICK_ASK_EVENT, close);
		};
	}, []);
	// Panels named by the palette's `deckControl` (TUI-only omp commands) and other `omp-console:open-panel` senders. `spawn`
	// and `catalog` have their own hosts; `agents` is handled by the focused session view.
	useEffect(() => {
		const onPanel = (event: Event): void => {
			const detail = (event as CustomEvent<OpenPanelDetail>).detail;
			if (detail?.panel === "overnight" && !capabilities.features.overnight) return;
			if (detail?.panel === "claude-import") {
				setSheet(null);
				setClaudeImportOpen(true);
			} else if (detail?.panel === "overnight") {
				setOvernightTarget({
					sessionId: detail.sessionId,
					cwd: detail.cwd,
					task: detail.task ?? (detail.command === "overnight" ? detail.args : undefined),
				});
				setSheet("overnight");
			} else if (detail?.panel === "status" || detail?.panel === "plan" || detail?.panel === "tree") setSheet("status");
			else if (detail?.panel === "settings") {
				setSettingsScope("global");
				setSettingsInitialSection("session");
				setSheet("settings");
			} else if (detail?.panel === "extensions") {
				setSettingsScope("session");
				setSettingsInitialSection("plugins");
				setSheet("settings");
			} else if (detail?.panel === "sessions") setSheet("sessions");
			else if (detail?.panel === "setup") setSheet("setup");
			else if (detail?.panel === "collab" && detail.command === "collab" && detail.args?.trim().toLowerCase() === "list") {
				setCollabListOnly(true);
				setSidebarOpen(true);
				setSheet("sessions");
			} else if (detail?.panel === "workspaces") openWorkspaces();
			else if (detail?.panel === "btw") openBtwPanel();
		};
		window.addEventListener(OPEN_PANEL_EVENT, onPanel);
		return () => window.removeEventListener(OPEN_PANEL_EVENT, onPanel);
	}, [capabilities.features.overnight]);
	// The focused pane's session drives the sidebar highlight, the needs-you bar and the status sheet.
	const focusedKey = useMemo(
		() => paneState.panes.find(pane => pane.id === paneState.focusedId)?.sessionId ?? null,
		[paneState.panes, paneState.focusedId],
	);
	const client = focusedKey === null ? null : (poolSnap.clients.get(focusedKey) ?? null);
	const selectedId = focusedKey !== null && !focusedKey.startsWith("link:") ? focusedKey : null;
	const selectedMachine =
		selectedId === null
			? visibleMachines.find(machine => machine.local)
			: machineForSessionKey(selectedId, visibleMachines);
	const selectedSessionId = selectedId === null ? null : sessionIdForSessionKey(selectedId);
	const selectedApi = selectedMachine?.api ?? api;
	const machineSessions = useMemo(() => {
		const sameMachine = (summary: SessionSummary): boolean =>
			selectedMachine === undefined || machineForSessionKey(summary.id, visibleMachines)?.id === selectedMachine.id;
		return {
			live: (snap.sessions?.live ?? []).filter(sameMachine).map(summary => ({ ...summary, id: sessionIdForSessionKey(summary.id) })),
			recent: (snap.sessions?.recent ?? []).filter(sameMachine).map(summary => ({ ...summary, id: sessionIdForSessionKey(summary.id) })),
		};
	}, [snap.sessions, selectedMachine, visibleMachines]);
	const machineHealth = useMemo(() => {
		if (snap.health === null || selectedMachine === undefined) return snap.health;
		return {
			...snap.health,
			workers: snap.health.workers
				.filter(worker => machineForSessionKey(worker.sessionId, visibleMachines)?.id === selectedMachine.id)
				.map(worker => ({ ...worker, sessionId: sessionIdForSessionKey(worker.sessionId) })),
		};
	}, [snap.health, selectedMachine, visibleMachines]);

	const connectLink = useCallback(
		(link: string, name: string): void => {
			const foreignHost = foreignRelayHost(link, window.location.origin);
			if (foreignHost !== null && !window.confirm(`Join a session hosted at ${foreignHost}?`)) return;
			try {
				localStorage.setItem(NAME_KEY, name);
			} catch {
				// storage unavailable (private mode) — non-fatal
			}
			model.open(pool.registerLink(link));
			window.location.hash = link;
		},
		[model, pool],
	);

	useEffect(() => {
		const onJoin = (event: Event): void => {
			const detail = (event as CustomEvent<{ panel?: string; command?: string; args?: string }>).detail;
			if (detail?.panel !== "join" || detail.command !== "join") return;
			const link = detail.args?.trim() ?? "";
			if (!link) {
				setJoinLinkDraft("");
				setJoinError(null);
				setJoinOpen(true);
				return;
			}
			try {
				connectLink(link, storedName());
				setJoinError(null);
			} catch (error) {
				setJoinLinkDraft(link);
				setJoinError(error instanceof Error ? error.message : String(error));
				setJoinOpen(true);
			}
		};
		window.addEventListener(OPEN_PANEL_EVENT, onJoin);
		return () => window.removeEventListener(OPEN_PANEL_EVENT, onJoin);
	}, [connectLink]);

	// Deep links: a page load with a room link in the hash joins that room directly;
	// `#session=<id>` (push notification clicks) selects that session, on load and on later changes.
	useEffect(() => {
		const link = parseDeepLink(window.location.hash);
		if (link?.kind === "room") connectLink(link.link, storedName());
	}, [connectLink]);

	// `#new=<path>` (Mac `omp-console://new`): the sidebar's picker consumes it; on a phone the sidebar lives in a sheet.
	useEffect(() => {
		const onHash = (): void => {
			if (mode === "phone" && parseDeepLink(window.location.hash)?.kind === "new") setSheet("sessions");
		};
		onHash();
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, [mode]);

	useEffect(
		() =>
			watchSessionDeepLink(
				window,
				sessionId => {
					setSheet(null);
					model.open(sessionId);
				},
				() => history.replaceState(null, "", window.location.pathname + window.location.search),
			),
		[model],
	);

	// Service worker messages: `omp-console:open` carries a notification tap's address, `omp-console:push` a push that
	// arrived while the page was visible.
	useEffect(() => {
		const container = navigator.serviceWorker;
		if (!container) return;
		const onMessage = (event: MessageEvent): void => {
			handleServiceWorkerMessage(event.data, {
				origin: window.location.origin,
				openSessionId: () => model.focused.sessionId,
				setHash: hash => {
					window.location.hash = hash;
				},
				showAlert: alert => alertStore.push(alert),
			});
		};
		container.addEventListener("message", onMessage);
		return () => container.removeEventListener("message", onMessage);
	}, [model, alertStore]);

	// "Turn finished" / "needs your answer" toasts for sessions other than the focused one.
	useEffect(
		() =>
			notificationSignals().subscribe(signal => {
				const alert = alertFromSignal(signal, model.focused.sessionId);
				if (alert) alertStore.push(alert);
			}),
		[model, alertStore],
	);

	// Settings "leave": the focused pane lets go of its session (the sole pane returns to the home screen).
	const leave = useCallback((): void => {
		forgetLastSession(window.localStorage);
		model.close();
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, [model]);

	// Keep the app inside the visible area when the on-screen keyboard opens (see lib/viewport.ts).
	useEffect(() => trackViewport(window, document.documentElement), []);
	// A file dropped where no pane takes it (sidebar, header) must not make the page navigate to the file.
	useEffect(() => {
		const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") === true;
		const swallow = (event: DragEvent): void => {
			if (!event.defaultPrevented && carriesFiles(event)) {
				event.preventDefault();
				if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "none";
			}
		};
		window.addEventListener("dragover", swallow);
		window.addEventListener("drop", swallow);
		return () => {
			window.removeEventListener("dragover", swallow);
			window.removeEventListener("drop", swallow);
		};
	}, []);

	useEffect(() => {
		if (!client) document.title = "omp console";
	}, [client]);

	// Keep saved panes intact through daemon reconnects; only an unknown pane absent from the first live and recent
	// lists is discarded. Previously live panes transition from reconnecting to stopped after the recovery window.
	useEffect(() => {
		if (selectedId !== null) rememberLastSession(window.localStorage, selectedId);
	}, [selectedId]);
	const seenLiveRef = useRef(new Set<string>());
	const firstListRef = useRef(true);
	useEffect(() => {
		if (snap.sessions === null) return;
		const now = Date.now();
		const shown = model.sessionIds();
		const shownSet = new Set(shown);
		const firstList = firstListRef.current;
		const live = new Set(snap.sessions.live.map(session => session.id));
		const recent = new Set(snap.sessions.recent.map(session => session.id));
		for (const id of sessionSummaryRef.current.keys()) {
			if (!live.has(id) && !recent.has(id) && !shownSet.has(id)) sessionSummaryRef.current.delete(id);
		}
		for (const id of liveSeenAtRef.current.keys()) {
			if (!live.has(id) && !recent.has(id) && !shownSet.has(id)) liveSeenAtRef.current.delete(id);
		}
		for (const id of seenLiveRef.current) {
			if (!live.has(id) && !recent.has(id) && !shownSet.has(id)) seenLiveRef.current.delete(id);
		}
		for (const id of transcriptScrollRef.current.keys()) {
			if (!live.has(id) && !recent.has(id) && !shownSet.has(id)) transcriptScrollRef.current.delete(id);
		}
		for (const summary of [...snap.sessions.live, ...snap.sessions.recent]) {
			sessionSummaryRef.current.set(summary.id, summary);
		}
		for (const id of live) {
			seenLiveRef.current.add(id);
			liveSeenAtRef.current.set(id, now);
		}
		setMissingSince(previous => {
			const next = new Map(previous);
			for (const id of shown) {
				if (live.has(id)) {
					next.delete(id);
					continue;
				}
				if ((liveSeenAtRef.current.has(id) || (firstList && recent.has(id))) && !next.has(id)) {
					next.set(id, now);
				}
			}
			for (const id of next.keys()) {
				if (!shownSet.has(id)) next.delete(id);
			}
			return next.size === previous.size && [...next].every(([id, at]) => previous.get(id) === at) ? previous : next;
		});
		for (const id of live) {
			const guest = poolSnap.clients.get(id);
			const ended = guest?.getSnapshot().phase === "ended";
			if ((ended || poolSnap.errors.has(id)) && reconnectAttemptsRef.current.get(id) !== snap.sessions) {
				reconnectAttemptsRef.current.set(id, snap.sessions);
				pool.rejoin(id);
			} else if (guest && !ended && !poolSnap.errors.has(id)) {
				reconnectAttemptsRef.current.delete(id);
			}
		}
		for (const id of shown) {
			if (!live.has(id)) reconnectAttemptsRef.current.delete(id);
		}
		const stale = staleSessions(shown, live, seenLiveRef.current, firstList, recent);
		if (stale.size > 0) model.dropSessions(id => !stale.has(id));
		if (!firstList) return;
		firstListRef.current = false;
		const target = pickRestorableSession(
			readLastSession(window.localStorage),
			snap.sessions.live,
			window.location.hash,
			model.focused.sessionId,
		);
		if (target !== null) model.open(target);
	}, [snap.sessions, model, pool, poolSnap.clients, poolSnap.errors]);

	useEffect(() => {
		if (snap.listError?.kind !== "network") return;
		const now = Date.now();
		const shown = model.sessionIds();
		setMissingSince(previous => {
			const next = new Map(previous);
			for (const id of shown) {
				if (!id.startsWith("link:") && !next.has(id)) next.set(id, now);
			}
			return next.size === previous.size ? previous : next;
		});
	}, [snap.listError, model]);

	useEffect(() => {
		const deadline = Math.min(
			...([...missingSince.values()].map(at => at + 60_001).filter(at => at > recoveryClock)),
		);
		if (!Number.isFinite(deadline)) return;
		const timer = setTimeout(() => setRecoveryClock(Date.now()), Math.max(0, deadline - Date.now()));
		return () => clearTimeout(timer);
	}, [missingSince, recoveryClock]);

	useEffect(() => {
		if (snap.sessions !== null) notificationSignals().observeSummaries(snap.sessions.live);
	}, [snap.sessions]);

	/** Sidebar, needs-you bar and alerts open a session in the focused pane; Cmd-click splits a new pane for it. */
	const select = useCallback(
		(id: string, newPane?: boolean): void => {
			setSheet(null);
			model.open(id, newPane ? "right" : "focused");
		},
		[model],
	);
	const openFocusedMachineSession = useCallback(
		(id: string): void => select(sessionKey(selectedMachine ?? machineDirectory.local, id)),
		[select, selectedMachine, machineDirectory],
	);
	/** Opens a spawned session; rejects (with the switcher's error) when it failed, so the row shows failure, not a tick. */
	const openSpawned = useCallback(
		async (spawned: Promise<SessionSummary | null>, newPane = false): Promise<void> => {
			const summary = await spawned;
			if (summary === null) throw new Error(switcher.getSnapshot().actionError ?? "The session could not be opened.");
			model.open(summary.id, newPane ? "right" : "focused");
		},
		[model, switcher],
	);
	const resume = useCallback(
		(session: SessionSummary, newPane = false): Promise<void> => {
			setSheet(null);
			return openSpawned(switcher.spawnResume(session, machineIdForSessionKey(session.id) ?? undefined), newPane);
		},
		[switcher, openSpawned],
	);
	// A session saved with a model that no longer exists: the user chose to continue it on the machine's default role.
	const retryResumeOnDefault = useCallback((): void => {
		const retry = snap.resumeModelRetry;
		if (retry === null) return;
		const machine = visibleMachines.find(candidate => candidate.id === retry.machineId) ?? visibleMachines.find(candidate => candidate.local);
		const modelsApi = machine?.api ?? api;
		void modelsApi
			.listModels()
			.then(list => {
				const target = list.roles.default;
				if (target) void openSpawned(switcher.retryResumeWithModel(target)).catch(() => {});
			})
			.catch(() => {});
	}, [snap.resumeModelRetry, visibleMachines, api, switcher, openSpawned]);
	const fork = useCallback(
		(session: SessionSummary): Promise<void> => openSpawned(switcher.spawnFork(session, machineIdForSessionKey(session.id) ?? undefined)),
		[switcher, openSpawned],
	);
	const stop = useCallback(async (id: string): Promise<void> => {
		if (!(await switcher.stop(id))) throw new Error(switcher.getSnapshot().actionError ?? "The session could not be ended.");
	}, [switcher]);
	const stopRunningTurn = useCallback(
		(id: string): void => {
			setSheet(null);
			const machine = machineDirectory.machineForKey(id) ?? machineDirectory.local;
			void stopTurn(machine.api, sessionIdForSessionKey(id))
				.then(result => {
					if (result === "not-authorized") {
						void switcher.refresh();
						return;
					}
					if (result === "aborted" || result === "unavailable") return;
					alertStore.push({
						tag: `${id}:stop-turn`,
						sessionId: id,
						title: "Stop turn",
						body: STOP_TURN_NOTE[result],
						level: "info",
						ttlMs: 5_000,
					});
				})
				.catch((err: unknown) => {
					alertStore.push({
						tag: `${id}:stop-turn`,
						sessionId: id,
						title: "Stop turn",
						body: err instanceof Error ? err.message : "The turn could not be stopped.",
						level: "warning",
						ttlMs: 5_000,
					});
				});
		},
		[machineDirectory, switcher, alertStore],
	);
	const create = useCallback(
		(request: Parameters<GuestSwitcher["create"]>[0], machineId?: string): void => {
			// The phone sheet stays open while the worker starts, so the picker row shows its pending state; it closes
			// when the session opens and stays open (with the action error) when creation fails.
			void switcher.spawn(request, machineId).then(summary => {
				if (summary === null) return;
				model.open(summary.id);
				setSheet(null);
			});
		},
		[switcher, model],
	);
	const startAgendaTask = useCallback((item: AgendaItem): void => {
		setAgendaTask(item);
		void import("./components/agenda/AgendaStrip").then(({ agendaTaskPrompt }) => setAgendaPrompt(agendaTaskPrompt(item)));
		setAgendaSession(null);
		setAgendaStartError(null);
	}, []);
	const closeAgendaStart = useCallback((): void => {
		if (agendaStartBusy) return;
		setAgendaTask(null);
		setAgendaSession(null);
		setAgendaStartError(null);
	}, [agendaStartBusy]);
	const createAgendaSession = useCallback(
		async (request: CreateSessionRequest, machineId?: string): Promise<void> => {
			if (agendaTask === null || agendaStartBusy) return;
			setAgendaStartBusy(true);
			setAgendaStartError(null);
			try {
				const summary = await switcher.spawn(
					{ ...request, handoff: agendaPrompt },
					machineId ?? machineDirectory.local.id,
				);
				if (summary === null) {
					setAgendaStartError("The session could not be created.");
					return;
				}
				setAgendaSession(summary);
				await api.linkAgendaTodo(agendaTask.uid, { sessionId: summary.id });
				setAgendaTask(null);
				setAgendaSession(null);
				select(summary.id);
			} catch (error) {
				setAgendaStartError(
					error instanceof Error
						? `Session started, but its task link failed: ${error.message}`
						: "Session started, but its task link failed.",
				);
			} finally {
				setAgendaStartBusy(false);
			}
		},
		[agendaTask, agendaStartBusy, agendaPrompt, switcher, machineDirectory, api, select],
	);
	const retryAgendaLink = useCallback(async (): Promise<void> => {
		if (agendaTask === null || agendaSession === null || agendaStartBusy) return;
		setAgendaStartBusy(true);
		setAgendaStartError(null);
		try {
			await api.linkAgendaTodo(agendaTask.uid, { sessionId: agendaSession.id });
			const sessionId = agendaSession.id;
			setAgendaTask(null);
			setAgendaSession(null);
			select(sessionId);
		} catch (error) {
			setAgendaStartError(error instanceof Error ? error.message : "The agenda task could not be linked.");
		} finally {
			setAgendaStartBusy(false);
		}
	}, [agendaTask, agendaSession, agendaStartBusy, api, select]);
	const toggleSidebar = useCallback(() => setSidebarOpen(open => !open), []);
	// ⌘\ or ⌘B (Ctrl+\ off the Mac) folds the session list to its rail and back.
	useEffect(() => {
		if (mode === "phone") return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.altKey || event.shiftKey) return;
			const mac = event.metaKey && !event.ctrlKey && (event.key === "\\" || event.key.toLowerCase() === "b");
			const other = event.ctrlKey && !event.metaKey && event.key === "\\";
			if (!mac && !other) return;
			event.preventDefault();
			toggleSidebar();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [mode, toggleSidebar]);
	const openSessions = useCallback(() => setSheet("sessions"), []);
	const openHomeSessionList = useCallback(() => {
		if (mode === "phone") setSheet("sessions");
		else {
			setSheet(null);
			setSidebarOpen(true);
		}
	}, [mode]);
	// Desktop has no sessions sheet (the sidebar is the list): the home screen's start button opens the picker.
	const [composeRequest, setComposeRequest] = useState(0);
	const startFromHome = useCallback(() => {
		if (mode === "phone") {
			setSheet("sessions");
			return;
		}
		setSidebarOpen(true);
		setComposeRequest(n => n + 1);
	}, [mode]);
	const openStatus = useCallback(() => setSheet("status"), []);
	const openGlobalSettings = useCallback(() => {
		setSettingsScope("global");
		setSettingsInitialSection("session");
		setSheet("settings");
	}, []);
	const openSessionSettings = useCallback(() => {
		setSettingsScope(selectedSessionId === null ? "global" : "session");
		setSettingsInitialSection("session");
		setSheet("settings");
	}, [selectedSessionId]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			handleGlobalSettingsShortcut(event, openGlobalSettings);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [openGlobalSettings]);
	useEffect(
		() => registerNativeMenuActions(
			{
				openSettings: openGlobalSettings,
				toggleSidebar: () => {
					if (mode !== "phone") toggleSidebar();
				},
			},
			window,
		),
		[mode, openGlobalSettings, toggleSidebar],
	);
	const retry = useCallback(() => void switcher.refresh(), [switcher]);
	const markMachineReachable = useCallback((id: string): void => machineDirectory.reportReachability(id, true), [machineDirectory]);
	const markMachineUnreachable = useCallback((id: string): void => machineDirectory.reportReachability(id, false), [machineDirectory]);

	const live = snap.sessions?.live ?? NO_SESSIONS;
	const recent = snap.sessions?.recent ?? NO_SESSIONS;
	const overnightSessions = useMemo(() => {
		const sessions = new Map<string, SessionSummary>();
		for (const session of [...live, ...recent]) {
			if (session.overnight && ["complete", "deadline", "blocked", "stopped"].includes(session.overnight.phase)) {
				sessions.set(session.id, session);
			}
		}
		return [...sessions.values()];
	}, [live, recent]);
	const loadOvernightState = useCallback((sessionKey: string): Promise<OvernightState> => {
		const machine = machineForSessionKey(sessionKey, machineSnapshot.machines) ?? machineDirectory.local;
		return machine.api.getOvernightState(sessionIdForSessionKey(sessionKey));
	}, [machineDirectory, machineSnapshot.machines]);
	const openOvernightFromHome = useCallback((sessionId: string, cwd: string): void => {
		openPanel({ panel: "overnight", sessionId, cwd });
	}, []);
	const focusedLive = selectedId !== null && live.some(session => session.id === selectedId);
	const focusedSummary =
		selectedId === null
			? undefined
			: live.find(session => session.id === selectedId) ??
				recent.find(session => session.id === selectedId) ??
				sessionSummaryRef.current.get(selectedId);
	const overnightSessionKey = overnightTarget?.sessionId ?? selectedId;
	const overnightMachine = overnightSessionKey === null
		? selectedMachine
		: machineForSessionKey(overnightSessionKey, machineSnapshot.machines) ?? machineDirectory.local;
	const overnightApi = overnightMachine?.api ?? api;
	const overnightSessionId = overnightSessionKey === null ? null : sessionIdForSessionKey(overnightSessionKey);
	const overnightSummary = overnightSessionKey === null
		? undefined
		: live.find(session => session.id === overnightSessionKey) ??
			recent.find(session => session.id === overnightSessionKey) ??
			sessionSummaryRef.current.get(overnightSessionKey);
	const overnightCwd = overnightTarget?.cwd ?? overnightSummary?.cwd ?? null;
	const focusedMachineUnreachable =
		selectedMachine !== undefined && !selectedMachine.local && !selectedMachine.reachable ? selectedMachine.name : null;
	const focusedRecovery =
		selectedId === null || focusedMachineUnreachable !== null
			? null
			: focusedLive
				? selectedMachine?.local && snap.listError?.kind === "network"
					? "reconnecting"
					: null
				: paneRecoveryStatus(missingSince.get(selectedId) ?? liveSeenAtRef.current.get(selectedId), recoveryClock);
	const sidebarProps = {
		api,
		touch: touchLayout,
		composeRequest,
		machines: visibleMachines,
		librarianEnabled: capabilities.features.librarian,
		overnightEnabled: capabilities.features.overnight,
		quickAskEnabled: capabilities.features.quickAsk,
		onMachineReachable: markMachineReachable,
		onMachineUnreachable: markMachineUnreachable,
		sessions: snap.sessions,
		health: snap.health,
		listError: snap.listError,
		authFailed: snap.authFailed,
		selectedId,
		busy: snap.busy,
		actionError: snap.actionError,
		resumeModelRetry: snap.resumeModelRetry,
		sleepCandidateRetry: snap.sleepCandidateRetry,
		onRetryResumeOnDefault: retryResumeOnDefault,
		onSelect: select,
		onResume: resume,
		onFork: fork,
		onStop: stop,
		onStopTurn: stopRunningTurn,
		onCreate: create,
		showLiveSharedSessions: collabListOnly,
		onClearLiveSharedSessions: () => setCollabListOnly(false),
	};

	const titleOf = useCallback(
		(key: string): string => {
			const found = live.find(s => s.id === key) ?? recent.find(s => s.id === key) ?? sessionSummaryRef.current.get(key);
			if (found) return found.title?.trim() || folderName(found.cwd);
			return key.startsWith("link:") ? "Joined room" : "Session";
		},
		[live, recent],
	);
	const isLive = useCallback((key: string): boolean => live.some(s => s.id === key), [live]);
	// Brief and agenda lines open a live session, or resume it when it is only in the recent list.
	const canOpenFromHome = useCallback(
		(id: string, line?: BriefLine): boolean =>
			live.some(s => s.id === id) || (snap.sessions?.recent ?? []).some(s => s.id === id) || line?.sessionFile !== undefined,
		[live, snap.sessions],
	);
	const openFromHome = useCallback(
		(id: string, line?: BriefLine): void => {
			if (live.some(s => s.id === id)) return select(id);
			const saved = snap.sessions?.recent.find(s => s.id === id);
			// A failed resume is shown as the switcher's action error; nothing here waits on it.
			if (saved) return void resume(saved).catch(() => {});
			if (line?.sessionFile === undefined) return;
			const now = Date.now();
			void resume({ id, title: line.title, cwd: line.cwd, sessionFile: line.sessionFile, state: "stopped", createdAt: now, lastActivityAt: now, agentCount: 0, goalActive: false, awaitingAnswer: false }).catch(() => {});
		},
		[live, snap.sessions, select, resume],
	);
	const renderEmpty = useCallback(
		(): ReactNode => (
			<div className="dk-empty-main">
				<LazyRegion fallback={<LoadingPanel label="sessions" />}>
					<AgendaStartSessionProvider onStartSession={startAgendaTask}>
						<HomeScreen
							state={
								snap.authFailed
									? "not-authorized"
									: snap.listError !== null
										? "unreachable"
										: snap.sessions !== null
											? "idle"
											: "connecting"
							}
							mode={mode}
							liveCount={live.length}
							linkError={null}
							onRetry={retry}
							onOpenSessions={startFromHome}
							onOpenSessionList={openHomeSessionList}
							onOpenStatus={openStatus}
							onOpenSettings={openGlobalSettings}
							api={api}
							setupApi={api}
							existingSessionCount={snap.sessions?.recent.length ?? 0}
							overnightSessions={capabilities.features.overnight ? overnightSessions : NO_SESSIONS}
							loadOvernightState={loadOvernightState}
							onOpenOvernight={openOvernightFromHome}
							librarianEnabled={capabilities.features.librarian}
							agendaEnabled={capabilities.features.agenda}
							overnightEnabled={capabilities.features.overnight}
							canOpenSession={canOpenFromHome}
							onOpenSession={openFromHome}
						/>
					</AgendaStartSessionProvider>
				</LazyRegion>
			</div>
		),
		[
			snap.authFailed,
			snap.listError,
			snap.sessions,
			mode,
			live.length,
			retry,
			startFromHome,
			openHomeSessionList,
			openStatus,
			openGlobalSettings,
			api,
			canOpenFromHome,
			openFromHome,
			overnightSessions,
			loadOvernightState,
			openOvernightFromHome,
			startAgendaTask,
			capabilities.features.librarian,
			capabilities.features.agenda,
			capabilities.features.overnight,
		],
	);
	const renderSession = useCallback(
		(args: PaneSessionArgs): ReactNode => {
			const isLink = args.sessionKey.startsWith("link:");
			const machine = machineDirectory.machineForKey(args.sessionKey) ?? machineDirectory.local;
			const keyedSummary = isLink
				? undefined
				: live.find(session => session.id === args.sessionKey) ??
					recent.find(session => session.id === args.sessionKey) ??
					sessionSummaryRef.current.get(args.sessionKey);
			const summary = keyedSummary === undefined ? undefined : { ...keyedSummary, id: sessionIdForSessionKey(keyedSummary.id) };
			const stopOnMachine = async (id: string): Promise<void> => {
				try {
					await machine.api.stopSession(id);
					if (!machine.local) markMachineReachable(machine.id);
					void switcher.refresh();
				} catch (error) {
					if (!machine.local) {
						if (isMachineNetworkError(error)) markMachineUnreachable(machine.id);
						else markMachineReachable(machine.id);
					}
					throw error;
				}
			};
			return (
				<Session
					api={machine.api}
					agendaEnabled={capabilities.features.agenda}
					overnightEnabled={capabilities.features.overnight}
					librarianEnabled={capabilities.features.librarian}
					key={clientKey(args.client)}
					mode={mode}
					touchLayout={touchLayout}
					client={args.client}
					getRoomLink={permission => machineApi.roomLink(args.sessionKey, permission)}
					summary={summary}
					initialScrollPosition={transcriptScrollRef.current.get(args.sessionKey)}
					onScrollPositionChange={position => transcriptScrollRef.current.set(args.sessionKey, position)}
					machineName={machine.local ? undefined : machine.name}
					health={healthView(snap.health, snap.listError, isLink ? null : args.sessionKey)}
					focused={args.focused}
					multi={args.multi}
					throttleMs={args.throttleMs}
					onLeave={args.onClose}
					onRejoin={args.onRejoin}
					onToggleSidebar={toggleSidebar}
					onOpenSessions={openSessions}
					onOpenStatus={openStatus}
					// The phone has no pane toolbar: its header gear opens the app-wide panel, which leads on to the session's.
					onOpenSettings={mode === "phone" ? openGlobalSettings : openSessionSettings}
					onStopSession={stopOnMachine}
					onRefreshSessions={() => void switcher.refresh()}
					onOpenSession={id => select(sessionKey(machine, id))}
				/>
			);
		},
		[
			machineDirectory,
			live,
			recent,
			mode,
			touchLayout,
			snap.health,
			snap.listError,
			toggleSidebar,
			openSessions,
			openStatus,
			openSessionSettings,
			markMachineReachable,
			markMachineUnreachable,
			switcher,
			select,
			machineApi,
			capabilities.features.agenda,
			capabilities.features.librarian,
		],
	);

	return (
		<div className="dk-layout" data-mode={mode} data-standalone={standalone ? "true" : "false"}>
			{mode !== "phone" && sidebarOpen && (
				<LazyRegion fallback={<SessionSidebarLoading />}>
					<SessionSidebar {...sidebarProps} onHide={toggleSidebar} />
				</LazyRegion>
			)}
			{mode !== "phone" && !sidebarOpen && (
				<div className="dk-side-rail">
					<button type="button" className="sh-btn sh-btn-icon" title="show sessions (⌘\)" aria-label="show sessions" aria-expanded={false} onClick={toggleSidebar}>
						<PanelLeftOpen size={15} />
					</button>
				</div>
			)}
			<div className="dk-content">
				{(offline || restartNotice !== null || focusedMachineUnreachable !== null || focusedRecovery !== null) && (
					<div className="dk-global-notices">
						{offline && <OfflineBanner />}
						{restartNotice !== null && <RestartNoticeBanner notice={restartNotice} onDismiss={dismissRestartNotice} />}
						{!offline && (focusedMachineUnreachable !== null || focusedRecovery !== null) && (
							<PaneRecoveryBanner
								status={focusedRecovery}
								machineName={focusedMachineUnreachable ?? undefined}
								onResume={focusedSummary?.sessionFile === undefined ? undefined : () => void resume(focusedSummary).catch(() => {})}
							/>
						)}
					</div>
				)}
				<NeedsYouHost
					client={client}
					selectedId={selectedId}
					sessions={live}
					onOpen={select}
					touch={touchLayout}
					uiTargetForSession={uiTargetForSession}
				/>
				<PaneHost
					onOpenSettings={openGlobalSettings}
					model={model}
					pool={pool}
					mode={mode}
					storage={layoutStorage()}
					renderSession={renderSession}
					renderEmpty={renderEmpty}
					titleOf={titleOf}
					isLive={isLive}
				/>
			</div>
			{sheet === "sessions" && mode === "phone" && (
				<Sheet title="Sessions" size="full" onClose={closeSheet}>
					<LazyRegion fallback={<LoadingPanel label="sessions" />}>
						<SessionSidebar {...sidebarProps} variant="sheet" />
					</LazyRegion>
				</Sheet>
			)}
			{claudeImportOpen && (
				<LazyRegion
					fallback={<Sheet title="Import from Claude Code or Codex" windowKind="claude-import" onClose={() => setClaudeImportOpen(false)}><LoadingPanel label="Claude Code and Codex migration" /></Sheet>}
					errorFallback={content => <Sheet title="Import from Claude Code or Codex" windowKind="claude-import" onClose={() => setClaudeImportOpen(false)}>{content}</Sheet>}
				>
					<ClaudeImportPanel
						api={api}
						onClose={() => setClaudeImportOpen(false)}
						onOpenSession={id => {
							setClaudeImportOpen(false);
							select(id);
						}}
					/>
				</LazyRegion>
			)}
			{sheet === "overnight" && (
				<OvernightSheet
					key={`${overnightSessionKey ?? "none"}:${overnightTarget?.task ?? ""}`}
					api={overnightApi}
					sessionId={overnightSessionId}
					summary={overnightSummary}
					initialCwd={overnightCwd}
					initialTask={overnightTarget?.task ?? ""}
					onClose={closeSheet}
					onRefresh={retry}
				/>
			)}
			{sheet === "status" && (
				<LazyRegion
					fallback={<Sheet title="Status" windowKind="status" onClose={closeSheet}><LoadingPanel label="status" /></Sheet>}
					errorFallback={content => <Sheet title="Status" windowKind="status" onClose={closeSheet}>{content}</Sheet>}
				>
					<StatusSheet
						api={selectedApi}
						onClose={closeSheet}
						client={client}
						selectedId={selectedSessionId}
						sessions={machineSessions.live}
						health={machineHealth}
						listError={snap.listError}
						onFork={request => create(request, selectedMachine?.id)}
					/>
				</LazyRegion>
			)}
			{sheet === "setup" && (
				<LazyRegion
					fallback={<Sheet title="First-run setup" onClose={closeSheet}><LoadingPanel label="setup" /></Sheet>}
					errorFallback={content => <Sheet title="First-run setup" onClose={closeSheet}>{content}</Sheet>}
				>
					<SetupSheet api={selectedApi} onClose={closeSheet} onStartSession={startFromHome} onOpenExistingSessions={openHomeSessionList} />
				</LazyRegion>
			)}
			{sheet === "settings" && (
				<LazyRegion
					fallback={<Sheet title={settingsScope === "global" ? "Settings" : "Session settings"} onClose={closeSheet}><LoadingPanel label="settings" /></Sheet>}
					errorFallback={content => <Sheet title={settingsScope === "global" ? "Settings" : "Session settings"} onClose={closeSheet}>{content}</Sheet>}
				>
					<SettingsSheet
						key={`${settingsScope}:${settingsInitialSection}`}
						scope={settingsScope}
						initialSection={settingsInitialSection}
						onClose={closeSheet}
						canLeave={settingsScope === "session" && client !== null}
						onLeave={leave}
						api={selectedApi}
						sessionId={settingsScope === "session" ? selectedSessionId ?? undefined : undefined}
						onOpenSession={openFocusedMachineSession}
						onOpenGlobalSettings={settingsScope === "session" ? openGlobalSettings : undefined}
						onCapabilitiesChanged={onCapabilitiesChanged}
						capabilities={capabilities}
						onOpenSessionSettings={settingsScope === "global" && mode === "phone" && selectedSessionId !== null ? openSessionSettings : undefined}
					/>
				</LazyRegion>
			)}
			{joinOpen && (
				<Sheet title="Join session" onClose={() => setJoinOpen(false)}>
					<form
						className="dk-agenda-start"
						onSubmit={event => {
							event.preventDefault();
							const link = joinLinkDraft.trim();
							if (!link) return;
							try {
								connectLink(link, storedName());
								setJoinOpen(false);
								setJoinError(null);
							} catch (error) {
								setJoinError(error instanceof Error ? error.message : String(error));
							}
						}}
					>
						<label className="dk-agenda-start-prompt">
							<span>Collaboration link</span>
							<input autoFocus value={joinLinkDraft} onChange={event => setJoinLinkDraft(event.currentTarget.value)} />
						</label>
						{joinError !== null && <p className="dk-agenda-start-error" role="alert">{joinError}</p>}
						<button type="submit" className="dk-wide-btn" disabled={!joinLinkDraft.trim()}>Join</button>
					</form>
				</Sheet>
			)}
			{agendaTask !== null && (
				<Sheet title="Start session from agenda" size="tall" onClose={closeAgendaStart}>
					<div className="dk-agenda-start">
						<label className="dk-agenda-start-prompt">
							<span>First prompt (edit before starting)</span>
							<textarea
								value={agendaPrompt}
								onChange={event => setAgendaPrompt(event.currentTarget.value)}
								disabled={agendaStartBusy || agendaSession !== null}
							/>
						</label>
						{agendaStartError !== null && <p className="dk-agenda-start-error" role="alert">{agendaStartError}</p>}
						{agendaSession === null ? (
								<LazyRegion fallback={<LoadingPanel label="session picker" />}>
									<NewSessionPicker
										api={api}
										librarianEnabled={capabilities.features.librarian}
										overnightEnabled={capabilities.features.overnight}
										machines={[machineDirectory.local]}
										initialPath={null}
										busy={agendaStartBusy || snap.busy}
										onCreate={(request, machineId) => void createAgendaSession(request, machineId)}
										onClose={closeAgendaStart}
									/>
								</LazyRegion>
						) : (
							<div className="dk-agenda-start-retry">
								<p>The session is running. Save its link to the agenda task, or open it without linking.</p>
								<button type="button" className="dk-wide-btn" onClick={() => void retryAgendaLink()} disabled={agendaStartBusy}>
									{agendaStartBusy ? "Linking…" : "Retry task link"}
								</button>
								<button
									type="button"
									className="dk-wide-btn"
									onClick={() => {
										const sessionId = agendaSession.id;
										setAgendaTask(null);
										setAgendaSession(null);
										select(sessionId);
									}}
									disabled={agendaStartBusy}
								>
									Open session
								</button>
							</div>
						)}
					</div>
				</Sheet>
			)}
			<WorkspacesHost
				api={selectedApi}
				currentSessionId={selectedSessionId ?? undefined}
				currentCwd={machineSessions.live.find(s => s.id === selectedSessionId)?.cwd}
				onOpenSession={openFocusedMachineSession}
			/>
			{capabilities.features.quickAsk && (
				<QuickAskHost api={api} displayName={storedName()} onOpenSession={select} allowedSources={capabilities.quickAskSources} />
			)}
			<Alerts store={alertStore} onOpen={select} />
			{snap.busy && (
				<div className="sh-banner" role="status">
					<span className="sh-banner-dot" />
					Opening session…
				</div>
			)}
		</div>
	);
}

interface SessionProps {
	mode: LayoutMode;
	touchLayout: boolean;
	client: GuestClient;
	api: DeckApi;
	getRoomLink(permission: RoomPermission): Promise<RoomLinkResponse>;
	/** Daemon summary of this session; undefined for a manually joined link. */
	summary: SessionSummary | undefined;
	initialScrollPosition?: TranscriptScrollPosition;
	onScrollPositionChange(position: TranscriptScrollPosition): void;
	machineName?: string;
	agendaEnabled: boolean;
	librarianEnabled: boolean;
	overnightEnabled: boolean;
	health: HealthView;
	onLeave(): void;
	onRejoin(): void;
	onStopSession(sessionId: string): Promise<void>;
	onRefreshSessions(): void;
	onToggleSidebar(): void;
	onOpenSessions(): void;
	onOpenStatus(): void;
	onOpenSettings(): void;
	onOpenSession(sessionId: string): void;
	/** This pane has keyboard focus: only it sets the window title. */
	focused: boolean;
	/** More than one pane is on screen: the agents rail stays closed until asked for (it would eat the pane). */
	multi: boolean;
	/** Snapshot render interval: 0 for the focused pane, a throttle for background panes. */
	throttleMs: number;
}

const RAIL_CLOSE_TRANSITION_MS = 200;

function Session({
	mode,
	touchLayout,
	client,
	api,
	getRoomLink,
	summary,
	initialScrollPosition,
	onScrollPositionChange,
	machineName,
	health,
	agendaEnabled,
	librarianEnabled,
	overnightEnabled,
	onLeave,
	onRejoin,
	onStopSession,
	onRefreshSessions,
	onToggleSidebar,
	onOpenSessions,
	onOpenStatus,
	onOpenSettings,
	onOpenSession,
	focused,
	multi,
	throttleMs,
}: SessionProps): ReactNode {
	const snap = useThrottledGuestSnapshot(client, throttleMs);

	const [pauseBusy, setPauseBusy] = useState(false);
	const [pauseError, setPauseError] = useState<string | null>(null);
	const [pauseNow, setPauseNow] = useState(() => Date.now());
	const [pauseOverride, setPauseOverride] = useState<{ sessionId: string; paused: boolean; pausedAt?: number } | null>(null);
	const sessionPauseOverride =
		summary !== undefined && pauseOverride?.sessionId === summary.id ? pauseOverride : undefined;
	const paused = sessionPauseOverride?.paused ?? summary?.paused === true;
	const pausedAt = sessionPauseOverride?.pausedAt ?? summary?.pausedAt;
	const visibleSummary =
		summary === undefined
			? undefined
			: sessionPauseOverride === undefined
				? summary
				: { ...summary, paused, ...(pausedAt === undefined ? {} : { pausedAt }) };
	useEffect(() => {
		if (pauseOverride === null) return;
		if (summary?.id !== pauseOverride.sessionId) {
			setPauseOverride(null);
			return;
		}
		const summaryPaused = summary.paused === true;
		if (summaryPaused === pauseOverride.paused && (!summaryPaused || summary.pausedAt === pauseOverride.pausedAt)) {
			setPauseOverride(null);
		}
	}, [pauseOverride, summary?.id, summary?.paused, summary?.pausedAt]);
	useEffect(() => {
		if (!paused) return;
		const timer = window.setInterval(() => setPauseNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [paused]);
	const changePause = useCallback(async (action: "pause" | "resume"): Promise<void> => {
		if (summary === undefined || pauseBusy) return;
		setPauseBusy(true);
		try {
			const result = await api.sessionOpV3(summary.id, { op: "pause", action });
			if (!("paused" in result)) throw new Error("The session did not confirm its pause state.");
			setPauseOverride({
				sessionId: summary.id,
				paused: result.paused,
				...(result.pausedAt === undefined ? {} : { pausedAt: result.pausedAt }),
			});
			onRefreshSessions();
			setPauseError(null);
		} catch (error) {
			setPauseError(error instanceof Error ? error.message : "Could not change the session pause state.");
		} finally {
			setPauseBusy(false);
		}
	}, [api, onRefreshSessions, pauseBusy, summary?.id]);
	const togglePause = useCallback((): void => {
		if (summary === undefined) return;
		void changePause(paused ? "resume" : "pause");
	}, [changePause, paused, summary?.id]);
	const pauseLabel =
		pausedAt === undefined
			? "Paused"
			: `Paused ${fmtDuration(Math.max(0, pauseNow - pausedAt))}`;
	const [commandFeedback, setCommandFeedback] = useState<{ tone: "status" | "error"; message: string } | null>(null);
	const [queueOpen, setQueueOpen] = useState(false);
	const [queueBusy, setQueueBusy] = useState(false);
	const [queueDraft, setQueueDraft] = useState("");
	const [copyPickerOpen, setCopyPickerOpen] = useState(false);
	const [collabPanel, setCollabPanel] = useState<"status" | "stop" | null>(null);
	const [collabStatus, setCollabStatus] = useState<CollabSessionStatus | null>(null);
	const [railOpen, setRailOpen] = useState(false);
	const [railMounted, setRailMounted] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [agentsSheetOpen, setAgentsSheetOpen] = useState(false);
	const [phoneActionsOpen, setPhoneActionsOpen] = useState(false);
	const autoOpenedRef = useRef(false);
	// What this client last set; the host's report (`state.planMode`, any client's change) wins when present.
	const [localPlanMode, setPlanModeEnabled] = useState<boolean | null>(null);
	const planModeEnabled = snap.state?.planMode ?? localPlanMode;

	const quickReplyEntryId =
		touchLayout && focused && summary !== undefined && snap.phase === "live" && !snap.working && !snap.readOnly && snap.uiRequest === null
			? latestAgentAnswerEntryId(snap.entries)
			: null;
	const [phoneQuickReplyResult, setPhoneQuickReplyResult] = useState<{
		sessionId: string;
		entryId: string;
		status: Exclude<QuickReplyStatus, "idle">;
		replies: string[];
	} | null>(null);
	useEffect(() => {
		if (!touchLayout || summary === undefined || quickReplyEntryId === null) {
			setPhoneQuickReplyResult(null);
			return;
		}
		let current = true;
		const sessionId = summary.id;
		const entryId = quickReplyEntryId;
		setPhoneQuickReplyResult({ sessionId, entryId, status: "loading", replies: [] });
		void api.sessionOpV3(sessionId, { op: "quick-replies", entryId }).then(
			result => {
				if (!current) return;
				if (!("replies" in result)) {
					setPhoneQuickReplyResult({ sessionId, entryId, status: "error", replies: [] });
					return;
				}
				setPhoneQuickReplyResult({
					sessionId,
					entryId,
					status: "ready",
					replies: limitPhoneSuggestions(result.replies),
				});
			},
			() => {
				if (current) setPhoneQuickReplyResult({ sessionId, entryId, status: "error", replies: [] });
			},
		);
		return () => {
			current = false;
		};
	}, [api, quickReplyEntryId, summary?.id, touchLayout]);
	const currentQuickReplyResult =
		summary !== undefined &&
		quickReplyEntryId !== null &&
		phoneQuickReplyResult !== null &&
		phoneQuickReplyResult.sessionId === summary.id &&
		phoneQuickReplyResult.entryId === quickReplyEntryId
			? phoneQuickReplyResult
			: null;
	const phoneSuggestionStatus: QuickReplyStatus =
		quickReplyEntryId === null ? "idle" : currentQuickReplyResult?.status ?? "loading";
	const phoneSuggestions = currentQuickReplyResult?.replies ?? EMPTY_PHONE_SUGGESTIONS;
	const latestLink = useMemo(() => latestTranscriptLink(snap.entries, snap.stream), [snap.entries, snap.stream]);
	const sendQuickReply = useCallback((reply: string): void => {
		if (summary === undefined || !focused || snap.phase !== "live" || snap.working || snap.readOnly || snap.uiRequest !== null) return;
		setPhoneActionsOpen(false);
		client.sendPrompt(reply);
		promptHistory.push(summary.id, reply);
	}, [client, focused, summary, snap.phase, snap.working, snap.readOnly, snap.uiRequest]);
	const editQuickReply = useCallback((reply: string): void => {
		insertIntoComposer({ text: reply, replace: true });
	}, []);
	const quickReplies =
		quickReplyEntryId === null || summary === undefined
			? null
			: (
				<QuickReplies
					generated={phoneSuggestions}
					tileLayout={mode === "phone"}
					onSend={sendQuickReply}
					onEdit={editQuickReply}
				/>
			);
	useEffect(() => setPhoneActionsOpen(false), [summary?.id, mode]);

	/** The rail is open because a subagent appeared, not because the user asked: splitting the layout closes it again. */
	const railAutoRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);
	const contextUsage = snap.state?.contextUsage;
	const contextPercent = contextUsage?.percent ?? (contextUsage?.tokens != null && contextUsage.contextWindow !== null && contextUsage.contextWindow > 0
		? (contextUsage.tokens / contextUsage.contextWindow) * 100
		: null);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears; below the desktop width it is an overlay
	// that would cover the transcript.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			if (mode === "desktop" && !multi) {
				railAutoRef.current = true;
				setRailOpen(true);
			}
		}
	}, [subCount, mode, multi]);
	useEffect(() => {
		if (multi && railAutoRef.current) {
			railAutoRef.current = false;
			setRailOpen(false);
		}
	}, [multi]);
	useEffect(() => {
		if (railOpen) {
			setRailMounted(true);
			return;
		}
		if (!railMounted) return;
		const timer = window.setTimeout(() => setRailMounted(false), RAIL_CLOSE_TRANSITION_MS);
		return () => window.clearTimeout(timer);
	}, [railOpen, railMounted]);

	const cardTitle = useCardTitle(summary?.id ?? snap.header?.id);
	const promptTitle = useMemo(() => firstPromptTitle(snap.entries), [snap.entries]);
	const userTitle = useUserTitle(summary?.id ?? snap.header?.id);
	const title = sessionDisplayTitle({ userTitle, headerTitle: snap.header?.title, sessionName: snap.state?.sessionName, cardTitle, promptTitle });
	useEffect(() => {
		if (focused) document.title = `${title} · omp console`;
	}, [title, focused]);

	// Notification signals for the connected session; the daemon poll covers the others.
	const signalId = summary?.id ?? snap.header?.id;
	const ask = snap.uiRequest;
	const askView = useMemo(() => (ask === null ? null : { reqId: ask.reqId, title: ask.title }), [ask]);
	useEffect(() => {
		if (signalId === undefined) return;
		notificationSignals().observeGuest(signalId, title, { phase: snap.phase, working: snap.working, ask: askView });
	}, [signalId, title, snap.phase, snap.working, askView]);
	useEffect(() => {
		if (signalId === undefined) return;
		return () => notificationSignals().releaseGuest(signalId);
	}, [signalId]);

	// The daemon's summary is authoritative (it also sees goals set outside the `goal` tool); the
	// replicated entries fill in the objective and cover links joined without a daemon.
	const derivedGoal = useMemo(() => deriveGoal(snap.entries), [snap.entries]);
	const goalActive = summary?.goalActive ?? derivedGoal?.active ?? false;
	const goalTitle = summary?.goalObjective ?? derivedGoal?.objective ?? "";
	const goal = useMemo(() => (goalActive ? { active: true, title: goalTitle } : null), [goalActive, goalTitle]);

	const toggleRail = useCallback(() => {
		railAutoRef.current = false;
		setRailOpen(open => !open);
	}, []);
	const openAgentsSheet = useCallback(() => setAgentsSheetOpen(true), []);
	const queueFollowUp = useCallback(async (value: string): Promise<void> => {
		if (summary === undefined) {
			setCommandFeedback({ tone: "error", message: "Queueing a follow-up requires an omp console session." });
			return;
		}
		const text = value.trim();
		if (text === "") {
			setCommandFeedback({ tone: "error", message: "Enter a follow-up to queue." });
			return;
		}
		if (queueBusy) return;
		setQueueBusy(true);
		try {
			const result = await api.sessionOpV3(summary.id, { op: "queue", text });
			if (!("queued" in result)) throw new Error("The session did not confirm the queued follow-up.");
			setQueueOpen(false);
			setQueueDraft("");
			setCommandFeedback({
				tone: "status",
				message: `Queued ${result.queued} follow-up${result.queued === 1 ? "" : "s"}.`,
			});
		} catch (error) {
			setCommandFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not queue the follow-up." });
		} finally {
			setQueueBusy(false);
		}
	}, [api, queueBusy, summary?.id]);
	const copyTranscriptTarget = useCallback(async (label: string, value: string | null): Promise<void> => {
		if (value === null) {
			setCommandFeedback({ tone: "error", message: `No ${label.toLowerCase()} is available in this transcript.` });
			return;
		}
		try {
			const copied = await copyText(value);
			if (copied) setCopyPickerOpen(false);
			setCommandFeedback({
				tone: copied ? "status" : "error",
				message: copied ? `${label} copied.` : `Could not copy ${label.toLowerCase()}.`,
			});
		} catch (error) {
			setCommandFeedback({ tone: "error", message: error instanceof Error ? error.message : `Could not copy ${label.toLowerCase()}.` });
		}
	}, []);
	const shareRoomLink = useCallback(async (permission: RoomPermission): Promise<void> => {
		if (summary === undefined) {
			setCommandFeedback({ tone: "error", message: "Collaboration links require an omp console session." });
			return;
		}
		try {
			const room = await getRoomLink(permission);
			const copied = await copyText(room.link);
			setCommandFeedback({
				tone: copied ? "status" : "error",
				message: copied
					? `${permission === "view" ? "View-only" : "Full-access"} collaboration link copied.`
					: "Could not copy the collaboration link.",
			});
		} catch (error) {
			setCommandFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not create a collaboration link." });
		}
	}, [getRoomLink, summary?.id]);
	const showCollabStatus = useCallback(async (): Promise<void> => {
		if (summary === undefined) {
			setCommandFeedback({ tone: "error", message: "Collaboration status requires an omp console session." });
			return;
		}
		try {
			const result = await api.sessionOpV3(summary.id, { op: "collab-status" });
			if (!("participants" in result)) throw new Error("The session did not return collaboration status.");
			setCollabStatus({ roomId: result.roomId, participants: result.participants });
			setCollabPanel("status");
		} catch (error) {
			setCommandFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not read collaboration status." });
		}
	}, [api, summary?.id]);
	const restartSession = useCallback(async (args: string): Promise<void> => {
		if (summary === undefined) {
			setCommandFeedback({ tone: "error", message: "Restart requires an omp console session." });
			return;
		}
		const busy = summary.state === "streaming" || summary.state === "asking" || summary.awaitingAnswer;
		const explicitlyConfirmed = args.trim().toLowerCase() === "anyway";
		if (busy && !explicitlyConfirmed && !window.confirm("Restart anyway? This aborts the active turn, then reopens the same session.")) {
			setCommandFeedback({ tone: "status", message: "Restart cancelled; the active turn was not changed." });
			return;
		}
		try {
			await api.restartSession(summary.id, busy ? { restartAnyway: true } : {});
			setCommandFeedback({ tone: "status", message: "Session worker restarted." });
		} catch (error) {
			setCommandFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not restart the session." });
		}
	}, [api, summary]);
	useEffect(() => {
		if (!focused) return;
		const onPanel = (event: Event): void => {
			const detail = (event as CustomEvent<{ panel?: string; command?: string; args?: string }>).detail;
			if (detail?.panel === "agents") {
				setAgentsSheetOpen(true);
				return;
			}
			const command = detail?.command;
			if (command === undefined) return;
			const args = detail.args?.trim() ?? "";
			setCommandFeedback(null);
			switch (command) {
				case "pause":
					togglePause();
					break;
				case "queue":
					if (args !== "") void queueFollowUp(args);
					else {
						setQueueDraft("");
						setQueueOpen(true);
					}
					break;
				case "restart":
					void restartSession(args);
					break;
				case "collab":
					if (args.toLowerCase() === "list") onOpenSessions();
					else if (args.toLowerCase() === "status") void showCollabStatus();
					else if (args.toLowerCase() === "stop") setCollabPanel("stop");
					else if (args.toLowerCase() === "view") void shareRoomLink("view");
					else if (args === "") void shareRoomLink("view");
					else setCommandFeedback({ tone: "error", message: "Use /collab, /collab view, /collab list, /collab status, or /collab stop." });
					break;
				case "leave":
				case "exit":
				case "quit":
					onLeave();
					break;
				case "open":
					if (latestLink === null || !openExternalLink(latestLink)) {
						setCommandFeedback({ tone: "error", message: "No link is available in this transcript." });
					}
					break;
				case "copy":
					if (args === "") setCopyPickerOpen(true);
					else if (args.toLowerCase() === "code") void copyTranscriptTarget("Code block", latestCopyCode(snap.entries, snap.stream));
					else if (["cmd", "command"].includes(args.toLowerCase())) void copyTranscriptTarget("Command", latestCopyCommand(snap.entries));
					else if (["link", "url"].includes(args.toLowerCase())) void copyTranscriptTarget("Link", latestLink);
					else setCommandFeedback({ tone: "error", message: "Use /copy [code|cmd|link]." });
					break;
				case "hotkeys":
					window.dispatchEvent(new Event(OPEN_KEYBINDINGS_EVENT));
					break;
			}
		};
		window.addEventListener(OPEN_PANEL_EVENT, onPanel);
		return () => window.removeEventListener(OPEN_PANEL_EVENT, onPanel);
	}, [
		focused,
		togglePause,
		queueFollowUp,
		restartSession,
		onOpenSessions,
		showCollabStatus,
		shareRoomLink,
		onLeave,
		latestLink,
		copyTranscriptTarget,
		snap.entries,
		snap.stream,
	]);
	const closeAgentsSheet = useCallback(() => setAgentsSheetOpen(false), []);
	const setPlanMode = useCallback(async (enabled: boolean, via: "direct" | "suggestion"): Promise<void> => {
		if (!summary) throw new Error("Plan mode requires a daemon session.");
		await runSessionOp(api, summary.id, { op: "plan-mode", enabled }, {
			feature: "1.6.plan-mode",
			action: enabled ? "enable" : "disable",
			screen: via === "suggestion" ? "session" : "header",
			via,
		});
		setPlanModeEnabled(enabled);
	}, [api, summary?.id]);
	// The host leaves plan mode itself when the agent's plan is approved (automatically, see session-host
	// plan-mode.ts), but guests get no mode_change entry: the approval's tool result is the signal.
	const planApprovals = useMemo(() => countPlanApprovals(snap.entries), [snap.entries]);
	const seenPlanApprovals = useRef(planApprovals);
	useEffect(() => {
		if (planApprovals > seenPlanApprovals.current) setPlanModeEnabled(false);
		seenPlanApprovals.current = planApprovals;
	}, [planApprovals]);

	// Model/thinking controls and "New agent" need the daemon's session id and the root agent.
	const rootAgentId = snap.agents.find(a => a.kind === "main")?.id ?? summary?.rootAgentId;
	const headerControls = useMemo(
		() => (summary === undefined || rootAgentId === undefined ? undefined : {
			api,
			sessionId: summary.id,
			agentId: rootAgentId,
			loopMode: summary.loopMode,
			vibeMode: summary.vibeMode,
			focused,
			planModeEnabled,
			approvalMode: snap.state?.approvalMode,
			onSetPlanMode: setPlanMode,
		}),
		[api, summary?.id, summary?.loopMode, summary?.vibeMode, rootAgentId, focused, planModeEnabled, snap.state?.approvalMode, setPlanMode],
	);
	// `omp-console:open-agent` (after a spawn, from the graph) opens that agent's drawer.
	useOpenAgentEvent(focused ? setSelectedId : ignoreOpenAgent);

	// omp keybindings the composer hands up (Shift+Tab thinking, Ctrl+P model, Alt+Shift+P plan, F5 retry, ...).
	const keyStateRef = useRef({ snap, rootAgentId, planModeEnabled });
	keyStateRef.current = { snap, rootAgentId, planModeEnabled };
	useEffect(() => {
		if (!focused || summary === undefined) return;
		const sessionId = summary.id;
		const onAction = (event: Event): void => {
			const detail = (event as CustomEvent<KeymapActionDetail>).detail;
			if (detail?.sessionId !== sessionId) return;
			const state = keyStateRef.current;
			void runShellKeyAction(detail.action, {
				rootAgentId: state.rootAgentId,
				thinkingLevel: state.snap.state?.thinkingLevel,
				modelId: state.snap.state?.model?.id,
				planModeEnabled: state.planModeEnabled,
				listModels: () => api.listModels(),
				setThinking: (agentId, level) => api.setAgentThinking(sessionId, agentId, level),
				setModel: async (agentId, selector) => {
					await api.setAgentModel(sessionId, agentId, selector);
				},
				sessionOp: op => api.sessionOp(sessionId, op),
				setPlanMode: enabled => setPlanMode(enabled, "direct"),
				runCommand: text => api.runCommand(sessionId, text),
				openControls: () => window.dispatchEvent(new CustomEvent(OPEN_SESSION_CONTROLS_EVENT, { detail: { sessionId } })),
				openAgents: () => setAgentsSheetOpen(true),
				openTree: () => openPanel({ panel: "tree" }),
			}).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : "The shortcut failed.";
				window.dispatchEvent(new CustomEvent("omp-console:keymap-error", { detail: { sessionId, message } }));
			});
		};
		window.addEventListener(KEYMAP_ACTION_EVENT, onAction);
		return () => window.removeEventListener(KEYMAP_ACTION_EVENT, onAction);
	}, [focused, summary?.id, api, setPlanMode]);

	const look = useSessionLook({ summary, entries: snap.entries, state: snap.state, phone: mode === "phone" });

	return (
		<div className="sh-app" {...look.rootProps}>
			<div className="sh-ambient" />
			{look.bar}
			<LazyRegion fallback={<HeaderLoading />}>
				<HeaderBar
					mode={mode}
					header={snap.header}
					state={snap.state}
					phase={snap.phase}
					readOnly={snap.readOnly}
					subCount={subCount}
					railOpen={railOpen}
					onToggleRail={toggleRail}
					onLeave={onLeave}
					goal={look.badges.some(b => b.id === "goal") ? null : goal}
					health={health}
					sessionSummary={visibleSummary ?? null}
					title={title}
					librarianEnabled={librarianEnabled}
					overnightEnabled={overnightEnabled}
					onToggleSidebar={onToggleSidebar}
					onOpenSessions={onOpenSessions}
					onOpenStatus={onOpenStatus}
					onOpenSettings={onOpenSettings}
					onTogglePause={togglePause}
					controls={headerControls}
					workspaceSlot={
						<>
							{machineName ? <>{look.headerSlot}<MachineChip name={machineName} /></> : look.headerSlot}
							{agendaEnabled && focused && !snap.readOnly && summary !== undefined ? (
								<LazyRegion fallback={null}>
									<AgendaSessionAction key={summary.id} api={api} sessionId={summary.id} />
								</LazyRegion>
							) : null}
						</>
					}
				/>
			</LazyRegion>
			{paused && !snap.readOnly && (
				<div
					className="sh-paused-banner"
					role="status"
					tabIndex={0}
					aria-label={pauseLabel}
					onKeyDown={event => {
						if (event.target !== event.currentTarget || !["Escape", "Enter", " "].includes(event.key)) return;
						event.preventDefault();
						void changePause("resume");
					}}
				>
					<span><strong>{pauseLabel}</strong> Agent loops are parked at safe boundaries; in-flight calls finish without being aborted.</span>
					<button type="button" className="sh-btn sh-btn-primary" disabled={pauseBusy || snap.phase !== "live"} onClick={() => void changePause("resume")}>
						{pauseBusy ? "Resuming…" : "Resume"}
					</button>
				</div>
			)}
			{pauseError !== null && <div className="sh-pause-error" role="alert">{pauseError}</div>}
			{commandFeedback !== null && (
				<div className="sh-command-feedback" data-tone={commandFeedback.tone} role={commandFeedback.tone === "error" ? "alert" : "status"}>
					<span>{commandFeedback.message}</span>
					<button type="button" onClick={() => setCommandFeedback(null)}>Dismiss</button>
				</div>
			)}
			{queueOpen && (
				<Sheet title="Queue follow-up" onClose={() => setQueueOpen(false)}>
					<form
						className="dk-agenda-start"
						onSubmit={event => {
							event.preventDefault();
							void queueFollowUp(queueDraft);
						}}
					>
						<label className="dk-agenda-start-prompt">
							<span>Message to queue after the current turn</span>
							<textarea autoFocus value={queueDraft} onChange={event => setQueueDraft(event.currentTarget.value)} disabled={queueBusy} />
						</label>
						<p>The current turn continues; this message runs as a follow-up.</p>
						<button type="submit" className="dk-wide-btn" disabled={queueBusy || !queueDraft.trim()}>
							{queueBusy ? "Queueing…" : "Queue follow-up"}
						</button>
					</form>
				</Sheet>
			)}
			{collabPanel === "status" && collabStatus !== null && (
				<Sheet title="Collaboration status" onClose={() => setCollabPanel(null)}>
					<div className="dk-agenda-start">
						<p>Room: <code>{collabStatus.roomId}</code></p>
						<p>Share links are issued per link as full-access or view-only. Existing links cannot be revoked in omp console.</p>
						<p>Connected participants</p>
						<ul>
							{collabStatus.participants.length === 0 && <li>No participants are currently connected.</li>}
							{collabStatus.participants.map((participant, index) => (
								<li key={`${participant.role}:${participant.name}:${index}`}>
									{participant.name} — {participant.role === "host" ? "host" : participant.readOnly ? "view-only guest" : "full-access guest"}
								</li>
							))}
						</ul>
						<button type="button" className="dk-wide-btn" onClick={() => void shareRoomLink("full")}>Copy full-access link</button>
						<button type="button" className="dk-wide-btn" onClick={() => void shareRoomLink("view")}>Copy view-only link</button>
					</div>
				</Sheet>
			)}
			{collabPanel === "stop" && (
				<Sheet title="Collaboration room stays open" onClose={() => setCollabPanel(null)}>
					<div className="dk-agenda-start">
						<p>omp console uses this room as the worker transport while the session is running. /collab stop cannot close that room or revoke copied links. End the session to close its room; link permissions can only be chosen when creating a new link.</p>
					</div>
				</Sheet>
			)}
			{copyPickerOpen && (
				<Sheet title="Copy from transcript" onClose={() => setCopyPickerOpen(false)}>
					<div className="dk-agenda-start">
						<p>Choose the latest matching transcript item.</p>
						<button type="button" className="dk-wide-btn" disabled={latestCopyText(snap.entries, snap.stream) === null} onClick={() => void copyTranscriptTarget("Text", latestCopyText(snap.entries, snap.stream))}>Copy latest text</button>
						<button type="button" className="dk-wide-btn" disabled={latestCopyCode(snap.entries, snap.stream) === null} onClick={() => void copyTranscriptTarget("Code block", latestCopyCode(snap.entries, snap.stream))}>Copy latest code block</button>
						<button type="button" className="dk-wide-btn" disabled={latestCopyCommand(snap.entries) === null} onClick={() => void copyTranscriptTarget("Command", latestCopyCommand(snap.entries))}>Copy latest command</button>
						<button type="button" className="dk-wide-btn" disabled={latestLink === null} onClick={() => void copyTranscriptTarget("Link", latestLink)}>Copy latest link</button>
					</div>
				</Sheet>
			)}

			{agendaEnabled && mode === "phone" && focused && !snap.readOnly && summary !== undefined ? (
				<div className="dk-agenda-mobile-session-action">
					<LazyRegion fallback={null}>
						<AgendaSessionAction key={summary.id} api={api} sessionId={summary.id} />
					</LazyRegion>
				</div>
			) : null}
			<SuggestionBar
				sessionId={summary?.id ?? null}
				summary={summary}
				entries={snap.entries}
				contextPercent={contextPercent}
				subagentCount={subCount}
				working={snap.working}
				readOnly={snap.readOnly}
				onSetPlanMode={setPlanMode}
				onOpenGraph={openAgentsSheet}
				onOpenStatus={onOpenStatus}
				onStopSession={onStopSession}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					{look.strip}
					<div
						className="sh-transcript"
						onPointerDown={mode === "phone" && phoneActionsOpen ? () => setPhoneActionsOpen(false) : undefined}
					>
						<Transcript
							sessionId={summary?.id}
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
							phoneLayout={mode === "phone"}
							latestLink={latestLink}
							initialScrollPosition={initialScrollPosition}
							onScrollPositionChange={onScrollPositionChange}
							tailSlot={mode === "phone" ? null : quickReplies}
						/>
						<LazyRegion fallback={null}>
							<CommandResults client={client} sessionId={summary?.id} />
						</LazyRegion>
					</div>
					{summary !== undefined && (
						<DriftCard api={api} sessionId={summary.id} kind={look.kind} onOpenSession={onOpenSession} />
					)}
					<Composer
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						paused={paused}
						onTogglePause={togglePause}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
						api={api}
						sessionId={summary?.id}
						active={focused}
						sessionOnLocalMachine={machineName === undefined}
						overnightEnabled={overnightEnabled}
						touchLayout={touchLayout}
						phoneLayout={mode === "phone"}
						quickReplies={mode === "phone" ? quickReplies : null}
						phoneSuggestions={phoneSuggestions}
						phoneSuggestionStatus={phoneSuggestionStatus}
						lastLink={latestLink}
						actionsOpen={phoneActionsOpen}
						onActionsOpenChange={setPhoneActionsOpen}
						planModeEnabled={planModeEnabled}
						// Settings entries (model, thinking level) do not count: a session is empty until a message exists.
						emptySession={!snap.entries.some(entry => entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction")}
					/>
				</section>
				{railMounted && (
					<>
						<div className="sh-rail-backdrop" data-open={railOpen ? "true" : "false"} aria-hidden={!railOpen} onClick={() => setRailOpen(false)} />
						<aside className="sh-rail" data-open={railOpen ? "true" : "false"} aria-hidden={!railOpen} inert={!railOpen}>
							<LazyRegion fallback={<LoadingPanel label="agents" />}>
								<AgentsPanel
									agents={snap.agents}
									progress={snap.progress}
									lifecycle={snap.lifecycle}
									working={snap.working}
									selectedId={selectedId}
									onSelect={setSelectedId}
									onOpenGraph={openAgentsSheet}
								/>
							</LazyRegion>
						</aside>
					</>
				)}
			</main>
			{(agentsSheetOpen || selectedId !== null) && (
				<LazyRegion
					fallback={
						agentsSheetOpen ? (
							<Sheet title="Agents" windowKind="agents" onClose={closeAgentsSheet}>
								<LoadingPanel label="agents" />
							</Sheet>
						) : null
					}
				>
					<AgentsOverlay
						api={api}
						agents={snap.agents}
						progress={snap.progress}
						lifecycle={snap.lifecycle}
						working={snap.working}
						client={client}
						readOnly={snap.readOnly}
						phone={mode === "phone"}
						sheetOpen={agentsSheetOpen}
						selectedId={selectedId}
						sessionId={summary?.id}
						entries={snap.entries}
						host={toolHost}
						onSelect={setSelectedId}
						onCloseSheet={closeAgentsSheet}
					/>
				</LazyRegion>
			)}
			{focused && <SpawnHost api={api} sessionId={summary?.id} readOnly={snap.readOnly} />}
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				loading={snap.loading}
				onRejoin={onRejoin}
				onNewLink={onLeave}
			/>
			<Toasts notices={snap.notices} sessionId={summary?.id} />
			{focused && (
				<LazyRegion fallback={null}>
					<DiscoveryHost api={api} sessionId={summary?.id} readOnly={snap.readOnly} overnightEnabled={overnightEnabled} />
				</LazyRegion>
			)}
		</div>
	);
}
