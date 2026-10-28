import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActionFeedbackMark, ActionFeedbackMessage } from "../shell/ActionFeedback";
import { InlineUiRequest, type UiRequestTarget } from "../shell/InlineUiRequest";
import type { DaemonHealth, SessionSummary } from "@omp-console/protocol";
import {
	Moon,
	BookmarkPlus,
	ChevronDown,
	Archive,
	ChevronRight,
	CircleHelp,
	FilePenLine,
	GitFork,
	MoreHorizontal,
	Power,
	Square,
	Pin,
	Target,
	TriangleAlert,
	Undo2,
	Users,
} from "lucide-react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useActionFeedback } from "../../lib/action-feedback";
import type { SessionCardGrouping, SessionCardView } from "../../lib/cards";
import { groupSessionCards, hiddenCardsInGroup, visibleCardsInGroup } from "../../lib/cards";
import { motionLevel, resolveSessionRowSwipe, type SwipeResolution } from "../../lib/motion";
import { relTime } from "../../lib/format";
import { workerFor } from "../../lib/health";
import { machineIdForSessionKey } from "../../lib/machines";
import { openPanel } from "../../lib/palette";
import { overnightPhaseLabel } from "../../lib/overnight";
import { MachineChip } from "../machines/MachineChip";
const ROW_EXIT_MS = 200;
const ROW_ENTER_MS = 240;
const ROW_ACTION_RAIL_PX = 104;
const ROW_SWIPE_AXIS_PX = 8;

interface RowSwipe {
	pointerId: number;
	startX: number;
	startY: number;
	lastX: number;
	lastAt: number;
	startDistance: number;
	width: number;
	velocity: number;
	captured: boolean;
}

type CardAction = "resume" | "fork" | "end" | "stop-turn" | "rename" | "undo" | "archive" | "pin";
const ACTION_FEEDBACK_LABELS: Record<CardAction, { pending: string; success: string }> = {
	resume: { pending: "Opening copy…", success: "Copy opened" },
	fork: { pending: "Forking…", success: "Forked" },
	end: { pending: "Ending…", success: "Ended" },
	"stop-turn": { pending: "Stopping turn…", success: "Turn stopped" },
	rename: { pending: "Saving…", success: "Saved" },
	undo: { pending: "Restoring title…", success: "Title restored" },
	archive: { pending: "Archiving…", success: "Archived" },
	pin: { pending: "Updating pin…", success: "Updated" },
};
type MaybePromise<T> = T | Promise<T>;

export interface SessionCardListProps {
	cards: readonly SessionCardView[];
	topics: readonly string[];
	health: DaemonHealth | null;
	selectedId: string | null;
	busy: boolean;
	onSelect(id: string, newPane?: boolean): void;
	actionError?: string | null;
	onResume(session: SessionSummary, newPane?: boolean): MaybePromise<void>;
	onFork(session: SessionSummary): MaybePromise<void>;
	onReadOnlyTranscript?(session: SessionSummary): void;
	onStop(id: string): MaybePromise<void>;
	onStopTurn?(id: string): MaybePromise<void>;
	onRename(sessionId: string, title: string): Promise<void>;
	canRename?: boolean;
	onUndoRename(sessionId: string): Promise<void>;
	onArchive(item: SessionCardView, stopIfLive: boolean): MaybePromise<void>;
	onArchiveAll(sessionIds: string[]): void;
	/** Machines that do not answer now: their last known live sessions show as Offline, not Live or Idle. */
	offlineMachines?: ReadonlySet<string>;
	overnightEnabled?: boolean;
	emptyContent?: ReactNode;
	touch?: boolean;
	uiTargetForSession?(sessionId: string): UiRequestTarget | null;
	refreshKey?: unknown;
	onTogglePin?(sessionId: string, pinned: boolean): Promise<void>;
	onSaveRecipe?(sessionId: string): void;
}

export function SessionCardList(props: SessionCardListProps): ReactNode {
	const [grouping, setGrouping] = useState<SessionCardGrouping>("status");
	const [scheduledOpen, setScheduledOpen] = useState(false);
	const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
	// Preview groups (Waiting on you, Unfinished, Done, topics) start open and can fold away entirely; remembered across reloads.
	const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(readCollapsedGroups);
	const [leavingCards, setLeavingCards] = useState<ReadonlyMap<string, SessionCardView>>(new Map());
	const [enteringCards, setEnteringCards] = useState<ReadonlySet<string>>(new Set());
	const [activeRowId, setActiveRowId] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	// "Live" means a running agent process on a machine that answers; offline machines' sessions and asleep sessions
	// (no process until opened) are not counted.
	const isRunning = (item: SessionCardView): boolean =>
		item.live &&
		item.summary?.state !== "asleep" &&
		props.offlineMachines?.has(machineIdForSessionKey(item.card.sessionId) ?? "") !== true;
	const [liveOnly, setLiveOnly] = useState(readLiveOnly);
	const liveByMachine = useMemo(() => {
		const counts = new Map<string | null, number>();
		for (const item of props.cards) {
			if (!isRunning(item)) continue;
			const machine = machineIdForSessionKey(item.card.sessionId);
			counts.set(machine, (counts.get(machine) ?? 0) + 1);
		}
		return counts;
	}, [props.cards, props.offlineMachines]);
	const liveCount = [...liveByMachine.values()].reduce((sum, count) => sum + count, 0);
	const shownCards = useMemo(() => (liveOnly ? props.cards.filter(isRunning) : props.cards), [liveOnly, props.cards, props.offlineMachines]);
	const previousCards = useRef(shownCards);
	const previousPositions = useRef(new Map<string, number>());
	const cardsWithLeaving = useMemo(() => {
		const activeIds = new Set(shownCards.map(item => item.card.sessionId));
		const leaving = [...leavingCards].filter(([id]) => !activeIds.has(id)).map(([, item]) => item);
		if (leaving.length === 0) return shownCards;
		// A leaving row keeps its place (the cards' own order) so it collapses where it was, not past the "more" cut.
		return [...shownCards, ...leaving].sort(
			(a, b) => b.card.lastActivityAt - a.card.lastActivityAt || a.card.sessionId.localeCompare(b.card.sessionId),
		);
	}, [shownCards, leavingCards]);
	const groups = useMemo(() => groupSessionCards(cardsWithLeaving, props.topics, grouping), [cardsWithLeaving, props.topics, grouping]);
	const visibleRowIds = useMemo(() => groups.flatMap(group => {
		const folded = !group.collapsible && collapsedGroups.has(group.key);
		return folded ? [] : visibleCardsInGroup(group, expandedGroups.has(group.key), scheduledOpen).map(item => item.card.sessionId);
	}), [groups, expandedGroups, collapsedGroups, scheduledOpen]);
	// The tab stop must land on a row that can open (a saved row without a file is disabled).
	const openableRowIds = useMemo(() => {
		const openable = new Set(cardsWithLeaving.filter(item =>
			item.live ||
			(Boolean(item.summary?.sessionFile) && (item.summary?.cwdExists !== false || props.onReadOnlyTranscript !== undefined)),
		).map(item => item.card.sessionId));
		return visibleRowIds.filter(id => openable.has(id));
	}, [visibleRowIds, cardsWithLeaving, props.onReadOnlyTranscript]);
	const preferredRowId =
		props.selectedId !== null && visibleRowIds.includes(props.selectedId) ? props.selectedId : openableRowIds[0] ?? null;
	const activeFocusId = activeRowId !== null && visibleRowIds.includes(activeRowId) ? activeRowId : preferredRowId;

	useLayoutEffect(() => {
		const activeIds = new Set(shownCards.map(item => item.card.sessionId));
		const previousIds = new Set(previousCards.current.map(item => item.card.sessionId));
		const added = shownCards.filter(item => !previousIds.has(item.card.sessionId));
		const removed = previousCards.current.filter(item => !activeIds.has(item.card.sessionId));
		previousCards.current = shownCards;
		setEnteringCards(current => {
			const next = new Set([...current].filter(id => activeIds.has(id)));
			for (const item of added) next.add(item.card.sessionId);
			return next.size === current.size && [...next].every(id => current.has(id)) ? current : next;
		});
		setLeavingCards(current => {
			let changed = false;
			const next = new Map(current);
			for (const id of activeIds) changed = next.delete(id) || changed;
			for (const item of removed) {
				if (next.has(item.card.sessionId)) continue;
				next.set(item.card.sessionId, item);
				changed = true;
			}
			return changed ? next : current;
		});
	}, [shownCards]);

	useEffect(() => {
		if (enteringCards.size === 0) return;
		const timer = window.setTimeout(
			() => setEnteringCards(new Set()),
			motionLevel() === "off" ? 0 : ROW_ENTER_MS,
		);
		return () => window.clearTimeout(timer);
	}, [enteringCards]);

	useEffect(() => {
		if (leavingCards.size === 0) return;
		const timer = window.setTimeout(
			() => setLeavingCards(new Map()),
			motionLevel() === "off" ? 0 : ROW_EXIT_MS,
		);
		return () => window.clearTimeout(timer);
	}, [leavingCards]);

	useLayoutEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const nextPositions = new Map<string, number>();
		const moves: Array<{ row: HTMLElement; offset: number }> = [];
		if (motionLevel() !== "off") {
			for (const row of list.querySelectorAll<HTMLElement>(".dk-card-row[data-session-id]")) {
				const id = row.dataset.sessionId;
				if (!id) continue;
				const top = row.getBoundingClientRect().top;
				const previousTop = previousPositions.current.get(id);
				if (previousTop !== undefined && Math.abs(previousTop - top) > 1) {
					moves.push({ row, offset: previousTop - top });
				}
				nextPositions.set(id, top);
			}
			for (const { row, offset } of moves) {
				row.style.setProperty("--flip-y", `${offset}px`);
				row.dataset.flipping = "true";
			}
		}
		previousPositions.current = nextPositions;
	}, [groups]);

	const toggleGroup = (key: string): void => {
		setExpandedGroups(current => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const toggleCollapsed = (key: string): void => {
		setCollapsedGroups(current => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			writeCollapsedGroups(next);
			return next;
		});
	};

	return (
		<div ref={listRef} className="dk-card-list">
			<div className="dk-card-list-tools">
				<button
					type="button"
					className="dk-live-filter"
					aria-pressed={liveOnly}
					title={liveSummary(liveByMachine, liveOnly)}
					onClick={() => setLiveOnly(value => {
						writeLiveOnly(!value);
						return !value;
					})}
				>
					<span className="dk-state dk-state-idle" aria-hidden="true" />
					{liveCount} live
				</button>
				<label className="dk-group-control">
					<span className="dk-visually-hidden">Group sessions</span>
					<select
						className="dk-group-toggle"
						aria-label="Group sessions"
						value={grouping}
						onChange={event => setGrouping(event.currentTarget.value as SessionCardGrouping)}
					>
						<option value="status">Group by status</option>
						<option value="folder">Group by project folder</option>
						<option value="topic">Group by topic</option>
					</select>
				</label>
			</div>
			{groups.length === 0 ? <div className="dk-empty">{props.emptyContent ?? (liveOnly ? "No live sessions." : "No sessions yet. Start one with + or pick a project folder.")}</div> : groups.map(group => {
				const expanded = expandedGroups.has(group.key);
				const folded = !group.collapsible && collapsedGroups.has(group.key);
				const sectionExpanded = group.scheduled ? scheduledOpen : expanded;
				const visible = folded ? [] : visibleCardsInGroup(group, expanded, scheduledOpen);
				const hidden = hiddenCardsInGroup(group);
				return (
					<section className="dk-card-group" key={group.key}>
						{group.collapsible ? (
							<button
								type="button"
								className="dk-section dk-section-button"
								aria-expanded={sectionExpanded}
								onClick={() => group.scheduled ? setScheduledOpen(open => !open) : toggleGroup(group.key)}
							>
								<span>{sectionExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{group.label}</span>
								<span className="dk-section-count">{group.cards.length}</span>
							</button>
						) : (
							<button type="button" className="dk-section dk-section-button" aria-expanded={!folded} onClick={() => toggleCollapsed(group.key)}>
								<span>{folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}{group.label}</span>
								<span className="dk-section-count">{group.cards.length}</span>
							</button>
						)}
						{group.key === "older" && group.cards.length > 0 && (
							<button
								type="button"
								className="dk-archive-all"
								disabled={props.busy}
								onClick={() => {
									if (typeof window !== "undefined" && !window.confirm(`Archive all ${group.cards.length} older sessions? Working sessions will be stopped.`)) return;
									props.onArchiveAll(group.cards.map(item => item.card.sessionId));
								}}
							>
								Archive all
							</button>
						)}
						{visible.length > 0 && (
							<ul className="dk-list">
								{visible.map(item => (
									<CardRow
										key={item.card.sessionId}
										item={item}
										selected={item.card.sessionId === props.selectedId}
										busy={props.busy}
										actionError={props.actionError ?? null}
										leaving={leavingCards.has(item.card.sessionId)}
										entering={enteringCards.has(item.card.sessionId)}
										tabStop={activeFocusId === item.card.sessionId}
										onFocusRow={setActiveRowId}
										stalled={workerFor(props.health, item.card.sessionId)?.stalled === true}
										overnightEnabled={props.overnightEnabled === true}
										offline={item.live && props.offlineMachines?.has(machineIdForSessionKey(item.card.sessionId) ?? "") === true}
										onSelect={props.onSelect}
										onReadOnlyTranscript={props.onReadOnlyTranscript}
										onResume={props.onResume}
										onFork={props.onFork}
										onStop={props.onStop}
										onStopTurn={props.onStopTurn}
										onRename={props.onRename}
										canRename={props.canRename === true}
										onUndoRename={props.onUndoRename}
										onArchive={props.onArchive}
										touch={props.touch === true}
										uiTarget={props.touch ? props.uiTargetForSession?.(item.card.sessionId) ?? null : null}
										refreshKey={props.refreshKey}
										onTogglePin={props.onTogglePin}
										onSaveRecipe={props.onSaveRecipe}
									/>
								))}
							</ul>
						)}
						{!group.collapsible && !folded && hidden > 0 && (
							<button type="button" className="dk-card-more" onClick={() => toggleGroup(group.key)}>
								{expanded ? "Show fewer" : `${hidden} more`}
							</button>
						)}
					</section>
				);
			})}
		</div>
	);
}

const COLLAPSED_GROUPS_KEY = "omp-console.sidebar.collapsedGroups";

const LIVE_ONLY_KEY = "omp-console-sidebar-live-only";

function readLiveOnly(): boolean {
	try {
		return window.localStorage.getItem(LIVE_ONLY_KEY) === "1";
	} catch {
		return false;
	}
}

function writeLiveOnly(value: boolean): void {
	try {
		if (value) window.localStorage.setItem(LIVE_ONLY_KEY, "1");
		else window.localStorage.removeItem(LIVE_ONLY_KEY);
	} catch {}
}

/** "Live: 8 here, 2 on VPS. Show only live sessions." Local sessions carry no machine id. */
export function liveSummary(byMachine: ReadonlyMap<string | null, number>, liveOnly: boolean): string {
	const parts = [...byMachine].map(([machine, count]) => (machine === null ? `${count} here` : `${count} on ${machineDisplayName(machine)}`));
	const counts = parts.length === 0 ? "none" : parts.join(", ");
	const action = liveOnly ? "Click to show all sessions." : "Click to show only live sessions.";
	return `Live sessions are running agents you can type to now: ${counts}. Each uses one of its machine's worker slots. ${action}`;
}

function readCollapsedGroups(): ReadonlySet<string> {
	try {
		const raw = globalThis.localStorage?.getItem(COLLAPSED_GROUPS_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
	} catch {
		return new Set();
	}
}

function writeCollapsedGroups(keys: ReadonlySet<string>): void {
	try {
		globalThis.localStorage?.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...keys]));
	} catch {
		// Storage full or blocked: the fold still applies for this page.
	}
}

/** "4m", "1h 5m" for a turn running at least a minute; nothing shorter, so quick turns do not flicker a counter. */
export function turnElapsed(startedAt: number | undefined, now: number = Date.now()): string | null {
	if (startedAt === undefined) return null;
	const minutes = Math.floor((now - startedAt) / 60_000);
	if (minutes < 1) return null;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}
function overnightDeadlineLabel(deadline: string): string {
	const date = new Date(deadline);
	if (Number.isNaN(date.getTime())) return deadline;
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function statusLabel(item: SessionCardView, offline = false): string {
	if (offline) return "Offline";
	const summary = item.summary;
	if (summary?.paused) {
		const elapsed = turnElapsed(summary.pausedAt);
		return elapsed ? `Paused ${elapsed}` : "Paused";
	}
	if (summary?.state === "waking") return "Waking…";
	if (summary?.state === "asleep") return "Asleep";
	if (!item.live) return summary?.source === "terminal" ? "From terminal" : "Saved";
	if (!summary) {
		if (item.status === "waiting") return "Waiting";
		if (item.status === "done") return "Done";
		return "Unfinished";
	}
	const elapsed = turnElapsed(summary.turnStartedAt);
	if (summary.awaitingAnswer || summary.state === "asking") return elapsed ? `Waiting ${elapsed}` : "Waiting";
	if (summary.state === "streaming") return elapsed ? `Working ${elapsed}` : "Working";
	if (summary.state === "crashed") return "Crashed";
	if (item.status === "done") return "Done";
	if (summary.state === "starting") return "Starting";
	if (summary.state === "stopped") return "Stopped";
	return "Idle";
}

function statusClass(item: SessionCardView): string {
	if (item.summary?.paused) return "dk-state dk-state-paused";
	if (item.summary?.state === "asleep") return "dk-state dk-state-asleep";
	if (item.summary?.state === "waking") return "dk-state dk-state-starting";
	if (!item.live && item.summary?.state === "stopped") return "dk-state dk-state-stopped";
	return `dk-card-dot dk-card-dot-${item.status}`;
}

function statusTone(item: SessionCardView, offline: boolean): string {
	if (offline) return "offline";
	if (item.summary?.paused) return "paused";
	if (item.status === "waiting") return "waiting";
	if (item.live && item.summary?.state === "streaming") return "working";
	if (item.summary?.state === "crashed") return "error";
	if (item.status === "done") return "done";
	return "quiet";
}


/** The usual peers by name (a VPS-hosted page lists the Mac as `mac`); any other id upper-cased. */
function machineDisplayName(id: string): string {
	return id === "mac" ? "Mac" : id.toUpperCase();
}

interface CardRowProps {
	item: SessionCardView;
	selected: boolean;
	busy: boolean;
	actionError: string | null;
	leaving: boolean;
	entering: boolean;
	tabStop: boolean;
	onFocusRow(id: string): void;
	stalled: boolean;
	offline: boolean;
	overnightEnabled: boolean;
	onSelect(id: string, newPane?: boolean): void;
	onResume(session: SessionSummary, newPane?: boolean): MaybePromise<void>;
	onFork(session: SessionSummary): MaybePromise<void>;
	onReadOnlyTranscript?(session: SessionSummary): void;
	onStop(id: string): MaybePromise<void>;
	onStopTurn?(id: string): MaybePromise<void>;
	onRename(sessionId: string, title: string): Promise<void>;
	canRename: boolean;
	onUndoRename(sessionId: string): Promise<void>;
	onArchive(item: SessionCardView, stopIfLive: boolean): MaybePromise<void>;
	onTogglePin?(sessionId: string, pinned: boolean): Promise<void>;
	onSaveRecipe?(sessionId: string): void;
	touch: boolean;
	uiTarget: UiRequestTarget | null;
	refreshKey?: unknown;
}

function CardRow({
	item,
	selected,
	busy,
	actionError,
	leaving,
	entering,
	tabStop,
	onFocusRow,
	stalled,
	offline,
	overnightEnabled,
	onSelect,
	onReadOnlyTranscript,
	onResume,
	onFork,
	onStop,
	onStopTurn,
	onRename,
	canRename,
	onUndoRename,
	onArchive,
	onTogglePin,
	onSaveRecipe,
	touch,
	uiTarget,
	refreshKey,
}: CardRowProps): ReactNode {
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [draft, setDraft] = useState(item.card.title);
	const [feedbackTarget, setFeedbackTarget] = useState<CardAction | null>(null);
	const [swipeOffset, setSwipeOffset] = useState(0);
	const [swiping, setSwiping] = useState(false);
	const actionFeedback = useActionFeedback();
	const rowRef = useRef<HTMLLIElement | null>(null);
	// The action menu opens upward when there is no room below the row.
	const [menuFlip, setMenuFlip] = useState(false);
	useLayoutEffect(() => {
		if (!menuOpen) return;
		const row = rowRef.current;
		const menu = menuRef.current;
		if (!row || typeof window === "undefined") return;
		// The menu sits 36 px below the row's top; flip only when it would overflow below and fits better above.
		const height = menu?.offsetHeight ?? 220;
		const rect = row.getBoundingClientRect();
		const below = window.innerHeight - (rect.top + 36);
		const above = rect.bottom - 36;
		setMenuFlip(height > below && above > below);
	}, [menuOpen]);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const swipeRef = useRef<RowSwipe | null>(null);
	const suppressClick = useRef(false);
	const longPressTimer = useRef<number | null>(null);
	const titleClickTimer = useRef<number | null>(null);
	const renamePending = useRef(false);
	const cancelingRename = useRef(false);
	const globalAction = useRef<{ target: CardAction; sawBusy: boolean; initialError: string | null } | null>(null);
	const session = item.summary;
	const title = item.card.title;
	const machineId = machineIdForSessionKey(item.card.sessionId);
	const state = session?.state;
	const stoppedAt = item.card.stoppedAt?.trim();
	const nextStep = item.card.nextStep?.trim();
	const details = [session?.pendingQuestion?.trim(), stoppedAt, nextStep && `Next: ${nextStep}`].filter(Boolean).join(" · ");
	const openable = item.live || (Boolean(session?.sessionFile) && (session?.cwdExists !== false || onReadOnlyTranscript !== undefined));
	const openTitle = !openable
		? "Session details are not available to resume"
		: session?.cwdExists === false
			? "This project folder no longer exists. Opens a saved transcript read-only."
			: session?.source === "terminal"
				? "Opens a copy; the terminal session is unchanged."
				: session?.model ? `Model: ${session.model}` : "Open session";
	const saving = actionFeedback.state === "pending";
	const attention = item.status === "waiting" || session?.awaitingAnswer === true || state === "asking";
	const feedbackFor = (target: CardAction): "idle" | "pending" | "success" | "failure" =>
		feedbackTarget === target ? actionFeedback.state : "idle";


	useEffect(() => {
		const pending = globalAction.current;
		if (!pending) return;
		if (busy) {
			pending.sawBusy = true;
			// An error cleared at the start of this action means any error afterwards is this attempt's.
			if (actionError === null) pending.initialError = null;
			return;
		}
		if (!pending.sawBusy) return;
		globalAction.current = null;
		if (actionError !== null && actionError !== pending.initialError) actionFeedback.fail(new Error(actionError));
		else actionFeedback.succeed();
	}, [busy, actionError, actionFeedback.state]);
	useEffect(() => () => {
		if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
		if (titleClickTimer.current !== null) window.clearTimeout(titleClickTimer.current);
	}, []);

	useEffect(() => {
		if (!menuOpen) {
			setConfirming(false);
			return;
		}
		menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest(".dk-card-menu, .dk-card-menu-trigger")) return;
			setMenuOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			setMenuOpen(false);
			rowRef.current?.querySelector<HTMLButtonElement>(".dk-card-menu-trigger")?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen]);


	const runAction = (target: CardAction, action: () => MaybePromise<void>): void => {
		if (busy || leaving || !actionFeedback.begin()) return;
		setFeedbackTarget(target);
		try {
			const result = action();
			if (result instanceof Promise) {
				void result.then(
					() => actionFeedback.succeed(),
					error => actionFeedback.fail(error),
				);
			} else {
				globalAction.current = { target, sawBusy: false, initialError: actionError };
			}
		} catch (error) {
			actionFeedback.fail(error);
		}
	};

	const runImmediateAction = (target: CardAction, action: () => MaybePromise<void>): void => {
		if (busy || leaving || !actionFeedback.begin()) return;
		setFeedbackTarget(target);
		void Promise.resolve().then(action).then(
			() => actionFeedback.succeed(),
			error => actionFeedback.fail(error),
		);
	};

	const runObservedAction = (target: CardAction, action: () => MaybePromise<void>): void => {
		setFeedbackTarget(target);
		void actionFeedback.run(action).catch(() => {});
	};

	const open = (newPane: boolean): void => {
		if (!session || busy || saving || leaving || !openable) return;
		setMenuOpen(false);
		if (item.live) onSelect(session.id, newPane);
		else if (session.cwdExists === false) onReadOnlyTranscript?.(session);
		else runAction("resume", () => onResume(session, newPane));
	};

	const startEditing = (): void => {
		if (!canRename || busy || saving || leaving) return;
		if (titleClickTimer.current !== null) window.clearTimeout(titleClickTimer.current);
		titleClickTimer.current = null;
		setMenuOpen(false);
		// A previous Escape/save may have left this set without a blur (WebKit fires none when the input unmounts).
		cancelingRename.current = false;
		setDraft(title);
		setEditing(true);
	};

	const saveRename = async (): Promise<void> => {
		if (renamePending.current || saving || busy || leaving) return;
		// An unchanged title is not a rename: saving it would turn the generated title into a "user" one.
		if (draft.trim() === title.trim()) {
			cancelingRename.current = true;
			setEditing(false);
			return;
		}
		renamePending.current = true;
		setFeedbackTarget("rename");
		try {
			await actionFeedback.run(() => onRename(item.card.sessionId, draft.trim()));
			cancelingRename.current = true;
			setEditing(false);
		} catch {
			// The sidebar reports the failed request and restores the previous title.
		} finally {
			renamePending.current = false;
		}
	};

	const submitRename = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		void saveRename();
	};
	const onOpenClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
		const titleClick = event.target instanceof Element && event.target.closest(".dk-card-title-text") !== null;
		if (canRename && titleClick && event.detail >= 2 && !event.metaKey && !event.ctrlKey) {
			event.preventDefault();
			startEditing();
			return;
		}
		if (titleClick && event.detail === 1 && !event.metaKey && !event.ctrlKey && !touch) {
			if (titleClickTimer.current !== null) window.clearTimeout(titleClickTimer.current);
			titleClickTimer.current = window.setTimeout(() => {
				titleClickTimer.current = null;
				open(false);
			}, 240);
			return;
		}
		if (titleClickTimer.current !== null) window.clearTimeout(titleClickTimer.current);
		titleClickTimer.current = null;
		open(event.metaKey || event.ctrlKey);
	};

	const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
		if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
			event.preventDefault();
			setMenuOpen(true);
			return;
		}
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		const list = event.currentTarget.closest(".dk-card-list");
		const buttons = list ? [...list.querySelectorAll<HTMLButtonElement>(".dk-card-open:not(:disabled)")] : [];
		const current = buttons.indexOf(event.currentTarget);
		if (current < 0 || buttons.length < 2) return;
		event.preventDefault();
		buttons[(current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
	};

	const onContextMenu = (event: ReactMouseEvent<HTMLLIElement>): void => {
		// Text fields and inline answers keep the native menu (paste); a row being renamed has no action menu.
		if (editing || (event.target instanceof Element && event.target.closest("input, textarea, .ui-request-inline"))) return;
		event.preventDefault();
		setMenuOpen(true);
	};
	const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = current < 0 ? 0 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
		items[next]?.focus();
	};


	const undo = async (): Promise<void> => {
		if (saving || busy || leaving) return;
		setMenuOpen(false);
		setFeedbackTarget("undo");
		try {
			await actionFeedback.run(() => onUndoRename(item.card.sessionId));
		} catch {
			// The sidebar reports the failed request and restores the current title.
		}
	};

	const archive = (): void => {
		if (saving || busy || leaving) return;
		const stopIfLive = item.live && (state === "streaming" || state === "asking" || session?.awaitingAnswer === true);
		if (stopIfLive && typeof window !== "undefined" && !window.confirm(`Stop and archive “${title}”?`)) {
			setSwipeOffset(0);
			return;
		}
		setMenuOpen(false);
		// Keyboard users keep their place: focus moves to the neighbouring row before this one leaves.
		const row = rowRef.current;
		if (row?.contains(document.activeElement)) {
			const rows = [...(row.closest(".dk-card-list")?.querySelectorAll<HTMLButtonElement>(".dk-card-open:not(:disabled)") ?? [])];
			const own = row.querySelector(".dk-card-open");
			const index = rows.findIndex(button => button === own);
			(rows[index + 1] ?? rows[index - 1])?.focus();
		}
		runObservedAction("archive", () => onArchive(item, stopIfLive));
	};
	const endSession = (): void => {
		if (!session || !item.live || busy || saving || leaving) return;
		if (!confirming) {
			setConfirming(true);
			return;
		}
		setConfirming(false);
		setMenuOpen(false);
		runAction("end", () => onStop(session.id));
	};

	const clearLongPress = (): void => {
		if (longPressTimer.current === null) return;
		window.clearTimeout(longPressTimer.current);
		longPressTimer.current = null;
	};

	const onRowPointerDown = (event: ReactPointerEvent<HTMLLIElement>): void => {
		if (!touch || event.pointerType === "mouse" || editing || busy || leaving) return;
		if (event.target instanceof Element && event.target.closest(".dk-row-swipe-actions, .dk-card-menu-trigger, .dk-card-menu, .dk-turn-stop, .ui-request-inline")) return;
		setMenuOpen(false);
		const row = rowRef.current;
		if (!row) return;
		swipeRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			lastX: event.clientX,
			lastAt: event.timeStamp,
			startDistance: swipeOffset,
			width: row.clientWidth,
			velocity: 0,
			captured: false,
		};
		clearLongPress();
		longPressTimer.current = window.setTimeout(() => {
			longPressTimer.current = null;
			const gesture = swipeRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId || gesture.captured) return;
			swipeRef.current = null;
			suppressClick.current = true;
			window.setTimeout(() => { suppressClick.current = false; }, 700);
			setMenuOpen(true);
		}, 500);
	};

	const onRowPointerMove = (event: ReactPointerEvent<HTMLLIElement>): void => {
		const gesture = swipeRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		const deltaX = event.clientX - gesture.startX;
		const deltaY = event.clientY - gesture.startY;
		if (Math.abs(deltaX) > ROW_SWIPE_AXIS_PX || Math.abs(deltaY) > ROW_SWIPE_AXIS_PX) clearLongPress();
		if (!gesture.captured) {
			if (Math.abs(deltaY) > ROW_SWIPE_AXIS_PX && Math.abs(deltaY) > Math.abs(deltaX)) {
				swipeRef.current = null;
				return;
			}
			if (Math.abs(deltaX) <= ROW_SWIPE_AXIS_PX || Math.abs(deltaX) <= Math.abs(deltaY)) return;
			gesture.captured = true;
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
			} catch {
				gesture.captured = false;
				swipeRef.current = null;
				return;
			}
			setSwiping(true);
		}
		event.preventDefault();
		const elapsed = Math.max(1, event.timeStamp - gesture.lastAt);
		gesture.velocity = -(event.clientX - gesture.lastX) / elapsed;
		gesture.lastX = event.clientX;
		gesture.lastAt = event.timeStamp;
		setSwipeOffset(Math.max(0, Math.min(ROW_ACTION_RAIL_PX, gesture.startDistance - deltaX)));
	};

	const finishRowPointer = (event: ReactPointerEvent<HTMLLIElement>, cancelled = false): void => {
		clearLongPress();
		const gesture = swipeRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		swipeRef.current = null;
		if (!gesture.captured) return;
		setSwiping(false);
		suppressClick.current = true;
		window.setTimeout(() => { suppressClick.current = false; }, 0);
		if (cancelled) {
			setSwipeOffset(gesture.startDistance);
			return;
		}
		// Touch pointerup usually repeats the last move's position: keep the last-move velocity unless the finger rested
		// (more than 80 ms since the last move), which means no flick.
		const elapsed = event.timeStamp - gesture.lastAt;
		if (event.clientX !== gesture.lastX && elapsed > 0) gesture.velocity = -(event.clientX - gesture.lastX) / elapsed;
		else if (elapsed > 80) gesture.velocity = 0;
		const distance = Math.max(0, gesture.startDistance - (event.clientX - gesture.startX));
		const resolution: SwipeResolution = resolveSessionRowSwipe(distance, gesture.velocity, gesture.width);
		if (resolution === "archive") {
			setSwipeOffset(0);
			archive();
		} else if (resolution === "reveal") {
			setSwipeOffset(Math.min(ROW_ACTION_RAIL_PX, gesture.width * 0.45));
		} else {
			setSwipeOffset(0);
		}
	};

	const onRowClickCapture = (event: ReactMouseEvent<HTMLLIElement>): void => {
		if (!suppressClick.current) return;
		suppressClick.current = false;
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<li
			ref={rowRef}
			className="dk-item-wrap dk-card-row"
			data-session-id={item.card.sessionId}
			data-selected={selected ? "true" : "false"}
			data-menu-open={menuOpen ? "true" : undefined}
			data-live={item.live && !offline ? "true" : "false"}
			data-offline={offline ? "true" : undefined}
			data-entering={entering ? "true" : undefined}
			data-leaving={leaving ? "true" : undefined}
			onPointerDown={onRowPointerDown}
			onPointerMove={onRowPointerMove}
			onPointerUp={event => finishRowPointer(event)}
			onPointerCancel={event => finishRowPointer(event, true)}
			onClickCapture={onRowClickCapture}
			onContextMenu={onContextMenu}
			onAnimationEnd={event => {
				if (event.animationName !== "dk-row-flip") return;
				delete event.currentTarget.dataset.flipping;
				event.currentTarget.style.removeProperty("--flip-y");
			}}
		>
			<div className="dk-row-swipe-actions" data-open={swipeOffset > 0 || swiping ? "true" : "false"} role="group" aria-label={`Actions for ${title}`}>
				<button type="button" className="sh-btn" disabled={swipeOffset === 0 || busy || saving} onClick={archive}>Archive</button>
				{item.live && session && (
					<button type="button" className="sh-btn sh-btn-stop" disabled={swipeOffset === 0 || busy || saving} onClick={endSession}>
						{confirming ? "Confirm end" : "End"}
					</button>
				)}
			</div>
			<div
				className={swiping ? "dk-card-row-content is-swiping" : "dk-card-row-content"}
				style={{ transform: swipeOffset > 0 ? `translate3d(${-swipeOffset}px, 0, 0)` : undefined }}
			>
				{editing && canRename ? (
					<form
						className="dk-card-rename"
						onSubmit={submitRename}
						onBlur={event => {
							if (cancelingRename.current) {
								cancelingRename.current = false;
								return;
							}
							if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
							void saveRename();
						}}
					>
						<input
							className="sh-input"
							aria-label={`Rename ${title}`}
							value={draft}
							autoFocus
							disabled={busy || saving}
							onChange={event => setDraft(event.target.value)}
							onKeyDown={event => {
								if (event.key !== "Escape") return;
								event.preventDefault();
								cancelingRename.current = true;
								setEditing(false);
								setDraft(title);
							}}
						/>
						<button type="submit" className="sh-btn sh-btn-primary" disabled={busy || saving}>
							<ActionFeedbackMark state={feedbackFor("rename")} />
							{feedbackFor("rename") === "pending" ? "Saving…" : "Save"}
						</button>
						<button type="button" className="sh-btn" disabled={saving} onClick={() => {
							cancelingRename.current = true;
							setEditing(false);
							setDraft(title);
						}}>Cancel</button>
					</form>
				) : (
					<>
						<button
							type="button"
							className="dk-card-open"
							tabIndex={tabStop ? 0 : -1}
							aria-current={selected ? "true" : undefined}
							disabled={!openable || busy}
							title={openTitle}
							onFocus={() => onFocusRow(item.card.sessionId)}
							onKeyDown={onRowKeyDown}
							onClick={onOpenClick}
							data-has-overnight={overnightEnabled && session?.overnight ? "true" : undefined}
						>
							<span className="dk-card-line-one">
								{item.live && state ? (
									<span
										className={`dk-state dk-state-${session?.paused ? "paused" : state === "waking" ? "starting" : state}`}
										title={session?.paused ? "Paused" : state === "asleep" ? "Asleep" : state === "waking" ? "Waking…" : `Live: running now (${state})`}
										role="img"
										aria-label={session?.paused ? "paused" : state === "asleep" ? "asleep" : state === "waking" ? "waking" : `live, ${state}`}
									/>
								) : (
									<span className={statusClass(item)} title={session?.source === "terminal" ? "Opens a copy; the terminal session is unchanged." : session?.cwdExists === false ? "Opens the saved transcript read-only; this project folder no longer exists." : "Saved"} aria-hidden="true" />
								)}
								<span className={attention ? "dk-card-title is-attention" : "dk-card-title"}>
									<span className="dk-card-title-text">{title}</span>
								</span>
								{machineId !== null && <MachineChip name={machineDisplayName(machineId)} />}
								<time className="dk-card-age" dateTime={new Date(item.card.lastActivityAt).toISOString()}>{relTime(item.card.lastActivityAt)}</time>
							</span>
							<span className="dk-card-line-two">
								<span className={`dk-card-status dk-card-status-${statusTone(item, offline)}`}>
									{session?.awaitingAnswer && <CircleHelp size={11} aria-hidden="true" />}
									{statusLabel(item, offline)}
								</span>
								{details !== "" && (
									<span className="dk-card-preview" title={details}>
										{details}
									</span>
								)}
								<span className="dk-card-marks">
									{stalled && <span title="stalled: no events while streaming"><TriangleAlert size={12} className="dk-mark-warn" aria-label="stalled" /></span>}
									{session?.goalActive && <Target size={12} className="dk-mark-goal" aria-label="goal active" />}
									{session?.loopMode?.active && (
										<span
											className="dk-card-loop"
											title={[session.loopMode.limit, session.loopMode.condition].filter(Boolean).join(" · ") || "Loop mode active"}
											aria-label={`Loop ${session.loopMode.waitingForPrompt ? "waiting for prompt" : `${session.loopMode.iteration}/${session.loopMode.limit ?? "unlimited"}`}`}
										>
											{session.loopMode.waitingForPrompt ? "Loop waiting" : `Loop ${session.loopMode.iteration}/${session.loopMode.limit ?? "∞"}`}
										</span>
									)}
									{session?.liveMode?.active && <span className="dk-card-live" aria-label={`Live voice ${session.liveMode.phase}`} title={`Live voice · ${session.liveMode.phase}`}>Live</span>}
									{Boolean(session?.agentCount) && <span title={`${session?.agentCount} subagents`}><Users size={12} />{session?.agentCount}</span>}
								</span>
							</span>
						</button>
						<span className="dk-card-actions">
							{overnightEnabled && session?.overnight && (
								<button
									type="button"
									className="dk-card-overnight"
									title={`Overnight run · ${overnightPhaseLabel(session.overnight.phase)} · deadline ${overnightDeadlineLabel(session.overnight.deadline)}`}
									aria-label={`Open overnight run status: ${overnightPhaseLabel(session.overnight.phase)}, deadline ${overnightDeadlineLabel(session.overnight.deadline)}`}
									onClick={() => openPanel({ panel: "overnight", sessionId: item.card.sessionId, cwd: session.cwd ?? item.card.cwd })}
								>
									<Moon size={12} aria-hidden="true" />
									<span>Overnight run · {overnightPhaseLabel(session.overnight.phase)} · {overnightDeadlineLabel(session.overnight.deadline)}</span>
								</button>
							)}
							<button
								type="button"
								className="dk-card-menu-trigger"
								aria-haspopup="menu"
								aria-expanded={menuOpen}
								aria-label={`Actions for ${title}`}
								title="More actions"
								disabled={busy || saving || leaving}
								onClick={() => setMenuOpen(open => !open)}
							>
								<MoreHorizontal size={16} aria-hidden="true" />
							</button>
							{menuOpen && (
								<div
									ref={menuRef}
									className="dk-card-menu"
									data-flip={menuFlip ? "up" : undefined}
									role="menu"
									aria-label={`Actions for ${title}`}
									onKeyDown={onMenuKeyDown}
								>
									{session?.model && <span className="dk-card-menu-model" title={session.model}>Model · {session.model}</span>}
									{onTogglePin && (
										<button
											type="button"
											role="menuitem"
											disabled={busy || saving || leaving}
											onClick={() => {
												setMenuOpen(false);
												runAction("pin", () => onTogglePin(item.card.sessionId, !item.card.pinned));
											}}
										>
											<ActionFeedbackMark state={feedbackFor("pin")} />
											<Pin size={14} />{item.card.pinned ? "Unpin" : "Pin"}
										</button>
									)}
									{(item.card.sessionFile ?? item.summary?.sessionFile) && onSaveRecipe && (
										<button
											type="button"
											role="menuitem"
											disabled={busy || saving || leaving}
											onClick={() => { setMenuOpen(false); onSaveRecipe(item.card.sessionId); }}
										>
											<BookmarkPlus size={14} />Save as session template
										</button>
									)}
									{canRename && <button type="button" role="menuitem" onClick={startEditing}><FilePenLine size={14} />Rename</button>}
									{canRename && item.card.titleHistory.length > 0 && (
										<button type="button" role="menuitem" disabled={busy || saving} onClick={() => void undo()}>
											<ActionFeedbackMark state={feedbackFor("undo")} />
											<Undo2 size={14} />{feedbackFor("undo") === "pending" ? "Restoring…" : "Undo title"}
										</button>
									)}
									{session?.sessionFile && (
										<button type="button" role="menuitem" disabled={busy || saving} onClick={() => { setMenuOpen(false); runAction("fork", () => onFork(session)); }}>
											<ActionFeedbackMark state={feedbackFor("fork")} />
											<GitFork size={14} />{feedbackFor("fork") === "pending" ? "Forking…" : "Fork"}
										</button>
									)}
									<button type="button" role="menuitem" disabled={!openable || busy || saving} onClick={() => open(true)}>
										{feedbackFor("resume") === "pending" ? <ActionFeedbackMark state="pending" /> : <ChevronRight size={14} />}
										Open in new pane
									</button>
									{state === "streaming" && onStopTurn && (
										<button type="button" role="menuitem" disabled={busy || saving} onClick={() => { setMenuOpen(false); runImmediateAction("stop-turn", () => onStopTurn(item.card.sessionId)); }}>
											<ActionFeedbackMark state={feedbackFor("stop-turn")} />
											<Square size={14} />Stop turn
										</button>
									)}
									{item.live && session && (
										<button type="button" role="menuitem" disabled={busy || saving} onClick={endSession}>
											<ActionFeedbackMark state={feedbackFor("end")} />
											<Power size={14} />{confirming ? "End session?" : "End"}
										</button>
									)}
									<button type="button" role="menuitem" disabled={busy || saving || leaving} onClick={archive}>
										<ActionFeedbackMark state={feedbackFor("archive")} />
										<Archive size={14} />Archive
									</button>
								</div>
							)}
						</span>
					</>
				)}
				{touch && item.live && !offline && (session?.awaitingAnswer || state === "asking") && uiTarget !== null && (
					<InlineUiRequest
						{...uiTarget}
						refreshKey={refreshKey}
						onOpen={() => open(false)}
					/>
				)}
				<ActionFeedbackMessage
					state={actionFeedback.state}
					error={actionFeedback.error}
					pendingLabel={feedbackTarget ? ACTION_FEEDBACK_LABELS[feedbackTarget].pending : "Saving…"}
					successLabel={feedbackTarget ? ACTION_FEEDBACK_LABELS[feedbackTarget].success : "Saved"}
				/>
			</div>
		</li>
	);
}
