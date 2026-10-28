import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentProfileDetail, ListModelsResponse } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_TREE_SESSION_ID } from "../dev/agent-tree-fixture";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";
import { ProfileDetailView } from "../src/components/profiles/ProfilesPanel";
import { ControlsBody } from "../src/components/spawn/SessionControls";
import { DeckApi, type FetchLike } from "../src/lib/api";
import { type DetailState, ProfileDetailStore } from "../src/lib/profiles";
import { SessionControlStore } from "../src/lib/session-model";
import { emptyRow, runSpawn } from "../src/lib/spawn";

const noop = (): void => {};

const MODELS: ListModelsResponse = {
	models: [
		{ selector: "anthropic/claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", available: true },
		{ selector: "anthropic/claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", available: true },
	],
	roles: { default: "anthropic/claude-sonnet-5-5" },
};

function body(patch: Partial<Parameters<typeof ControlsBody>[0]> = {}): string {
	return renderToStaticMarkup(
		<ControlsBody
			models={MODELS}
			modelsError={null}
			onRetryModels={noop}
			modelLabel="Claude Sonnet 5.5"
			selector="anthropic/claude-sonnet-5-5"
			thinking="medium"
			busy={null}
			pending={null}
			error={null}
			note={null}
			onPickModel={noop}
			onPickThinking={noop}
			onCopy={noop}
			{...patch}
		/>,
	);
}

describe("model and thinking controls", () => {
	it("marks the current thinking level, states that the change is session-only, and shows the omp commands", () => {
		const html = body();
		expect(html).toMatch(/role="radio" aria-checked="true" class="sc-seg-btn" data-on="true">medium</);
		expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]) {
			expect(html).toContain(`>${level}</button>`);
		}
		expect(html).toContain("does not change your omp default");
		expect(html).toContain("/effort medium");
		expect(html).toContain("/switch anthropic/claude-sonnet-5-5");
	});

	it("puts an error under the control it belongs to, and locks both while a change is in flight", () => {
		const failed = body({ error: { control: "thinking", message: "The daemon did not accept that level: nope" } });
		const thinkingSection = failed.slice(failed.indexOf('aria-label="thinking"'));
		const modelSection = failed.slice(failed.indexOf('aria-label="model"'), failed.indexOf('aria-label="thinking"'));
		expect(thinkingSection).toContain("did not accept that level");
		expect(modelSection).not.toContain("did not accept");

		const busy = body({ busy: "model", pending: "anthropic/claude-opus-5-5" });
		expect(busy).toContain("switching to claude-opus-5-5…");
		expect(busy.match(/class="sc-seg-btn"[^>]*disabled/g)).toHaveLength(8);
	});
});

const REVIEWER: AgentProfileDetail = {
	name: "reviewer",
	source: "user",
	description: "Reviews a finished change.",
	definitionModels: ["plan"],
	effectiveModel: "anthropic/claude-opus-5-5",
	tools: ["read", "grep"],
	spawns: [],
	thinking: "high",
	skills: ["visual-review"],
	file: "/Users/dev/.omp/agent/agents/reviewer.md",
};

function ready(...profiles: AgentProfileDetail[]): DetailState {
	return { state: "ready", sessionId: "s", byName: new Map(profiles.map(p => [p.name, p])) };
}

describe("profile details", () => {
	it("lists what the definition declares, the file path to copy, and a spawn action", () => {
		const html = renderToStaticMarkup(<ProfileDetailView name="reviewer" detail={{ state: ready(REVIEWER), onLoad: noop }} />);
		expect(html).toContain('<span class="pd-tag">read</span><span class="pd-tag">grep</span>');
		expect(html).toContain("visual-review");
		expect(html).toContain("high");
		expect(html).toContain("/Users/dev/.omp/agent/agents/reviewer.md");
		expect(html).toContain("copy: /Users/dev/.omp/agent/agents/reviewer.md");
		expect(html).toContain("Spawn with this agent profile");
		expect(html).toContain('task({ &quot;agent&quot;: &quot;reviewer&quot;');
	});

	it("says a bundled profile has no file, and shows 'any profile' for an open spawn list", () => {
		const bundled: AgentProfileDetail = { name: "task", source: "bundled", definitionModels: [], spawns: "*" };
		const html = renderToStaticMarkup(<ProfileDetailView name="task" detail={{ state: ready(bundled), onLoad: noop }} />);
		expect(html).toContain("Built into omp: there is no file to edit");
		expect(html).toContain("any profile");
		expect(html).toContain("all tools");
		expect(html).not.toContain("copy: /");
	});

	it("explains each state in which there is nothing to show", () => {
		const view = (state: DetailState, name = "reviewer"): string =>
			renderToStaticMarkup(<ProfileDetailView name={name} detail={{ state, onLoad: noop }} />);
		expect(view({ state: "no-session" })).toContain("Start or open a session");
		expect(view({ state: "error", message: "The daemon is unreachable." })).toContain("The daemon is unreachable.");
		expect(view(ready(REVIEWER), "ghost")).toContain("does not list a profile named ghost");
		expect(view({ state: "loading" })).toContain("Loading definition");
	});
});

describe("ProfileDetailStore", () => {
	it("shares one request between concurrent callers and does not refetch once loaded", async () => {
		const urls: string[] = [];
		const fetch: FetchLike = async input => {
			urls.push(input);
			const json = (b: unknown): Response => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
			if (input.endsWith("/sessions")) return json({ live: [{ id: "s1" }], recent: [] });
			return json({ commands: [], tools: [], profiles: [REVIEWER], skills: [], roles: {}, mcp: [], generatedAt: 1 });
		};
		const store = new ProfileDetailStore(new DeckApi({ fetch, base: "/api" }));
		await Promise.all([store.ensure(), store.ensure()]);
		await store.ensure();
		expect(urls).toEqual(["/api/sessions", "/api/sessions/s1/catalog"]);
		const state = store.getSnapshot();
		expect(state.state === "ready" && state.byName.get("reviewer")?.file).toBe(REVIEWER.file);
	});
});

describe("against the mock daemon", () => {
	let daemon: MockDaemon;
	let api: DeckApi;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0, seed: false, agentTree: true });
		api = new DeckApi({ base: `${daemon.url}/api` });
	});
	afterAll(async () => {
		await daemon.stop();
	});

	it("reads profile definitions from the live session's catalog", async () => {
		const store = new ProfileDetailStore(api, AGENT_TREE_SESSION_ID);
		await store.ensure();
		const state = store.getSnapshot();
		if (state.state !== "ready") throw new Error(`state ${state.state}`);
		expect(state.sessionId).toBe(AGENT_TREE_SESSION_ID);
		expect(state.byName.get("reviewer")?.tools).toContain("lsp");
		expect(state.byName.get("task")?.spawns).toBe("*");
	});

	it("reports no-session when nothing is live", async () => {
		const empty = await startMockDaemon({ port: 0, seed: false });
		try {
			const store = new ProfileDetailStore(new DeckApi({ base: `${empty.url}/api` }));
			await store.ensure();
			expect(store.getSnapshot().state).toBe("no-session");
		} finally {
			await empty.stop();
		}
	});

	it("applies thinking, and maps a level the model does not support to the inline error", async () => {
		const store = new SessionControlStore({ api, sessionId: AGENT_TREE_SESSION_ID, agentId: "main", record: noop });
		await store.setThinking("max", "medium");
		expect(store.getSnapshot().thinking).toEqual({ value: "max", baseline: "medium" });
		await store.setThinking("xhigh", "medium");
		const snap = store.getSnapshot();
		expect(snap.error?.message).toBe("The daemon did not accept that level: claude-sonnet-5-5 does not support xhigh");
		expect(snap.thinking?.value).toBe("max");
	});

	it("spawns rows in order, keeps going past a refusal, and starts only the failed row on retry", async () => {
		const rows = [emptyRow("task"), emptyRow("reviewer"), emptyRow("explore")];
		rows[0]!.task = "first";
		rows[1]!.task = "second #refuse";
		rows[2]!.task = "third";
		const states: string[] = [];
		const deps = {
			api,
			sessionId: AGENT_TREE_SESSION_ID,
			record: noop,
			onStatus: (key: string, status: { state: string }) => states.push(`${rows.findIndex(r => r.key === key)}:${status.state}`),
		};
		const first = await runSpawn(deps, rows);
		expect(first.failed).toBe(1);
		expect(states).toEqual(["0:spawning", "0:done", "1:spawning", "1:error", "2:spawning", "2:done"]);

		rows[1]!.task = "second";
		states.length = 0;
		const previous = new Map([
			[rows[0]!.key, { state: "done" as const, agentId: "RelayProbe" }],
			[rows[2]!.key, { state: "done" as const, agentId: "RelayProbe" }],
		]);
		const retry = await runSpawn(deps, rows, previous);
		expect(states).toEqual(["1:spawning", "1:done"]);
		expect(retry).toEqual({ agentIds: ["RelayProbe", "RelayProbe", "RelayProbe"], failed: 0 });
	});

	it("refuses an unknown profile and an empty task with the daemon's words", async () => {
		const rows = [emptyRow("ghost")];
		rows[0]!.task = "x";
		const messages: string[] = [];
		await runSpawn(
			{
				api,
				sessionId: AGENT_TREE_SESSION_ID,
				record: noop,
				onStatus: (_key, status) => {
					if (status.state === "error") messages.push(status.message);
				},
			},
			rows,
		);
		expect(messages).toEqual(["The daemon did not accept it: unknown profile ghost"]);
	});
});
