import { describe, expect, it } from "bun:test";
import type { ListModelsResponse } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_TREE_SILENT, makeTreeAgents, makeTreeLifecycle, makeTreeProgress } from "../dev/agent-tree-fixture";
import { AgentGraphView, fitGraph } from "../src/components/agents/AgentGraphView";
import { AgentStatusSection } from "../src/components/agents/AgentStatusSection";
import { AgentsSheet } from "../src/components/agents/AgentsSheet";
import { AgentTree } from "../src/components/agents/AgentTree";
import { ModelPicker } from "../src/components/agents/ModelPicker";
import { ProfilesView } from "../src/components/profiles/ProfilesPanel";
import { buildAgentGraph, layoutAgentGraph, summarizeAgents } from "../src/lib/agent-graph";
import type { ProfileConfigSnapshot } from "../src/lib/profile-config";

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

describe("agent graph rendering", () => {
	it("draws parent-to-batch and batch-to-agent edges left to right, with flow only into active targets", () => {
		const graph = treeGraph();
		const html = renderToStaticMarkup(<AgentGraphView graph={graph} selectedId={null} onSelect={noop} />);
		const unescape = (value: string | undefined): string => (value ?? "").replaceAll("&gt;", ">");
		const edges = [...html.matchAll(/data-edge="([^"]+)"/g)].map(match => unescape(match[1])).sort();
		const expectedEdges = graph.batches
			.flatMap(batch =>
				batch.childIds.length > 1
					? [`${batch.parentId}>${batch.id}`, ...batch.childIds.map(id => `${batch.id}>${id}`)]
					: batch.childIds.map(id => `${batch.parentId}>${id}`),
			)
			.sort();
		expect(edges).toEqual(expectedEdges);
		const verifyBatch = graph.batches.find(batch => batch.parentId === "main" && batch.childIds.length === 5)!;
		const reconnectBatch = graph.batches.find(batch => batch.parentId === "main" && batch.childIds.length === 3)!;
		const flowing = [...html.matchAll(/class="ag-gedge ag-gedge--flow"\s+data-edge="([^"]+)"/g)].map(match => unescape(match[1])).sort();
		expect(flowing).toEqual([`main>${verifyBatch.id}`, `${verifyBatch.id}>BuildBot`, `${reconnectBatch.id}>RelayProbe`].sort());
		expect(html.match(/ag-gnode-pulse/g)).toHaveLength(3);
		expect(html).toMatch(/ag-gnode--running ag-gnode--stalled[^>]*data-node-id="DocSweep"/);
		expect(html).toContain('aria-label="DocSweep, stalled"');
		expect(html).toContain('aria-label="ProbeWorker, failed"');
		expect(html).toContain('aria-label="Planner, finished"');
	});

	it("shows batch modes, aggregate status and compact agent activity, model, usage and duration", () => {
		const graph = treeGraph();
		const html = renderToStaticMarkup(<AgentGraphView graph={graph} selectedId={null} onSelect={noop} />);
		expect(html.match(/data-batch-id=/g)).toHaveLength(2);
		expect(html).toContain("3 agents");
		expect(html).toContain("5 agents");
		expect(html).toContain("blocking");
		expect(html).toContain("async");
		expect(html).toContain("failed");
		expect(html).toContain("claude-sonnet-5-5");
		expect(html).toContain("19.8k tok");
		expect(html).toContain("$0.045");
		expect(html).toContain("12 tools");
		expect(html).toContain("1m41s");
		expect(html).toContain('aria-label="Collapse task batch');
		expect(html).toContain('aria-label="Collapse RelayProbe subtree"');
	});

	it("keeps the root card inside the viewport when the readability floor makes a narrow graph overflow", () => {
		const layout = layoutAgentGraph(treeGraph());
		const root = layout.nodes.find(node => node.id === "main")!;
		const viewport = { width: 676, height: 636 };
		const fitted = fitGraph(layout, viewport);
		const left = root.x * fitted.k + fitted.x;
		const right = (root.x + root.width) * fitted.k + fitted.x;
		expect(left).toBeGreaterThanOrEqual(0);
		expect(right).toBeLessThanOrEqual(viewport.width);
	});

	it("marks the selected node", () => {
		const html = renderToStaticMarkup(<AgentGraphView graph={treeGraph()} selectedId="Planner" onSelect={noop} />);
		expect(html).toMatch(/ag-gnode--selected[^>]*data-node-id="Planner"/);
		expect(html).toContain('aria-pressed="true"');
	});

	it("shows the same tree as an indented list with status, stall flag and usage", () => {
		const html = renderToStaticMarkup(<AgentTree graph={treeGraph()} selectedId={null} onSelect={noop} />);
		const order = [...html.matchAll(/ag-tree-name">([^<]+)</g)].map(match => match[1]);
		expect(order).toEqual(["Main", "Planner", "PatchScout", "RelayProbe", "ProbeWorker", "DocSweep", "TestRunner", "AuditWorker", "BuildBot", "DocWriter", "ReleaseCheck"]);
		expect(html).toContain("padding-left:32px"); // ProbeWorker, depth 2
		expect(html).toContain("stalled");
		expect(html).toContain("12.8k tok"); // Planner
		expect(html).toContain("3.9k tok"); // ProbeWorker
	});

	it("opens the list on a phone and the graph elsewhere, with the summary row above both", () => {
		const graph = treeGraph();
		const props = { graph, summary: summarizeAgents(graph.nodes), selectedId: null, onSelect: noop, onClose: noop };
		const phone = renderToStaticMarkup(<AgentsSheet {...props} phone />);
		const desktop = renderToStaticMarkup(<AgentsSheet {...props} phone={false} />);
		expect(phone).toContain('class="ag-tree"');
		expect(phone).not.toContain("ag-graph-svg");
		expect(desktop).toContain("ag-graph-svg");
		expect(desktop).not.toContain('class="ag-tree"');
		for (const html of [phone, desktop]) {
			expect(html).toContain("<strong>3</strong> running");
			expect(html).toContain("<strong>1</strong> stalled");
		}
	});

	it("flags the stalled agent in the status section with how long it has been silent", () => {
		// The room never emits progress for the silent agent, so the browser has no signal for it either.
		const progress = new Map(makeTreeProgress(1, new Map(), AGENT_TREE_SILENT).map(p => [p.progress.id, p]));
		const lifecycle = new Map(makeTreeLifecycle().map(p => [p.id, p]));
		const html = renderToStaticMarkup(
			<AgentStatusSection agents={makeTreeAgents(Date.now())} progress={progress} lifecycle={lifecycle} working={true} />,
		);
		expect(html).toContain("stalled · no activity 4m");
		expect(html).toContain("DocSweep");
		expect(html).toContain("RelayProbe");
		expect(html.indexOf("DocSweep")).toBeLessThan(html.indexOf("RelayProbe")); // stalled agents are listed first
	});

	it("says so when there are no subagents", () => {
		const html = renderToStaticMarkup(
			<AgentStatusSection agents={makeTreeAgents(NOW).slice(0, 1)} progress={new Map()} lifecycle={new Map()} working={false} />,
		);
		expect(html).toContain("No subagents in this session.");
	});
});

const MODELS: ListModelsResponse = {
	models: [
		{ selector: "anthropic/claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", available: true },
		{ selector: "google/gemini-3-pro", provider: "google", label: "Gemini 3 Pro", available: false },
	],
	roles: { plan: "anthropic/claude-opus-5-5" },
};

describe("ModelPicker", () => {
	it("hides unavailable models behind a count, marks the one in use, and shows role aliases with their target", () => {
		const html = renderToStaticMarkup(
			<ModelPicker models={MODELS} current="anthropic/claude-opus-5-5" onPick={noop} />,
		);
		const row = (needle: string): string => html.split("<button").find(part => part.includes(needle)) ?? "";
		expect(html).not.toContain("google/gemini-3-pro");
		expect(html).toContain("Show 1 unavailable model");
		const opus = row("Claude Opus 5.5");
		expect(opus).toContain('aria-selected="true"');
		expect(opus).not.toContain("disabled");
		expect(html).toContain("→ anthropic/claude-opus-5-5");
	});

	it("keeps an unavailable model in use listed, disabled", () => {
		const html = renderToStaticMarkup(<ModelPicker models={MODELS} current="google/gemini-3-pro" onPick={noop} />);
		const gemini = html.split("<button").find(part => part.includes("google/gemini-3-pro")) ?? "";
		expect(gemini).toContain("disabled");
		expect(gemini).toContain("unavailable");
		expect(html).not.toContain("unavailable model");
	});

	it("shows the load failure instead of an empty list", () => {
		const html = renderToStaticMarkup(
			<ModelPicker models={null} error="The daemon is unreachable. Nothing was changed." onPick={noop} onRetry={noop} />,
		);
		expect(html).toContain("The daemon is unreachable");
		expect(html).toContain("retry");
		expect(html).not.toContain("listbox");
	});
});

function snapshot(patch: Partial<ProfileConfigSnapshot>): ProfileConfigSnapshot {
	return {
		load: "ready",
		loadError: null,
		profiles: [
			{
				name: "reviewer",
				source: "user",
				description: "Reviews a change",
				definitionModels: ["plan"],
				override: "anthropic/claude-haiku-5-5",
				effectiveModel: "anthropic/claude-haiku-5-5",
			},
		],
		roles: { plan: "anthropic/claude-opus-5-5", default: "anthropic/claude-sonnet-5-5" },
		models: MODELS,
		modelsError: null,
		edit: null,
		saved: null,
		...patch,
	};
}

const handlers = { onBegin: noop, onChoose: noop, onBack: noop, onCancel: noop, onConfirm: noop, onRetry: noop };

describe("ProfilesView", () => {
	it("states that it edits the user's omp config for new spawns in all sessions, and shows definition, override and effective model", () => {
		const html = renderToStaticMarkup(<ProfilesView snapshot={snapshot({})} {...handlers} />);
		expect(html).toContain("your omp configuration");
		expect(html).toContain("new spawns in all sessions");
		expect(html).toContain("Definition");
		expect(html).toContain("plan");
		expect(html).toContain("Override");
		expect(html).toContain("anthropic/claude-haiku-5-5");
		expect(html).toContain("Effective");
		expect(html.indexOf("anthropic/claude-sonnet-5-5")).toBeLessThan(html.indexOf("anthropic/claude-opus-5-5")); // default role first
	});

	it("asks for confirmation naming the target, the value and the blast radius before anything is saved", () => {
		const html = renderToStaticMarkup(
			<ProfilesView
				snapshot={snapshot({
					edit: {
						target: { kind: "profile", name: "reviewer" },
						stage: "confirm",
						before: "anthropic/claude-haiku-5-5",
						selector: "anthropic/claude-opus-5-5",
						error: null,
					},
				})}
				{...handlers}
			/>,
		);
		expect(html).toContain("profile reviewer");
		expect(html).toContain("anthropic/claude-opus-5-5");
		expect(html).toContain("applies to new spawns in <strong>all sessions</strong>");
		expect(html).toContain("Confirm and save");
	});

	it("offers to clear an existing override and shows a failed save inline", () => {
		const choosing = renderToStaticMarkup(
			<ProfilesView
				snapshot={snapshot({
					edit: { target: { kind: "profile", name: "reviewer" }, stage: "choose", before: "x/y", selector: undefined, error: null },
				})}
				{...handlers}
			/>,
		);
		expect(choosing).toContain("Clear override");
		const failed = renderToStaticMarkup(
			<ProfilesView
				snapshot={snapshot({
					edit: { target: { kind: "role", role: "plan" }, stage: "confirm", before: "a/b", selector: "c/d", error: "The daemon did not accept that model: boom" },
				})}
				{...handlers}
			/>,
		);
		expect(failed).toContain("The daemon did not accept that model: boom");
		const role = renderToStaticMarkup(
			<ProfilesView
				snapshot={snapshot({ edit: { target: { kind: "role", role: "plan" }, stage: "choose", before: "a/b", selector: undefined, error: null } })}
				{...handlers}
			/>,
		);
		expect(role).not.toContain("Clear override"); // a role always has a value
	});

	it("shows a load failure with a retry instead of an empty table", () => {
		const html = renderToStaticMarkup(
			<ProfilesView
				snapshot={snapshot({ load: "error", loadError: "The daemon is unreachable. Nothing was changed.", profiles: [], roles: {} })}
				{...handlers}
			/>,
		);
		expect(html).toContain("The daemon is unreachable");
		expect(html).toContain("Retry");
		expect(html).not.toContain("Model roles");
	});
});
