import type { DraftRun, DraftRunNode } from "@omp-console/protocol";
import { ExternalLink, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import {
	connectError,
	DRAFT_NODE_HEIGHT,
	DRAFT_NODE_WIDTH,
	describeConnectError,
	type DraftEditorNode,
	draftBounds,
	runNodeById,
	runNodeElapsedMs,
	runStateView,
} from "../../lib/draft";
import { fmtDuration } from "../../lib/format";
import { wrapLines } from "../../lib/plan-graph";
import { capturePointer, usePanZoom, ZOOM_STEP } from "./use-pan-zoom";
import "./plan.css";

const MOVE_THRESHOLD_PX = 4;
const TITLE_CHARS = 22;
const TEXT_CHARS = 28;

export type DraftSelection = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string } | null;

interface NodeDrag {
	id: string;
	pointerId: number;
	grab: { x: number; y: number };
	origin: { x: number; y: number };
	moved: boolean;
	startClient: { x: number; y: number };
}

interface ConnectDrag {
	from: string;
	pointerId: number;
	x: number;
	y: number;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function edgePath(from: DraftEditorNode, to: { x: number; y: number }, fromIsNode = true): string {
	const x1 = fromIsNode ? from.x + DRAFT_NODE_WIDTH : from.x;
	const y1 = from.y + DRAFT_NODE_HEIGHT / 2;
	const dx = Math.max(36, Math.abs(to.x - x1) / 2);
	return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/**
 * The draft as an SVG canvas. Editing: drag a node to move it, drag from its right port to another node to say "that
 * one waits for this one", tap an edge to select it. Run view (`run` set): the same picture, read-only, with each
 * node showing its run state. Dependency edges are always dashed: they are user-authored and omp records no such thing.
 */
export function DraftCanvas(props: {
	/** Editor nodes; in run view the run's plan laid out, see `runView`. */
	nodes: readonly DraftEditorNode[];
	selection: DraftSelection;
	/** Node ids with a validation problem to highlight. */
	flagged: ReadonlySet<string>;
	run?: DraftRun;
	now: number;
	onSelect(selection: DraftSelection): void;
	onMove(id: string, x: number, y: number): void;
	onConnect(from: string, to: string): void;
	onOpenAgent(agentId: string): void;
}): ReactNode {
	const { nodes, selection, flagged, run, now, onSelect, onMove, onConnect, onOpenAgent } = props;
	const editable = run === undefined;
	const bounds = useMemo(() => draftBounds(nodes), [nodes]);
	const zoom = usePanZoom(bounds, { onTap: () => onSelect(null) });
	const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
	const nodeDrag = useRef<NodeDrag | null>(null);
	const connectRef = useRef<ConnectDrag | null>(null);
	const [connect, setConnect] = useState<ConnectDrag | null>(null);
	const [hint, setHint] = useState<string | null>(null);
	const { transform } = zoom;

	const edges = useMemo(
		() => nodes.flatMap(node => node.dependsOn.map(dep => ({ from: dep, to: node.id }))).filter(edge => byId.has(edge.from)),
		[nodes, byId],
	);

	const onDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		zoom.bind.onPointerDown(event);
		if (!editable || event.button !== 0 || !(event.target instanceof Element)) return;
		const port = event.target.closest("[data-port-out]");
		const nodeEl = event.target.closest("[data-draft-node]");
		const id = nodeEl?.getAttribute("data-draft-node");
		if (!id) return;
		const node = byId.get(id);
		if (!node) return;
		setHint(null);
		const at = zoom.toContent(event.clientX, event.clientY);
		if (port) {
			capturePointer(event.currentTarget, event.pointerId);
			connectRef.current = { from: id, pointerId: event.pointerId, x: at.x, y: at.y };
			setConnect(connectRef.current);
			return;
		}
		capturePointer(event.currentTarget, event.pointerId);
		nodeDrag.current = {
			id,
			pointerId: event.pointerId,
			grab: { x: at.x - node.x, y: at.y - node.y },
			origin: { x: node.x, y: node.y },
			moved: false,
			startClient: { x: event.clientX, y: event.clientY },
		};
	};

	const onMoveEvent = (event: ReactPointerEvent<HTMLDivElement>): void => {
		zoom.bind.onPointerMove(event);
		const drag = nodeDrag.current;
		if (drag && drag.pointerId === event.pointerId) {
			if (!drag.moved && Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) < MOVE_THRESHOLD_PX) return;
			drag.moved = true;
			const at = zoom.toContent(event.clientX, event.clientY);
			onMove(drag.id, Math.max(0, Math.round(at.x - drag.grab.x)), Math.max(0, Math.round(at.y - drag.grab.y)));
			return;
		}
		const dragging = connectRef.current;
		if (dragging && dragging.pointerId === event.pointerId) {
			const at = zoom.toContent(event.clientX, event.clientY);
			const next = { ...dragging, x: at.x, y: at.y };
			connectRef.current = next;
			setConnect(next);
		}
	};

	const finish = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
		if (cancelled) zoom.bind.onPointerCancel(event);
		else zoom.bind.onPointerUp(event);
		const drag = nodeDrag.current;
		if (drag && drag.pointerId === event.pointerId) {
			nodeDrag.current = null;
			if (!drag.moved && !cancelled) onSelect({ kind: "node", id: drag.id });
			return;
		}
		const dragging = connectRef.current;
		if (dragging && dragging.pointerId === event.pointerId) {
			connectRef.current = null;
			setConnect(null);
			if (cancelled) return;
			const under = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-draft-node]");
			const to = under?.getAttribute("data-draft-node");
			if (!to) return;
			const error = connectError({ nodes }, dragging.from, to);
			if (error !== null) setHint(describeConnectError(error));
			else onConnect(dragging.from, to);
		}
	};

	const from = connect ? byId.get(connect.from) : undefined;

	return (
		<div className="dc">
			<div
				ref={zoom.frameRef}
				className="dc-frame"
				data-editable={editable}
				tabIndex={0}
				aria-label={editable ? "draft canvas" : "draft run"}
				onPointerDown={onDown}
				onPointerMove={onMoveEvent}
				onPointerUp={event => finish(event, false)}
				onPointerCancel={event => finish(event, true)}
			>
				<svg className="dc-svg" role="group" aria-label="draft graph" width="100%" height="100%">
					<defs>
						<marker id="dc-arrow" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto">
							<path d="M 0 1 L 9 5 L 0 9 z" />
						</marker>
						<clipPath id="dc-clip" clipPathUnits="userSpaceOnUse">
							<rect x={0} y={0} width={DRAFT_NODE_WIDTH - 10} height={DRAFT_NODE_HEIGHT} />
						</clipPath>
					</defs>
					<g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
						{edges.map(edge => {
							const a = byId.get(edge.from);
							const b = byId.get(edge.to);
							if (!a || !b) return null;
							const key = `${edge.from}>${edge.to}`;
							const selected = selection?.kind === "edge" && selection.from === edge.from && selection.to === edge.to;
							const state = runNodeById(run, edge.from)?.state;
							const classes = ["dc-edge"];
							if (selected) classes.push("dc-edge--selected");
							if (state) classes.push(`dc-edge--${state}`);
							const d = edgePath(a, { x: b.x, y: b.y + DRAFT_NODE_HEIGHT / 2 });
							return (
								<g key={key} data-draft-edge={key}>
									<path className={classes.join(" ")} d={d} markerEnd="url(#dc-arrow)" />
									{editable ? (
										<path
											className="dc-edge-hit"
											d={d}
											data-no-pan
											onClick={event => {
												event.stopPropagation();
												onSelect({ kind: "edge", from: edge.from, to: edge.to });
											}}
										/>
									) : null}
								</g>
							);
						})}
						{connect && from ? (
							<path className="dc-edge dc-edge--ghost" d={edgePath(from, { x: connect.x, y: connect.y })} markerEnd="url(#dc-arrow)" />
						) : null}
						{nodes.map(node => (
							<DraftNodeView
								key={node.id}
								node={node}
								selected={selection?.kind === "node" && selection.id === node.id}
								flagged={flagged.has(node.id)}
								runNode={runNodeById(run, node.id)}
								editable={editable}
								now={now}
								isTarget={connect !== null && connect.from !== node.id}
								onOpenAgent={onOpenAgent}
								onActivate={() => onSelect({ kind: "node", id: node.id })}
							/>
						))}
					</g>
				</svg>
				{nodes.length === 0 ? (
					<div className="dc-empty">
						<strong>Draw a plan.</strong> Add tasks, then drag from a task's right dot to the task that must wait for it.
					</div>
				) : null}
				<div className="dc-badge" title="omp records no dependencies between tasks; this graph is drawn by you and run by omp console">
					draft · dashed lines are yours, not omp's
				</div>
				{hint !== null ? (
					<div className="dc-hint" role="alert">
						{hint}
					</div>
				) : null}
				<div className="ag-graph-controls">
					<button type="button" className="ag-iconbtn" aria-label="zoom in" onClick={() => zoom.zoomBy(ZOOM_STEP)}>
						<ZoomIn size={15} aria-hidden />
					</button>
					<button type="button" className="ag-iconbtn" aria-label="zoom out" onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}>
						<ZoomOut size={15} aria-hidden />
					</button>
					<button type="button" className="ag-iconbtn" aria-label="fit to view" onClick={zoom.fit}>
						<Maximize2 size={14} aria-hidden />
					</button>
				</div>
			</div>
		</div>
	);
}

function DraftNodeView(props: {
	node: DraftEditorNode;
	selected: boolean;
	flagged: boolean;
	runNode: DraftRunNode | undefined;
	editable: boolean;
	now: number;
	isTarget: boolean;
	onActivate(): void;
	onOpenAgent(agentId: string): void;
}): ReactNode {
	const { node, selected, flagged, runNode, editable, now, isTarget, onOpenAgent, onActivate } = props;
	const classes = ["dn"];
	if (selected) classes.push("dn--selected");
	if (flagged) classes.push("dn--flagged");
	if (isTarget) classes.push("dn--target");
	const view = runNode ? runStateView(runNode.state) : null;
	if (view) classes.push(`dn--${view.tone}`);
	const elapsed = runNode ? runNodeElapsedMs(runNode, now) : undefined;
	const title = node.title.trim() || "(untitled task)";
	const lines = wrapLines(node.instruction.trim() || "no instruction yet", TEXT_CHARS, 1);
	const label = `${title}, ${view ? view.label : node.profile || "No agent profile"}`;
	return (
		<g
			className={classes.join(" ")}
			transform={`translate(${node.x} ${node.y})`}
			data-draft-node={node.id}
			data-no-pan
			role="button"
			tabIndex={0}
			aria-label={label}
			onKeyDown={event => {
				if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault();
					onActivate();
				}
			}}
		>
			<rect className="dn-box" width={DRAFT_NODE_WIDTH} height={DRAFT_NODE_HEIGHT} rx={10} />
			{view?.tone === "running" ? <rect className="dn-pulse" width={DRAFT_NODE_WIDTH} height={DRAFT_NODE_HEIGHT} rx={10} /> : null}
			<g clipPath="url(#dc-clip)">
				<text className="dn-title" x={14} y={22}>
					{clip(title, TITLE_CHARS)}
				</text>
				<text className={node.profile ? "dn-profile" : "dn-profile dn-profile--missing"} x={14} y={40}>
					{node.profile ? clip(node.profile, 24) : "No agent profile"}
					{node.isolated ? " · isolated" : ""}
				</text>
				{view ? (
					<text className="dn-state" x={14} y={58}>
						{view.label}
						{elapsed !== undefined ? ` · ${fmtDuration(elapsed)}` : ""}
					</text>
				) : (
					<text className="dn-text" x={14} y={58}>
						{lines[0]}
					</text>
				)}
			</g>
			{runNode?.agentId ? (
				<g
					className="dn-open"
					transform={`translate(${DRAFT_NODE_WIDTH - 26} 6)`}
					data-no-pan
					role="link"
					tabIndex={0}
					aria-label={`open agent for ${title}`}
					onPointerDown={event => event.stopPropagation()}
					onClick={event => {
						event.stopPropagation();
						if (runNode.agentId) onOpenAgent(runNode.agentId);
					}}
					onKeyDown={event => {
						if ((event.key === "Enter" || event.key === " ") && runNode.agentId) {
							event.preventDefault();
							onOpenAgent(runNode.agentId);
						}
					}}
				>
					<rect width={20} height={20} rx={6} />
					<ExternalLink x={4} y={4} size={12} aria-hidden />
				</g>
			) : null}
			{editable ? (
				<>
					<circle className="dn-port dn-port--in" cx={0} cy={DRAFT_NODE_HEIGHT / 2} r={5} />
					<circle className="dn-port-hit" data-port-out cx={DRAFT_NODE_WIDTH} cy={DRAFT_NODE_HEIGHT / 2} r={13} />
					<circle className="dn-port dn-port--out" cx={DRAFT_NODE_WIDTH} cy={DRAFT_NODE_HEIGHT / 2} r={5.5} pointerEvents="none" />
				</>
			) : null}
		</g>
	);
}

