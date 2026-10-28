import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { type InstructContext, TaskNodeMenu } from "../agents/NodeMenu";
import { OmpEquivalent } from "../agents/OmpEquivalent";
import {
	layoutPlanGraph,
	type PlanAgent,
	type PlanTaskNode,
	PLAN_COL_WIDTH,
	PLAN_TASK_HEIGHT,
	wrapLines,
} from "../../lib/plan-graph";
import type { TodoBoard, TodoStatus } from "../../lib/todos";
import { ZOOM_STEP, usePanZoom } from "./use-pan-zoom";
import "./plan.css";

const TEXT_CHARS = 27;
const CHIP_CHARS = 24;

const STATUS_LABEL: Record<TodoStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	completed: "completed",
	abandoned: "abandoned",
};
const LEGEND: readonly TodoStatus[] = ["in_progress", "pending", "completed", "abandoned"];

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function Canvas(props: {
	board: TodoBoard;
	agents: readonly PlanAgent[];
	ctx: InstructContext | null;
}): ReactNode {
	const { board, agents, ctx } = props;
	const layout = useMemo(() => layoutPlanGraph(board, agents), [board, agents]);
	const taskById = useMemo(() => new Map(layout.tasks.map(task => [task.id, task])), [layout]);
	const [menu, setMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);

	const open = (target: Element, at?: { x: number; y: number }): void => {
		const node = target.closest("[data-task-id]");
		const chip = target.closest("[data-agent-chip]");
		if (chip && ctx) {
			const id = chip.getAttribute("data-agent-chip");
			if (id) ctx.onOpenAgent(id);
			return;
		}
		const taskId = node?.getAttribute("data-task-id");
		if (!node || !taskId || !ctx) return;
		const box = node.getBoundingClientRect();
		setMenu({ taskId, x: at?.x ?? box.left + box.width / 2, y: at?.y ?? box.bottom });
	};

	const zoom = usePanZoom(layout, {
		onTap: target => open(target),
		onLongPress: (target, at) => open(target, at),
	});
	const { transform } = zoom;
	const menuTask = menu ? taskById.get(menu.taskId) : undefined;

	return (
		<div className="pg">
			<div
				ref={zoom.frameRef}
				className="pg-frame"
				{...zoom.bind}
				onContextMenu={event => {
					const node = event.target instanceof Element ? event.target.closest("[data-task-id]") : null;
					if (!node || !ctx) return;
					event.preventDefault();
					const taskId = node.getAttribute("data-task-id");
					if (taskId) setMenu({ taskId, x: event.clientX || node.getBoundingClientRect().left, y: event.clientY || node.getBoundingClientRect().bottom });
				}}
			>
				<svg className="pg-svg" role="group" aria-label="plan graph" width="100%" height="100%">
					<defs>
						<clipPath id="pg-tclip" clipPathUnits="userSpaceOnUse">
							<rect x={0} y={0} width={(layout.tasks[0]?.width ?? PLAN_COL_WIDTH) - 8} height={PLAN_TASK_HEIGHT} />
						</clipPath>
					</defs>
					<g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
						{layout.edges.map(edge => (
							<path key={`${edge.phaseId}>${edge.taskId}`} className="pg-member" data-member={`${edge.phaseId}>${edge.taskId}`} d={edge.d} />
						))}
						{layout.phases.map(phase => (
							<g key={phase.id} className="pg-phase" data-phase-id={phase.id} transform={`translate(${phase.x} ${phase.y})`}>
								<rect className="pg-phase-box" width={phase.width} height={phase.height} rx={10} />
								<text className="pg-phase-name" x={12} y={20}>
									{clip(phase.name || "(unnamed phase)", 22)}
								</text>
								<text className="pg-phase-count" x={phase.width - 12} y={20} textAnchor="end">
									{phase.done}/{phase.total}
								</text>
								<rect className="pg-phase-track" x={12} y={30} width={phase.width - 24} height={4} rx={2} />
								<rect
									className="pg-phase-fill"
									x={12}
									y={30}
									width={phase.total === 0 ? 0 : ((phase.width - 24) * phase.done) / phase.total}
									height={4}
									rx={2}
								/>
							</g>
						))}
						{layout.tasks.map(task => (
							<TaskNode key={task.id} task={task} selected={menu?.taskId === task.id} onActivate={target => open(target)} />
						))}
					</g>
				</svg>
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
			<ul className="ag-legend" aria-label="legend">
				{LEGEND.map(status => (
					<li key={status} className="ag-legend-item">
						<span className={`pg-swatch pg-swatch--${status}`} aria-hidden />
						{STATUS_LABEL[status]}
					</li>
				))}
				<li className="ag-legend-item">
					<span className="pg-swatch pg-swatch--link" aria-hidden />
					agent working on it (inferred from the task text)
				</li>
			</ul>
			<div className="pg-foot">
				<span>omp keeps phases and tasks only; it records no order between tasks and no owner.</span>
				<OmpEquivalent text="/todo" />
			</div>
			{menu && menuTask && ctx ? <TaskNodeMenu task={menuTask} x={menu.x} y={menu.y} ctx={ctx} onClose={() => setMenu(null)} /> : null}
		</div>
	);
}

function TaskNode(props: { task: PlanTaskNode; selected: boolean; onActivate(target: Element): void }): ReactNode {
	const { task, selected, onActivate } = props;
	const lines = wrapLines(task.content, TEXT_CHARS, 2);
	const classes = ["pg-task", `pg-task--${task.status}`];
	if (selected) classes.push("pg-task--selected");
	if (task.agent) classes.push("pg-task--linked");
	return (
		<g
			className={classes.join(" ")}
			transform={`translate(${task.x} ${task.y})`}
			data-task-id={task.id}
			role="button"
			tabIndex={0}
			aria-label={`${task.content}, ${STATUS_LABEL[task.status]}${task.agent ? `, ${task.agent.agentName} seems to be working on it` : ""}`}
			onKeyDown={event => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onActivate(event.currentTarget);
				}
			}}
		>
			<title>{task.content}</title>
			<rect className="pg-task-box" width={task.width} height={task.height} rx={9} />
			<rect className="pg-task-stripe" x={0} y={0} width={5} height={task.height} rx={2.5} />
			<g clipPath="url(#pg-tclip)">
				{lines.map((line, i) => (
					<text key={`${i}:${line}`} className="pg-task-text" x={16} y={21 + i * 15}>
						{line}
					</text>
				))}
			</g>
			{task.agent ? (
				<g className="pg-chip" data-agent-chip={task.agent.agentId} transform={`translate(12 ${task.height - 24})`}>
					<title>{`${task.agent.agentName}: inferred from matching task text (${Math.round(task.agent.score * 100)}%)`}</title>
					<rect width={task.width - 24} height={18} rx={9} />
					<text x={9} y={12.5}>
						{`↔ ${clip(task.agent.agentName, CHIP_CHARS - 10)} · inferred`}
					</text>
				</g>
			) : (
				<text className="pg-task-status" x={16} y={task.height - 11}>
					{STATUS_LABEL[task.status]}
				</text>
			)}
		</g>
	);
}

/** The todo board as a graph: phases as columns, tasks coloured by status, tap a task for what you can do with it. */
export function PlanGraphView(props: {
	board: TodoBoard | null;
	agents: readonly PlanAgent[];
	/** Null: no actions (no menu). */
	ctx: InstructContext | null;
}): ReactNode {
	const { board, agents, ctx } = props;
	if (board === null) {
		return (
			<div className="pg pg--empty">
				<div className="ag-empty">No todo list yet. When the agent writes one with the todo tool, its phases and tasks appear here.</div>
				<div className="pg-foot">
					<OmpEquivalent text="/todo" />
				</div>
			</div>
		);
	}
	return <Canvas board={board} agents={agents} ctx={ctx} />;
}

