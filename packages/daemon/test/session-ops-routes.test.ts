/** `POST /api/sessions/:id/ops` and the plugin routes: body validation, status mapping, and the real supervisor behind them. */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ApiError, ExtensionUiState, ListPluginsResponse, PluginInfo, SessionOp, SessionOpResult, SessionOpV3, SessionOpV3Result } from "@omp-console/protocol";
import { createPluginRoutes } from "../src/plugins/routes";
import { createSessionOpsRoutes } from "../src/session-ops/routes";
import { Supervisor, SupervisorError } from "../src/supervisor";
import { fakeCmd, makeTmp, readJsonLines } from "./helpers";
import { until } from "./ws-helpers";

type Handler = (req: Request, url: URL) => Promise<Response | undefined>;

function call(handler: Handler, method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<Response | undefined> {
	const init: RequestInit = { method, ...(signal === undefined ? {} : { signal }) };
	if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
	return handler(new Request(`http://daemon${pathname}`, init), new URL(`http://daemon${pathname}`));
}

let supervisors: Supervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.map(supervisor => supervisor.shutdown()));
	supervisors = [];
});
function supervise(...flags: string[]): Supervisor {
	const supervisor = new Supervisor({ workerCmd: fakeCmd(...flags), relayUrl: () => "ws://127.0.0.1:9", stopGraceMs: 300, termGraceMs: 300, readyTimeoutMs: 5_000 });
	supervisors.push(supervisor);
	return supervisor;
}

describe("session ops route", () => {
	const seen: Array<{ sessionId: string; op: SessionOp | SessionOpV3 }> = [];
	const handler = createSessionOpsRoutes({
		async sessionOp(sessionId, op): Promise<SessionOpResult> {
			seen.push({ sessionId, op });
			if (sessionId === "busy") throw new SupervisorError("conflict", "session is busy");
			if (sessionId === "gone") throw new SupervisorError("not-found", "no live session gone");
			if (sessionId === "boom") throw new Error("socket exploded: secret-detail");
			return { ok: true };
		},
	});

	it("forwards a valid operation untouched and answers 200 with the worker's result", async () => {
		seen.length = 0;
		const ops: Array<SessionOp | SessionOpV3> = [
			{ op: "plan-mode", enabled: true },
			{ op: "loop-mode", action: "toggle", args: "2 repeat" },
			{ op: "loop-mode", action: "status" },
			{ op: "vibe-mode", action: "toggle" },
			{ op: "vibe-mode", action: "disable" },
			{ op: "goal", action: "set", objective: "Make the build green", tokenBudget: 50_000 },
			{ op: "goal", action: "pause" },
			{ op: "goal", action: "budget", tokenBudget: 9 },
			{ op: "todos", phases: [{ name: "Build", tasks: [{ content: "Write it", status: "in_progress" }] }] },
			{ op: "compact", mode: "snap" },
			{ op: "compact" },
			{ op: "approval-mode", mode: "always-ask-cached" },
			{ op: "dequeue", index: 2 },
			{ op: "dequeue" },
			{ op: "stats" },
			{ op: "tree" },
			{ op: "context" },
			{ op: "rewind-points" },
			{ op: "rewind", entryId: "entry-1" },
			{ op: "shell", kind: "bash", code: "echo deck", excludeFromContext: false },
			{ op: "shell", kind: "python", code: "print('deck')", excludeFromContext: true },
			{ op: "btw", question: "What is 6 times 7?" },
			{ op: "btw", question: "And times 8?", recordId: "topic-1" },
			{ op: "ui-requests" },
			{ op: "ui-answer", reqId: "17", value: "Yes" },
			{ op: "ui-answer", reqId: "18", value: null },
			{ op: "quick-replies", entryId: "entry-1" },
			{ op: "skills-search", query: "format" },
			{ op: "skills-installed" },
			{ op: "skills-install", specs: ["@omp-console/review"], global: false },
			{ op: "skills-update", names: [], global: true },
			{ op: "git-view" },
			{ op: "git-view", revision: "HEAD~1" },
			{ op: "git-diff", path: "src/main.ts", area: "unstaged" },
			{ op: "git-stage", action: "stage", paths: ["src/main.ts"] },
			{ op: "git-hunk", action: "stage", path: "src/main.ts", area: "unstaged", hunkIndex: 0, patchHash: "a".repeat(64) },
			{ op: "git-commit", message: "fix: review" },
			{ op: "queue", text: "next request", images: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }] },
			{ op: "pause", action: "pause" },
			{ op: "pause", action: "resume" },
			{ op: "pause", action: "toggle" },
			{ op: "collab-status" },
			{ op: "live-mode", action: "status" },
			{ op: "debug", action: "adapters" },
			{ op: "debug", action: "launch", program: "src/main.js", confirmed: true },
			{ op: "debug", action: "attach", pid: 123, confirmed: true },
			{ op: "tan-start", work: "Run a background task" },
			{ op: "omfg-generate", requestId: "omfg-route", complaint: "Avoid this response" },
			{
				op: "omfg-save",
				requestId: "omfg-route",
				fileContent: "description: rule\n",
				scope: "project",
				overwrite: false,
				acceptUnvalidated: false,
			},
			{ op: "omfg-cancel", requestId: "omfg-route" },
			{ op: "cleanse-discover", includeTests: true },
			{ op: "cleanse-start", runId: "cleanse-route", scope: { kind: "all" }, includeTests: false, maxAgents: 2, model: "stub/model" },
			{ op: "cleanse-cancel", runId: "cleanse-route" },
			{ op: "cleanse-state" },
		];
		for (const op of ops) {
			const res = await call(handler, "POST", "/api/sessions/s%201/ops", op);
			expect(res?.status).toBe(200);
			expect(await res?.json()).toEqual({ ok: true });
		}
		expect(seen.map(entry => entry.op)).toEqual(ops);
		expect(seen.every(entry => entry.sessionId === "s 1")).toBe(true);
	});
	it("forwards all y3 operations through the HTTP route and supervisor to a worker", async () => {
		const requestLog = path.join(makeTmp(), "requests.jsonl");
		const supervisor = supervise("--dump-requests", requestLog);
		const { id } = await supervisor.create({ cwd: makeTmp() });
		const routes = createSessionOpsRoutes(supervisor);
		const ops: SessionOpV3[] = [
			{ op: "tan-start", work: "Run a background task" },
			{ op: "omfg-generate", requestId: "omfg-route", complaint: "Avoid this response" },
			{
				op: "omfg-save",
				requestId: "omfg-route",
				fileContent: "description: rule\n",
				scope: "project",
				overwrite: false,
				acceptUnvalidated: false,
			},
			{ op: "omfg-cancel", requestId: "omfg-route" },
			{ op: "cleanse-discover", includeTests: true },
			{ op: "cleanse-start", runId: "cleanse-route", scope: { kind: "all" }, includeTests: false, maxAgents: 2, model: "stub/model" },
			{ op: "cleanse-cancel", runId: "cleanse-route" },
			{ op: "cleanse-state" },
			{ op: "live-mode", action: "start", offer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" },
		];
		for (const op of ops) {
			const response = await call(routes, "POST", `/api/sessions/${id}/ops`, op);
			expect(response?.status).toBe(200);
			expect(await response?.json()).toEqual({ ok: true });
		}
		const forwarded = readJsonLines(requestLog)
			.filter(request => request.t === "session-op")
			.map(request => request.op);
		expect(forwarded).toEqual(ops);
	}, 30_000);

	it("accepts y3 operation fields at the worker decoder's size boundaries", async () => {
		seen.length = 0;
		const ops: SessionOpV3[] = [
			{ op: "tan-start", work: "w".repeat(4000) },
			{ op: "omfg-generate", requestId: "r".repeat(256), complaint: "c".repeat(4000) },
			{
				op: "omfg-save",
				requestId: "r".repeat(256),
				fileContent: `x${" ".repeat(63_999)}`,
				scope: "user",
				overwrite: true,
				acceptUnvalidated: false,
			},
			{ op: "omfg-cancel", requestId: "r".repeat(256) },
			{ op: "cleanse-discover", includeTests: false },
			{
				op: "cleanse-start",
				runId: "r".repeat(256),
				scope: { kind: "request", request: "q".repeat(4000) },
				includeTests: true,
				maxAgents: 1,
				model: "m".repeat(4000),
			},
			{ op: "cleanse-cancel", runId: "r".repeat(256) },
			{ op: "cleanse-state" },
		];
		for (const op of ops) {
			const response = await call(handler, "POST", "/api/sessions/s1/ops", op);
			expect(response?.status).toBe(200);
			await response?.json();
		}
		expect(seen.map(entry => entry.op)).toEqual(ops);
	});

	it("rejects every malformed body with 400 and never reaches the worker", async () => {
		seen.length = 0;
		const bodies: Array<[unknown, string]> = [
			["not json {", "valid JSON"],
			["[]", "session operation"],
			[{ op: "format-disk" }, "unknown session operation"],
			[{ op: "plan-mode", enabled: "yes" }, "boolean"],
			[{ op: "goal", action: "set", objective: "  " }, "objective"],
			[{ op: "goal", action: "set", objective: "x", tokenBudget: 0 }, "tokenBudget"],
			[{ op: "goal", action: "budget", tokenBudget: 1.5 }, "tokenBudget"],
			[{ op: "goal", action: "explode" }, "action"],
			[{ op: "todos", phases: [{ name: "p", tasks: [{ content: "c", status: "done" }] }] }, "status"],
			[{ op: "todos", phases: [{ name: "", tasks: [] }] }, "name"],
			[{ op: "todos", phases: "none" }, "phases"],
			[{ op: "compact", mode: "gentle" }, "mode"],
			[{ op: "approval-mode", mode: "root" }, "mode"],
			[{ op: "dequeue", index: -1 }, "index"],
			[{ op: "rewind" }, "entryId"],
			[{ op: "rewind", entryId: " " }, "entryId"],
			[{ op: "shell", kind: "sh", code: "echo x", excludeFromContext: false }, "kind"],
			[{ op: "shell", kind: "bash", code: " ", excludeFromContext: false }, "code"],
			[{ op: "shell", kind: "python", code: "print(1)" }, "excludeFromContext"],
			[{ op: "btw", question: "  " }, "question"],
			[{ op: "btw", question: "q", recordId: "" }, "recordId"],
			[{ op: "btw", question: "q", recordId: 7 }, "recordId"],
			[{ op: "ui-answer" }, "reqId"],
			[{ op: "ui-answer", reqId: "1", value: 7 }, "value"],
			[{ op: "quick-replies", entryId: " " }, "entryId"],
			[{ op: "skills-search", query: " " }, "query"],
			[{ op: "skills-install", specs: [], global: false }, "specs"],
			[{ op: "skills-update", names: "all", global: false }, "names"],
			[{ op: "git-view", revision: " " }, "revision"],
			[{ op: "git-diff", path: "a.ts", area: "binary" }, "area"],
			[{ op: "git-stage", action: "stage", paths: [] }, "paths"],
			[{ op: "git-hunk", action: "stage", path: "a.ts", area: "staged", hunkIndex: 0, patchHash: "a".repeat(64) }, "stage targets"],
			[{ op: "git-hunk", action: "stage", path: "a.ts", area: "unstaged", hunkIndex: 0, patchHash: "bad" }, "patchHash"],
			[{ op: "git-commit", message: " " }, "message"],
			[{ op: "pause", action: "stop" }, "action"],
			[{ op: "queue" }, "string `text`"],
			[{ op: "queue", text: "x", images: "image" }, "array"],
			[{ op: "queue", text: "x", images: [{ type: "image", data: "", mimeType: "text/plain" }] }, "image data"],
			[{ op: "loop-mode", action: "pause" }, "action"],
			[{ op: "vibe-mode", action: "toggle", args: 3 }, "args"],
			[{ op: "tan-start", work: " " }, "work"],
			[{ op: "tan-start", work: "x".repeat(4001) }, "work"],
			[{ op: "omfg-generate", requestId: "", complaint: "x" }, "requestId"],
			[{ op: "omfg-generate", requestId: "x".repeat(257), complaint: "x" }, "requestId"],
			[{ op: "omfg-generate", requestId: "x", complaint: " " }, "complaint"],
			[{ op: "omfg-generate", requestId: "x", complaint: "x".repeat(4001) }, "complaint"],
			[{ op: "omfg-save", requestId: "x", fileContent: "x", scope: "invalid", overwrite: false, acceptUnvalidated: false }, "scope"],
			[{ op: "omfg-save", requestId: "x", fileContent: " ", scope: "project", overwrite: false, acceptUnvalidated: false }, "fileContent"],
			[{ op: "omfg-save", requestId: "x", fileContent: "x".repeat(64_001), scope: "project", overwrite: false, acceptUnvalidated: false }, "fileContent"],
			[{ op: "omfg-save", requestId: "x", fileContent: "x", scope: "project", overwrite: "yes", acceptUnvalidated: false }, "overwrite"],
			[{ op: "omfg-cancel", requestId: " " }, "requestId"],
			[{ op: "cleanse-discover", includeTests: 1 }, "includeTests"],
			[{ op: "cleanse-start", runId: "", scope: { kind: "all" }, includeTests: false }, "runId"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "checker", id: " " }, includeTests: false }, "scope"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "checker", id: "x".repeat(257) }, includeTests: false }, "scope"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "request", request: " " }, includeTests: false }, "scope"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "request", request: "x".repeat(4001) }, includeTests: false }, "scope"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "all" }, includeTests: false, maxAgents: 0 }, "maxAgents"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "all" }, includeTests: false, maxAgents: 1.5 }, "maxAgents"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "all" }, includeTests: false, model: " " }, "model"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "all" }, includeTests: false, model: "x".repeat(4001) }, "model"],
			[{ op: "cleanse-cancel", runId: " " }, "runId"],
			[{ op: "loop-mode", action: "toggle", args: "x".repeat(4001) }, "args"],
			[{ op: "live-mode", action: "pause" }, "action"],
			[{ op: "live-mode", action: "start" }, "SDP offer"],
			[{ op: "live-mode", action: "start", offer: "x".repeat(65_537) }, "SDP offer"],
			[{ op: "live-mode", action: "start", offer: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 111\r\n" }, "SDP offer"],
			[{ op: "live-mode", action: "start", offer: "v=1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }, "SDP offer"],
			[{ op: "debug-diagnostics", action: "unknown" }, "unknown debug diagnostics action"],
			[{ op: "debug-diagnostics", action: "clear-cache", confirmed: false }, "confirmation must be true"],
			[{ op: "debug", action: "launch", program: "sample.js" }, "explicit confirmation"],
			[{ op: "debug", action: "attach", port: 4711 }, "explicit confirmation"],
			[{ op: "debug", action: "attach", confirmed: true }, "pid or port"],
			[{ op: "debug", action: "attach", port: 65_536, confirmed: true }, "at most 65535"],
			[{ op: "debug", action: "select", sessionId: " " }, "session id"],
			[{ op: "omfg-save", requestId: "x".repeat(257), fileContent: "x", scope: "project", overwrite: false, acceptUnvalidated: false }, "requestId"],
			[{ op: "omfg-save", requestId: "x", fileContent: "x", scope: "project", overwrite: false, acceptUnvalidated: "yes" }, "acceptUnvalidated"],
			[{ op: "omfg-cancel", requestId: "x".repeat(257) }, "requestId"],
			[{ op: "cleanse-discover", includeTests: "false" }, "includeTests"],
			[{ op: "cleanse-start", runId: "x".repeat(257), scope: { kind: "all" }, includeTests: false }, "runId"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "all" }, includeTests: "false" }, "includeTests"],
			[{ op: "cleanse-start", runId: "x", scope: { kind: "all" }, includeTests: false, model: 7 }, "model"],
			[{ op: "cleanse-cancel", runId: "x".repeat(257) }, "runId"],
		];
		for (const [body, fragment] of bodies) {
			const res = await call(handler, "POST", "/api/sessions/s1/ops", body);
			expect(res?.status).toBe(400);
			const error = (await res?.json()) as ApiError;
			expect(error.code).toBe("bad-request");
			expect(error.error).toContain(fragment);
		}
		expect(seen).toEqual([]);
	});

	it("maps worker refusals to their status without leaking an unexpected error's text", async () => {
		const busy = await call(handler, "POST", "/api/sessions/busy/ops", { op: "compact" });
		expect(busy?.status).toBe(409);
		expect(await busy?.json()).toEqual({ error: "session is busy", code: "conflict" });
		expect((await call(handler, "POST", "/api/sessions/gone/ops", { op: "stats" }))?.status).toBe(404);
		const boom = await call(handler, "POST", "/api/sessions/boom/ops", { op: "stats" });
		expect(boom?.status).toBe(500);
		expect(JSON.stringify(await boom?.json())).not.toContain("secret-detail");
	});

	it("answers only its own route and its own method", async () => {
		expect(await call(handler, "POST", "/api/sessions/s1/abort")).toBeUndefined();
		expect(await call(handler, "POST", "/api/sessions/s1/ops/extra")).toBeUndefined();
		const get = await call(handler, "GET", "/api/sessions/s1/ops");
		expect(get?.status).toBe(405);
		expect(get?.headers.get("allow")).toBe("POST");
	});

	it("through a real supervisor: a result passes through, a worker refusal is a 400 with its message, an unknown session is a 404", async () => {
		const supervisor = supervise();
		const { id } = await supervisor.create({ cwd: makeTmp() });
		const routes = createSessionOpsRoutes(supervisor);
		const stats = await call(routes, "POST", `/api/sessions/${id}/ops`, { op: "stats" });
		expect(stats?.status).toBe(200);
		expect(await stats?.json()).toMatchObject({ ok: true, stats: { contextWindow: 128000 } });
		const refused = await call(routes, "POST", `/api/sessions/${id}/ops`, { op: "goal", action: "set", objective: "refuse" });
		expect(refused?.status).toBe(400);
		expect(((await refused?.json()) as ApiError).error).toContain("Goal mode is disabled");
		expect((await call(routes, "POST", "/api/sessions/nope/ops", { op: "stats" }))?.status).toBe(404);
	});
	it("aborts the worker's skills operation when its HTTP caller disconnects", async () => {
		const dir = makeTmp();
		const dump = `${dir}/requests.jsonl`;
		const supervisor = new Supervisor({
			workerCmd: fakeCmd("--ignore-requests", "--dump-requests", dump),
			relayUrl: () => "ws://127.0.0.1:9",
			stopGraceMs: 300,
			termGraceMs: 300,
			readyTimeoutMs: 5_000,
			sessionOpTimeoutMs: 5_000,
			skillsTimeoutMs: 5_000,
		});
		supervisors.push(supervisor);
		const { id } = await supervisor.create({ cwd: dir });
		const routes = createSessionOpsRoutes(supervisor);
		const controller = new AbortController();
		const pending = call(routes, "POST", `/api/sessions/${id}/ops`, {
			op: "skills-install",
			specs: ["@omp-console/review"],
			global: false,
			approvalId: "abandoned",
		}, controller.signal);
		await until(() => readJsonLines(dump).some(line => line.t === "session-op"), "session-op reached the fake worker");
		controller.abort();
		expect((await pending)?.status).toBe(409);
		await until(() => readJsonLines(dump).some(line => line.t === "cancel-session-op"), "cancel-session-op after HTTP abort");
		const requests = readJsonLines(dump);
		const sessionOp = requests.find(line => line.t === "session-op");
		const cancellation = requests.find(line => line.t === "cancel-session-op");
		if (!sessionOp || !cancellation) throw new Error("the abandoned operation should have a matching cancellation command");
		expect(cancellation.id).toBe(sessionOp.id);
	});
});

describe("plugin routes", () => {
	const calls: string[] = [];
	const plugins: PluginInfo[] = [{ id: "skill:deck-skill", kind: "skill", name: "deck-skill", enabled: true }];
	const idle: ExtensionUiState = { statuses: [], widgets: [], panels: [], notifications: [] };
	const handler = createPluginRoutes({
		async plugins(sessionId) {
			if (sessionId === "gone") throw new SupervisorError("not-found", "no live session gone");
			return plugins;
		},
		async togglePlugin(sessionId, pluginId, enabled) {
			calls.push(`${sessionId}|${pluginId}|${enabled}`);
			if (pluginId === "skill:nope") throw new SupervisorError("not-found", "no such plugin");
		},
		extensionUi(sessionId) {
			if (sessionId === "gone") throw new SupervisorError("not-found", "no live session gone");
			return sessionId === "busy" ? { ...idle, statuses: [{ key: "k", text: "t" }] } : idle;
		},
	});

	it("lists plugins, toggles by URL-encoded id with 204, and reads the extension UI", async () => {
		const list = await call(handler, "GET", "/api/sessions/s1/plugins");
		expect(list?.status).toBe(200);
		expect(((await list?.json()) as ListPluginsResponse).plugins).toEqual(plugins);

		const off = await call(handler, "POST", `/api/sessions/s1/plugins/${encodeURIComponent("skill:deck-skill")}/disable`);
		expect(off?.status).toBe(204);
		const on = await call(handler, "POST", `/api/sessions/s1/plugins/${encodeURIComponent("extension-module:x y")}/enable`);
		expect(on?.status).toBe(204);
		expect(calls).toEqual(["s1|skill:deck-skill|false", "s1|extension-module:x y|true"]);

		expect(await (await call(handler, "GET", "/api/sessions/busy/ext-ui"))?.json()).toMatchObject({ statuses: [{ key: "k", text: "t" }] });
		expect(await (await call(handler, "GET", "/api/sessions/s1/ext-ui"))?.json()).toEqual(idle);
	});

	it("refuses unknown plugins and sessions, wrong methods and smuggled separators", async () => {
		expect((await call(handler, "POST", "/api/sessions/s1/plugins/skill%3Anope/enable"))?.status).toBe(404);
		expect((await call(handler, "GET", "/api/sessions/gone/plugins"))?.status).toBe(404);
		expect((await call(handler, "GET", "/api/sessions/gone/ext-ui"))?.status).toBe(404);
		expect((await call(handler, "POST", "/api/sessions/s1/plugins"))?.status).toBe(405);
		expect((await call(handler, "GET", "/api/sessions/s1/plugins/skill%3Aa/enable"))?.status).toBe(405);
		const traversal = await call(handler, "POST", "/api/sessions/s1/plugins/..%2Fetc/enable");
		expect(traversal?.status).toBe(400);
		expect(await call(handler, "GET", "/api/sessions/s1/other")).toBeUndefined();
	});

	it("through a real supervisor: the worker's plugin list and toggle outcome come back as HTTP", async () => {
		const supervisor = supervise();
		const { id } = await supervisor.create({ cwd: makeTmp() });
		const routes = createPluginRoutes(supervisor);
		const list = (await (await call(routes, "GET", `/api/sessions/${id}/plugins`))?.json()) as ListPluginsResponse;
		expect(list.plugins.map(plugin => plugin.id)).toEqual(["skill:fake-skill", "mcp:fake-server"]);
		expect((await call(routes, "POST", `/api/sessions/${id}/plugins/mcp%3Afake-server/enable`))?.status).toBe(204);
		expect((await call(routes, "POST", `/api/sessions/${id}/plugins/missing/enable`))?.status).toBe(404);
		expect(await (await call(routes, "GET", `/api/sessions/${id}/ext-ui`))?.json()).toEqual({ statuses: [], widgets: [], panels: [], notifications: [] });
	});
});
