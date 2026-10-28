import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import {
	layoutPlanGraph,
	linkAgentsToTasks,
	matchScore,
	PLAN_COL_GAP,
	PLAN_COL_WIDTH,
	type PlanAgent,
	wrapLines,
} from "../src/lib/plan-graph";
import { deriveTodos, type TodoBoard } from "../src/lib/todos";

function todoEntry(phases: unknown): SessionEntry {
	return {
		id: "t1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "message",
		message: { role: "toolResult", toolCallId: "c", toolName: "todo", content: [{ type: "text", text: "ok" }], details: { phases }, isError: false, timestamp: 0 },
	};
}

const PHASES = [
	{ name: "Investigate", tasks: [{ content: "Plan the reconnect fix", status: "completed" }, { content: "Probe relay reconnect behaviour", status: "in_progress" }] },
	{
		name: "Fix",
		tasks: [
			{ content: "Sweep collab docs for close code 1006", status: "in_progress" },
			{ content: "Treat close code 1001 as transient", status: "pending" },
			{ content: "Drop the legacy fatal-code table", status: "abandoned" },
		],
	},
	{ name: "Verify", tasks: [{ content: "Add a reconnect regression test", status: "pending" }] },
];

function board(): TodoBoard {
	const derived = deriveTodos([todoEntry(PHASES)]);
	if (!derived) throw new Error("no board");
	return derived;
}

describe("plan graph layout from the todo tool result", () => {
	it("puts each phase in its own column, in order, with its tasks stacked under the header", () => {
		const layout = layoutPlanGraph(board(), []);
		expect(layout.phases.map(p => p.name)).toEqual(["Investigate", "Fix", "Verify"]);
		expect(layout.phases.map(p => `${p.done}/${p.total}`)).toEqual(["1/2", "0/3", "0/1"]);
		const xs = layout.phases.map(p => p.x);
		expect(xs[1]! - xs[0]!).toBe(PLAN_COL_WIDTH + PLAN_COL_GAP);
		expect(layout.tasks).toHaveLength(6);
		const fix = layout.tasks.filter(t => t.phase === 1);
		expect(fix.map(t => t.status)).toEqual(["in_progress", "pending", "abandoned"]);
		for (let i = 1; i < fix.length; i++) expect(fix[i]!.y).toBeGreaterThan(fix[i - 1]!.y + fix[i - 1]!.height - 1);
		expect(fix.every(t => t.x > layout.phases[1]!.x)).toBe(true);
		// Membership: one edge per task, from its own phase, nothing else.
		expect(layout.edges.map(e => `${e.phaseId}>${e.taskId}`).sort()).toEqual(layout.tasks.map(t => `p${t.phase}>${t.id}`).sort());
		expect(layout.width).toBeGreaterThan(xs[2]! + PLAN_COL_WIDTH);
		expect(layout.height).toBeGreaterThan(Math.max(...layout.tasks.map(t => t.y + t.height)));
	});

	it("shows nothing for an empty board (deriveTodos returns null)", () => {
		expect(deriveTodos([todoEntry([{ name: "Empty", tasks: [] }])])).toBeNull();
	});
});

describe("linking running agents to todo tasks by text", () => {
	const agents: PlanAgent[] = [
		{ id: "RelayProbe", name: "RelayProbe", task: "relay reconnect probe · probe relay reconnect" },
		{ id: "DocSweep", name: "DocSweep", task: "sweep collab docs" },
	];

	it("links an agent to the open task its assignment matches and records the score as an inference", () => {
		const links = linkAgentsToTasks(board(), agents);
		expect(links.get("p0t1")).toMatchObject({ agentId: "RelayProbe" });
		expect(links.get("p1t0")).toMatchObject({ agentId: "DocSweep" });
		expect(links.get("p0t1")!.score).toBeGreaterThanOrEqual(0.6);
		expect(links.size).toBe(2);
	});

	it("never links a completed or abandoned task, and never one word out of several", () => {
		const links = linkAgentsToTasks(board(), [
			{ id: "P", name: "P", task: "plan the reconnect fix" }, // task p0t0 is completed
			{ id: "L", name: "L", task: "drop the legacy fatal-code table" }, // p1t2 is abandoned
			{ id: "R", name: "R", task: "fix the reconnect indicator colours in the header" }, // shares only "reconnect"
		]);
		expect(links.size).toBe(0);
	});

	it("gives one agent to one task, the in-progress one, when two tasks read alike", () => {
		const twin = deriveTodos([
			todoEntry([{ name: "A", tasks: [{ content: "Sweep collab docs", status: "pending" }, { content: "Sweep collab docs again", status: "in_progress" }] }]),
		])!;
		const links = linkAgentsToTasks(twin, [{ id: "D", name: "D", task: "sweep collab docs" }]);
		expect(links.size).toBe(1);
		expect(links.get("p0t1")?.agentId).toBe("D"); // equal score: the task being worked on wins
	});

	it("matches containment outright and scores unrelated text zero", () => {
		expect(matchScore("Sweep collab docs", "please sweep collab docs for 1006 mentions")).toBe(1);
		expect(matchScore("Sweep collab docs", "benchmark the transcript renderer")).toBe(0);
		expect(matchScore("", "anything")).toBe(0);
	});
});

describe("wrapLines", () => {
	it("wraps on words, caps the line count and marks the cut", () => {
		expect(wrapLines("one two three four", 9, 3)).toEqual(["one two", "three", "four"]);
		const cut = wrapLines("alpha beta gamma delta epsilon zeta", 11, 2);
		expect(cut).toHaveLength(2);
		expect(cut[1]!.endsWith("…")).toBe(true);
		expect(wrapLines("short", 20, 2)).toEqual(["short"]);
		expect(wrapLines("   ", 20, 2)).toEqual([]);
	});

	it("cuts a single word longer than the line", () => {
		expect(wrapLines("supercalifragilistic", 8, 1)).toEqual(["superca…"]);
	});
});
