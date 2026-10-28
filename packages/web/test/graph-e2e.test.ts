import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GRAPH_SESSION_ID } from "../dev/mock-graph";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";
import { planAgentsOf } from "../src/components/agents/AgentsSheet";
import { buildAgentGraph } from "../src/lib/agent-graph";
import { DeckApi, DeckApiError } from "../src/lib/api";
import { GuestClient } from "../src/lib/client";
import { isRunActive, runCounts, runStateView, validateDraft } from "../src/lib/draft";
import { aggregateMessageEdges, extractIrcEvents } from "../src/lib/message-edges";
import { layoutPlanGraph } from "../src/lib/plan-graph";
import { deriveTodos } from "../src/lib/todos";

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

describe("graph features against the mock daemon's `graph` room (real frames, real client)", () => {
	let daemon: MockDaemon;
	let client: GuestClient;
	let api: DeckApi;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0, seed: false, agentTree: true });
		api = new DeckApi({ base: `${daemon.url}/api` });
		const { link } = await api.roomLink(GRAPH_SESSION_ID);
		client = new GuestClient(link, "graph-e2e");
		client.connect();
		await until(() => {
			const snap = client.getSnapshot();
			return snap.phase === "live" && snap.lifecycle.size >= 4 && snap.entries.some(entry => entry.type === "custom_message");
		}, "welcome, lifecycle and the transcript");
	});
	afterAll(async () => {
		client.close();
		await daemon.stop();
	});

	it("derives the message edges the room's transcript records, each message once", () => {
		const snap = client.getSnapshot();
		const ids = new Set(snap.agents.map(agent => agent.id));
		const main = snap.agents.find(agent => agent.kind === "main")!.id;
		const edges = aggregateMessageEdges(extractIrcEvents(main, snap.entries), ids, main);
		expect(edges.map(e => `${e.from}>${e.to}:${e.kind}x${e.count}`)).toEqual([
			"DocSweep>main:messagex1",
			"DocSweep>RelayProbe:messagex1",
			"main>DocSweep:broadcastx1",
			"main>Planner:messagex1",
			"main>RelayProbe:broadcastx1",
			"main>RelayProbe:messagex2",
			"RelayProbe>DocSweep:messagex3",
			"RelayProbe>main:messagex1",
			"RelayProbe>main:replyx1",
		]);
	});

	it("lays the todo board out and links the two running agents whose assignments read like their tasks", () => {
		const snap = client.getSnapshot();
		const board = deriveTodos(snap.entries)!;
		const graph = buildAgentGraph({ agents: snap.agents, progress: snap.progress, lifecycle: snap.lifecycle, now: Date.now() });
		const layout = layoutPlanGraph(board, planAgentsOf(graph, snap.progress, snap.lifecycle));
		expect(layout.phases.map(p => p.name)).toEqual(["Investigate", "Fix", "Verify"]);
		const linked = layout.tasks.filter(task => task.agent).map(task => `${task.content} -> ${task.agent!.agentId}`);
		expect(linked).toEqual(["Probe relay reconnect behaviour -> RelayProbe", "Sweep collab docs for close code 1006 -> DocSweep"]);
	});

	it("reports the seeded run's node states in the order the daemon computes them", async () => {
		const { runs } = await api.listDraftRuns(GRAPH_SESSION_ID);
		const run = runs.find(candidate => isRunActive(candidate))!;
		expect(run.nodes.map(node => runStateView(node.state).label)).toEqual(["done", "running", "running", "waiting", "waiting"]);
		expect(runCounts(run)).toMatchObject({ done: 1, running: 2, waiting: 2 });
		expect(run.nodes.find(node => node.id === "n2")!.agentId).toBe("RelayProbe");
	});

	it("refuses a cyclic draft with the same sentence the client shows before sending", async () => {
		const cyclic = {
			name: "loop",
			nodes: [
				{ id: "a", title: "A", instruction: "x", profile: "task", dependsOn: ["b"] },
				{ id: "b", title: "B", instruction: "x", profile: "task", dependsOn: ["a"] },
			],
		};
		const local = validateDraft(cyclic, ["task"]).find(issue => issue.kind === "cycle")!;
		const error = await api.startDraftRun(GRAPH_SESSION_ID, cyclic).then(
			() => null,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(DeckApiError);
		expect((error as DeckApiError).kind).toBe("bad-request");
		expect((error as DeckApiError).message).toBe(local.message);
	});

	it("cancels a started draft: running nodes are cancelled, waiting dependents skipped", async () => {
		const started = await api.startDraftRun(GRAPH_SESSION_ID, {
			name: "chain",
			nodes: [
				{ id: "a", title: "A", instruction: "go [fail]", profile: "task" },
				{ id: "b", title: "B", instruction: "go", profile: "task", dependsOn: ["a"] },
				{ id: "c", title: "C", instruction: "go", profile: "task" },
			],
		});
		expect(started.state).toBe("running");
		expect(started.nodes.map(node => node.state)).toEqual(["running", "waiting", "running"]);
		await api.cancelDraftRun(GRAPH_SESSION_ID, started.runId);
		const { runs } = await api.listDraftRuns(GRAPH_SESSION_ID);
		const after = runs.find(run => run.runId === started.runId)!;
		expect(after.state).toBe("cancelled");
		expect(after.nodes.map(node => node.state)).toEqual(["cancelled", "skipped", "cancelled"]);
	});

	it("keeps a saved template and hands it back whole", async () => {
		const plan = { name: "my plan", nodes: [{ id: "n1", title: "One", instruction: "x", profile: "task", files: ["a.ts"], dependsOn: [] }] };
		await api.savePlanTemplate(plan);
		const { templates } = await api.listPlanTemplates();
		expect(templates.find(template => template.name === "my plan")).toEqual(plan);
	});
});
