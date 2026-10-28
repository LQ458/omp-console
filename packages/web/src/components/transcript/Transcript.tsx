import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ArrowDown, ChevronRight } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { benchCommitted } from "../../lib/bench";
import { copyText } from "../catalog/clipboard";
import { KEYMAP_ACTION_EVENT, type KeymapActionDetail } from "../../lib/keymap";
import { copyableMessageText, latestTranscriptLink, openExternalLink } from "./clipboard";
import { TRANSCRIPT_OUTPUT_EVENT, type TranscriptOutputDetail } from "./events";
import { replaceTabs, stripAnsi } from "../../tool-render/util";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { offlineCachedEntriesPartial } from "../../lib/offline-cache/view";
import { fmtTokens } from "../../lib/format";
import { type ScrollAnchor, VirtualModel, type WindowRange } from "../../lib/virtual-list";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	/** Identifies local shell output and scopes session key actions. */
	sessionId?: string;
	tailSlot?: ReactNode;
	phoneLayout?: boolean;
	latestLink?: string | null;
	/** Position retained by the owning session while this view remounts between pane hosts. */
	initialScrollPosition?: TranscriptScrollPosition;
	onScrollPositionChange?(position: TranscriptScrollPosition): void;
}

export interface TranscriptScrollPosition {
	/** Entry pinned to the viewport top; unlike a pixel offset this survives pane-width reflow. */
	anchor: ScrollAnchor | null;
	locked: boolean;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}
const TAIL_LOCK_DISTANCE_PX = 40;

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry using the shared tail threshold. */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= TAIL_LOCK_DISTANCE_PX;
}

function Row({
	kind,
	gutter,
	title,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/**
 * omp's `async-result` follow-up (a background job or subagent finished) is model-facing: a `<system-notice>`
 * wrapper, a "resume your work" line, and each job's `<task-result>` envelope. Printed as Markdown it showed raw
 * tags in the middle of the conversation. It reads as one collapsed line naming the job, with the results inside.
 */
function asyncResultParts(text: string): { title: string; body: string } {
	const inner = text.replace(/^\s*<system-notice>\s*/, "").replace(/\s*<\/system-notice>\s*$/, "");
	const many = /^(\d+) background jobs have completed\./.exec(inner);
	const one = /^Background job (\S+) has completed\./.exec(inner);
	const title = many ? `${many[1]} background jobs finished` : one ? `Background job ${one[1]} finished` : "Background job finished";
	const rest = inner.replace(/^.*?Resume your work using the results? below\.\s*/s, "");
	const body = rest
		.replace(/<task-result(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/task-result>/g, (_m, result: string) => {
			const output = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(result)?.[2];
			return (output ?? result).trim();
		})
		.trim();
	return { title, body };
}

function AsyncResultBlock({ text }: { text: string }): ReactNode {
	const [open, setOpen] = useState(false);
	const { title, body } = asyncResultParts(text);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				{title}
			</button>
			{open && body !== "" && <Markdown text={body} />}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function CopyMessageButton({ text }: { text: string }): ReactNode {
	const [label, setLabel] = useState("Copy");
	const timer = useRef<number | null>(null);

	useEffect(() => () => {
		if (timer.current !== null) window.clearTimeout(timer.current);
	}, []);

	const copy = async (): Promise<void> => {
		const ok = await copyText(text);
		setLabel(ok ? "Copied" : "Copy failed");
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => {
			timer.current = null;
			setLabel("Copy");
		}, 1200);
	};

	return <button type="button" className="tr-copy" aria-label="Copy message" onClick={() => void copy()}>{label}</button>;
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
	toolsVisible,
	thinkingVisible,
	toolsExpanded,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	pending: boolean;
	host?: ToolRenderHost;
	toolsVisible: boolean;
	thinkingVisible: boolean;
	toolsExpanded: boolean;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return thinkingVisible ? <ThinkingBlock key={i} text={block.thinking} /> : null;
			case "redactedThinking":
				return thinkingVisible ? <ThinkingBlock key={i} text="" redacted /> : null;
			case "text":
				return pending ? <StreamingMarkdown key={i} text={block.text} /> : <Markdown key={i} text={block.text} />;
			case "toolCall": {
				if (!toolsVisible) return null;
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={`${block.id}:${toolsExpanded ? "expanded" : "collapsed"}`}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
						defaultOpen={toolsExpanded}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	toolsVisible: boolean;
	thinkingVisible: boolean;
	toolsExpanded: boolean;
	host?: ToolRenderHost;
}

/** Re-render only when the entry itself, a tool pairing, or a visibility preference changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (
		prev.entry !== next.entry ||
		prev.host !== next.host ||
		prev.toolsVisible !== next.toolsVisible ||
		prev.thinkingVisible !== next.thinkingVisible ||
		prev.toolsExpanded !== next.toolsExpanded
	) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({
	entry,
	results,
	active,
	toolsVisible,
	thinkingVisible,
	toolsExpanded,
	host,
}: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user": {
					const text = copyableMessageText(msg.content);
					return (
						<Row kind="user" gutter="host" title={entry.timestamp}>
							<MsgContent content={msg.content} />
							{text !== "" && <CopyMessageButton text={text} />}
						</Row>
					);
				}
				case "assistant": {
					const text = copyableMessageText(msg.content);
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp}>
							<AssistantBody
								message={msg}
								results={results}
								active={active}
								pending={false}
								host={host}
								toolsVisible={toolsVisible}
								thinkingVisible={thinkingVisible}
								toolsExpanded={toolsExpanded}
							/>
							{text !== "" && <CopyMessageButton text={text} />}
						</Row>
					);
				}
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row kind="user" gutter={<span className="tr-badge">{from}</span>} title={entry.timestamp}>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			if (entry.customType === "async-result") {
				const text =
					typeof entry.content === "string"
						? entry.content
						: entry.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
				return (
					<Row kind="custom" gutter="" title={entry.timestamp}>
						<AsyncResultBlock text={text} />
					</Row>
				);
			}
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/** Pixels mounted beyond each viewport edge, so a normal fling never reaches an unmounted row. */
const OVERSCAN_PX = 600;
/** Height assumed for a row before it is measured; replaced by the measured mean as rows mount. */
const ESTIMATED_ROW_PX = 96;
/** Viewport height used until the real one is measured (server render, first paint). */
const FALLBACK_VIEWPORT_PX = 800;
/** Scrolled this far from the bottom, the "jump to latest" button appears. */
const JUMP_BUTTON_PX = 200;

/**
 * Entries that produce a row. Kept next to `EntryRow`: tool results are folded into the assistant
 * row that called them, and hidden or unknown entries render nothing, so they must not take a
 * slot (and an estimated height) in the windowed list.
 */
export function isRenderedEntry(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return entry.message.role === "user" || entry.message.role === "assistant";
		case "custom_message":
			return entry.customType === "collab-prompt" || entry.display;
		case "compaction":
		case "branch_summary":
		case "model_change":
		case "thinking_level_change":
			return true;
		default:
			return false;
	}
}

interface WindowedRowProps extends EntryRowProps {
	/** 1-based position among rendered rows, for assistive tech while most rows are unmounted. */
	position: number;
	total: number;
	observer: ResizeObserver | null;
}

/** Measured wrapper around one entry: its height feeds the windowing model. */
const WindowedRow = memo(function WindowedRow({
	entry,
	results,
	active,
	toolsVisible,
	thinkingVisible,
	toolsExpanded,
	host,
	position,
	total,
	observer,
}: WindowedRowProps): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element === null || observer === null) return;
		observer.observe(element);
		return () => observer.unobserve(element);
	}, [observer]);
	return (
		<div ref={ref} className="tr-vrow" role="article" aria-posinset={position} aria-setsize={total} data-key={entry.id}>
			<EntryRow
				entry={entry}
				results={results}
				active={active}
				toolsVisible={toolsVisible}
				thinkingVisible={thinkingVisible}
				toolsExpanded={toolsExpanded}
				host={host}
			/>
		</div>
	);
});

function rangesEqual(a: WindowRange, b: WindowRange): boolean {
	return a.start === b.start && a.end === b.end;
}

/**
 * Windowed transcript. Only rows near the viewport are mounted; the rest are two spacers whose
 * heights come from `VirtualModel` (measured heights cached by entry id, the measured mean for
 * rows never seen). Rows report their real height through one ResizeObserver, so streaming text,
 * expanded tool cards and window resizes are all handled the same way.
 *
 * Scroll rules:
 * - Bottom-locked (within 40px of the end): the window is always the tail and every layout change
 *   re-pins the bottom, so streaming text and appended entries stay in view.
 * - Scrolled away: the window follows the scroll position. A height change above the viewport top
 *   adds the same amount to `scrollTop`, and a change of the entry list (history prepended, resync)
 *   restores the entry that was at the viewport top. Nothing moves under the reader.
 *
 * Limits: browser find-in-page (Ctrl/Cmd-F) only sees mounted rows, and the scrollbar thumb is
 * approximate until rows have been measured.
 */
export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		stream,
		streamDone,
		activeTools,
		working,
		compact,
		host,
		phase,
		sessionId,
		tailSlot,
		phoneLayout = false,
		latestLink: latestLinkProp,
		initialScrollPosition,
		onScrollPositionChange,
	} = props;

	const items = useMemo(() => entries.filter(isRenderedEntry), [entries]);

	// Results are looked up across the whole transcript: windowed rows no longer imply visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [entries]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const tailRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(initialScrollPosition?.locked ?? true);
	const [locked, setLocked] = useState(initialScrollPosition?.locked ?? true);
	const [showJump, setShowJump] = useState(false);
	const [observer, setObserver] = useState<ResizeObserver | null>(null);
	const [, setRevision] = useState(0);
	const [toolsVisible, setToolsVisible] = useState(true);
	const [thinkingVisible, setThinkingVisible] = useState(true);
	const [toolsExpanded, setToolsExpanded] = useState(false);
	const [shellOutputs, setShellOutputs] = useState<TranscriptOutputDetail[]>([]);

	useEffect(() => {
		if (sessionId === undefined) return;
		const onAction = (event: Event): void => {
			const detail = (event as CustomEvent<KeymapActionDetail>).detail;
			if (detail?.sessionId !== sessionId) return;
			switch (detail.action) {
				case "expandTools":
					setToolsExpanded(true);
					break;
				case "toggleToolsVisibility":
					setToolsVisible(value => !value);
					break;
				case "toggleThinkingVisibility":
					setThinkingVisible(value => !value);
					break;
			}
		};
		window.addEventListener(KEYMAP_ACTION_EVENT, onAction);
		return () => window.removeEventListener(KEYMAP_ACTION_EVENT, onAction);
	}, [sessionId]);

	useEffect(() => {
		if (sessionId === undefined) return;
		const onOutput = (event: Event): void => {
			const detail = (event as CustomEvent<TranscriptOutputDetail>).detail;
			if (detail?.sessionId !== sessionId) return;
			setShellOutputs(current => [...current.slice(-19), detail]);
		};
		window.addEventListener(TRANSCRIPT_OUTPUT_EVENT, onOutput);
		return () => window.removeEventListener(TRANSCRIPT_OUTPUT_EVENT, onOutput);
	}, [sessionId]);

	const visibleShellOutputs = useMemo(
		() => sessionId === undefined ? [] : shellOutputs.filter(output => output.sessionId === sessionId),
		[sessionId, shellOutputs],
	);

	const latestLink = useMemo(
		() => latestLinkProp === undefined ? latestTranscriptLink(entries, stream) : latestLinkProp,
		[entries, latestLinkProp, stream],
	);

	const modelRef = useRef<VirtualModel | null>(null);
	modelRef.current ??= new VirtualModel(ESTIMATED_ROW_PX);
	const model = modelRef.current;
	/** Viewport top in list space (0 = top of the first row), refreshed on scroll and after layout. */
	const scrollTopRef = useRef(0);
	const scrollPositionRef = useRef(initialScrollPosition ?? null);
	const stablePositionRef = useRef<TranscriptScrollPosition | null>(initialScrollPosition ?? null);
	const skipInitialLiveRef = useRef(initialScrollPosition !== undefined);
	const viewportRef = useRef(FALLBACK_VIEWPORT_PX);
	const widthRef = useRef<number | null>(null);
	const heightRef = useRef<number | null>(null);
	/** Becomes true only after ResizeObserver has observed a non-zero viewport. */
	const viewportObservedRef = useRef(false);
	const userScrollIntentUntilRef = useRef(0);
	/** Raw `scrollTop` at the previous scroll event: only an upward user scroll releases the tail lock. */
	const lastRawScrollTopRef = useRef(0);
	/** True while Dockview is changing this container's geometry; do not publish transient positions. */
	const resizingRef = useRef(false);
	/** Entry pinned to the viewport top across a model change; consumed by the next layout effect. */
	const pendingAnchorRef = useRef<ScrollAnchor | null>(null);
	const renderedRangeRef = useRef<WindowRange>({ start: 0, end: 0 });
	const syncedItemsRef = useRef<readonly SessionEntry[] | null>(null);

	/** List top inside the scroll container's content box: row offsets are relative to it. */
	const listOrigin = (): number => listRef.current?.offsetTop ?? 0;
	const currentRange = (): WindowRange => {
		if (lockRef.current) return model.tailRange(viewportRef.current, OVERSCAN_PX);
		return model.rangeFor(scrollTopRef.current, viewportRef.current, OVERSCAN_PX);
	};
	const viewportIsReady = (root: HTMLElement): boolean => {
		const width = root.clientWidth;
		const height = root.clientHeight;
		return (
			width > 0 &&
			height > 0 &&
			viewportObservedRef.current &&
			!resizingRef.current &&
			(widthRef.current === null || Math.abs(width - widthRef.current) <= 0.5) &&
			(heightRef.current === null || Math.abs(height - heightRef.current) <= 0.5)
		);
	};
	const reportScrollPosition = (root: HTMLElement): void => {
		if (!viewportIsReady(root)) return;
		const top = root.scrollTop - listOrigin();
		scrollTopRef.current = top;
		const anchor = lockRef.current ? null : model.captureAnchor(top);
		const position: TranscriptScrollPosition = { anchor, locked: lockRef.current };
		stablePositionRef.current = position;
		onScrollPositionChange?.(position);
	};
	const restoreSavedPosition = (root: HTMLElement): boolean => {
		const saved = scrollPositionRef.current;
		if (saved === null || !viewportIsReady(root)) return false;
		const restored = saved.locked ? null : saved.anchor === null ? 0 : model.scrollTopForAnchor(saved.anchor);
		if (!saved.locked && restored === null) return false;
		scrollPositionRef.current = null;
		lockRef.current = saved.locked;
		setLocked(saved.locked);
		if (saved.locked) followTranscriptTail(root, lockRef);
		else {
			scrollTopRef.current = restored!;
			root.scrollTop = restored! + listOrigin();
		}
		return true;
	};

	if (syncedItemsRef.current !== items) {
		// Pin the viewport-top entry against the layout that is still on screen, then swap the keys.
		const root = rootRef.current;
		if (root !== null && !lockRef.current && pendingAnchorRef.current === null) {
			pendingAnchorRef.current = model.captureAnchor(root.scrollTop - listOrigin());
		}
		model.setKeys(items.map(entry => entry.id));
		syncedItemsRef.current = items;
	}

	let range: WindowRange;
	if (locked) {
		range = model.tailRange(viewportRef.current, OVERSCAN_PX);
	} else {
		const anchor = pendingAnchorRef.current;
		const top = (anchor === null ? null : model.scrollTopForAnchor(anchor)) ?? scrollTopRef.current;
		range = model.rangeFor(top, viewportRef.current, OVERSCAN_PX);
	}
	renderedRangeRef.current = range;
	const paddingTop = model.offsetOf(range.start);
	const paddingBottom = model.totalHeight - model.offsetOf(range.end);

	const setLock = (value: boolean): void => {
		lockRef.current = value;
		setLocked(value);
	};

	// Height feed: one observer for the container, the live tail and every mounted row.
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		const initialWidth = root.clientWidth;
		const initialHeight = root.clientHeight;
		widthRef.current = initialWidth;
		heightRef.current = initialHeight;
		viewportRef.current = initialHeight;
		resizingRef.current = initialWidth <= 0 || initialHeight <= 0;
		const resizeObserver = new ResizeObserver(observed => {
			if (root.clientWidth <= 0 || root.clientHeight <= 0) {
				resizingRef.current = true;
				if (lockRef.current) followTranscriptTail(root, lockRef);
				return;
			}
			const list = listRef.current;
			if (list === null) {
				if (lockRef.current) followTranscriptTail(root, lockRef);
				return;
			}
			const origin = list.offsetTop;
			const top = root.scrollTop - origin;
			// Captured against the pre-update model: Dockview may have already reset scrollTop while it applies
			// the new pane geometry, so prefer the last stable anchor when it is still present.
			const stableAnchor =
				!lockRef.current && stablePositionRef.current?.locked === false ? stablePositionRef.current.anchor : null;
			const anchorBefore =
				stableAnchor !== null && model.indexOfKey(stableAnchor.key) >= 0 ? stableAnchor : lockRef.current ? null : model.captureAnchor(top);
			let invalidated = false;
			let rootResized = false;
			for (const entry of observed) {
				if (entry.target !== root) continue;
				rootResized = true;
				viewportObservedRef.current = true;
			}
			const width = root.clientWidth;
			const height = root.clientHeight;
			const widthChanged = widthRef.current !== null && Math.abs(width - widthRef.current) > 0.5;
			const heightChanged = heightRef.current !== null && Math.abs(height - heightRef.current) > 0.5;
			const viewportChanged = widthChanged || heightChanged;
			if (widthChanged) {
				model.invalidate();
				invalidated = true;
			}
			if (rootResized || viewportChanged) resizingRef.current = true;
			viewportRef.current = height;
			widthRef.current = width;
			heightRef.current = height;
			for (const entry of observed) {
				const target = entry.target;
				if (target === root || target === tailRef.current) continue;
				const key = target instanceof HTMLElement ? target.dataset.key : undefined;
				if (key === undefined) continue;
				const index = model.indexOfKey(key);
				if (index < 0) continue;
				const height = entry.borderBoxSize?.[0]?.blockSize ?? target.getBoundingClientRect().height;
				model.setHeight(index, height);
			}
			const modelShifted = model.reestimate() || invalidated;
			if (lockRef.current) followTranscriptTail(root, lockRef);
			else if (anchorBefore !== null) {
				if (modelShifted) {
					// Spacer sizes changed too: wait for the re-render so DOM and model agree, then restore.
					pendingAnchorRef.current ??= anchorBefore;
				} else {
					const restored = model.scrollTopForAnchor(anchorBefore);
					if (restored !== null && Math.abs(restored - top) > 0.5) root.scrollTop = restored + origin;
				}
				scrollTopRef.current = root.scrollTop - origin;
			}
			if (rootResized || viewportChanged || modelShifted || !rangesEqual(currentRange(), renderedRangeRef.current)) setRevision(r => r + 1);
		});
		resizeObserver.observe(root);
		if (tailRef.current !== null) resizeObserver.observe(tailRef.current);
		setObserver(resizeObserver);
		setRevision(r => r + 1); // the real viewport replaces the fallback used for the first window
		return () => resizeObserver.disconnect();
	}, [model]);
	// After every commit: restore a pinned entry or re-pin the bottom, then tell the bench a paint is due.
	useLayoutEffect(() => {
		try {
			const root = rootRef.current;
			if (root === null) return;
			if (resizingRef.current && root.clientWidth > 0 && root.clientHeight > 0) resizingRef.current = false;
			let restoredSaved = false;
			if (viewportIsReady(root)) {
				restoredSaved = restoreSavedPosition(root);
				const anchor = pendingAnchorRef.current;
				if (anchor !== null) {
					pendingAnchorRef.current = null;
					if (!lockRef.current) {
						const restored = model.scrollTopForAnchor(anchor);
						if (restored !== null) root.scrollTop = restored + listOrigin();
					}
				}
			}
			if (lockRef.current) followTranscriptTail(root, lockRef);
			scrollTopRef.current = root.scrollTop - listOrigin();
			if (restoredSaved) setRevision(r => r + 1);
			reportScrollPosition(root);
		} finally {
			benchCommitted();
		}
	});
	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useLayoutEffect(() => {
		if (phase !== "live") return;
		if (skipInitialLiveRef.current) {
			skipInitialLiveRef.current = false;
			return;
		}
		setLock(true);
		setShowJump(false);
		setRevision(r => r + 1);
	}, [phase]);

	const markUserScrollIntent = (): void => {
		userScrollIntentUntilRef.current = performance.now() + 250;
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (
			event.key === "ArrowDown" ||
			event.key === "ArrowUp" ||
			event.key === "End" ||
			event.key === "Home" ||
			event.key === "PageDown" ||
			event.key === "PageUp" ||
			event.key === " "
		) {
			markUserScrollIntent();
		}
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		if (event.buttons !== 0) markUserScrollIntent();
	};
	// Streaming layout changes also dispatch scroll events. Reaching the bottom (by any means) locks to the tail; only
	// a user scroll that actually moved up releases it, so a layout-caused event inside the intent window cannot.
	const onScroll = (): void => {
		const root = rootRef.current;
		if (root === null) return;
		const wasLocked = lockRef.current;
		const gap = root.scrollHeight - root.scrollTop - root.clientHeight;
		const movedUp = root.scrollTop < lastRawScrollTopRef.current;
		lastRawScrollTopRef.current = root.scrollTop;
		if (gap <= TAIL_LOCK_DISTANCE_PX) lockRef.current = true;
		else if (movedUp && performance.now() <= userScrollIntentUntilRef.current) lockRef.current = false;
		else if (lockRef.current) followTranscriptTail(root, lockRef);
		scrollTopRef.current = root.scrollTop - listOrigin();
		if (lockRef.current !== wasLocked) setLocked(lockRef.current);
		reportScrollPosition(root);
		const away = !lockRef.current && root.scrollHeight - root.scrollTop - root.clientHeight > JUMP_BUTTON_PX;
		setShowJump(away);
		if (!lockRef.current && !rangesEqual(currentRange(), renderedRangeRef.current)) setRevision(r => r + 1);
	};

	const jumpToLatest = (): void => {
		setLock(true);
		setShowJump(false);
		setRevision(r => r + 1);
	};

	// Tool calls committed anywhere in the session: rescanned when entries change,
	// not per streaming token or tool output update.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	const cachedPartial = offlineCachedEntriesPartial(entries);
	return (
		<div className="tr-shell">
			<div
				ref={rootRef}
				className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
				role="feed"
				aria-label="Transcript"
				aria-busy={working}
				tabIndex={0}
				data-deck-scroller={compact === true ? undefined : ""}
				onScroll={onScroll}
				onWheel={markUserScrollIntent}
				onTouchMove={markUserScrollIntent}
				onPointerMove={onPointerMove}
				onKeyDown={onKeyDown}
			>
				{settled && entries.length === 0 && stream === null && visibleShellOutputs.length === 0 && !working && (
					<div className="tr-empty">no activity yet</div>
				)}
				{cachedPartial !== undefined && (
					<div className="tr-cache-status" role="status">
						<span>Saved copy · updates when connected</span>
						{cachedPartial && <span>earlier messages not cached</span>}
					</div>
				)}
				<div ref={listRef} className="tr-list" style={{ paddingTop, paddingBottom }}>
					{items.slice(range.start, range.end).map((entry, i) => (
						<WindowedRow
							key={entry.id}
							entry={entry}
							results={results}
							active={activeTools}
							toolsVisible={toolsVisible}
							thinkingVisible={thinkingVisible}
							toolsExpanded={toolsExpanded}
							host={host}
							position={range.start + i + 1}
							total={items.length}
							observer={observer}
						/>
					))}
				</div>
				<div ref={tailRef} className="tr-tail">
					{stream !== null && (
						<Row kind="assistant" gutter="agent">
							<AssistantBody
								message={stream}
								results={results}
								active={activeTools}
								pending={!streamDone}
								host={host}
								toolsVisible={toolsVisible}
								thinkingVisible={thinkingVisible}
								toolsExpanded={toolsExpanded}
							/>
							{copyableMessageText(stream.content) !== "" && <CopyMessageButton text={copyableMessageText(stream.content)} />}
						</Row>
					)}
					{toolsVisible && tailTools.length > 0 && (
						<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
							{tailTools.map(tool => (
								<ToolCard
									key={`${tool.toolCallId}:${toolsExpanded ? "expanded" : "collapsed"}`}
									toolCallId={tool.toolCallId}
									name={tool.toolName}
									intent={tool.intent}
									args={tool.args}
									running
									partialResult={tool.partialResult}
									defaultOpen={toolsExpanded}
									host={host}
								/>
							))}
						</Row>
					)}
					{visibleShellOutputs.map(output => (
						<div className="tr-shell-output" key={output.id} role="status">
							<div className="tr-shell-output-head">
								<code>{output.excludeFromContext ? (output.kind === "bash" ? "!!" : "$$") : (output.kind === "bash" ? "!" : "$")} {replaceTabs(output.command)}</code>
								{output.exitCode !== undefined && output.exitCode !== 0 && <span>exit {output.exitCode}</span>}
							</div>
							<pre>{replaceTabs(stripAnsi(output.output)) || "(no output)"}</pre>
						</div>
					))}
					{working && stream === null && activeTools.size === 0 && (
						<Row kind="assistant" gutter="agent">
							<div className="tr-shimmer">thinking…</div>
						</Row>
					)}
					{latestLink !== null && !phoneLayout && (
						<button type="button" className="tr-open-link" onClick={() => openExternalLink(latestLink)} aria-label="Open last link">
							Open last link
						</button>
					)}
					{tailSlot}
				</div>
			</div>
			{showJump && !locked && (
				<button type="button" className="tr-jump" onClick={jumpToLatest} aria-label="Jump to latest">
					<ArrowDown size={14} aria-hidden="true" />
					<span>latest</span>
				</button>
			)}
		</div>
	);
}
