/**
 * Draft graph (spec 4.5/4.6): a plan the user draws, not something omp recorded. Nodes are `task` assignments, an edge A -> B
 * means "B starts after A finished successfully". This module is the editor's model: state and reducer, client-side
 * validation mirroring what the daemon refuses with a 400, auto layout, (de)serialization to `DraftPlan` and to
 * localStorage, and the mapping from a daemon `DraftRun` to what the run view shows.
 */
import type { DraftNode, DraftNodeState, DraftPlan, DraftRun, DraftRunNode } from "@omp-console/protocol";

export const DRAFT_NODE_WIDTH = 188;
export const DRAFT_NODE_HEIGHT = 72;
export const DRAFT_GAP_X = 64;
export const DRAFT_GAP_Y = 26;
export const DRAFT_PADDING = 24;
const GRID_COLUMNS = 4;

export interface DraftEditorNode extends DraftNode {
	/** Canvas position; the daemon never sees it (a loaded template is laid out again). */
	x: number;
	y: number;
	dependsOn: string[];
}

export interface DraftState {
	name: string;
	nodes: DraftEditorNode[];
	/** Next number for `n<k>` ids; never reused, so a deleted node's id cannot come back with another meaning. */
	nextId: number;
}

export type DraftNodeFields = Pick<DraftNode, "title" | "instruction" | "profile" | "files" | "isolated">;

export type DraftAction =
	| { type: "add"; profile?: string }
	| { type: "update"; id: string; patch: Partial<DraftNodeFields> }
	| { type: "move"; id: string; x: number; y: number }
	| { type: "connect"; from: string; to: string }
	| { type: "disconnect"; from: string; to: string }
	| { type: "remove"; id: string }
	| { type: "rename"; name: string }
	| { type: "load"; plan: DraftPlan }
	| { type: "layout" }
	| { type: "clear" };

export const EMPTY_DRAFT: DraftState = { name: "", nodes: [], nextId: 1 };

// ---- connect rules -------------------------------------------------------------------------------------------------

export type ConnectError = "self" | "duplicate" | "cycle" | "unknown";

/** Whether `target` can be reached from `start` following "is a dependency of" backwards (dependsOn), i.e. start depends on target. */
function dependsTransitively(nodes: readonly DraftNode[], start: string, target: string): boolean {
	const byId = new Map(nodes.map(node => [node.id, node]));
	const seen = new Set<string>();
	const stack = [start];
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (id === target) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) stack.push(dep);
	}
	return false;
}

/** `from` must finish before `to` starts. Null when the edge may be added. */
export function connectError(state: { nodes: readonly DraftNode[] }, from: string, to: string): ConnectError | null {
	if (from === to) return "self";
	const target = state.nodes.find(node => node.id === to);
	if (!target || !state.nodes.some(node => node.id === from)) return "unknown";
	if ((target.dependsOn ?? []).includes(from)) return "duplicate";
	// `from` already (transitively) depends on `to`: the new edge would close a loop.
	if (dependsTransitively(state.nodes, from, to)) return "cycle";
	return null;
}

export function describeConnectError(error: ConnectError): string {
	switch (error) {
		case "self":
			return "A task cannot depend on itself.";
		case "duplicate":
			return "That dependency already exists.";
		case "cycle":
			return "That would make a cycle: the other task already waits for this one.";
		case "unknown":
			return "That task no longer exists.";
	}
}

// ---- layout --------------------------------------------------------------------------------------------------------

/** Layer = length of the longest dependency chain below the node (loop-safe: a node on a cycle counts from where the walk entered it). */
function layers(nodes: readonly DraftNode[]): Map<string, number> {
	const byId = new Map(nodes.map(node => [node.id, node]));
	const layer = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (id: string): number => {
		const known = layer.get(id);
		if (known !== undefined) return known;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		let best = 0;
		for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) best = Math.max(best, depth(dep) + 1);
		visiting.delete(id);
		layer.set(id, best);
		return best;
	};
	for (const node of nodes) depth(node.id);
	return layer;
}

/** Left to right by dependency layer; rows keep the node order inside a layer. */
export function autoLayout(nodes: readonly DraftEditorNode[]): DraftEditorNode[] {
	const layer = layers(nodes);
	const rows = new Map<number, number>();
	return nodes.map(node => {
		const column = layer.get(node.id) ?? 0;
		const row = rows.get(column) ?? 0;
		rows.set(column, row + 1);
		return {
			...node,
			x: DRAFT_PADDING + column * (DRAFT_NODE_WIDTH + DRAFT_GAP_X),
			y: DRAFT_PADDING + row * (DRAFT_NODE_HEIGHT + DRAFT_GAP_Y),
		};
	});
}

/** First free cell of a 4-wide grid, row by row, so a new node never lands on top of another. */
export function freeSpot(nodes: readonly DraftEditorNode[]): { x: number; y: number } {
	const stepX = DRAFT_NODE_WIDTH + DRAFT_GAP_X;
	const stepY = DRAFT_NODE_HEIGHT + DRAFT_GAP_Y;
	for (let i = 0; ; i++) {
		const x = DRAFT_PADDING + (i % GRID_COLUMNS) * stepX;
		const y = DRAFT_PADDING + Math.floor(i / GRID_COLUMNS) * stepY;
		const taken = nodes.some(node => Math.abs(node.x - x) < DRAFT_NODE_WIDTH / 2 && Math.abs(node.y - y) < DRAFT_NODE_HEIGHT / 2);
		if (!taken) return { x, y };
	}
}

export function draftBounds(nodes: readonly DraftEditorNode[]): { width: number; height: number } {
	let width = DRAFT_PADDING * 2 + DRAFT_NODE_WIDTH;
	let height = DRAFT_PADDING * 2 + DRAFT_NODE_HEIGHT;
	for (const node of nodes) {
		width = Math.max(width, node.x + DRAFT_NODE_WIDTH + DRAFT_PADDING);
		height = Math.max(height, node.y + DRAFT_NODE_HEIGHT + DRAFT_PADDING);
	}
	return { width, height };
}

// ---- plan <-> state ------------------------------------------------------------------------------------------------

function normalizeFiles(files: readonly string[] | undefined): string[] | undefined {
	const list = (files ?? []).map(file => file.trim()).filter(file => file !== "");
	return list.length > 0 ? list : undefined;
}

/** The wire form: optional fields only when set, positions dropped. */
export function toDraftPlan(state: Pick<DraftState, "name" | "nodes">): DraftPlan {
	return {
		name: state.name.trim(),
		nodes: state.nodes.map(node => {
			const out: DraftNode = { id: node.id, title: node.title, instruction: node.instruction, profile: node.profile };
			const files = normalizeFiles(node.files);
			if (files) out.files = files;
			if (node.dependsOn.length > 0) out.dependsOn = [...node.dependsOn];
			if (node.isolated === true) out.isolated = true;
			return out;
		}),
	};
}

function highestNumericId(nodes: readonly DraftNode[]): number {
	let max = 0;
	for (const node of nodes) {
		const match = /^n(\d+)$/.exec(node.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max;
}

/** Editor state for a plan (a template, or a finished run's plan): same ids, fresh layout. */
export function fromDraftPlan(plan: DraftPlan): DraftState {
	const nodes = autoLayout(plan.nodes.map(node => ({ ...node, dependsOn: [...(node.dependsOn ?? [])], x: 0, y: 0 })));
	return { name: plan.name, nodes, nextId: highestNumericId(plan.nodes) + 1 };
}

const STORAGE_VERSION = 1;

/** Draft plan per session; distinct from the composer's text draft (`omp-console-composer-draft:`, prompt-history.ts). */
export function storageKeyFor(sessionId: string): string {
	return `omp-console-plan-draft:${sessionId}`;
}

export function serializeDraft(state: DraftState): string {
	return JSON.stringify({ v: STORAGE_VERSION, name: state.name, nextId: state.nextId, nodes: state.nodes });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Null for anything that is not a draft written by `serializeDraft`; never throws. */
export function parseDraft(raw: string | null): DraftState | null {
	if (raw === null) return null;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(data) || data.v !== STORAGE_VERSION || !Array.isArray(data.nodes)) return null;
	const nodes: DraftEditorNode[] = [];
	const seen = new Set<string>();
	for (const item of data.nodes as unknown[]) {
		if (!isRecord(item) || typeof item.id !== "string" || seen.has(item.id)) continue;
		seen.add(item.id);
		nodes.push({
			id: item.id,
			title: typeof item.title === "string" ? item.title : "",
			instruction: typeof item.instruction === "string" ? item.instruction : "",
			profile: typeof item.profile === "string" ? item.profile : "",
			files: strings(item.files),
			isolated: item.isolated === true,
			dependsOn: strings(item.dependsOn),
			x: typeof item.x === "number" && Number.isFinite(item.x) ? item.x : 0,
			y: typeof item.y === "number" && Number.isFinite(item.y) ? item.y : 0,
		});
	}
	for (const node of nodes) node.dependsOn = node.dependsOn.filter(dep => seen.has(dep) && dep !== node.id);
	const nextId = typeof data.nextId === "number" && Number.isInteger(data.nextId) ? data.nextId : 1;
	return { name: typeof data.name === "string" ? data.name : "", nodes, nextId: Math.max(nextId, highestNumericId(nodes) + 1) };
}

// ---- reducer -------------------------------------------------------------------------------------------------------

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
	switch (action.type) {
		case "add": {
			const spot = freeSpot(state.nodes);
			const node: DraftEditorNode = {
				id: `n${state.nextId}`,
				title: "",
				instruction: "",
				profile: action.profile ?? "",
				files: [],
				isolated: false,
				dependsOn: [],
				...spot,
			};
			return { ...state, nodes: [...state.nodes, node], nextId: state.nextId + 1 };
		}
		case "update":
			return { ...state, nodes: state.nodes.map(node => (node.id === action.id ? { ...node, ...action.patch } : node)) };
		case "move":
			return { ...state, nodes: state.nodes.map(node => (node.id === action.id ? { ...node, x: action.x, y: action.y } : node)) };
		case "connect":
			if (connectError(state, action.from, action.to) !== null) return state;
			return {
				...state,
				nodes: state.nodes.map(node => (node.id === action.to ? { ...node, dependsOn: [...node.dependsOn, action.from] } : node)),
			};
		case "disconnect":
			return {
				...state,
				nodes: state.nodes.map(node =>
					node.id === action.to ? { ...node, dependsOn: node.dependsOn.filter(dep => dep !== action.from) } : node,
				),
			};
		case "remove":
			return {
				...state,
				nodes: state.nodes
					.filter(node => node.id !== action.id)
					.map(node => (node.dependsOn.includes(action.id) ? { ...node, dependsOn: node.dependsOn.filter(dep => dep !== action.id) } : node)),
			};
		case "rename":
			return { ...state, name: action.name };
		case "load":
			return fromDraftPlan(action.plan);
		case "layout":
			return { ...state, nodes: autoLayout(state.nodes) };
		case "clear":
			return { ...EMPTY_DRAFT, nextId: state.nextId };
	}
}

// ---- validation ----------------------------------------------------------------------------------------------------

export type DraftIssueKind =
	| "empty"
	| "cycle"
	| "missing-profile"
	| "unknown-profile"
	| "empty-title"
	| "empty-instruction"
	| "unknown-dependency"
	| "duplicate-id";

export interface DraftIssue {
	kind: DraftIssueKind;
	/** Nodes the issue is about (the whole cycle for `cycle`). */
	nodeIds: string[];
	message: string;
}

function label(node: DraftNode | undefined, id: string): string {
	const title = node?.title.trim();
	return title ? `"${title}"` : id;
}

/** Every dependency cycle the DFS meets, as node ids in run order (each one finishes before the next), closed by repeating the first. */
export function findCycles(nodes: readonly DraftNode[]): string[][] {
	const byId = new Map(nodes.map(node => [node.id, node]));
	const colour = new Map<string, 1 | 2>();
	const cycles: string[][] = [];
	const stack: string[] = [];
	const visit = (id: string): void => {
		colour.set(id, 1);
		stack.push(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (!byId.has(dep)) continue;
			const state = colour.get(dep);
			if (state === 1) {
				// stack runs node -> dependency; the run order is the reverse.
				const loop = stack.slice(stack.indexOf(dep)).reverse();
				cycles.push([...loop, loop[0]!]);
			} else if (state === undefined) {
				visit(dep);
			}
		}
		stack.pop();
		colour.set(id, 2);
	};
	for (const node of nodes) if (!colour.has(node.id)) visit(node.id);
	return cycles;
}

/**
 * What the daemon would refuse (cycle, unknown dependency, duplicate id, unknown profile) plus what it cannot judge
 * (a node with no title, instruction or profile). `profiles` is the catalog's profile names; when it is not loaded,
 * unknown profiles are not reported.
 */
export function validateDraft(plan: DraftPlan, profiles?: readonly string[]): DraftIssue[] {
	const issues: DraftIssue[] = [];
	if (plan.nodes.length === 0) {
		return [{ kind: "empty", nodeIds: [], message: "Add at least one task." }];
	}
	const byId = new Map<string, DraftNode>();
	for (const node of plan.nodes) {
		if (byId.has(node.id)) {
			issues.push({ kind: "duplicate-id", nodeIds: [node.id], message: `Two tasks share the id ${node.id}.` });
			continue;
		}
		byId.set(node.id, node);
	}
	const known = profiles ? new Set(profiles) : undefined;
	for (const node of plan.nodes) {
		const name = label(node, node.id);
		if (node.title.trim() === "") issues.push({ kind: "empty-title", nodeIds: [node.id], message: `Task ${node.id} has no title.` });
		if (node.instruction.trim() === "") {
			issues.push({ kind: "empty-instruction", nodeIds: [node.id], message: `${name} has no instruction.` });
		}
		if (node.profile.trim() === "") {
			issues.push({ kind: "missing-profile", nodeIds: [node.id], message: `${name} has no profile: pick which agent runs it.` });
		} else if (known && !known.has(node.profile)) {
			issues.push({ kind: "unknown-profile", nodeIds: [node.id], message: `${name} uses profile "${node.profile}", which this session does not have.` });
		}
		for (const dep of node.dependsOn ?? []) {
			if (!byId.has(dep)) {
				issues.push({ kind: "unknown-dependency", nodeIds: [node.id], message: `${name} waits for ${dep}, which is not in the draft.` });
			}
		}
	}
	for (const cycle of findCycles(plan.nodes)) {
		const path = cycle.map(id => label(byId.get(id), id)).join(" → ");
		issues.push({ kind: "cycle", nodeIds: cycle.slice(0, -1), message: `Dependency cycle: ${path}` });
	}
	return issues;
}

// ---- omp equivalent ------------------------------------------------------------------------------------------------

/** Arguments of omp's `task` tool for one node: what the model (or deck) would call to spawn it. */
export function taskToolArgs(node: Pick<DraftNode, "profile" | "instruction" | "files" | "isolated">): Record<string, unknown> {
	const mentions = (node.files ?? []).map(file => (file.includes(" ") ? `@"${file}"` : `@${file}`));
	const args: Record<string, unknown> = {
		agent: node.profile,
		task: mentions.length > 0 ? `${node.instruction}\n\n${mentions.join(" ")}` : node.instruction,
	};
	if (node.isolated === true) args.isolated = true;
	return args;
}

/** The plan as the `task` calls it stands for, in a valid start order (a cyclic plan yields its acyclic part). */
export function draftToTaskCalls(plan: DraftPlan): Array<Record<string, unknown>> {
	const done = new Set<string>();
	const order: DraftNode[] = [];
	let progressed = true;
	while (progressed) {
		progressed = false;
		for (const node of plan.nodes) {
			if (done.has(node.id) || !(node.dependsOn ?? []).every(dep => done.has(dep))) continue;
			done.add(node.id);
			order.push(node);
			progressed = true;
		}
	}
	return order.map(node => ({ name: node.title, ...taskToolArgs(node) }));
}

// ---- run view ------------------------------------------------------------------------------------------------------

export interface RunStateView {
	label: string;
	/** CSS tone suffix. */
	tone: "waiting" | "running" | "done" | "failed" | "skipped" | "cancelled";
	/** The node will not change state again. */
	terminal: boolean;
}

const RUN_STATE_VIEWS: Record<DraftNodeState, RunStateView> = {
	waiting: { label: "waiting", tone: "waiting", terminal: false },
	running: { label: "running", tone: "running", terminal: false },
	done: { label: "done", tone: "done", terminal: true },
	failed: { label: "failed", tone: "failed", terminal: true },
	skipped: { label: "skipped", tone: "skipped", terminal: true },
	cancelled: { label: "cancelled", tone: "cancelled", terminal: true },
};

export function runStateView(state: DraftNodeState): RunStateView {
	return RUN_STATE_VIEWS[state];
}

export const RUN_STATE_ORDER: readonly DraftNodeState[] = ["running", "waiting", "done", "failed", "skipped", "cancelled"];

export function runCounts(run: DraftRun): Record<DraftNodeState, number> {
	const counts: Record<DraftNodeState, number> = { waiting: 0, running: 0, done: 0, failed: 0, skipped: 0, cancelled: 0 };
	for (const node of run.nodes) counts[node.state]++;
	return counts;
}

export function isRunActive(run: DraftRun | undefined): boolean {
	return run?.state === "running";
}

/** One line: "2 of 5 done · 1 running · 1 failed". Zero counts are left out; `done` is always shown. */
export function runSummary(run: DraftRun): string {
	const counts = runCounts(run);
	const parts = [`${counts.done} of ${run.nodes.length} done`];
	for (const state of ["running", "waiting", "failed", "skipped", "cancelled"] as const) {
		if (counts[state] > 0) parts.push(`${counts[state]} ${state}`);
	}
	return parts.join(" · ");
}

/** The run to show: an active one first, else the newest. */
export function pickRun(runs: readonly DraftRun[]): DraftRun | undefined {
	let best: DraftRun | undefined;
	for (const run of runs) {
		if (!best) best = run;
		else if (isRunActive(run) !== isRunActive(best)) best = isRunActive(run) ? run : best;
		else if (run.startedAt > best.startedAt) best = run;
	}
	return best;
}

export function runNodeById(run: DraftRun | undefined, id: string): DraftRunNode | undefined {
	return run?.nodes.find(node => node.id === id);
}

/** Elapsed time of a run node: end - start, or now - start while it runs; undefined before it started. */
export function runNodeElapsedMs(node: DraftRunNode, now: number): number | undefined {
	if (node.startedAt === undefined) return undefined;
	return Math.max(0, (node.endedAt ?? now) - node.startedAt);
}
