import { describe, expect, it } from "bun:test";
import type { DraftRun } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTreeAgents, makeTreeLifecycle, makeTreeProgress } from "../dev/agent-tree-fixture";
import { AgentGraphView } from "../src/components/agents/AgentGraphView";
import { AgentsSheet } from "../src/components/agents/AgentsSheet";
import { placeMenu } from "../src/components/agents/NodeMenu";
import {
	agentMenuItems,
	ASK_PROGRESS_MESSAGE,
	splitTaskMessage,
	taskMenuItems,
} from "../src/components/agents/node-actions";
import { DraftCanvas } from "../src/components/plan/DraftCanvas";
import { PlanGraphView } from "../src/components/plan/PlanGraphView";
import { buildAgentGraph, summarizeAgents } from "../src/lib/agent-graph";
import { fromDraftPlan } from "../src/lib/draft";
import type { MessageEdge } from "../src/lib/message-edges";
import { deriveTodos } from "../src/lib/todos";

const NOW = Date.now();
const noop = (): void => {};

function treeGraph() {
	return buildAgentGraph({
		agents: makeTreeAgents(NOW),
		progress: new Map(makeTreeProgress(3, new Map()).map(p => [p.progress.id, p])),
		lifecycle: new Map(makeTreeLifecycle().map(p => [p.id, p])),
		now: NOW,
	});
}

const EDGES: MessageEdge[] = [
	{ from: "main", to: "RelayProbe", kind: "message", count: 3, lastAt: 0 },
	{ from: "RelayProbe", to: "main", kind: "reply", count: 1, lastAt: 0 },
	{ from: "main", to: "DocSweep", kind: "broadcast", count: 2, lastAt: 0 },
];

describe("message edges on the graph", () => {
	const render = (visibleKinds?: ReadonlySet<"spawn" | "message" | "reply" | "broadcast">) =>
		renderToStaticMarkup(
			<AgentGraphView graph={treeGraph()} selectedId={null} onSelect={noop} messageEdges={EDGES} visibleKinds={visibleKinds} onToggleKind={noop} />,
		);
	const unescape = (value: string): string => value.replaceAll("&gt;", ">");

	it("draws each counted edge with its direction and count, apart from the spawn edges", () => {
		const graph = treeGraph();
		const html = renderToStaticMarkup(
			<AgentGraphView graph={graph} selectedId={null} onSelect={noop} messageEdges={EDGES} visibleKinds={undefined} onToggleKind={noop} />,
		);
		const drawn = [...html.matchAll(/data-message-edge="([^"]+)" data-kind="([^"]+)"/g)].map(m => `${unescape(m[1]!)}:${m[2]}`).sort();
		expect(drawn).toEqual(["main>DocSweep:broadcast", "main>RelayProbe:message", "RelayProbe>main:reply"].sort());
		expect(html).toContain('marker-end="url(#ag-arrow-message)"');
		const counts = [...html.matchAll(/data-message-count="([^"]+)"[^>]*>.*?<text[^>]*>(\d+)<\/text>/g)].map(m => `${unescape(m[1]!)}=${m[2]}`);
		expect(counts).toEqual(["main>RelayProbe:message=3", "RelayProbe>main:reply=1", "main>DocSweep:broadcast=2"]);
		const expectedSpawnEdges = graph.batches.flatMap(batch =>
			batch.childIds.length > 1 ? [`${batch.parentId}>${batch.id}`, ...batch.childIds.map(id => `${batch.id}>${id}`)] : batch.childIds.map(id => `${batch.parentId}>${id}`),
		);
		expect([...html.matchAll(/data-edge="([^"]+)"/g)].map(match => unescape(match[1])).sort()).toEqual([...expectedSpawnEdges].sort());
	});

	it("hides exactly the kinds that are switched off, and the toggles show what each kind holds", () => {
		const html = render(new Set(["spawn", "reply"]));
		expect(html).not.toContain('data-kind="message"');
		expect(html).not.toContain('data-kind="broadcast"');
		expect(html).toContain('data-kind="reply"');
		const pressed = [...html.matchAll(/ag-edgetoggle--(\w+)[^"]*"[^>]*aria-pressed="(true|false)"/g)].map(m => `${m[1]}:${m[2]}`);
		expect(pressed).toEqual(["spawn:true", "message:false", "reply:true", "broadcast:false"]);
		// The counts stay visible while a kind is off: spawn 10, messages 3, replies 1, broadcasts 2.
		expect([...html.matchAll(/ag-edgetoggle-count">(\d+)</g)].map(m => m[1])).toEqual(["10", "3", "1", "2"]);
		expect(render(new Set(["message"]))).not.toContain("data-edge=");
	});

	it("shows no toggles and no message edges when the graph is given neither (link guests)", () => {
		const html = renderToStaticMarkup(<AgentGraphView graph={treeGraph()} selectedId={null} onSelect={noop} />);
		expect(html).not.toContain("ag-edgetoggle");
		expect(html).not.toContain("data-message-edge");
	});
});

describe("what the node menu offers", () => {
	const live = { id: "R", displayName: "RelayProbe", kind: "sub", status: "running", hasSessionFile: true } as const;
	const enabled = (items: ReturnType<typeof agentMenuItems>): string[] => items.filter(i => i.enabled).map(i => i.id);

	it("lets a running subagent be steered, asked, re-modelled and killed, not revived", () => {
		const items = agentMenuItems(live, { readOnly: false, hasSession: true });
		expect(enabled(items)).toEqual(["message", "ask", "model", "kill", "transcript"]);
		expect(items.find(i => i.id === "revive")).toMatchObject({ enabled: false, reason: expect.stringContaining("parked or aborted") });
	});

	it("lets a parked subagent be revived and nothing else that needs it running", () => {
		const items = agentMenuItems({ ...live, status: "parked" }, { readOnly: false, hasSession: true });
		expect(enabled(items)).toEqual(["revive", "transcript"]);
	});

	it("offers the main agent no kill or revive, and a view-only link nothing that sends a frame", () => {
		const main = agentMenuItems({ ...live, id: "m", kind: "main" }, { readOnly: false, hasSession: true });
		expect(main.map(i => i.id)).toEqual(["message", "ask", "model", "transcript"]);
		const viewer = agentMenuItems(live, { readOnly: true, hasSession: true });
		expect(enabled(viewer)).toEqual(["transcript"]);
		expect(viewer.find(i => i.id === "kill")!.reason).toBe("this is a view-only link");
		expect(agentMenuItems(live, { readOnly: false, hasSession: false }).find(i => i.id === "model")!.enabled).toBe(false);
	});

	it("gives every action its omp equivalent", () => {
		const all = [
			...agentMenuItems(live, { readOnly: false, hasSession: true }),
			...taskMenuItems({ content: "x", agentName: "RelayProbe" }, { readOnly: false, hasSession: true }),
		];
		expect(all.every(item => item.equivalent.length > 0)).toBe(true);
	});

	it("offers a plan task do-now, split and assign, plus the linked agent only when there is one", () => {
		const caps = { readOnly: false, hasSession: true };
		expect(taskMenuItems({ content: "t" }, caps).map(i => i.id)).toEqual(["do-now", "split", "assign"]);
		expect(taskMenuItems({ content: "t", agentName: "DocSweep" }, caps).map(i => i.id)).toEqual(["do-now", "split", "assign", "open-agent"]);
		const noSession = taskMenuItems({ content: "t" }, { readOnly: false, hasSession: false });
		expect(noSession.filter(i => i.enabled).map(i => i.id)).toEqual(["split"]);
	});

	it("puts the task into the split request and leaves no template marker behind", () => {
		const text = splitTaskMessage("Cap pending\n   sends while reconnecting");
		expect(text).toContain("Cap pending sends while reconnecting");
		expect(text).not.toContain("{{");
		expect(ASK_PROGRESS_MESSAGE.length).toBeGreaterThan(0);
	});

	it("keeps the menu inside the viewport", () => {
		const view = { width: 1000, height: 700 };
		const corner = placeMenu(990, 690, 6, view);
		expect(corner.left + 320).toBeLessThanOrEqual(1000);
		expect(corner.top).toBeGreaterThanOrEqual(8);
		expect(corner.top + 6 * 84).toBeLessThanOrEqual(700);
		expect(placeMenu(100, 100, 3, view)).toEqual({ left: 100, top: 100 });
	});
});

describe("plan graph rendering", () => {
	const board = deriveTodos([
		{
			id: "t",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c",
				toolName: "todo",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 0,
				details: {
					phases: [
						{ name: "Fix", tasks: [{ content: "Sweep collab docs for 1006", status: "in_progress" }, { content: "Cap pending sends", status: "pending" }] },
					],
				},
			},
		},
	]);

	it("draws the task colour class per status and links a running agent as inferred", () => {
		const html = renderToStaticMarkup(
			<PlanGraphView board={board} agents={[{ id: "DocSweep", name: "DocSweep", task: "sweep collab docs" }]} ctx={null} />,
		);
		expect(html).toMatch(/pg-task pg-task--in_progress pg-task--linked/);
		expect(html).toMatch(/pg-task pg-task--pending"/);
		expect(html).toContain('data-agent-chip="DocSweep"');
		expect(html).toContain("DocSweep · inferred");
		expect(html.match(/data-agent-chip=/g)).toHaveLength(1);
	});

	it("says there is no list yet instead of drawing an empty graph", () => {
		const html = renderToStaticMarkup(<PlanGraphView board={null} agents={[]} ctx={null} />);
		expect(html).toContain("No todo list yet");
		expect(html).not.toContain("pg-svg");
	});
});

describe("draft canvas rendering", () => {
	const plan = {
		name: "p",
		nodes: [
			{ id: "n1", title: "Plan", instruction: "x", profile: "plan" },
			{ id: "n2", title: "Build", instruction: "x", profile: "task", dependsOn: ["n1"] },
			{ id: "n3", title: "Review", instruction: "x", profile: "reviewer", dependsOn: ["n2"] },
		],
	};
	const nodes = fromDraftPlan(plan).nodes;
	const run: DraftRun = {
		runId: "r",
		sessionId: "s",
		plan,
		state: "failed",
		startedAt: 1000,
		nodes: [
			{ id: "n1", state: "done", agentId: "Agent-1", startedAt: 1000, endedAt: 2000 },
			{ id: "n2", state: "failed", agentId: "Agent-2", startedAt: 2000, endedAt: 6000 },
			{ id: "n3", state: "skipped" },
		],
	};
	const render = (withRun: boolean) =>
		renderToStaticMarkup(
			<DraftCanvas nodes={nodes} selection={null} flagged={new Set()} run={withRun ? run : undefined} now={9000} onSelect={noop} onMove={noop} onConnect={noop} onOpenAgent={noop} />,
		);

	it("shows each node's run state, its time, and a way to the agent only where one was spawned", () => {
		const html = render(true);
		expect(html).toContain('aria-label="Plan, done"');
		expect(html).toContain('aria-label="Build, failed"');
		expect(html).toContain('aria-label="Review, skipped"');
		expect(html).toContain("failed · 4.0s");
		expect(html.match(/aria-label="open agent for /g)).toHaveLength(2);
		expect(html).not.toContain('aria-label="open agent for Review"');
		// Edges are coloured by what the upstream node did.
		expect(html).toMatch(/dc-edge dc-edge--done"/);
		expect(html).toMatch(/dc-edge dc-edge--failed"/);
		expect(html).toContain('data-editable="false"');
	});

	it("offers ports and dashed own-drawing edges only while editing", () => {
		const editing = render(false);
		expect(editing).toContain("data-port-out");
		expect(editing).toContain('data-editable="true"');
		expect(editing).toContain("draft · dashed lines are yours");
		expect(editing).toContain("dc-edge-hit");
		const running = render(true);
		expect(running).not.toContain("data-port-out");
		expect(running).not.toContain("dc-edge-hit");
	});

	it("tells an empty canvas what to do first", () => {
		const html = renderToStaticMarkup(
			<DraftCanvas nodes={[]} selection={null} flagged={new Set()} now={0} onSelect={noop} onMove={noop} onConnect={noop} onOpenAgent={noop} />,
		);
		expect(html).toContain("Draw a plan.");
	});
});

describe("agents sheet without a session", () => {
	it("keeps only Tree and Graph for a plain link guest, with no edge toggles", () => {
		const graph = treeGraph();
		const html = renderToStaticMarkup(
			<AgentsSheet graph={graph} summary={summarizeAgents(graph.nodes)} selectedId={null} phone={false} onSelect={noop} onClose={noop} />,
		);
		expect([...html.matchAll(/<button[^>]*role="tab"[^>]*>.*?<\/button>/g)].map(m => m[0].replace(/<[^>]+>/g, "").trim())).toEqual(["Tree", "Graph"]);
		expect(html).not.toContain("ag-edgetoggle");
	});
});
