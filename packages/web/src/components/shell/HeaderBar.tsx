import type { SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { Activity, Check, ChevronDown, FilePenLine, ListFilter, LogOut, Mic, Moon, MoreHorizontal, PanelLeft, PanelRight, Pause, Play, Plus, Settings, Target, X } from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LoopModeStatus, SessionCard, SessionStatsView, SessionSummary, VibeModeStatus, Workspace } from "@omp-console/protocol";
import type { ConnectionPhase } from "../../lib/client";
import { fmtCost, fmtDuration, fmtPercent, fmtTokens, shortenPath } from "../../lib/format";
import type { HealthView } from "../../lib/health";
import type { LayoutMode } from "../../lib/layout";
import { statsFromResult } from "../../lib/session-ops";
import type { DeckApi } from "../../lib/api";
import { rememberUserTitle } from "../../lib/card-titles";
import { renameCardOptimistically, undoCardTitleOptimistically } from "../../lib/cards";
import { recordUsage } from "../../lib/journal";
import { publishCardTitles } from "../../lib/card-titles";
import { openSpawnPanel } from "../../lib/spawn";
import { openPanel } from "../../lib/palette";
import { overnightPhaseLabel } from "../../lib/overnight";
import { ExtensionStatus } from "../plugins/PluginsPanel";
import { QuotaHeaderChip } from "../quota/QuotaBadges";
import { useWorkspaces } from "../workspaces/WorkspaceProvider";
import { OmpMark } from "./OmpMark";
import { SessionControls } from "../spawn/SessionControls";
import { SessionOpsMenu } from "../session-ops/SessionOpsMenu";

/** Renders into `document.body`, above every pane, so pane clipping and stacking cannot hide a header popover. */
function viewportLayer(node: ReactNode): ReactNode {
	return typeof document === "undefined" ? node : createPortal(node, document.body);
}

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

export interface HeaderAttentionStatus {
	label: string;
	title: string;
}

export function headerAttentionStatus(session: SessionSummary | null, now: number): HeaderAttentionStatus | null {
	if (!session || (!session.awaitingAnswer && session.state !== "asking") || session.state === "stopped" || session.state === "crashed") {
		return null;
	}
	const kind = session.pendingKind === "approval" ? "approval" : "question";
	const wait = fmtDuration(Math.max(0, now - session.lastActivityAt));
	return {
		label: `Needs you · ${kind} · ${wait}`,
		title: `Waiting for your ${kind === "approval" ? "approval" : "answer"} · ${wait}`,
	};
}

export function headerConnectionStatus(phase: ConnectionPhase, online: boolean): { label: string; phase: ConnectionPhase } {
	return online ? { label: PHASE_LABEL[phase], phase } : { label: "Offline", phase: "reconnecting" };
}

export interface HeaderHealthStatus {
	level: HealthView["level"] | "waiting";
	label: string;
	title: string;
}

export function headerHealthStatus(
	health: HealthView | null,
	attention: HeaderAttentionStatus | null,
	sessionSummaryKnown: boolean,
): HeaderHealthStatus | null {
	if (attention) return { level: "waiting", label: attention.label, title: attention.title };
	if (!health || health.level === "unknown" || (health.level === "ok" && !sessionSummaryKnown)) return null;
	return { level: health.level, label: health.level === "ok" ? "healthy" : health.level, title: health.title };
}
function overnightDeadlineLabel(deadline: string): string {
	const date = new Date(deadline);
	if (Number.isNaN(date.getTime())) return deadline;
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export const STATUS_SEGMENTS = ["branch", "tokens", "cost", "cache", "elapsed", "subagents"] as const;
export type StatusSegmentId = (typeof STATUS_SEGMENTS)[number];
export type StatusSegmentStorage = Pick<Storage, "getItem" | "setItem">;

export const STATUS_SEGMENT_STORAGE_KEY = "omp-console.header.statusSegments";
function browserStatusStorage(): StatusSegmentStorage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export const STATUS_SEGMENT_LABELS: Record<StatusSegmentId, string> = {
	branch: "Branch",
	tokens: "Tokens",
	cost: "Cost",
	cache: "Cache hit",
	elapsed: "Time",
	subagents: "Subagents",
};

/** No extra status segment is shown by default; tokens, cost, cache, time, subagents and branch can be enabled by the user. */
export const DEFAULT_STATUS_SEGMENTS: readonly StatusSegmentId[] = [];

export function readStatusSegments(storage: StatusSegmentStorage | null): readonly StatusSegmentId[] {
	if (!storage) return DEFAULT_STATUS_SEGMENTS;
	try {
		const raw = storage.getItem(STATUS_SEGMENT_STORAGE_KEY);
		if (raw === null) return DEFAULT_STATUS_SEGMENTS;
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return DEFAULT_STATUS_SEGMENTS;
		const values = parsed as unknown[];
		return STATUS_SEGMENTS.filter(segment => values.includes(segment));
	} catch {
		return DEFAULT_STATUS_SEGMENTS;
	}
}

export function writeStatusSegments(storage: StatusSegmentStorage | null, segments: readonly StatusSegmentId[]): void {
	if (!storage) return;
	try {
		const selected = STATUS_SEGMENTS.filter(segment => segments.includes(segment));
		storage.setItem(STATUS_SEGMENT_STORAGE_KEY, JSON.stringify(selected));
	} catch {
		// Status preferences remain usable when local storage is unavailable.
	}
}

export function statusSegmentValues(
	workspace: Workspace | null,
	header: SessionHeader | null,
	stats: SessionStatsView | null,
	subCount: number,
	now: number,
): Record<StatusSegmentId, string | null> {
	const start = header === null ? Number.NaN : Date.parse(header.timestamp);
	const cacheInput = stats === null ? 0 : stats.tokens.input + stats.tokens.cacheRead;
	return {
		branch: workspace?.git === undefined ? null : workspace.git.branch ?? "detached",
		tokens: stats === null ? null : `${fmtTokens(stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite)} tok`,
		cost: stats === null ? null : fmtCost(stats.cost),
		cache: cacheInput > 0 && stats !== null ? `${fmtPercent((stats.tokens.cacheRead / cacheInput) * 100)}` : null,
		elapsed: Number.isFinite(start) ? fmtDuration(Math.max(0, now - start)) : null,
		subagents: `${subCount}`,
	};
}

export interface HeaderBarProps {
	mode: LayoutMode;
	header: SessionHeader | null;
	state: SessionState | null;
	/** Current daemon summary; supplied when available to avoid a duplicate session-list poll. */
	sessionSummary?: SessionSummary | null;
	/** Display name from {@link sessionDisplayTitle}; defaults to the omp title or "session". */
	title?: string;
	phase: ConnectionPhase;
	readOnly: boolean;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	/** Goal indicator; null when no goal is known. `title` is the objective when the entries expose it. */
	goal?: { active: boolean; title: string } | null;
	health?: HealthView | null;
	/** Collapses the inline session sidebar (tablet and desktop). */
	onToggleSidebar?(): void;
	/** Opens the full-height session sheet (phone). */
	onOpenSessions?(): void;
	onOpenStatus?(): void;
	onOpenSettings?(): void;
	onTogglePause?(): void;
	/** Enables title edits through the daemon-backed session card API. */
	controls?: HeaderControls;
	overnightEnabled?: boolean;
	librarianEnabled?: boolean;
	/** Workspace chip and mode badges (`useSessionLook`); shown after the working directory on tablet and desktop. */
	workspaceSlot?: ReactNode;
}

export interface HeaderControls {
	api: DeckApi;
	sessionId: string;
	/** The session's root agent. */
	agentId: string;
	planModeEnabled: boolean | null;
	loopMode?: LoopModeStatus;
	vibeMode?: VibeModeStatus;
	focused?: boolean;
	/** Host tool approval mode when the host reports it. */
	approvalMode?: string;
	onSetPlanMode(enabled: boolean, via: "direct" | "suggestion"): Promise<void>;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
const COMPACT_PHONE_QUERY = "(max-width: 639.98px)";

export const HeaderBar = memo(function HeaderBar({
	mode,
	header,
	state,
	sessionSummary,
	title: titleProp,
	phase,
	readOnly,
	subCount,
	railOpen,
	onToggleRail,
	onLeave,
	goal = null,
	health = null,
	onToggleSidebar,
	onOpenSessions,
	onOpenStatus,
	onOpenSettings,
	onTogglePause,
	controls,
	librarianEnabled,
	overnightEnabled = false,
	workspaceSlot,
}: HeaderBarProps): ReactNode {
	const phone = mode === "phone";
	// Below 640 px the inline phone actions no longer fit beside the title (in a narrow native window or a phone in
	// landscape): they move into the "…" menu.
	const [compactPhone, setCompactPhone] = useState(
		() => typeof window !== "undefined" && window.matchMedia(COMPACT_PHONE_QUERY).matches,
	);
	const [localHeaderTitle, setLocalHeaderTitle] = useState<{ sessionId: string; title: string } | null>(null);
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const [titleSaving, setTitleSaving] = useState(false);
	const [titleError, setTitleError] = useState<string | null>(null);
	const titleInputRef = useRef<HTMLInputElement | null>(null);
	const titleSavePending = useRef(false);
	const titleCanceling = useRef(false);
	useEffect(() => {
		const media = window.matchMedia(COMPACT_PHONE_QUERY);
		const sync = (): void => setCompactPhone(media.matches);
		sync();
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);
	const headerRef = useRef<HTMLElement | null>(null);
	const [headerWidth, setHeaderWidth] = useState(0);
	useEffect(() => {
		if (phone) return;
		const headerElement = headerRef.current;
		if (!headerElement) return;
		setHeaderWidth(headerElement.getBoundingClientRect().width);
		const observer = new ResizeObserver(entries => {
			const entry = entries[entries.length - 1];
			if (entry) setHeaderWidth(entry.contentRect.width);
		});
		observer.observe(headerElement);
		return () => observer.disconnect();
	}, [phone]);
	const moveReadouts = !phone && headerWidth < 1360;
	const moveActions = !phone && headerWidth < 1120;
	const moveSessionControls = !phone && headerWidth < 960;
	const overflowRef = useRef<HTMLDetailsElement | null>(null);
	// Desktop: the menu renders in a viewport layer (portal + fixed position) so a short pane cannot clip it.
	const overflowMenuRef = useRef<HTMLDivElement | null>(null);
	const [overflowOpen, setOverflowOpen] = useState(false);
	const [overflowAnchor, setOverflowAnchor] = useState<{ top: number; right: number } | null>(null);
	// A header wide enough to show everything has no overflow menu: an open one closes with it.
	useEffect(() => {
		if (!moveReadouts) setOverflowOpen(false);
	}, [moveReadouts]);
	useLayoutEffect(() => {
		if (!overflowOpen) {
			setOverflowAnchor(null);
			return;
		}
		const layer = overflowMenuRef.current;
		try {
			if (layer !== null && typeof layer.showPopover === "function") layer.showPopover();
		} catch {
			layer?.removeAttribute("popover");
			// Older engines keep the header menu in its fixed body portal.
		}
		const place = (): void => {
			const summary = overflowRef.current?.querySelector("summary");
			if (!summary) return;
			const rect = summary.getBoundingClientRect();
			const top = Math.round(rect.bottom + 6);
			const right = Math.max(8, Math.round(window.innerWidth - rect.right));
			setOverflowAnchor(previous => (previous?.top === top && previous.right === right ? previous : { top, right }));
		};
		place();
		// Keyboard users continue into the menu (it lives at the end of <body>, not after its trigger).
		const focusFrame = requestAnimationFrame(() => overflowMenuRef.current?.focus({ preventScroll: true }));
		// A pane splitter drag moves the trigger without a window resize: follow the pane and header too.
		const summary = overflowRef.current?.querySelector("summary");
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
		for (const element of [summary?.closest(".pn-frame"), summary?.closest(".sh-header")]) if (element) observer?.observe(element);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			cancelAnimationFrame(focusFrame);
			observer?.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
			try {
				if (layer?.matches(":popover-open")) layer.hidePopover();
			} catch {
				// The Popover API is optional in older engines.
			}
		};
	}, [overflowOpen]);
	useEffect(() => {
		if (phone && !compactPhone) return;
		const onPointer = (event: PointerEvent): void => {
			const menu = overflowRef.current;
			if (!menu?.open || !(event.target instanceof Node) || menu.contains(event.target)) return;
			if (overflowMenuRef.current?.contains(event.target)) return;
			if (event.target instanceof Element && event.target.closest(".dk-sheet-root, .sc-pop, .so-menu")) return;
			menu.removeAttribute("open");
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			const menu = overflowRef.current;
			const focusInMenu = overflowMenuRef.current?.contains(document.activeElement) === true;
			menu?.removeAttribute("open");
			if (focusInMenu) menu?.querySelector("summary")?.focus();
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [phone, compactPhone]);
	const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
	useEffect(() => {
		const sync = (): void => setBrowserOnline(navigator.onLine);
		window.addEventListener("online", sync);
		window.addEventListener("offline", sync);
		sync();
		return () => {
			window.removeEventListener("online", sync);
			window.removeEventListener("offline", sync);
		};
	}, []);
	const [selectedSegments, setSelectedSegments] = useState<readonly StatusSegmentId[]>(() => readStatusSegments(browserStatusStorage()));
	const [statsSnapshot, setStatsSnapshot] = useState<{ sessionId: string; stats: SessionStatsView | null } | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const workspaceContext = useWorkspaces();
	const workspace = workspaceContext.lookFor(state?.cwd ?? header?.cwd)?.workspace ?? null;
	const statsApi = controls?.api;
	const statsSessionId = controls?.sessionId;
	const [polledSession, setPolledSession] = useState<{ sessionId: string; summary: SessionSummary | null } | null>(null);
	const statusApi = controls?.api;
	const statusSessionId = controls?.sessionId;
	useEffect(() => {
		setPolledSession(null);
		if (sessionSummary !== undefined || readOnly || !statusApi || !statusSessionId) return;
		let active = true;
		let inFlight = false;
		const controller = new AbortController();
		const load = async (): Promise<void> => {
			if (inFlight || document.visibilityState === "hidden") return;
			inFlight = true;
			try {
				const response = await statusApi.listSessions(controller.signal);
				if (active) {
					const summary = response.live.find(session => session.id === statusSessionId) ?? null;
					setPolledSession({ sessionId: statusSessionId, summary });
				}
			} catch {
				// Keep the last known status while the list endpoint is unavailable.
			} finally {
				inFlight = false;
			}
		};
		const onVisibilityChange = (): void => {
			if (document.visibilityState === "visible") void load();
		};
		void load();
		const timer = window.setInterval(() => void load(), 3_000);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			active = false;
			controller.abort();
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [readOnly, sessionSummary, statusApi, statusSessionId]);
	const needsStats = selectedSegments.some(segment => segment === "tokens" || segment === "cost" || segment === "cache");
	const stats = statsSnapshot !== null && statsSnapshot.sessionId === statsSessionId ? statsSnapshot.stats : null;
	useEffect(() => {
		setStatsSnapshot(null);
		if (phone || !statsApi || !statsSessionId || !needsStats) return;
		let live = true;
		let inFlight = false;
		const load = async (): Promise<void> => {
			if (inFlight || document.visibilityState === "hidden") return;
			inFlight = true;
			try {
				const result = await statsApi.sessionOp(statsSessionId, { op: "stats" });
				if (live) setStatsSnapshot({ sessionId: statsSessionId, stats: statsFromResult(result) });
			} catch {
				// Header readouts stay quiet when stats are unavailable.
			} finally {
				inFlight = false;
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), 30_000);
		return () => {
			live = false;
			window.clearInterval(timer);
		};
	}, [phone, statsApi, statsSessionId, needsStats]);

	useEffect(() => {
		if (phone || !selectedSegments.includes("elapsed") || header === null) return;
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, [phone, selectedSegments, header]);

	const toggleStatusSegment = (segment: StatusSegmentId, checked: boolean): void => {
		setSelectedSegments(current => {
			const next = STATUS_SEGMENTS.filter(candidate => candidate === segment ? checked : current.includes(candidate));
			writeStatusSegments(browserStatusStorage(), next);
			return next;
		});
	};
	const statusValues = statusSegmentValues(workspace, header, stats, subCount, now);
	const defaultTitle = titleProp ?? header?.title ?? state?.sessionName ?? "session";
	const title =
		localHeaderTitle !== null && localHeaderTitle.sessionId === controls?.sessionId
			? localHeaderTitle.title
			: defaultTitle;
	const canRenameTitle = !readOnly && controls !== undefined && librarianEnabled === true;
	// A rename elsewhere (the list) arrives as a new title prop: it replaces any local, optimistic header title.
	useEffect(() => setLocalHeaderTitle(null), [titleProp]);

	useEffect(() => {
		setEditingTitle(false);
		setTitleError(null);
	}, [controls?.sessionId]);

	const beginTitleEdit = (): void => {
		if (!canRenameTitle) return;
		setTitleDraft(title);
		setTitleError(null);
		titleCanceling.current = false;
		setEditingTitle(true);
	};
	const cancelTitleEdit = (): void => {
		titleCanceling.current = true;
		setEditingTitle(false);
		setTitleDraft(title);
		setTitleError(null);
	};
	const saveTitleEdit = async (): Promise<void> => {
		if (titleSavePending.current || titleSaving || !controls) return;
		const sessionId = controls.sessionId;
		const nextTitle = titleDraft.trim();
		if (nextTitle !== "" && nextTitle === title) {
			titleCanceling.current = true;
			setEditingTitle(false);
			return;
		}
		titleSavePending.current = true;
		setTitleSaving(true);
		setTitleError(null);
		const fallbackTitle = header?.title?.trim() || state?.sessionName?.trim() || titleProp?.trim() || "session";
		setLocalHeaderTitle({ sessionId, title: nextTitle || fallbackTitle });
		try {
			const before = await controls.api.cards({ limit: 400 });
			let card = before.cards.find(candidate => candidate.sessionId === sessionId);
			if (!card) throw new Error("Session title is not available to edit.");
			let persistedTitle = card.title;
			const setOverrides = (update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): void => {
				setLocalHeaderTitle(current => {
					const currentTitles = new Map<string, string>();
					if (current?.sessionId === sessionId) currentTitles.set(sessionId, current.title);
					const nextTitles = update(currentTitles);
					return { sessionId, title: nextTitles.get(sessionId) ?? persistedTitle };
				});
			};
			const saveCard = (updated: SessionCard): void => {
				persistedTitle = updated.title;
				// The shared title store (rememberUserTitle → the title prop) names the session from now on; a generated
				// card title must never stand in for omp's own title, so the local override ends here.
				rememberUserTitle(sessionId, updated.titleSource === "user" ? updated.title : null);
				setLocalHeaderTitle(null);
			};
			if (nextTitle !== "") {
				card = await renameCardOptimistically(controls.api, sessionId, nextTitle, setOverrides, saveCard);
			} else {
				while (card.titleSource === "user" && card.titleHistory.length > 0) {
					const previous = card.titleHistory.at(-1);
					if (!previous) break;
					card = await undoCardTitleOptimistically(controls.api, sessionId, previous.title, setOverrides, saveCard);
				}
				if (card.titleSource === "user") throw new Error("Generated title is not available to restore.");
			}
			titleCanceling.current = true;
			setEditingTitle(false);
			setLocalHeaderTitle(null);
		} catch (error) {
			setLocalHeaderTitle(null);
			setTitleError(error instanceof Error ? error.message : "The title could not be saved.");
		} finally {
			titleSavePending.current = false;
			setTitleSaving(false);
		}
	};
	const submitTitleEdit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		void saveTitleEdit();
	};
	const titleForm = (
		<form
			className={phone ? "dk-header-title-form dk-header-title-form-phone" : "dk-header-title-form"}
			onSubmit={submitTitleEdit}
			onBlur={event => {
				if (titleCanceling.current) {
					titleCanceling.current = false;
					return;
				}
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				void saveTitleEdit();
			}}
		>
			<input
				ref={titleInputRef}
				className="sh-input dk-header-title-input"
				aria-label="Edit session title"
				value={titleDraft}
				autoFocus
				disabled={titleSaving}
				onChange={event => setTitleDraft(event.target.value)}
				onKeyDown={event => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					cancelTitleEdit();
				}}
			/>
			<button type="submit" className="dk-header-title-save" aria-label="Save session title" disabled={titleSaving}>
				<Check size={14} aria-hidden="true" />
			</button>
			<button type="button" className="dk-header-title-cancel" aria-label="Cancel title edit" disabled={titleSaving} onClick={cancelTitleEdit}>
				<X size={14} aria-hidden="true" />
			</button>
			{titleError && <span className="dk-header-title-error" role="alert">{titleError}</span>}
		</form>
	);
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}
	const healthLevel = health?.level ?? "unknown";
	const polledSummary =
		polledSession !== null && polledSession.sessionId === statusSessionId ? polledSession.summary : null;
	const currentSummary = sessionSummary !== undefined ? sessionSummary : polledSummary;
	const overnight = overnightEnabled ? currentSummary?.overnight : undefined;
	const overnightLabel = overnight === undefined ? null : overnightPhaseLabel(overnight.phase);
	const overnightDeadline = overnight === undefined ? null : overnightDeadlineLabel(overnight.deadline);
	const sessionStatusKnown =
		sessionSummary !== undefined ||
		(statusSessionId !== undefined && polledSession !== null && polledSession.sessionId === statusSessionId);

	useEffect(() => {
		if (!currentSummary?.paused) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [currentSummary?.paused]);
	const attention = headerAttentionStatus(currentSummary, Date.now());
	const connection = headerConnectionStatus(phase, browserOnline);
	const healthStatus = headerHealthStatus(health, attention, sessionStatusKnown);
	const pauseElapsed =
		currentSummary?.paused && currentSummary.pausedAt !== undefined
			? fmtDuration(Math.max(0, now - currentSummary.pausedAt))
			: null;
	const pauseLabel = pauseElapsed === null ? "Paused" : `Paused ${pauseElapsed}`;

	const phoneActions = (
		<>
			{controls && !readOnly && (
				<div className="sh-phone-menu-row sh-phone-menu-services">
					<span className="sh-phone-menu-label">Provider status</span>
					<QuotaHeaderChip api={controls.api} provider={state?.model?.provider} />
					<ExtensionStatus api={controls.api} sessionId={controls.sessionId} />
				</div>
			)}
			{controls && !readOnly && (
				<div className="sh-phone-menu-row">
					<span className="sh-phone-menu-label">Model and thinking</span>
					<SessionControls api={controls.api} sessionId={controls.sessionId} agentId={controls.agentId} state={state} phone />
				</div>
			)}
			{controls && !readOnly && (
				<div className="sh-phone-menu-row">
					<span className="sh-phone-menu-label">Session mode</span>
					<SessionOpsMenu
						key={controls.sessionId}
						api={controls.api}
						sessionId={controls.sessionId}
						planModeEnabled={controls.planModeEnabled}
						loopMode={controls.loopMode}
						vibeMode={controls.vibeMode}
						focused={controls.focused}
						hostApprovalMode={controls.approvalMode}
						onSetPlanMode={controls.onSetPlanMode}
					/>
				</div>
			)}
			{controls && !readOnly && (
				<div className="sh-phone-menu-row">
					<span className="sh-phone-menu-label">New agent</span>
					<button
						type="button"
						className="dk-tap"
						onClick={() => {
							recordUsage({ feature: "2.5.spawn", action: "open-header", outcome: "ok", via: "direct", screen: "header", sessionId: controls.sessionId });
							openSpawnPanel();
						}}
						title="new agent"
						aria-label="new agent"
					>
						<Plus size={20} />
					</button>
				</div>
			)}
			{currentSummary && !readOnly && onTogglePause && (
				<div className="sh-phone-menu-row">
					<span className="sh-phone-menu-label">Session</span>
					<button type="button" className="dk-tap" onClick={onTogglePause} title={currentSummary?.paused ? "resume session" : "pause session"} aria-label={currentSummary?.paused ? "resume session" : "pause session"}>
						{currentSummary?.paused ? <Play size={20} /> : <Pause size={20} />}
					</button>
				</div>
			)}
			{onOpenStatus && (
				<div className="sh-phone-menu-row">
					<span className="sh-phone-menu-label">Status</span>
					<button type="button" className="dk-tap dk-status-btn" onClick={onOpenStatus} aria-label={`status: goal, todos, health (${healthLevel})`} title="status">
						<Activity size={20} />
						<span className={`dk-ind dk-ind-${healthLevel}`} />
						{goal?.active && <span className="dk-ind-goal" />}
					</button>
				</div>
			)}
			<div className="sh-phone-menu-row">
				<span className="sh-phone-menu-label">Agents</span>
				<button
					type="button"
					className={railOpen ? "dk-tap dk-tap-on" : "dk-tap"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
					aria-label={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={20} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
			</div>
			{onOpenSettings && (
				<div className="sh-phone-menu-row">
					<span className="sh-phone-menu-label">Settings</span>
					<button type="button" className="dk-tap" onClick={onOpenSettings} title="settings" aria-label="settings" data-tour="settings">
						<Settings size={20} />
					</button>
				</div>
			)}
		</>
	);

	const brand = (
		<span className="sh-brand" aria-label="omp console">
			<OmpMark />
			<span className="sh-brand-slash">/</span>
		</span>
	);
	const statusSegments = (
		<div className="sh-deck-status" role="group" aria-label="session status segments">
			{STATUS_SEGMENTS.map(segment => {
				const value = statusValues[segment];
				if (!selectedSegments.includes(segment) || value === null) return null;
				const label = STATUS_SEGMENT_LABELS[segment];
				return (
					<span key={segment} className="sh-chip sh-status-segment" data-status-segment={segment} title={`${label}: ${value}`}>
						<span className="sh-status-segment-label">{label}</span>
						<span>{value}</span>
					</span>
				);
			})}
			<details className="sh-segment-chooser">
				<summary title="choose status bar segments" aria-label="choose status bar segments">
					<ListFilter size={13} aria-hidden />
				</summary>
				<div className="sh-segment-chooser-menu" role="group" aria-label="status bar segments">
					<strong>Show in header</strong>
					{STATUS_SEGMENTS.map(segment => (
						<label key={segment}>
							<input type="checkbox" checked={selectedSegments.includes(segment)} onChange={event => toggleStatusSegment(segment, event.currentTarget.checked)} />
							{STATUS_SEGMENT_LABELS[segment]}
						</label>
					))}
				</div>
			</details>
		</div>
	);
	const modelReadouts = (
		<>
			{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
			{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
		</>
	);
	const modelControls =
		controls && !readOnly ? (
			<SessionControls
				api={controls.api}
				sessionId={controls.sessionId}
				agentId={controls.agentId}
				state={state}
				phone={false}
			/>
		) : null;
	const sessionModeControl =
		controls && !readOnly ? (
			<SessionOpsMenu
				key={controls.sessionId}
				api={controls.api}
				sessionId={controls.sessionId}
				planModeEnabled={controls.planModeEnabled}
				hostApprovalMode={controls.approvalMode}
				loopMode={controls.loopMode}
				vibeMode={controls.vibeMode}
				focused={controls.focused}
				onSetPlanMode={controls.onSetPlanMode}
			/>
		) : null;
	const passiveReadouts = (
		<>
			{readOnly && <span className="sh-chip" title="you joined with a read-only link — watching only">read-only</span>}
			{(!controls || readOnly) && modelReadouts}
			{currentSummary?.liveMode?.active && (
				<span className="sh-chip dk-live-chip" title={`Live voice · ${currentSummary.liveMode.phase}`}>
					<Mic size={11} aria-hidden="true" />
					<span className="dk-chip-label">Live</span>
				</span>
			)}
			{goal?.active && (
				<span className="sh-chip dk-goal" title={goal.title ? `goal: ${goal.title}` : "goal active"}>
					<Target size={11} />
					<span className="dk-chip-label">goal</span>
				</span>
			)}
			{healthStatus && (
				<span className={`sh-chip dk-health dk-health-${healthStatus.level}`} title={healthStatus.title}>
					<span className="dk-health-dot" />
					<span className="dk-chip-label">{healthStatus.label}</span>
				</span>
			)}
			{pct != null && (
				<span className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"} title={`context ${fmtPercent(pct)}`} aria-label={`context ${fmtPercent(pct)}`}>
					<span className="sh-gauge-track">
						<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
					</span>
					<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
				</span>
			)}
			{state && state.participants.length > 0 && (
				<span className="sh-avatars">
					{state.participants.map((participant, index) => (
						<span
							key={`${participant.name}:${index}`}
							className={participant.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
							title={`${participant.name} · ${participant.role}${participant.readOnly ? " · view-only" : ""}`}
						>
							{(participant.name[0] ?? "?").toUpperCase()}
						</span>
					))}
				</span>
			)}
			{statusSegments}
			{controls && !readOnly && (
				<>
					<QuotaHeaderChip api={controls.api} provider={state?.model?.provider} />
					<ExtensionStatus api={controls.api} sessionId={controls.sessionId} />
				</>
			)}
		</>
	);
	const secondaryActions = (
		<>
			{controls && !readOnly && (
				<button
					type="button"
					className="dk-tap"
					onClick={() => {
						recordUsage({ feature: "2.5.spawn", action: "open-header", outcome: "ok", via: "direct", screen: "header", sessionId: controls.sessionId });
						openSpawnPanel();
					}}
					title="new agent"
					aria-label="new agent"
				>
					<Plus size={15} />
				</button>
			)}
			{currentSummary && !readOnly && onTogglePause && (
				<button type="button" className="dk-tap" onClick={onTogglePause} title={currentSummary?.paused ? "resume session" : "pause session"} aria-label={currentSummary?.paused ? "resume session" : "pause session"}>
					{currentSummary?.paused ? <Play size={15} /> : <Pause size={15} />}
				</button>
			)}
			{onOpenStatus && (
				<button type="button" className="dk-tap dk-status-btn" onClick={onOpenStatus} aria-label={`status: goal, todos, health (${healthLevel})`} title="status">
					<Activity size={15} />
				</button>
			)}
			<button
				type="button"
				className={railOpen ? "dk-tap dk-tap-on" : "dk-tap"}
				onClick={onToggleRail}
				title={railOpen ? "hide agents" : "show agents"}
				aria-label={railOpen ? "hide agents" : "show agents"}
			>
				<PanelRight size={15} />
				{subCount > 0 && <span className="sh-badge">{subCount}</span>}
			</button>
			{onOpenSettings && (
				<button type="button" className="dk-tap" onClick={onOpenSettings} title="settings" aria-label="settings" data-tour="settings">
					<Settings size={15} />
				</button>
			)}
		</>
	);
	const overflowLevel = moveSessionControls ? "controls" : moveActions ? "actions" : moveReadouts ? "readouts" : "wide";

	return (
		<header
			ref={phone ? undefined : headerRef}
			className="sh-header"
			data-mode={mode}
			data-overflow-level={phone ? undefined : overflowLevel}
		>
			<div className="sh-header-left">
				{phone ? (
					<div className="dk-session-btn" role="group" aria-label={`session: ${title}${attention ? `; ${attention.label}` : ""}`}>
						<span className={`sh-dot sh-dot-${connection.phase}`} title={`connection: ${connection.label}`} />
						{editingTitle ? titleForm : canRenameTitle ? (
							<button type="button" className="dk-session-btn-title dk-header-title-trigger" aria-label="Rename session title" onClick={beginTitleEdit}>
								<span>{title}</span>
								<FilePenLine className="dk-header-title-pencil" size={13} aria-hidden="true" />
							</button>
						) : <span className="dk-session-btn-title">{title}</span>}
						{attention && <span className="dk-session-btn-attention" title={attention.title}>{attention.label}</span>}
						{currentSummary?.paused && <span className="sh-chip sh-paused-chip" title={pauseLabel}>{pauseLabel}</span>}
						{overnight && (
							<button
								type="button"
								className="sh-chip dk-overnight-chip"
								title={`Overnight run ${overnightLabel} · deadline ${overnightDeadline}`}
								aria-label={`Overnight run ${overnightLabel}, deadline ${overnightDeadline}`}
								onClick={() => openPanel({ panel: "overnight" })}
							>
								<Moon size={12} aria-hidden="true" />
								<span>{overnightLabel} · until {overnightDeadline}</span>
							</button>
						)}
						{onOpenSessions && (
							<button type="button" className="dk-session-open" onClick={onOpenSessions} title="Sessions" aria-label="Open sessions">
								<ListFilter size={16} aria-hidden="true" />
							</button>
						)}
					</div>
				) : (
					<>
						{onToggleSidebar && (
							<button
								type="button"
								className="sh-btn sh-btn-icon dk-sidebar-toggle"
								onClick={onToggleSidebar}
								title="sessions"
								aria-label="toggle session list"
							>
								<PanelLeft size={14} />
							</button>
						)}
						{!moveReadouts && brand}
						{!moveReadouts && workspaceSlot}
						{editingTitle ? titleForm : canRenameTitle ? (
							<button type="button" className="sh-title dk-header-title-trigger" title="Rename session title" aria-label="Rename session title" onClick={beginTitleEdit}>
								<span>{title}</span>
								<FilePenLine className="dk-header-title-pencil" size={12} aria-hidden="true" />
							</button>
						) : <span className="sh-title" title={title}>{title}</span>}
						{!moveReadouts && state?.cwd && <span className="sh-cwd" title={state.cwd}>{shortenPath(state.cwd)}</span>}
					</>
				)}
			</div>
			<div className="sh-header-right">
				{!phone ? (
					<>
						<span className={`sh-status sh-status-${connection.phase}${moveSessionControls ? " sh-status-compact" : ""}`} title={`connection: ${connection.label}`}>
							<span className={`sh-dot sh-dot-${connection.phase}`} />
							<span className="sh-status-label">{connection.label}</span>
						</span>
						{currentSummary?.paused && (
							<span className="sh-chip sh-paused-chip" title={pauseLabel}>
								<Pause size={12} aria-hidden="true" />
								{pauseLabel}
							</span>
						)}
						{overnight && (
							<button
								type="button"
								className="sh-chip dk-overnight-chip"
								title={`Overnight run ${overnightLabel} · deadline ${overnightDeadline}`}
								aria-label={`Overnight run ${overnightLabel}, deadline ${overnightDeadline}`}
								onClick={() => openPanel({ panel: "overnight" })}
							>
								<Moon size={12} aria-hidden="true" />
								<span>{overnightLabel} · until {overnightDeadline}</span>
							</button>
						)}
						{!moveReadouts && passiveReadouts}
						{!moveSessionControls && modelControls}
						{!moveSessionControls && sessionModeControl}
						{!moveActions && secondaryActions}
						<button type="button" className="dk-tap" onClick={onLeave} title="leave session" aria-label="leave session">
							<LogOut size={15} />
						</button>
						{moveReadouts && (
						<details className="sh-header-overflow" ref={overflowRef} onToggle={event => setOverflowOpen(event.currentTarget.open)}>
							<summary className="dk-tap" title="more session controls" aria-label="more session controls">
								<MoreHorizontal size={18} />
							</summary>
							{viewportLayer(
								<div
									ref={overflowMenuRef}
									className="sh-header-overflow-menu sh-header-overflow-layer"
									popover="manual"
									data-open={overflowOpen ? "true" : "false"}
								style={overflowAnchor ? ({ top: overflowAnchor.top, right: overflowAnchor.right, "--sh-overflow-top": `${overflowAnchor.top}px` } as CSSProperties) : undefined}
								role="group"
								aria-label="More session controls"
								onClick={event => {
									// Clicks inside a portaled popover (session-ops, model picker) bubble here through React but belong
									// to that popover: closing the overflow would strand it without its trigger.
									if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
									const target = event.target instanceof Element ? event.target : null;
									if (target?.closest("button") && !target.closest(".so-header-controls, .sc-chip")) {
										overflowRef.current?.removeAttribute("open");
									}
								}}
							>
								{moveReadouts && (
									<section className="sh-overflow-section" aria-label="Session details">
										<h3>Session details</h3>
										<div className="sh-overflow-row">
											<span>omp console</span>
											<div className="sh-overflow-row-content">{brand}</div>
										</div>
										{workspaceSlot && (
											<div className="sh-overflow-row sh-overflow-workspace">
												<span>Workspace</span>
												<div className="sh-overflow-row-content">{workspaceSlot}</div>
											</div>
										)}
										{state?.cwd && (
											<div className="sh-overflow-row">
												<span>Directory</span>
												<span className="sh-overflow-row-content sh-cwd" title={state.cwd}>{shortenPath(state.cwd)}</span>
											</div>
										)}
										<div className="sh-overflow-readouts">{passiveReadouts}</div>
									</section>
								)}
								{moveActions && (
									<section className="sh-overflow-section" aria-label="Session actions">
										<h3>Session actions</h3>
										<div className="sh-overflow-actions">{secondaryActions}</div>
									</section>
								)}
								{moveSessionControls && (
									<section className="sh-overflow-section" aria-label="Model and session controls">
										<h3>Model and session controls</h3>
										{modelControls && <div className="sh-overflow-row sh-overflow-model">{modelControls}</div>}
										{sessionModeControl && <div className="sh-overflow-row sh-overflow-session-mode">{sessionModeControl}</div>}
									</section>
								)}
							</div>,
							)}
						</details>
						)}
					</>
				) : compactPhone ? (
					<>
						<details className="sh-phone-overflow" ref={overflowRef}>
							<summary className="dk-tap" title="more session actions" aria-label="more session actions">
								<MoreHorizontal size={20} />
							</summary>
							<div
								className="sh-phone-overflow-menu"
								role="group"
								aria-label="session actions"
								onClick={event => {
									const target = event.target instanceof Element ? event.target : null;
									if (target?.closest("button") && !target.closest(".so-header-controls")) overflowRef.current?.removeAttribute("open");
								}}
							>
								{phoneActions}
							</div>
						</details>
						<button type="button" className="dk-tap" onClick={onLeave} title="leave session" aria-label="leave session">
							<LogOut size={20} />
						</button>
					</>
				) : (
					<>
						<div className="sh-phone-inline-actions" role="group" aria-label="session actions">
							{phoneActions}
						</div>
						<button type="button" className="dk-tap" onClick={onLeave} title="leave session" aria-label="leave session">
							<LogOut size={20} />
						</button>
					</>
				)}
			</div>
		</header>
	);
});
