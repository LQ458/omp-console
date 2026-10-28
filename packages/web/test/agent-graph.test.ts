import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import {
	AGENT_TREE_EDGES,
	AGENT_TREE_SESSION_ID,
	makeTreeAgents,
	makeTreeLifecycle,
	makeTreeProgress,
} from "../dev/agent-tree-fixture";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";
import { ProgressSeen } from "../src/lib/agent-activity";
import {
	type AgentGraph,
	agentCollapseKey,
	batchCollapseKey,
	buildAgentGraph,
	GAP_X,
	GAP_Y,
	layoutAgentGraph,
	LAYOUT_PADDING,
	NODE_HEIGHT,
	NODE_WIDTH,
	STALL_AFTER_MS,
	summarizeAgents,
} from "../src/lib/agent-graph";
import { DeckApi } from "../src/lib/api";
import { GuestClient } from "../src/lib/client";

const NOW = 1_000_000_000_000;
const NONE = new Map<string, never>();

function agent(id: string, parentId: string | undefined, extra: Partial<AgentSnapshot> = {}): AgentSnapshot {
	return {
		id,
		displayName: id,
		kind: "sub",
		parentId,
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 60_000,
		lastActivity: NOW - 1_000,
		...extra,
	};
}

function graphOf(agents: AgentSnapshot[], now = NOW): AgentGraph {
	return buildAgentGraph({ agents, progress: NONE, lifecycle: NONE, now });
}
function fixtureGraph(now = NOW): AgentGraph {
	return buildAgentGraph({
		agents: makeTreeAgents(now),
		progress: new Map(makeTreeProgress(0, new Map()).map(payload => [payload.progress.id, payload])),
		lifecycle: new Map(makeTreeLifecycle().map(payload => [payload.id, payload])),
		now,
	});
}

const layoutEdgeKeys = (graph: AgentGraph): string[] =>
	graph.batches
		.flatMap(batch =>
			batch.childIds.length > 1
				? [`${batch.parentId}>${batch.id}`, ...batch.childIds.map(id => `${batch.id}>${id}`)]
				: batch.childIds.map(id => `${batch.parentId}>${id}`),
		)
		.sort();

const edgeKeys = (graph: AgentGraph): string[] =>
	graph.edges.filter(edge => !edge.cycle).map(edge => `${edge.from}>${edge.to}`).sort();

async function until(check: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

describe("main agent busy state", () => {
	const silentMain = agent("main", undefined, { kind: "main", lastActivity: NOW - 10 * 60_000 });
	const node = (mainWorking: boolean | undefined) =>
		buildAgentGraph({ agents: [silentMain], progress: NONE, lifecycle: NONE, now: NOW, mainWorking }).nodes[0]!;

	it("an idle session's main agent is idle, never stalled, however long it has been quiet", () => {
		expect(node(false)).toMatchObject({ status: "idle", stalled: false });
	});

	it("a main agent silent for over two minutes while its turn streams is flagged stalled", () => {
		expect(node(true)).toMatchObject({ status: "running", stalled: true });
	});

	it("subagents keep their registry status whatever the session is doing", () => {
		const sub = agent("s1", "main", { lastActivity: NOW - 10 * 60_000 });
		const graph = buildAgentGraph({ agents: [silentMain, sub], progress: NONE, lifecycle: NONE, now: NOW, mainWorking: false });
		expect(graph.nodes.find(n => n.id === "s1")).toMatchObject({ status: "running", stalled: true });
	});
});

describe("agent graph from the fixture room's frames (rubric #9)", () => {
	let daemon: MockDaemon;
	let client: GuestClient;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0, seed: false, agentTree: true });
		const api = new DeckApi({ base: `${daemon.url}/api` });
		const { link } = await api.roomLink(AGENT_TREE_SESSION_ID);
		client = new GuestClient(link, "graph-test");
		client.connect();
		await until(
			() => client.getSnapshot().phase === "live" && client.getSnapshot().lifecycle.size >= makeTreeLifecycle().length,
			"welcome and lifecycle frames",
		);
	});
	afterAll(async () => {
		client.close();
		await daemon.stop();
	});

	it("matches every parent-to-child edge of the spawn tree and invents none", () => {
		const snap = client.getSnapshot();
		const graph = buildAgentGraph({ agents: snap.agents, progress: snap.progress, lifecycle: snap.lifecycle, now: Date.now() });
		const expected = AGENT_TREE_EDGES.map(([parent, child]) => `${parent}>${child}`).sort();
		expect(edgeKeys(graph)).toEqual(expected);
		expect(graph.nodes.map(node => node.id).sort()).toEqual([
			"AuditWorker",
			"BuildBot",
			"DocSweep",
			"DocWriter",
			"PatchScout",
			"Planner",
			"ProbeWorker",
			"RelayProbe",
			"ReleaseCheck",
			"TestRunner",
			"main",
		]);
		expect(graph.roots).toEqual(["main"]);
		expect(graph.edges.every(edge => !edge.cycle)).toBe(true);
	});

	it("groups children by task call, sorts members by index and orders batches by their start time", () => {
		const graph = fixtureGraph();
		const batches = graph.batches.filter(batch => batch.parentId === "main");
		expect(batches.map(batch => batch.childIds.length)).toEqual([1, 3, 5]);
		expect(batches.map(batch => batch.label)).toEqual(["plan the reconnect fix", "probe relay reconnect", "run reconnect suite"]);
		expect(batches.map(batch => batch.detached)).toEqual([false, false, true]);
		expect(batches.map(batch => batch.status)).toEqual(["finished", "failed", "running"]);
		expect(batches.map(batch => batch.durationMs)).toEqual([41_000, 337_000, 162_000]);
		expect(batches[1]?.childIds).toEqual(["RelayProbe", "DocSweep", "PatchScout"]);
		expect(batches[2]?.childIds).toEqual(["TestRunner", "BuildBot", "AuditWorker", "DocWriter", "ReleaseCheck"]);
		expect(batches[0]!.startAt).toBeLessThan(batches[1]!.startAt);
		expect(batches[1]!.startAt).toBeLessThan(batches[2]!.startAt);
	});

	it("lays out parent, task batch and agents left to right with batch order top to bottom", () => {
		const graph = fixtureGraph();
		const layout = layoutAgentGraph(graph);
		const byId = new Map(layout.nodes.map(node => [node.id, node]));
		expect(layout.edges.map(edge => `${edge.from}>${edge.to}`).sort()).toEqual(layoutEdgeKeys(graph));
		for (const edge of layout.edges) expect(byId.get(edge.to)!.x).toBeGreaterThan(byId.get(edge.from)!.x);
		const mainBatches = graph.batches.filter(batch => batch.parentId === "main");
		const visibleBatches = mainBatches.filter(batch => batch.childIds.length > 1);
		expect(visibleBatches.map(batch => byId.get(batch.id)!.y)).toEqual(
			[...visibleBatches].map(batch => byId.get(batch.id)!.y).sort((a, b) => a - b),
		);
		for (const batch of visibleBatches) {
			const childY = batch.childIds.map(id => byId.get(id)!.y);
			expect(childY).toEqual([...childY].sort((a, b) => a - b));
		}
		expect(byId.has(mainBatches[0]!.id)).toBe(false);
	});
});

describe("layoutAgentGraph", () => {
	const tree = [
		agent("main", undefined, { kind: "main", createdAt: NOW - 600_000 }),
		agent("a", "main", { createdAt: NOW - 500_000 }),
		agent("b", "main", { createdAt: NOW - 400_000 }),
		agent("a1", "a", { createdAt: NOW - 300_000 }),
		agent("a2", "a", { createdAt: NOW - 200_000 }),
	];

	it("gives the same picture whatever order the frames list the agents in", () => {
		const forward = layoutAgentGraph(graphOf(tree));
		const shuffled = layoutAgentGraph(graphOf([tree[3]!, tree[1]!, tree[4]!, tree[0]!, tree[2]!]));
		const byId = (layout: typeof forward) => [...layout.nodes].sort((x, y) => (x.id < y.id ? -1 : 1));
		expect(byId(shuffled)).toEqual(byId(forward));
		expect(shuffled.width).toBe(forward.width);
		expect(shuffled.height).toBe(forward.height);
	});

	it("places parents left of children and centres them over their descendant rows", () => {
		const layout = layoutAgentGraph(graphOf(tree));
		const at = new Map(layout.nodes.map(node => [node.id, node]));
		const centreY = (id: string): number => at.get(id)!.y + NODE_HEIGHT / 2;
		expect(at.get("main")!.x).toBeLessThan(at.get("a")!.x);
		expect(at.get("a")!.x).toBeLessThan(at.get("a1")!.x);
		expect(centreY("a")).toBe((centreY("a1") + centreY("a2")) / 2);
		expect(centreY("main")).toBe((centreY("a1") + centreY("b")) / 2);
		expect(at.get("a2")!.y - at.get("a1")!.y).toBe(NODE_HEIGHT + GAP_Y);
		expect(layout.width).toBeGreaterThanOrEqual(3 * NODE_WIDTH + 2 * GAP_X + 2 * LAYOUT_PADDING);
	});

	it("keeps every visible agent and batch box separate, with roots in the leftmost column", () => {
		const graph = fixtureGraph();
		const layout = layoutAgentGraph(graph);
		const at = new Map(layout.nodes.map(node => [node.id, node]));
		expect(at.get("main")!.x).toBe(Math.min(...layout.nodes.map(node => node.x)));
		for (let i = 0; i < layout.nodes.length; i++) {
			const first = layout.nodes[i]!;
			for (let j = i + 1; j < layout.nodes.length; j++) {
				const second = layout.nodes[j]!;
				const overlapX = first.x < second.x + second.width && second.x < first.x + first.width;
				const overlapY = first.y < second.y + second.height && second.y < first.y + first.height;
				expect(overlapX && overlapY).toBe(false);
			}
		}
	});

	it("stacks multiple roots vertically without overlap", () => {
		const layout = layoutAgentGraph(graphOf([agent("r1", undefined, { createdAt: NOW - 3 }), agent("r2", "ghost", { createdAt: NOW - 2 })]));
		expect(layout.nodes).toHaveLength(2);
		const [top, bottom] = [...layout.nodes].sort((a, b) => a.y - b.y);
		expect(top!.x).toBe(bottom!.x);
		expect(bottom!.y - top!.y).toBe(NODE_HEIGHT + GAP_Y);
	});

	it("survives parent cycles, self-parents and duplicate ids: every agent is laid out exactly once", () => {
		const agents = [
			agent("x", "y", { createdAt: NOW - 400 }),
			agent("y", "x", { createdAt: NOW - 300 }),
			agent("z", "x", { createdAt: NOW - 200 }),
			agent("self", "self", { createdAt: NOW - 100 }),
			agent("x", "z", { createdAt: NOW - 50 }), // duplicate id: the first entry wins
		];
		const graph = graphOf(agents);
		expect(graph.nodes.map(node => node.id).sort()).toEqual(["self", "x", "y", "z"]);
		const layout = layoutAgentGraph(graph);
		expect(layout.nodes.map(node => node.id).sort()).toEqual(["self", "x", "y", "z"]);
		// x is promoted to a root; the cycle-closing y -> x edge stays flagged but is not drawn.
		expect(graph.roots).toContain("x");
		expect(graph.edges.find(edge => edge.from === "y" && edge.to === "x")?.cycle).toBe(true);
		expect(layout.edges.some(edge => edge.from === "y" && edge.to === "x")).toBe(false);
		expect(layout.edges.map(edge => `${edge.from}>${edge.to}`).sort()).toEqual(["x>y", "x>z"]);
	});

	it("handles a chain far deeper than the call stack would allow recursively", () => {
		const chain = Array.from({ length: 20_000 }, (_, i) => agent(`n${i}`, i === 0 ? undefined : `n${i - 1}`, { createdAt: NOW - 20_000 + i }));
		const layout = layoutAgentGraph(graphOf(chain));
		expect(layout.nodes).toHaveLength(20_000);
	});
});

describe("task batch collapse", () => {
	it("collapses a batch and an agent subtree, then restores their descendants when expanded", () => {
		const graph = fixtureGraph();
		const batch = graph.batches.find(candidate => candidate.parentId === "main" && candidate.childIds.length === 3)!;
		const full = layoutAgentGraph(graph);
		const collapsedBatch = layoutAgentGraph(graph, new Set([batchCollapseKey(batch.id)]));
		const visibleAfterBatchCollapse = new Set(collapsedBatch.nodes.map(node => node.id));
		expect(visibleAfterBatchCollapse.has(batch.id)).toBe(true);
		for (const childId of batch.childIds) expect(visibleAfterBatchCollapse.has(childId)).toBe(false);
		expect(visibleAfterBatchCollapse.has("ProbeWorker")).toBe(false);
		expect(collapsedBatch.height).toBeLessThan(full.height);
		expect(layoutAgentGraph(graph, new Set()).nodes).toEqual(full.nodes);

		const collapsedAgent = layoutAgentGraph(graph, new Set([agentCollapseKey("RelayProbe")]));
		expect(collapsedAgent.nodes.some(node => node.id === "RelayProbe")).toBe(true);
		expect(collapsedAgent.nodes.some(node => node.id === "ProbeWorker")).toBe(false);
	});
});

describe("status and stalled detection", () => {
	const life = (id: string, status: SubagentLifecyclePayload["status"]): [string, SubagentLifecyclePayload] => [
		id,
		{ id, agent: "task", status, index: 0 },
	];

	it("flags a running agent only after 120 s without a signal", () => {
		const quiet = agent("q", "main", { lastActivity: NOW - STALL_AFTER_MS });
		const fresh = agent("f", "main", { lastActivity: NOW - STALL_AFTER_MS + 1 });
		const parked = agent("p", "main", { status: "parked", lastActivity: NOW - 10 * STALL_AFTER_MS });
		const graph = graphOf([agent("main", undefined, { kind: "main" }), quiet, fresh, parked]);
		const byId = new Map(graph.nodes.map(node => [node.id, node]));
		expect(byId.get("q")?.stalled).toBe(true);
		expect(byId.get("q")?.activity).toBe("no activity for 2m");
		expect(byId.get("f")?.stalled).toBe(false);
		expect(byId.get("p")?.stalled).toBe(false); // only running agents can stall
	});

	it("a progress frame seen by the browser counts as activity even when the registry timestamp is old", () => {
		const old = agent("w", "main", { lastActivity: NOW - 10 * STALL_AFTER_MS });
		const seen = new ProgressSeen();
		const progress = new Map<string, SubagentProgressPayload>(makeTreeProgress(1, new Map()).map(p => [p.progress.id, p]));
		const withSeen = new Map([["w", NOW - 5_000]]);
		const live = buildAgentGraph({ agents: [old], progress: NONE, lifecycle: NONE, progressSeenAt: withSeen, now: NOW });
		const silent = buildAgentGraph({ agents: [old], progress: NONE, lifecycle: NONE, now: NOW });
		expect(live.nodes[0]?.stalled).toBe(false);
		expect(silent.nodes[0]?.stalled).toBe(true);

		// ProgressSeen restamps only payloads that changed, and forgets agents that left.
		const first = seen.observe(progress, 100);
		expect([...first.values()].every(at => at === 100)).toBe(true);
		const next = new Map(progress);
		const changed = progress.get("RelayProbe")!;
		next.set("RelayProbe", { ...changed });
		const second = seen.observe(next, 200);
		expect(second.get("RelayProbe")).toBe(200);
		expect(second.get("Planner")).toBe(100);
		expect(seen.observe(next, 300)).toBe(second); // nothing changed: same map identity
		next.delete("Planner");
		expect(seen.observe(next, 400).has("Planner")).toBe(false);
	});

	it("a tracker that mounts late reports the original first-seen time, so an old payload does not hide a stalled agent", () => {
		const payload = makeTreeProgress(1, new Map()).find(p => p.progress.id === "RelayProbe")!;
		const progress = new Map([["RelayProbe", payload]]);
		const early = new ProgressSeen();
		expect(early.observe(progress, 1_000).get("RelayProbe")).toBe(1_000);
		const late = new ProgressSeen(); // e.g. the status sheet opened 5 minutes later
		expect(late.observe(progress, 1_000 + 5 * 60_000).get("RelayProbe")).toBe(1_000);
		const graph = buildAgentGraph({
			agents: [agent("RelayProbe", undefined, { lastActivity: 0 })],
			progress,
			lifecycle: NONE,
			progressSeenAt: late.observe(progress, 1_000 + 5 * 60_000),
			now: 1_000 + 5 * 60_000,
		});
		expect(graph.nodes[0]?.stalled).toBe(true);
	});

	it("a revived agent is running again whatever its old lifecycle said; outcomes only show on stopped agents", () => {
		const lifecycle = new Map([life("a", "completed"), life("b", "failed"), life("c", "aborted"), life("d", "completed")]);
		const agents = [
			agent("main", undefined, { kind: "main", status: "idle" }),
			agent("a", "main", { status: "running" }),
			agent("b", "main", { status: "parked" }),
			agent("c", "main", { status: "parked" }),
			agent("d", "main", { status: "parked" }),
			agent("e", "main", { status: "aborted" }),
			agent("f", "main", { status: "parked" }),
		];
		const graph = buildAgentGraph({ agents, progress: NONE, lifecycle, now: NOW });
		const status = Object.fromEntries(graph.nodes.map(node => [node.id, node.status]));
		expect(status).toEqual({ main: "idle", a: "running", b: "failed", c: "aborted", d: "finished", e: "aborted", f: "parked" });
	});

	it("summarises all subagents and token and cost totals only when reported", () => {
		const graph = fixtureGraph();
		const withUsage = summarizeAgents(graph.nodes);
		expect(withUsage.total).toBe(10);
		expect(withUsage.running).toBe(3);
		expect(withUsage.stalled).toBe(1);
		expect(withUsage.tokens).toBe(12_800 + 18_400 + 7_300 + 5_600 + 9_400 + 11_600 + 4_100 + 6_800 + 7_200 + 3_900);
		expect(withUsage.cost).toBeCloseTo(0.083 + 0.041 + 0.017 + 0.012 + 0.021 + 0.029 + 0.008 + 0.016 + 0.018 + 0.009, 6);
		const without = summarizeAgents(buildAgentGraph({ agents: makeTreeAgents(NOW), progress: NONE, lifecycle: NONE, now: NOW }).nodes);
		expect(without.tokens).toBeNull();
		expect(without.cost).toBeNull();
	});
});
