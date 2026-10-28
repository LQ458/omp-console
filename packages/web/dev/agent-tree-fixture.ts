/**
 * Fixture room for the agent graph: a root, three spawn-call batches of 1, 3 and 5 agents, one grandchild, and
 * mixed outcomes. `AGENT_TREE_EDGES` is the ground truth spawn tree (rubric #9).
 *
 *   main
 *   ├─ planning batch (1): Planner, finished
 *   ├─ reconnect batch (3): RelayProbe, DocSweep, PatchScout
 *   │   └─ ProbeWorker, failed
 *   └─ verification batch (5): TestRunner, BuildBot, AuditWorker, DocWriter, ReleaseCheck
 */
import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";

type TreeLifecyclePayload = SubagentLifecyclePayload & { detached?: boolean };
type TreeProgressPayload = SubagentProgressPayload & { detached?: boolean };

export const AGENT_TREE_SESSION_ID = "agent-tree";

/** Parent -> child, in spawn order. */
export const AGENT_TREE_EDGES: ReadonlyArray<readonly [parent: string, child: string]> = [
	["main", "Planner"],
	["main", "RelayProbe"],
	["main", "DocSweep"],
	["main", "PatchScout"],
	["main", "TestRunner"],
	["main", "BuildBot"],
	["main", "AuditWorker"],
	["main", "DocWriter"],
	["main", "ReleaseCheck"],
	["RelayProbe", "ProbeWorker"],
];

/** Agents the mock ticker never refreshes, so they go quiet and show as stalled. */
export const AGENT_TREE_SILENT = new Set(["DocSweep"]);

const MIN = 60_000;

export function makeTreeAgents(now: number): AgentSnapshot[] {
	return [
		{ id: "main", displayName: "Main", kind: "main", status: "running", hasSessionFile: true, createdAt: now - 40 * MIN, lastActivity: now - 3_000 },
		{ id: "Planner", displayName: "Planner", kind: "sub", parentId: "main", status: "parked", hasSessionFile: true, createdAt: now - 32 * MIN, lastActivity: now - 20 * MIN },
		{ id: "PatchScout", displayName: "PatchScout", kind: "sub", parentId: "main", status: "parked", hasSessionFile: true, createdAt: now - 14 * MIN, lastActivity: now - 13 * MIN },
		{ id: "RelayProbe", displayName: "RelayProbe", kind: "sub", parentId: "main", status: "running", hasSessionFile: true, createdAt: now - 12 * MIN, lastActivity: now - 2_000 },
		{ id: "DocSweep", displayName: "DocSweep", kind: "sub", parentId: "main", status: "running", hasSessionFile: true, createdAt: now - 11 * MIN, lastActivity: now - 4 * MIN },
		{ id: "TestRunner", displayName: "TestRunner", kind: "sub", parentId: "main", status: "parked", hasSessionFile: true, createdAt: now - 9 * MIN, lastActivity: now - 8 * MIN },
		{ id: "AuditWorker", displayName: "AuditWorker", kind: "sub", parentId: "main", status: "aborted", hasSessionFile: true, createdAt: now - 8 * MIN, lastActivity: now - 7 * MIN },
		{ id: "BuildBot", displayName: "BuildBot", kind: "sub", parentId: "main", status: "running", hasSessionFile: true, createdAt: now - 7 * MIN, lastActivity: now - 1_000 },
		{ id: "DocWriter", displayName: "DocWriter", kind: "sub", parentId: "main", status: "parked", hasSessionFile: true, createdAt: now - 6 * MIN, lastActivity: now - 5 * MIN },
		{ id: "ProbeWorker", displayName: "ProbeWorker", kind: "sub", parentId: "RelayProbe", status: "parked", hasSessionFile: true, createdAt: now - 6 * MIN, lastActivity: now - 5 * MIN },
		{ id: "ReleaseCheck", displayName: "ReleaseCheck", kind: "sub", parentId: "main", status: "parked", hasSessionFile: true, createdAt: now - 5 * MIN, lastActivity: now - 4 * MIN },
	];
}

export function makeTreeLifecycle(): TreeLifecyclePayload[] {
	return [
		{ id: "Planner", agent: "plan", description: "plan the reconnect fix", status: "completed", index: 0, parentToolCallId: "task-plan", detached: false },
		{ id: "RelayProbe", agent: "task", description: "probe relay reconnect", status: "started", index: 0, parentToolCallId: "task-reconnect", detached: false },
		{ id: "DocSweep", agent: "task", description: "sweep collab docs", status: "started", index: 1, parentToolCallId: "task-reconnect", detached: false },
		{ id: "PatchScout", agent: "task", description: "inspect reconnect patch", status: "failed", index: 2, parentToolCallId: "task-reconnect", detached: false },
		{ id: "TestRunner", agent: "task", description: "run reconnect suite", status: "completed", index: 0, parentToolCallId: "task-verify", detached: true },
		{ id: "BuildBot", agent: "task", description: "build the web package", status: "started", index: 1, parentToolCallId: "task-verify", detached: true },
		{ id: "AuditWorker", agent: "task", description: "audit failed cases", status: "aborted", index: 2, parentToolCallId: "task-verify", detached: true },
		{ id: "DocWriter", agent: "task", description: "write the result note", status: "started", index: 3, parentToolCallId: "task-verify", detached: true },
		{ id: "ReleaseCheck", agent: "task", description: "check release artifacts", status: "completed", index: 4, parentToolCallId: "task-verify", detached: true },
		{ id: "ProbeWorker", agent: "task", description: "drop the relay socket", status: "failed", index: 0, parentToolCallId: "task-probe-child", detached: false },
	];
}

const DEFAULT_MODEL = "claude-sonnet-5-5";

interface ProgressSeed {
	id: string;
	agent: string;
	task: string;
	status: "running" | "completed" | "failed" | "aborted";
	parentToolCallId: string;
	index: number;
	detached: boolean;
	tool?: string;
	toolElapsedMs?: number;
	args?: string;
	intent?: string;
	tokens: number;
	cost: number;
	toolCount: number;
	durationMs: number;
}

const SEEDS: ProgressSeed[] = [
	{ id: "Planner", agent: "plan", task: "plan the reconnect fix", status: "completed", parentToolCallId: "task-plan", index: 0, detached: false, tokens: 12_800, cost: 0.083, toolCount: 6, durationMs: 41_000 },
	{ id: "RelayProbe", agent: "task", task: "probe relay reconnect", status: "running", parentToolCallId: "task-reconnect", index: 0, detached: false, tool: "bash", toolElapsedMs: 13_000, args: "bun test collab --filter reconnect", intent: "Replaying drop scenario", tokens: 18_400, cost: 0.041, toolCount: 9, durationMs: 95_000 },
	{ id: "DocSweep", agent: "task", task: "sweep collab docs", status: "running", parentToolCallId: "task-reconnect", index: 1, detached: false, tool: "grep", toolElapsedMs: 31_000, args: "close code 1006", intent: "Scanning docs", tokens: 7_300, cost: 0.017, toolCount: 4, durationMs: 210_000 },
	{ id: "PatchScout", agent: "task", task: "inspect reconnect patch", status: "failed", parentToolCallId: "task-reconnect", index: 2, detached: false, tokens: 5_600, cost: 0.012, toolCount: 3, durationMs: 32_000 },
	{ id: "TestRunner", agent: "task", task: "run reconnect suite", status: "completed", parentToolCallId: "task-verify", index: 0, detached: true, tokens: 9_400, cost: 0.021, toolCount: 5, durationMs: 50_000 },
	{ id: "BuildBot", agent: "task", task: "build the web package", status: "running", parentToolCallId: "task-verify", index: 1, detached: true, tool: "bun", intent: "Building web assets", tokens: 11_600, cost: 0.029, toolCount: 7, durationMs: 45_000 },
	{ id: "AuditWorker", agent: "task", task: "audit failed cases", status: "aborted", parentToolCallId: "task-verify", index: 2, detached: true, tokens: 4_100, cost: 0.008, toolCount: 2, durationMs: 12_000 },
	{ id: "DocWriter", agent: "task", task: "write the result note", status: "running", parentToolCallId: "task-verify", index: 3, detached: true, intent: "Summarizing the verification", tokens: 6_800, cost: 0.016, toolCount: 3, durationMs: 20_000 },
	{ id: "ReleaseCheck", agent: "task", task: "check release artifacts", status: "completed", parentToolCallId: "task-verify", index: 4, detached: true, tokens: 7_200, cost: 0.018, toolCount: 4, durationMs: 35_000 },
	{ id: "ProbeWorker", agent: "task", task: "drop the relay socket", status: "failed", parentToolCallId: "task-probe-child", index: 0, detached: false, tokens: 3_900, cost: 0.009, toolCount: 3, durationMs: 22_000 },
];

/**
 * One progress payload per agent that has reported (running agents tick with `tick`). `models` holds the
 * per-agent model set through the model endpoint; the rest use the default.
 */
export function makeTreeProgress(
	tick: number,
	models: ReadonlyMap<string, string>,
	skip: ReadonlySet<string> = new Set(),
): TreeProgressPayload[] {
	const out: TreeProgressPayload[] = [];
	const now = Date.now();
	for (const seed of SEEDS) {
		if (skip.has(seed.id)) continue;
		const running = seed.status === "running";
		const grow = running ? tick : 0;
		out.push({
			index: seed.index,
			agent: seed.agent,
			task: seed.task,
			parentToolCallId: seed.parentToolCallId,
			detached: seed.detached,
			progress: {
				index: seed.index,
				id: seed.id,
				agent: seed.agent,
				status: seed.status,
				task: seed.task,
				description: seed.task,
				lastIntent: seed.intent,
				currentTool: seed.tool,
				currentToolArgs: seed.args,
				currentToolStartMs: seed.toolElapsedMs === undefined ? undefined : now - seed.toolElapsedMs - grow * 2_000,
				recentTools: [],
				recentOutput: [],
				toolCount: seed.toolCount + grow,
				requests: 2 + grow,
				tokens: seed.tokens + grow * 450,
				cost: seed.cost + grow * 0.0012,
				durationMs: seed.durationMs + grow * 2_000,
				resolvedModel: models.get(seed.id) ?? DEFAULT_MODEL,
			},
		});
	}
	return out;
}
