/**
 * Agent tree for one session: frame payloads in, nodes, edges and a deterministic left-to-right task-batch layout out.
 *
 * Inputs are what the collab host sends: the `agents` frame (`AgentSnapshot`: id, parentId, status, activity
 * time) plus the `task:subagent:progress` / `task:subagent:lifecycle` bus payloads (activity text, model, tokens,
 * cost, final outcome). Everything here is pure; `now` is passed in so tests control the clock.
 *
 * Defensive on purpose: the host is trusted but the frames are not validated upstream. Duplicate ids keep the
 * first entry, a parent that is not listed (or is the node itself) makes the node a root, and a parent cycle is
 * broken at its oldest member: that edge stays in `edges` flagged `cycle` and is not laid out.
 */
import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { fmtAge, fmtDuration } from "./format";

/** A running agent with no activity for this long is flagged stalled (rubric: stuck = 120 s without an event). */
export const STALL_AFTER_MS = 120_000;

/**
 * `finished` and `failed` come from the lifecycle bus (the registry only knows `running | idle | parked |
 * aborted`); a plain `idle` main agent keeps its own state.
 */
export type AgentGraphStatus = "running" | "idle" | "parked" | "finished" | "failed" | "aborted";

export interface AgentNode {
	id: string;
	/** What the node is called: a subagent's own name (the task name it was spawned with), else omp's label. */
	displayName: string;
	/** Agent profile of a named subagent (omp's `displayName` for subagents), shown under the name. */
	profile?: string;
	kind: AgentSnapshot["kind"];
	/** Resolved parent: null for roots (no parentId, unlisted parent, self-parent, or a broken cycle). */
	parentId: string | null;
	depth: number;
	status: AgentGraphStatus;
	stalled: boolean;
	/** Epoch ms of the newest activity signal (host `lastActivity`, or a progress frame seen later). */
	lastSignalAt: number;
	hasSessionFile: boolean;
	createdAt: number;
	/** Spawn-call grouping metadata; absent parentToolCallId is kept as a single-agent group. */
	parentToolCallId?: string;
	spawnIndex: number;
	task?: string;
	detached?: boolean;
	/** One line: current tool, intent, or the status. */
	activity: string;
	model?: string;
	tokens?: number;
	cost?: number;
	durationMs?: number;
	toolCount?: number;
}

export interface AgentBatch {
	id: string;
	parentId: string;
	/** Children in the task call's `index` order. */
	childIds: string[];
	label: string;
	index: number;
	/** Earliest child creation time; used to order task calls top-to-bottom. */
	startAt: number;
	detached: boolean;
	status: AgentGraphStatus;
	/** Sum of member durations, representing total agent runtime for the call. */
	durationMs?: number;
}

export interface AgentEdge {
	from: string;
	to: string;
	/** Dropped from the layout to break a parent cycle. */
	cycle: boolean;
}

export interface AgentGraph {
	/** Pre-order (parents before children, siblings by creation time): the order of the indented tree. */
	nodes: AgentNode[];
	/** Task-call groups, including singleton groups that collapse into their agent node in the graph. */
	batches: AgentBatch[];
	edges: AgentEdge[];
	roots: string[];
}

export interface AgentGraphInput {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Browser time each agent's progress last changed (see `ProgressSeen`); optional. */
	progressSeenAt?: ReadonlyMap<string, number>;
	now: number;
	/** Host `state.isStreaming` of the session; `false` shows the main agent idle. Unknown (undefined) keeps the registry status. */
	mainWorking?: boolean;
}

function compareAgents(a: AgentSnapshot, b: AgentSnapshot): number {
	if (a.kind !== b.kind) return a.kind === "main" ? -1 : 1;
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareSpawnOrder(a: AgentNode, b: AgentNode): number {
	return a.spawnIndex - b.spawnIndex || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function compareAgentStart(a: AgentNode, b: AgentNode): number {
	return a.createdAt - b.createdAt || a.spawnIndex - b.spawnIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function payloadDetached(
	payload: SubagentLifecyclePayload | SubagentProgressPayload | undefined,
): boolean | undefined {
	if (payload !== undefined && "detached" in payload && typeof payload.detached === "boolean") return payload.detached;
	return undefined;
}

/** Registry status refined by the bus: a revived agent is `running` again whatever its old lifecycle said. */
export function graphStatus(
	agent: AgentSnapshot,
	lifecycle: SubagentLifecyclePayload | undefined,
	progress: SubagentProgressPayload | undefined,
): AgentGraphStatus {
	if (agent.status === "running") return "running";
	if (agent.status === "aborted") return "aborted";
	if (lifecycle?.status === "failed" || progress?.progress.status === "failed") return "failed";
	if (lifecycle?.status === "aborted") return "aborted";
	if (agent.status === "parked") {
		return lifecycle?.status === "completed" || progress?.progress.status === "completed" ? "finished" : "parked";
	}
	return agent.kind === "sub" && lifecycle?.status === "completed" ? "finished" : "idle";
}

/** Same wording the rail shows: the running tool with its elapsed time, else the last intent, else the status. */
export function agentActivityLine(
	status: AgentGraphStatus,
	progress: SubagentProgressPayload | undefined,
	now: number,
): string {
	const p = progress?.progress;
	if (status === "running" && p?.currentTool) {
		const start = p.currentToolStartMs ?? p.recentTools[0]?.endMs;
		return typeof start === "number" ? `${p.currentTool} · ${fmtDuration(Math.max(0, now - start))}` : p.currentTool;
	}
	if (status === "running" && p?.lastIntent) return p.lastIntent;
	if (status === "running") return "running";
	if (status === "finished") return "completed";
	return status;
}
function aggregateBatchStatus(members: readonly AgentNode[]): AgentGraphStatus {
	if (members.some(node => node.status === "failed")) return "failed";
	if (members.some(node => node.status === "running")) return "running";
	if (members.some(node => node.status === "aborted")) return "aborted";
	if (members.some(node => node.status === "parked")) return "parked";
	if (members.some(node => node.status === "idle")) return "idle";
	return "finished";
}

function buildAgentBatches(nodes: readonly AgentNode[]): AgentBatch[] {
	const byParent = new Map<string, Map<string, AgentNode[]>>();
	for (const node of nodes) {
		if (node.parentId === null) continue;
		let groups = byParent.get(node.parentId);
		if (!groups) {
			groups = new Map();
			byParent.set(node.parentId, groups);
		}
		const key = node.parentToolCallId === undefined ? `agent:${node.id}` : `tool:${node.parentToolCallId}`;
		const members = groups.get(key);
		if (members) members.push(node);
		else groups.set(key, [node]);
	}

	const usedIds = new Set<string>();
	for (const node of nodes) usedIds.add(node.id);
	const batches: AgentBatch[] = [];
	for (const [parentId, groups] of byParent) {
		const ordered: Array<{ key: string; members: AgentNode[]; startAt: number; index: number }> = [];
		for (const [key, members] of groups) {
			members.sort(compareSpawnOrder);
			let startAt = Number.POSITIVE_INFINITY;
			let index = Number.POSITIVE_INFINITY;
			for (const member of members) {
				if (member.createdAt < startAt) startAt = member.createdAt;
				if (member.spawnIndex < index) index = member.spawnIndex;
			}
			ordered.push({ key, members, startAt, index });
		}
		ordered.sort((a, b) => a.startAt - b.startAt || a.index - b.index || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		for (let i = 0; i < ordered.length; i++) {
			const group = ordered[i]!;
			let id = `batch:${encodeURIComponent(JSON.stringify([parentId, group.key]))}`;
			while (usedIds.has(id)) id += ":";
			usedIds.add(id);
			let durationMs = 0;
			let hasDuration = false;
			for (const member of group.members) {
				if (member.durationMs === undefined) continue;
				durationMs += member.durationMs;
				hasDuration = true;
			}
			let label: string | undefined;
			for (const member of group.members) {
				const task = member.task?.trim();
				if (task) {
					label = task;
					break;
				}
			}
			batches.push({
				id,
				parentId,
				childIds: group.members.map(node => node.id),
				label: label ?? `batch ${i + 1}`,
				index: group.index,
				startAt: group.startAt,
				detached: group.members.some(node => node.detached === true),
				status: aggregateBatchStatus(group.members),
				...(hasDuration ? { durationMs } : {}),
			});
		}
	}
	return batches.sort((a, b) => (a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0) || a.startAt - b.startAt || a.index - b.index);
}

export function agentCollapseKey(id: string): string {
	return `agent:${id}`;
}

export function batchCollapseKey(id: string): string {
	return `batch:${id}`;
}

const EMPTY_COLLAPSED = new Set<string>();

function compareBatch(a: AgentBatch, b: AgentBatch): number {
	return a.startAt - b.startAt || a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function collapseLabel(kind: "agent" | "batch", id: string, collapsed: ReadonlySet<string>): boolean {
	return collapsed.has(kind === "agent" ? agentCollapseKey(id) : batchCollapseKey(id));
}

export function buildAgentGraph(input: AgentGraphInput): AgentGraph {
	const { progress, lifecycle, progressSeenAt, now } = input;
	const byId = new Map<string, AgentSnapshot>();
	for (const agent of input.agents) if (!byId.has(agent.id)) byId.set(agent.id, agent);
	const sorted = [...byId.values()].sort(compareAgents);

	const parentOf = new Map<string, string>();
	const children = new Map<string, AgentSnapshot[]>();
	for (const agent of sorted) {
		const parent = agent.parentId;
		if (parent === undefined || parent === agent.id || !byId.has(parent)) continue;
		parentOf.set(agent.id, parent);
		const siblings = children.get(parent);
		if (siblings) siblings.push(agent);
		else children.set(parent, [agent]);
	}

	const nodes: AgentNode[] = [];
	const roots: string[] = [];
	const placed = new Set<string>();
	const promotedByCycle = new Set<string>();

	const visit = (root: AgentSnapshot): void => {
		// Iterative pre-order: a pathological chain must not overflow the call stack.
		const stack: Array<{ agent: AgentSnapshot; depth: number; parent: string | null }> = [
			{ agent: root, depth: 0, parent: null },
		];
		while (stack.length > 0) {
			const { agent, depth, parent } = stack.pop()!;
			if (placed.has(agent.id)) continue;
			placed.add(agent.id);
			nodes.push(toNode(agent, depth, parent));
			const kids = children.get(agent.id);
			if (!kids) continue;
			for (let i = kids.length - 1; i >= 0; i--) stack.push({ agent: kids[i]!, depth: depth + 1, parent: agent.id });
		}
	};

	const toNode = (agent: AgentSnapshot, depth: number, parent: string | null): AgentNode => {
		const prog = progress.get(agent.id);
		const life = lifecycle.get(agent.id);
		const registryStatus = graphStatus(agent, life, prog);
		// The registry lists the main agent as `running` for the whole life of the session; it is busy only while a
		// turn streams (host `state.isStreaming`), so an idle session must not read as a stalled agent.
		const status = agent.kind === "main" && input.mainWorking === false && registryStatus === "running" ? "idle" : registryStatus;
		const lastSignalAt = Math.max(agent.lastActivity, progressSeenAt?.get(agent.id) ?? 0);
		const p = prog?.progress;
		const stalled = status === "running" && now - lastSignalAt >= STALL_AFTER_MS;
		const durationMs = p?.durationMs ?? (status === "running" ? Math.max(0, now - agent.createdAt) : undefined);
		return {
			id: agent.id,
			displayName: agent.kind === "sub" && agent.id !== agent.displayName ? agent.id : agent.displayName,
			...(agent.kind === "sub" && agent.id !== agent.displayName ? { profile: agent.displayName } : {}),
			kind: agent.kind,
			parentId: parent,
			depth,
			status,
			stalled,
			lastSignalAt,
			hasSessionFile: agent.hasSessionFile,
			createdAt: agent.createdAt,
			parentToolCallId: life?.parentToolCallId ?? prog?.parentToolCallId,
			spawnIndex: life?.index ?? prog?.index ?? 0,
			task: prog?.task ?? life?.description,
			detached: payloadDetached(life) ?? payloadDetached(prog),
			activity: stalled ? `no activity for ${fmtAge(now - lastSignalAt)}` : agentActivityLine(status, prog, now),
			model: p?.resolvedModel,
			tokens: p?.tokens,
			cost: p?.cost,
			durationMs,
			toolCount: p?.toolCount,
		};
	};

	for (const agent of sorted) {
		if (!parentOf.has(agent.id)) {
			roots.push(agent.id);
			visit(agent);
		}
	}
	// Whatever is still unplaced hangs in a parent cycle: promote its oldest member and lay the rest below it.
	for (const agent of sorted) {
		if (placed.has(agent.id)) continue;
		promotedByCycle.add(agent.id);
		roots.push(agent.id);
		visit(agent);
	}

	const edges: AgentEdge[] = [];
	for (const agent of sorted) {
		const parent = parentOf.get(agent.id);
		if (parent !== undefined) edges.push({ from: parent, to: agent.id, cycle: promotedByCycle.has(agent.id) });
	}
	return { nodes, batches: buildAgentBatches(nodes), edges, roots };
}

export interface AgentSummary {
	/** Subagents only; the main agent is the session itself. */
	total: number;
	running: number;
	stalled: number;
	/** Present only when at least one subagent reported progress. */
	tokens: number | null;
	cost: number | null;
}

export function summarizeAgents(nodes: readonly AgentNode[]): AgentSummary {
	let total = 0;
	let running = 0;
	let stalled = 0;
	let tokens: number | null = null;
	let cost: number | null = null;
	for (const node of nodes) {
		if (node.kind !== "sub") continue;
		total++;
		if (node.status === "running") running++;
		if (node.stalled) stalled++;
		if (node.tokens !== undefined) tokens = (tokens ?? 0) + node.tokens;
		if (node.cost !== undefined) cost = (cost ?? 0) + node.cost;
	}
	return { total, running, stalled, tokens, cost };
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;
export const GAP_X = 52;
export const GAP_Y = 24;
export const LAYOUT_PADDING = 20;

export interface LaidOutNode {
	id: string;
	kind: "agent" | "batch";
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LaidOutEdge {
	from: string;
	to: string;
	/** Right edge of the parent. */
	x1: number;
	y1: number;
	/** Left edge of the child. */
	x2: number;
	y2: number;
}

export interface GraphLayout {
	nodes: LaidOutNode[];
	/** Visible tree edges, including synthetic task-batch nodes. */
	edges: LaidOutEdge[];
	width: number;
	height: number;
}

/**
 * Layered left-to-right tree: parents sit to the left, siblings stack by spawn-call time, and task-call batches
 * occupy a column between their parent and multiple child agents. Singleton batches use the child agent directly.
 */
export function layoutAgentGraph(graph: AgentGraph, collapsed: ReadonlySet<string> = EMPTY_COLLAPSED): GraphLayout {
	const agentById = new Map(graph.nodes.map(node => [node.id, node]));
	const batchesById = new Map<string, AgentBatch>();
	const groupsByParent = new Map<string, AgentBatch[]>();
	for (const batch of graph.batches) {
		if (!agentById.has(batch.parentId)) continue;
		let groups = groupsByParent.get(batch.parentId);
		if (!groups) {
			groups = [];
			groupsByParent.set(batch.parentId, groups);
		}
		groups.push(batch);
	}
	for (const groups of groupsByParent.values()) groups.sort(compareBatch);

	const childrenById = new Map<string, string[]>();
	const assignedAgents = new Set<string>();
	for (const agent of graph.nodes) {
		const groups = groupsByParent.get(agent.id) ?? [];
		const children: string[] = [];
		for (const group of groups) {
			const members = group.childIds.filter(id => agentById.has(id)).map(id => agentById.get(id)!);
			members.sort(compareSpawnOrder);
			if (members.length === 0) continue;
			for (const member of members) assignedAgents.add(member.id);
			if (members.length > 1) {
				batchesById.set(group.id, group);
				children.push(group.id);
				childrenById.set(group.id, members.map(member => member.id));
			} else {
				children.push(members[0]!.id);
			}
		}
		childrenById.set(agent.id, children);
	}
	// Older graph snapshots may not have group metadata; retain their tree as singleton relationships.
	for (const agent of graph.nodes) {
		if (agent.parentId === null || assignedAgents.has(agent.id) || !agentById.has(agent.parentId)) continue;
		const siblings = childrenById.get(agent.parentId);
		if (siblings) siblings.push(agent.id);
		else childrenById.set(agent.parentId, [agent.id]);
		assignedAgents.add(agent.id);
	}
	for (const [parentId, children] of childrenById) {
		if (agentById.has(parentId)) {
			const direct = children.filter(id => agentById.has(id));
			direct.sort((a, b) => compareAgentStart(agentById.get(a)!, agentById.get(b)!));
			const batches = children.filter(id => batchesById.has(id)).sort((a, b) => compareBatch(batchesById.get(a)!, batchesById.get(b)!));
			if (direct.length > 0 && batches.length > 0) {
				const entries = [
					...direct.map(id => ({ id, at: agentById.get(id)!.createdAt, index: agentById.get(id)!.spawnIndex })),
					...batches.map(id => ({ id, at: batchesById.get(id)!.startAt, index: batchesById.get(id)!.index })),
				].sort((a, b) => a.at - b.at || a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
				children.splice(0, children.length, ...entries.map(entry => entry.id));
			} else if (batches.length > 0) {
				children.splice(0, children.length, ...batches);
			} else {
				children.splice(0, children.length, ...direct);
			}
		}
	}

	const roots: string[] = [];
	const rootSet = new Set<string>();
	for (const id of graph.roots) {
		if (agentById.has(id) && !rootSet.has(id)) {
			roots.push(id);
			rootSet.add(id);
		}
	}
	for (const agent of graph.nodes) {
		if (agent.parentId === null && !rootSet.has(agent.id)) {
			roots.push(agent.id);
			rootSet.add(agent.id);
		}
	}

	const order: string[] = [];
	const visibleChildren = new Map<string, string[]>();
	const columnById = new Map<string, number>();
	const visited = new Set<string>();
	for (const root of roots) {
		const stack: Array<{ id: string; column: number }> = [{ id: root, column: 0 }];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (visited.has(current.id) || (!agentById.has(current.id) && !batchesById.has(current.id))) continue;
			visited.add(current.id);
			order.push(current.id);
			columnById.set(current.id, current.column);
			const kind = agentById.has(current.id) ? "agent" : "batch";
			const children = collapseLabel(kind, current.id, collapsed) ? [] : (childrenById.get(current.id) ?? []);
			visibleChildren.set(current.id, children);
			for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i]!, column: current.column + 1 });
		}
	}

	const slotX = NODE_WIDTH + GAP_X;
	const slotY = NODE_HEIGHT + GAP_Y;
	const centreY = new Map<string, number>();
	const firstLeafY = new Map<string, number>();
	const lastLeafY = new Map<string, number>();
	let leafIndex = 0;
	for (const id of order) {
		if ((visibleChildren.get(id)?.length ?? 0) !== 0) continue;
		const y = LAYOUT_PADDING + leafIndex * slotY + NODE_HEIGHT / 2;
		centreY.set(id, y);
		firstLeafY.set(id, y);
		lastLeafY.set(id, y);
		leafIndex++;
	}
	for (let i = order.length - 1; i >= 0; i--) {
		const id = order[i]!;
		const children = visibleChildren.get(id) ?? [];
		if (children.length === 0) continue;
		const first = children[0]!;
		const last = children[children.length - 1]!;
		const firstY = firstLeafY.get(first)!;
		const lastY = lastLeafY.get(last)!;
		firstLeafY.set(id, firstY);
		lastLeafY.set(id, lastY);
		centreY.set(id, (firstY + lastY) / 2);
	}

	let maxColumn = 0;
	const nodes: LaidOutNode[] = [];
	for (const id of order) {
		const column = columnById.get(id) ?? 0;
		maxColumn = Math.max(maxColumn, column);
		const centre = centreY.get(id) ?? LAYOUT_PADDING + NODE_HEIGHT / 2;
		nodes.push({
			id,
			kind: agentById.has(id) ? "agent" : "batch",
			x: LAYOUT_PADDING + column * slotX,
			y: centre - NODE_HEIGHT / 2,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
		});
	}

	const at = new Map(nodes.map(node => [node.id, node]));
	const edges: LaidOutEdge[] = [];
	for (const [parentId, children] of visibleChildren) {
		const parent = at.get(parentId);
		if (!parent) continue;
		for (const childId of children) {
			const child = at.get(childId);
			if (!child) continue;
			edges.push({
				from: parentId,
				to: childId,
				x1: parent.x + parent.width,
				y1: parent.y + parent.height / 2,
				x2: child.x,
				y2: child.y + child.height / 2,
			});
		}
	}
	return {
		nodes,
		edges,
		width: LAYOUT_PADDING * 2 + maxColumn * slotX + NODE_WIDTH,
		height: LAYOUT_PADDING * 2 + Math.max(1, leafIndex) * slotY - GAP_Y,
	};
}
