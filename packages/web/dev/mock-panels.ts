import type {
	ApiError,
	EquivalenceTable,
	ExtensionUiState,
	HistoryResponse,
	ListPluginsResponse,
	ListProcessesResponse,
	PluginInfo,
	QuotaResponse,
	SpawnEstimate,
} from "@omp-console/protocol";
import type { ProcessPoliciesRequest } from "@omp-console/protocol";

export interface PanelsMockContext {
	hasSession(id: string): boolean;
	liveIds(): string[];
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	return json({ error, code } satisfies ApiError, status);
}

const basePlugins: PluginInfo[] = [
	{ id: "review-notes", kind: "extension", name: "Review notes", enabled: true, source: "user", description: "Adds review status and key-point widgets." },
	{ id: "markdown-tools", kind: "tool", name: "Markdown tools", enabled: true, source: "project", description: "Formats and checks Markdown files." },
	{ id: "local-search", kind: "mcp", name: "local-search", enabled: false, source: "user", description: "Searches the local fixture knowledge base." },
	{ id: "session-hook", kind: "hook", name: "Session hook", enabled: true, source: "bundled", description: "Records session lifecycle events." },
];

const quota: QuotaResponse = {
	accounts: [
		{ provider: "anthropic", account: "subscription", fetchedAt: Date.now(), stale: false, windows: [{ id: "5h", usedPct: 62, reservePct: 10, projectedPct: 78, resetsAt: Date.now() + 7_200_000 }, { id: "7d", usedPct: 31, reservePct: 10, projectedPct: 44, resetsAt: Date.now() + 4 * 86_400_000 }] },
		{ provider: "openai", account: "plus", fetchedAt: Date.now() - 18 * 60_000, stale: true, windows: [{ id: "5h", usedPct: 84, reservePct: 8, resetsAt: Date.now() + 1_800_000 }] },
	],
	providers: [
		{ provider: "anthropic", headroomPct: 38, bindingWindow: "5h", cap: 2, running: 1, queued: 1, state: "throttled", burnLocalPctPerMin: 0.12, burnExternalPctPerMin: 0.03, reason: "Projected end is near the reserve; new top-level spawns are paced." },
		{ provider: "openai", headroomPct: 16, bindingWindow: "5h", cap: 1, running: 1, queued: 2, state: "paused", burnLocalPctPerMin: 0.08, burnExternalPctPerMin: 0.14, reason: "Fresh external burn holds the cap until the next sample." },
	],
	equivalence: { tiers: [{ tier: "default", roles: ["default", "smol"], models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5-5"] }, { tier: "judgment", roles: ["plan", "judge", "critic"], models: [] }] },
	cacheWarming: "off",
	updatedAt: Date.now(),
};

const panels: ExtensionUiState = {
	statuses: [{ key: "review", text: "Review notes ready" }],
	widgets: [{ key: "review", lines: ["2 files changed", "1 open question"] }],
	panels: [
		{ key: "progress", descriptor: { kind: "progress", title: "Extension progress", value: 7, max: 10, label: "review checklist" } },
		{ key: "actions", descriptor: { kind: "buttons", title: "Extension actions", buttons: [{ label: "Run review", command: "/review" }, { label: "Compact", command: "/compact soft" }] } },
	],
	notifications: [{ at: Date.now(), message: "Extension UI bridge is connected.", level: "info" }],
};

const history: HistoryResponse = {
	nodes: [
		{ sessionId: "history-relay", workspaceId: "project:relay", title: "Refactor relay backoff", createdAt: Date.now() - 86_400_000, lastActivityAt: Date.now() - 3_600_000, sessionFile: "/Users/dev/relay/.omp/sessions/history-relay.jsonl", keyPoints: { sessionId: "history-relay", title: "Refactor relay backoff", goal: "Make reconnects durable", decisions: ["Keep entry ids stable"], files: ["src/relay.ts"], outcome: "Fixture completed", openQuestions: ["Measure mobile resume"], generatedAt: Date.now() - 3_500_000 } },
		{ sessionId: "history-docs", workspaceId: "project:docs", title: "Docs sweep", createdAt: Date.now() - 21_600_000, lastActivityAt: Date.now() - 1_800_000, sessionFile: "/Users/dev/docs/.omp/sessions/history-docs.jsonl", keyPoints: { sessionId: "history-docs", title: "Docs sweep", decisions: ["Use native controls"], files: ["docs/architecture.md"], outcome: "Waiting for review", openQuestions: [], generatedAt: Date.now() - 1_700_000 } },
	],
	edges: [{ from: "history-relay", to: "history-docs", kind: "handoff" }],
};

const processes: ListProcessesResponse = {
	processes: [
		{ pid: 41001, ppid: 40000, kind: "omp-console-worker", command: "omp-console worker --session relay", startedAt: Date.now() - 3_600_000, rssBytes: 780 * 1024 * 1024, cwd: "/Users/dev/relay", sessionId: "history-relay", lastSessionWriteAt: Date.now() - 120_000, state: "active" },
		{ pid: 41002, ppid: 1, kind: "omp-terminal", command: "omp --cwd /Users/dev/docs", startedAt: Date.now() - 86_400_000, rssBytes: 1.8 * 1024 ** 3, cwd: "/Users/dev/docs", state: "idle", reason: "detached terminal" },
		{ pid: 41003, ppid: 41001, kind: "omp-helper", command: "daemon_broker --session relay", startedAt: Date.now() - 3_500_000, rssBytes: 95 * 1024 * 1024, cwd: "/Users/dev/relay", state: "orphan", reason: "parent worker stopped" },
	],
	policies: { idleStopAfterMs: null, rssWarnBytes: 1.5 * 1024 ** 3 },
};

export function createPanelsMock(): (req: Request, route: string, context: PanelsMockContext) => Promise<Response | null> {
	const enabled = new Map<string, boolean>(basePlugins.map(plugin => [plugin.id, plugin.enabled]));
	let warming = quota.cacheWarming;
	let equivalence: EquivalenceTable = quota.equivalence;
	let currentPolicies = processes.policies;
	return async (req, route, context) => {
		const method = req.method;
		if (route === "/quota" && method === "GET") return json({ ...quota, cacheWarming: warming, equivalence, updatedAt: Date.now() });
		if (route === "/quota/equivalence" && method === "PUT") {
			equivalence = (await req.json().catch(() => null)) as EquivalenceTable;
			return new Response(null, { status: 204 });
		}
		if (route === "/quota/cache-warming" && method === "PUT") {
			const body = (await req.json().catch(() => null)) as { mode?: QuotaResponse["cacheWarming"] } | null;
			if (!body || !body.mode || !["off", "streaming", "idle"].includes(body.mode)) return fail(400, "bad-request", "invalid warming mode");
			warming = body.mode;
			return new Response(null, { status: 204 });
		}
		if (route === "/quota/estimate" && method === "GET") return json({ tokens: 18_400, windowPct: 1.7, samples: 14 } satisfies SpawnEstimate);

		const pluginsRoute = /^\/sessions\/([^/]+)\/plugins$/.exec(route);
		if (pluginsRoute && method === "GET") {
			if (!context.hasSession(decodeURIComponent(pluginsRoute[1]!))) return fail(404, "not-found", "no such session");
			return json({ plugins: basePlugins.map(plugin => ({ ...plugin, enabled: enabled.get(plugin.id) ?? plugin.enabled })) } satisfies ListPluginsResponse);
		}
		const toggleRoute = /^\/sessions\/([^/]+)\/plugins\/([^/]+)\/(enable|disable)$/.exec(route);
		if (toggleRoute && method === "POST") {
			if (!context.hasSession(decodeURIComponent(toggleRoute[1]!))) return fail(404, "not-found", "no such session");
			enabled.set(decodeURIComponent(toggleRoute[2]!), toggleRoute[3] === "enable");
			return new Response(null, { status: 204 });
		}
		const extRoute = /^\/sessions\/([^/]+)\/ext-ui$/.exec(route);
		if (extRoute && method === "GET") {
			if (!context.hasSession(decodeURIComponent(extRoute[1]!))) return fail(404, "not-found", "no such session");
			return json(panels);
		}

		if (route === "/history" && method === "GET") {
			const url = new URL(req.url);
			const workspace = url.searchParams.get("workspace");
			const q = url.searchParams.get("q")?.toLowerCase() ?? "";
			return json({ nodes: history.nodes.filter(node => (!workspace || node.workspaceId === workspace) && (!q || node.title.toLowerCase().includes(q) || JSON.stringify(node.keyPoints).toLowerCase().includes(q))), edges: history.edges } satisfies HistoryResponse);
		}
		const keyPointsRoute = /^\/sessions\/([^/]+)\/key-points$/.exec(route);
		if (keyPointsRoute && method === "POST") return new Response(null, { status: context.hasSession(decodeURIComponent(keyPointsRoute[1]!)) ? 202 : 404 });
		if (route === "/workspaces" && method === "GET") return json({ workspaces: [{ id: "project:relay", kind: "project", name: "relay", root: "/Users/dev/relay", rules: [], hueOverride: 188, liveSessions: 1 }, { id: "project:docs", kind: "project", name: "docs", root: "/Users/dev/docs", rules: [], liveSessions: 1 }] });

		if (route === "/processes" && method === "GET") return json({ processes: processes.processes, policies: currentPolicies } satisfies ListProcessesResponse);
		if (route === "/processes/policies" && method === "PUT") {
			currentPolicies = (await req.json().catch(() => null)) as ProcessPoliciesRequest;
			return new Response(null, { status: 204 });
		}
		const stopRoute = /^\/processes\/(\d+)\/stop$/.exec(route);
		if (stopRoute && method === "POST") return new Response(null, { status: processes.processes.some(process => process.pid === Number(stopRoute[1])) ? 202 : 404 });
		return null;
	};
}
