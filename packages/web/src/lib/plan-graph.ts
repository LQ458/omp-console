/**
 * The todo board (`todo` tool result: phases of tasks) laid out as a graph: one column per phase, one node per task.
 * omp records phase -> task membership and nothing else (no ordering between tasks, no owner), so the only extra
 * relation drawn is "an agent seems to be working on this task", and it is matched by text and labelled inferred.
 */
import type { TodoBoard, TodoStatus } from "./todos";

export interface PlanAgent {
	id: string;
	name: string;
	/** Whatever the agent was given: lifecycle description, progress task, or the first user message. */
	task: string;
}

export interface PlanAgentLink {
	agentId: string;
	agentName: string;
	/** 0..1 word overlap between the task text and the agent's assignment. */
	score: number;
}

export interface PlanTaskNode {
	id: string;
	phase: number;
	index: number;
	content: string;
	status: TodoStatus;
	x: number;
	y: number;
	width: number;
	height: number;
	/** At most one running agent; always an inference. */
	agent?: PlanAgentLink;
}

export interface PlanPhaseNode {
	id: string;
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
	done: number;
	total: number;
}

export interface PlanMembershipEdge {
	phaseId: string;
	taskId: string;
	/** Elbow from the phase header down a spine to the task. */
	d: string;
}

export interface PlanGraphLayout {
	phases: PlanPhaseNode[];
	tasks: PlanTaskNode[];
	edges: PlanMembershipEdge[];
	width: number;
	height: number;
}

export const PLAN_COL_WIDTH = 216;
export const PLAN_COL_GAP = 28;
export const PLAN_HEADER_HEIGHT = 46;
export const PLAN_TASK_HEIGHT = 66;
export const PLAN_ROW_GAP = 14;
export const PLAN_PADDING = 20;
const SPINE_INSET = 9;
const TASK_INDENT = 20;

/** Below this overlap a text pair is not called a match. */
export const MATCH_THRESHOLD = 0.6;

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "then", "all", "are", "was", "not"]);

function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (word.length >= 3 && !STOP.has(word)) out.add(word);
	}
	return out;
}

/**
 * Overlap of a todo task and an agent's assignment, in 0..1: the share of the shorter text's words found in the
 * other. One text containing the other wins outright. Texts with fewer than two meaningful words must match fully;
 * a single shared word out of several never counts.
 */
export function matchScore(taskText: string, agentText: string): number {
	const a = taskText.toLowerCase().replace(/\s+/g, " ").trim();
	const b = agentText.toLowerCase().replace(/\s+/g, " ").trim();
	if (a === "" || b === "") return 0;
	if (a.length >= 8 && b.includes(a)) return 1;
	if (b.length >= 8 && a.includes(b)) return 1;
	const ta = tokens(a);
	const tb = tokens(b);
	const small = ta.size <= tb.size ? ta : tb;
	const large = small === ta ? tb : ta;
	if (small.size === 0) return 0;
	let shared = 0;
	for (const word of small) if (large.has(word)) shared++;
	if (shared < Math.min(2, small.size)) return 0;
	return shared / small.size;
}

/**
 * One agent per task and one task per agent, best matches first; an in-progress task wins a tie. Only pairs at or
 * above `MATCH_THRESHOLD` link.
 */
export function linkAgentsToTasks(board: TodoBoard, agents: readonly PlanAgent[]): Map<string, PlanAgentLink> {
	const candidates: Array<{ taskId: string; agent: PlanAgent; score: number; rank: number }> = [];
	board.phases.forEach((phase, p) => {
		phase.tasks.forEach((task, t) => {
			if (task.status === "completed" || task.status === "abandoned") return;
			for (const agent of agents) {
				const score = matchScore(task.content, agent.task);
				if (score >= MATCH_THRESHOLD) {
					candidates.push({ taskId: taskId(p, t), agent, score, rank: task.status === "in_progress" ? 1 : 0 });
				}
			}
		});
	});
	candidates.sort((x, y) => y.score - x.score || y.rank - x.rank || x.taskId.localeCompare(y.taskId));
	const links = new Map<string, PlanAgentLink>();
	const usedAgents = new Set<string>();
	for (const c of candidates) {
		if (links.has(c.taskId) || usedAgents.has(c.agent.id)) continue;
		links.set(c.taskId, { agentId: c.agent.id, agentName: c.agent.name, score: Math.round(c.score * 100) / 100 });
		usedAgents.add(c.agent.id);
	}
	return links;
}

export function taskId(phase: number, index: number): string {
	return `p${phase}t${index}`;
}

/** Phases as columns, tasks stacked under their phase header, in the order the todo tool reports them. */
export function layoutPlanGraph(board: TodoBoard, agents: readonly PlanAgent[]): PlanGraphLayout {
	const links = linkAgentsToTasks(board, agents);
	const phases: PlanPhaseNode[] = [];
	const tasks: PlanTaskNode[] = [];
	const edges: PlanMembershipEdge[] = [];
	let tallest = 0;
	board.phases.forEach((phase, p) => {
		const x = PLAN_PADDING + p * (PLAN_COL_WIDTH + PLAN_COL_GAP);
		const phaseNode: PlanPhaseNode = {
			id: `p${p}`,
			name: phase.name,
			x,
			y: PLAN_PADDING,
			width: PLAN_COL_WIDTH,
			height: PLAN_HEADER_HEIGHT,
			done: phase.tasks.filter(task => task.status === "completed").length,
			total: phase.tasks.length,
		};
		phases.push(phaseNode);
		const spineX = x + SPINE_INSET;
		let y = PLAN_PADDING + PLAN_HEADER_HEIGHT + PLAN_ROW_GAP;
		phase.tasks.forEach((task, t) => {
			const id = taskId(p, t);
			const node: PlanTaskNode = {
				id,
				phase: p,
				index: t,
				content: task.content,
				status: task.status,
				x: x + TASK_INDENT,
				y,
				width: PLAN_COL_WIDTH - TASK_INDENT,
				height: PLAN_TASK_HEIGHT,
				agent: links.get(id),
			};
			tasks.push(node);
			const midY = y + PLAN_TASK_HEIGHT / 2;
			edges.push({
				phaseId: phaseNode.id,
				taskId: id,
				d: `M ${spineX} ${PLAN_PADDING + PLAN_HEADER_HEIGHT} V ${midY} H ${node.x}`,
			});
			y += PLAN_TASK_HEIGHT + PLAN_ROW_GAP;
		});
		tallest = Math.max(tallest, y - PLAN_ROW_GAP);
	});
	const columns = Math.max(1, board.phases.length);
	return {
		phases,
		tasks,
		edges,
		width: PLAN_PADDING * 2 + columns * PLAN_COL_WIDTH + (columns - 1) * PLAN_COL_GAP,
		height: Math.max(tallest, PLAN_PADDING + PLAN_HEADER_HEIGHT) + PLAN_PADDING,
	};
}

/** Word-wraps for SVG text: at most `maxLines` lines of `maxChars`, the last one ending in an ellipsis when cut. */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (let i = 0; i < words.length; i++) {
		let word = words[i]!;
		if (word.length > maxChars) word = `${word.slice(0, maxChars - 1)}…`;
		const next = line === "" ? word : `${line} ${word}`;
		if (next.length <= maxChars) {
			line = next;
			continue;
		}
		lines.push(line);
		line = word;
		if (lines.length === maxLines) break;
	}
	if (lines.length < maxLines && line !== "") lines.push(line);
	const consumed = lines.join(" ").split(" ").length;
	if (consumed < words.length) {
		const last = lines[maxLines - 1] ?? lines[lines.length - 1] ?? "";
		lines[Math.min(lines.length, maxLines) - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
	}
	return lines.slice(0, maxLines);
}
