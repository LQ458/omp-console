import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	agentCollapseKey,
	batchCollapseKey,
	type AgentBatch,
	type AgentGraph,
	type AgentGraphStatus,
	type AgentNode,
	layoutAgentGraph,
	LAYOUT_PADDING,
	NODE_HEIGHT,
	NODE_WIDTH,
} from "../../lib/agent-graph";
import { fitTransform, panBy, type ViewTransform, zoomAt } from "../../lib/agent-viewport";
import { startPanInertia } from "../../lib/motion";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { EDGE_KINDS, type EdgeKind, type MessageEdge, messageEdgeTitle, placeMessageEdges } from "../../lib/message-edges";
import "./agents.css";
import "./graph-tools.css";

const DRAG_THRESHOLD_PX = 4;
/** A touch held this long on a node opens its menu (iOS fires no `contextmenu` for it). */
const LONG_PRESS_MS = 500;
const ALL_KINDS: ReadonlySet<EdgeKind> = new Set(EDGE_KINDS.map(item => item.kind));
const ZOOM_STEP = 1.25;
const MIN_FIT_SCALE = 0.72;
/** Approximate glyph width of node text; labels are clipped before they leave the box. */
const NAME_CHARS = 21;
const ACTIVITY_CHARS = 35;
const META_CHARS = 38;

const LEGEND: ReadonlyArray<{ key: AgentGraphStatus | "stalled"; label: string }> = [
	{ key: "running", label: "running" },
	{ key: "stalled", label: "stalled" },
	{ key: "parked", label: "parked" },
	{ key: "finished", label: "finished" },
	{ key: "failed", label: "failed" },
	{ key: "aborted", label: "aborted" },
];

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function shortModel(model: string | undefined): string {
	if (!model) return "model unavailable";
	return clip(model.slice(model.lastIndexOf("/") + 1), 18);
}

function stats(node: AgentNode): string {
	const parts: string[] = [];
	if (node.tokens !== undefined) parts.push(`${fmtTokens(node.tokens)} tok`);
	if (node.cost !== undefined) parts.push(fmtCost(node.cost));
	if (node.toolCount !== undefined) parts.push(`${node.toolCount} tools`);
	return parts.join(" · ") || "usage unavailable";
}

function nodeTitle(node: AgentNode): string {
	return [
		node.displayName,
		node.stalled ? "stalled" : node.status,
		node.profile,
		node.activity,
		node.task,
		node.model,
		node.durationMs === undefined ? undefined : fmtDuration(node.durationMs),
		node.tokens === undefined ? undefined : `${fmtTokens(node.tokens)} tokens`,
		node.cost === undefined ? undefined : fmtCost(node.cost),
		node.toolCount === undefined ? undefined : `${node.toolCount} tools`,
	]
		.filter(Boolean)
		.join(" · ");
}

function batchTitle(batch: AgentBatch): string {
	return [
		batch.label,
		`${batch.childIds.length} agents`,
		batch.detached ? "async" : "blocking",
		batch.status,
		batch.durationMs === undefined ? undefined : fmtDuration(batch.durationMs),
	]
		.filter(Boolean)
		.join(" · ");
}

export function fitGraph(layout: { width: number; height: number }, size: { width: number; height: number }): ViewTransform {
	const fitted = fitTransform(layout, size);
	if (fitted.k >= MIN_FIT_SCALE) return fitted;
	const k = MIN_FIT_SCALE;
	// The readability floor can make the whole graph wider than the pane; keep the root visible and let users pan right.
	return {
		x: Math.max(LAYOUT_PADDING * k, (size.width - layout.width * k) / 2),
		y: (size.height - layout.height * k) / 2,
		k,
	};
}


interface Point {
	x: number;
	y: number;
}

interface Gesture {
	start: Point;
	lastAt: number;
	velocityX: number;
	velocityY: number;
	moved: boolean;
	nodeId: string | null;
	/** A menu was opened by this gesture; its end must not also select the node. */
	menuOpened: boolean;
	longPress: number | null;
}

export interface NodeMenuRequest {
	nodeId: string;
	/** Viewport coordinates. */
	x: number;
	y: number;
}

/**
 * The agent tree as an SVG graph with pan (drag), zoom (wheel, pinch, buttons) and fit. Running nodes pulse and
 * their incoming edge flows; stalled nodes are outlined dashed. A tap on a node (not the end of a drag) selects it.
 */
export function AgentGraphView(props: {
	graph: AgentGraph;
	selectedId: string | null;
	onSelect(id: string): void;
	/** Message edges to overlay (direction and count); see `aggregateMessageEdges`. */
	messageEdges?: readonly MessageEdge[];
	/** Edge kinds drawn; all when absent. */
	visibleKinds?: ReadonlySet<EdgeKind>;
	/** Shows the edge toggles and calls this when one is flipped. */
	onToggleKind?(kind: EdgeKind): void;
	/** Right-click or long-press on a node. */
	onNodeMenu?(request: NodeMenuRequest): void;
}): ReactNode {
	const { graph, selectedId, onSelect, messageEdges, onToggleKind, onNodeMenu } = props;
	const visibleKinds = props.visibleKinds ?? ALL_KINDS;
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const layout = useMemo(() => layoutAgentGraph(graph, collapsed), [graph, collapsed]);
	const geometryKey = useMemo(() => layout.nodes.map(node => `${node.id}:${node.x}:${node.y}`).join("|"), [layout.nodes]);
	const placedMessages = useMemo(
		() => placeMessageEdges(layout, (messageEdges ?? []).filter(edge => visibleKinds.has(edge.kind))),
		[layout, messageEdges, visibleKinds],
	);
	const kindCounts = useMemo(() => {
		const counts: Record<EdgeKind, number> = { spawn: graph.edges.filter(edge => !edge.cycle).length, message: 0, reply: 0, broadcast: 0 };
		for (const edge of messageEdges ?? []) counts[edge.kind] += edge.count;
		return counts;
	}, [graph, messageEdges]);
	const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph]);
	const batchById = useMemo(() => new Map(graph.batches.map(batch => [batch.id, batch])), [graph]);
	const expandableAgents = useMemo(() => new Set(graph.batches.map(batch => batch.parentId)), [graph]);
	const runningTargets = useMemo(() => {
		const targets = new Set(graph.nodes.filter(node => node.status === "running" && !node.stalled).map(node => node.id));
		for (const batch of graph.batches) if (batch.status === "running") targets.add(batch.id);
		return targets;
	}, [graph]);

	const frameRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
	/** Once the person pans or zooms, a resize or a new node no longer snaps the view back. */
	const touchedRef = useRef(false);
	const pointers = useRef(new Map<number, Point>());
	const gesture = useRef<Gesture | null>(null);
	const inertia = useRef<(() => void) | null>(null);
	const toggleCollapse = useCallback((key: string) => {
		touchedRef.current = false;
		setCollapsed(current => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);


	useEffect(() => {
		const frame = frameRef.current;
		if (!frame || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(entries => {
			const box = entries[0]?.contentRect;
			if (box) setSize({ width: box.width, height: box.height });
		});
		observer.observe(frame);
		return () => observer.disconnect();
	}, []);
	useEffect(
		() => () => {
			inertia.current?.();
			inertia.current = null;
		},
		[],
	);

	useEffect(() => {
		if (touchedRef.current) return;
		setTransform(fitGraph(layout, size));
	}, [layout.width, layout.height, geometryKey, size.width, size.height]);

	const fit = useCallback(() => {
		touchedRef.current = false;
		setTransform(fitGraph(layout, size));
	}, [layout.width, layout.height, size.width, size.height]);

	const zoomBy = useCallback(
		(factor: number, around?: Point) => {
			touchedRef.current = true;
			const centre = around ?? { x: size.width / 2, y: size.height / 2 };
			setTransform(current => zoomAt(current, centre.x, centre.y, factor));
		},
		[size.width, size.height],
	);

	// The wheel listener must be non-passive to stop the page from scrolling under the graph.
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const onWheel = (event: WheelEvent): void => {
			event.preventDefault();
			const rect = frame.getBoundingClientRect();
			const unit = event.deltaMode === 1 ? 16 : 1;
			zoomBy(Math.exp(-event.deltaY * unit * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
		};
		frame.addEventListener("wheel", onWheel, { passive: false });
		return () => frame.removeEventListener("wheel", onWheel);
	}, [zoomBy]);

	const clearLongPress = (active: Gesture | null): void => {
		if (active?.longPress != null) {
			window.clearTimeout(active.longPress);
			active.longPress = null;
		}
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0) return; // right/middle button: `contextmenu` handles it, not a pan or a select
		inertia.current?.();
		inertia.current = null;
		pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.current.size === 1) {
			const target = event.target instanceof Element ? event.target.closest("[data-node-id]") : null;
			const nodeId = target?.getAttribute("data-node-id") ?? null;
			const start = { x: event.clientX, y: event.clientY };
			const started: Gesture = {
				start,
				lastAt: event.timeStamp,
				velocityX: 0,
				velocityY: 0,
				moved: false,
				nodeId,
				menuOpened: false,
				longPress: null,
			};
			if (nodeId !== null && onNodeMenu && event.pointerType !== "mouse") {
				const at = { x: event.clientX, y: event.clientY };
				started.longPress = window.setTimeout(() => {
					started.longPress = null;
					if (started.moved || gesture.current !== started) return;
					started.menuOpened = true;
					onNodeMenu({ nodeId, x: at.x, y: at.y });
				}, LONG_PRESS_MS);
			}
			gesture.current = started;
		} else if (gesture.current) {
			gesture.current.moved = true; // a second finger turns the gesture into a pinch
			gesture.current.velocityX = 0;
			gesture.current.velocityY = 0;
			clearLongPress(gesture.current);
		}
	};

	const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
		const target = event.target instanceof Element ? event.target.closest("[data-node-id]") : null;
		const nodeId = target?.getAttribute("data-node-id") ?? null;
		if (nodeId === null || !onNodeMenu) return;
		event.preventDefault();
		clearLongPress(gesture.current);
		if (gesture.current) gesture.current.menuOpened = true;
		// The ContextMenu key reports 0,0: anchor at the focused node instead.
		const box = target?.getBoundingClientRect();
		const keyboard = event.clientX === 0 && event.clientY === 0 && box !== undefined;
		onNodeMenu({ nodeId, x: keyboard ? box.left + box.width / 2 : event.clientX, y: keyboard ? box.top + box.height / 2 : event.clientY });
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const previous = pointers.current.get(event.pointerId);
		const active = gesture.current;
		if (!previous || !active) return;
		const next = { x: event.clientX, y: event.clientY };
		pointers.current.set(event.pointerId, next);
		if (pointers.current.size >= 2) {
			let other: Point | undefined;
			for (const [id, point] of pointers.current) if (id !== event.pointerId) other = point;
			if (!other) return;
			const before = Math.hypot(previous.x - other.x, previous.y - other.y);
			const after = Math.hypot(next.x - other.x, next.y - other.y);
			const rect = event.currentTarget.getBoundingClientRect();
			if (before > 0 && after > 0) {
				zoomBy(after / before, { x: (next.x + other.x) / 2 - rect.left, y: (next.y + other.y) / 2 - rect.top });
			}
			return;
		}
		if (!active.moved) {
			if (Math.hypot(next.x - active.start.x, next.y - active.start.y) < DRAG_THRESHOLD_PX) return;
			active.moved = true;
			clearLongPress(active);
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
			} catch {
				// Pointer capture may end before a drag begins.
			}
		}
		const dx = next.x - previous.x;
		const dy = next.y - previous.y;
		touchedRef.current = true;
		const elapsed = Math.max(1, event.timeStamp - active.lastAt);
		active.velocityX = dx / elapsed;
		active.velocityY = dy / elapsed;
		active.lastAt = event.timeStamp;
		setTransform(current => panBy(current, dx, dy));
	};

	const endPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
		const active = gesture.current;
		clearLongPress(active);
		if (pointers.current.size === 1 && active && !active.moved && !active.menuOpened && active.nodeId !== null && !cancelled) {
			onSelect(active.nodeId);
		}
		pointers.current.delete(event.pointerId);
		if (pointers.current.size === 0) {
			if (active?.moved && !cancelled) {
				inertia.current = startPanInertia(active.velocityX, active.velocityY, (dx, dy) => {
					touchedRef.current = true;
					setTransform(current => panBy(current, dx, dy));
				});
			}
			gesture.current = null;
		}
	};

	if (graph.nodes.length === 0) return <div className="ag-empty">No agents yet</div>;

	return (
		<div className="ag-graph">
			{onToggleKind ? (
				<div className="ag-edgebar" role="group" aria-label="edge kinds">
					{EDGE_KINDS.map(item => {
						const on = visibleKinds.has(item.kind);
						return (
							<button
								key={item.kind}
								type="button"
								className={on ? `ag-edgetoggle ag-edgetoggle--${item.kind} ag-edgetoggle--on` : `ag-edgetoggle ag-edgetoggle--${item.kind}`}
								aria-pressed={on}
								title={item.hint}
								onClick={() => onToggleKind(item.kind)}
							>
								<span className="ag-edgetoggle-swatch" aria-hidden />
								{item.label}
								<span className="ag-edgetoggle-count">{kindCounts[item.kind]}</span>
							</button>
						);
					})}
				</div>
			) : null}
			<div
				ref={frameRef}
				className="ag-graph-frame"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={event => endPointer(event, false)}
				onPointerCancel={event => endPointer(event, true)}
				onContextMenu={onContextMenu}
			>
				<svg className="ag-graph-svg" role="group" aria-label="agent graph" width="100%" height="100%">
					<defs>
						<clipPath id="ag-gclip" clipPathUnits="userSpaceOnUse">
							<rect x={0} y={0} width={NODE_WIDTH - 6} height={NODE_HEIGHT} />
						</clipPath>
						{EDGE_KINDS.filter(item => item.kind !== "spawn").map(item => (
							<marker
								key={item.kind}
								id={`ag-arrow-${item.kind}`}
								className={`ag-arrow ag-arrow--${item.kind}`}
								viewBox="0 0 10 10"
								refX={9}
								refY={5}
								markerWidth={7}
								markerHeight={7}
								orient="auto"
							>
								<path d="M 0 1 L 9 5 L 0 9 z" />
							</marker>
						))}
					</defs>
					<g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
						{visibleKinds.has("spawn")
							? layout.edges.map(edge => {
									const middle = (edge.x2 - edge.x1) / 2;
									return (
										<path
											key={`${edge.from}>${edge.to}`}
											className={runningTargets.has(edge.to) ? "ag-gedge ag-gedge--flow" : "ag-gedge"}
											data-edge={`${edge.from}>${edge.to}`}
											d={`M ${edge.x1} ${edge.y1} C ${edge.x1 + middle} ${edge.y1}, ${edge.x2 - middle} ${edge.y2}, ${edge.x2} ${edge.y2}`}
										/>
									);
								})
							: null}
						{placedMessages.map(placed => (
							<path
								key={`${placed.edge.from}>${placed.edge.to}:${placed.edge.kind}`}
								className={`ag-medge ag-medge--${placed.edge.kind}`}
								data-message-edge={`${placed.edge.from}>${placed.edge.to}`}
								data-kind={placed.edge.kind}
								d={placed.d}
								markerEnd={`url(#ag-arrow-${placed.edge.kind})`}
							/>
						))}
						{layout.nodes.map(placed => {
							if (placed.kind === "batch") {
								const batch = batchById.get(placed.id);
								if (!batch) return null;
								const isCollapsed = collapsed.has(batchCollapseKey(batch.id));
								return (
									<g
										key={batch.id}
										className={`ag-batch ag-batch--${batch.status}`}
										transform={`translate(${placed.x} ${placed.y})`}
										data-batch-id={batch.id}
										role="group"
										aria-label={batchTitle(batch)}
									>
										<rect className="ag-batch-box" width={placed.width} height={placed.height} rx={10} />
										<text className="ag-batch-name" x={12} y={18}>
											{clip(batch.label, 25)}
										</text>
										<text className="ag-batch-count" x={placed.width - 34} y={18} textAnchor="end">
											{batch.childIds.length} agents
										</text>
										<text className="ag-batch-state" x={12} y={38}>
											{batch.detached ? "async" : "blocking"} · {batch.status}
										</text>
										<text className="ag-batch-duration" x={12} y={59}>
											{batch.durationMs === undefined ? "duration unavailable" : `total ${fmtDuration(batch.durationMs)}`}
										</text>
										<g
											className="ag-collapse-toggle ag-batch-toggle"
											transform={`translate(${placed.width - 15} 18)`}
											role="button"
											tabIndex={0}
											aria-expanded={!isCollapsed}
											aria-label={`${isCollapsed ? "Expand" : "Collapse"} task batch ${batch.label}`}
											onPointerDown={event => event.stopPropagation()}
											onClick={event => {
												event.stopPropagation();
												toggleCollapse(batchCollapseKey(batch.id));
											}}
											onKeyDown={event => {
												if (event.key !== "Enter" && event.key !== " ") return;
												event.preventDefault();
												event.stopPropagation();
												toggleCollapse(batchCollapseKey(batch.id));
											}}
										>
											<circle r={8} />
											<text textAnchor="middle" y={4}>
												{isCollapsed ? "+" : "−"}
											</text>
										</g>
										<title>{batchTitle(batch)}</title>
									</g>
								);
							}
							const node = nodeById.get(placed.id);
							if (!node) return null;
							const selected = selectedId === node.id;
							const hasChildren = expandableAgents.has(node.id);
							const isCollapsed = collapsed.has(agentCollapseKey(node.id));
							const meta = `${shortModel(node.model)} · ${node.durationMs === undefined ? "duration unavailable" : fmtDuration(node.durationMs)}`;
							const classes = ["ag-gnode", `ag-gnode--${node.status}`];
							if (node.stalled) classes.push("ag-gnode--stalled");
							if (selected) classes.push("ag-gnode--selected");
							return (
								<g
									key={node.id}
									className={classes.join(" ")}
									transform={`translate(${placed.x} ${placed.y})`}
									data-node-id={node.id}
									role="button"
									tabIndex={0}
									aria-pressed={selected}
									aria-expanded={hasChildren ? !isCollapsed : undefined}
									aria-label={`${node.displayName}, ${node.stalled ? "stalled" : node.status}`}
									onKeyDown={event => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											onSelect(node.id);
										}
									}}
								>
									{node.status === "running" && !node.stalled ? (
										<rect className="ag-gnode-pulse" width={placed.width} height={placed.height} rx={10} />
									) : null}
									<rect className="ag-gnode-box" width={placed.width} height={placed.height} rx={10} />
									<circle className="ag-gnode-dot" cx={16} cy={15} r={5} />
									<g clipPath="url(#ag-gclip)">
										<text className="ag-gnode-name" x={28} y={18}>
											{clip(node.displayName, NAME_CHARS)}
										</text>
										<text className="ag-gnode-status" x={placed.width - (hasChildren ? 30 : 12)} y={18} textAnchor="end">
											{node.stalled ? "stalled" : node.status}
										</text>
										<text className="ag-gnode-activity" x={12} y={36}>
											{clip(node.profile ? `${node.profile} · ${node.activity}` : node.activity, ACTIVITY_CHARS)}
										</text>
										<text className="ag-gnode-meta" x={12} y={52}>
											{clip(meta, META_CHARS)}
										</text>
										<text className="ag-gnode-meta ag-gnode-stats" x={12} y={66}>
											{clip(stats(node), META_CHARS)}
										</text>
									</g>
									{hasChildren ? (
										<g
											className="ag-collapse-toggle ag-agent-toggle"
											transform={`translate(${placed.width - 15} 15)`}
											role="button"
											tabIndex={0}
											aria-expanded={!isCollapsed}
											aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.displayName} subtree`}
											onPointerDown={event => event.stopPropagation()}
											onClick={event => {
												event.stopPropagation();
												toggleCollapse(agentCollapseKey(node.id));
											}}
											onKeyDown={event => {
												if (event.key !== "Enter" && event.key !== " ") return;
												event.preventDefault();
												event.stopPropagation();
												toggleCollapse(agentCollapseKey(node.id));
											}}
										>
											<circle r={8} />
											<text textAnchor="middle" y={4}>
												{isCollapsed ? "+" : "−"}
											</text>
										</g>
									) : null}
									<title>{nodeTitle(node)}</title>
								</g>
							);
						})}
						{placedMessages.map(placed => (
							<g
								key={`badge:${placed.edge.from}>${placed.edge.to}:${placed.edge.kind}`}
								className={`ag-mbadge ag-mbadge--${placed.edge.kind}`}
								data-message-count={`${placed.edge.from}>${placed.edge.to}:${placed.edge.kind}`}
								transform={`translate(${placed.labelX} ${placed.labelY})`}
							>
								<title>{messageEdgeTitle(placed.edge)}</title>
								<rect x={-11} y={-9} width={22} height={18} rx={9} />
								<text textAnchor="middle" y={4}>
									{placed.edge.count}
								</text>
							</g>
						))}
					</g>
				</svg>
				<div className="ag-graph-controls">
					<button type="button" className="ag-iconbtn" aria-label="zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
						<ZoomIn size={15} aria-hidden />
					</button>
					<button type="button" className="ag-iconbtn" aria-label="zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
						<ZoomOut size={15} aria-hidden />
					</button>
					<button type="button" className="ag-iconbtn" aria-label="fit to view" onClick={fit}>
						<Maximize2 size={14} aria-hidden />
					</button>
				</div>
			</div>
			<ul className="ag-legend" aria-label="legend">
				{LEGEND.map(item => (
					<li key={item.key} className="ag-legend-item">
						<span className={`ag-legend-swatch ag-legend-swatch--${item.key}`} aria-hidden />
						{item.label}
					</li>
				))}
			</ul>
		</div>
	);
}
