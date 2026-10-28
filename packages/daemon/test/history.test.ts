/**
 * History: graph assembly, search ranking, key-points storage and the idle/stop summariser. Persisted sessions are
 * injected (no `~/.omp`); one subprocess test reads real forked session files in an isolated agent dir.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HistoryResponse, KeyPoints, SessionSummary } from "@omp-console/protocol";
import { createHistoryRoutes, type HistoryRoutes } from "../src/history/routes";
import type { HistoryPorts, PersistedSession } from "../src/history/ports";
import { SupervisorError } from "../src/supervisor";
import { makeTmp } from "./helpers";

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
const MIN = 60_000;

const persisted = (over: Partial<PersistedSession> & { id: string }): PersistedSession => ({
	file: `/sessions/${over.id}.jsonl`,
	cwd: "/work/a",
	createdAt: T0 - 5 * MIN,
	modifiedAt: T0 - MIN,
	...over,
});

const live = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
	cwd: "/work/a",
	state: "idle",
	createdAt: T0 - 5 * MIN,
	lastActivityAt: T0 - MIN,
	agentCount: 1,
	goalActive: false,
	awaitingAnswer: false,
	...over,
});

const card = (sessionId: string, over: Partial<KeyPoints> = {}): KeyPoints => ({
	sessionId,
	title: `Card ${sessionId}`,
	decisions: [],
	files: [],
	openQuestions: [],
	generatedAt: T0,
	...over,
});

class FakePorts implements HistoryPorts {
	sessions: SessionSummary[] = [];
	summarized: string[] = [];
	cards = new Map<string, KeyPoints>();
	failWith: Error | undefined;
	clock = T0;

	list(): SessionSummary[] {
		return this.sessions;
	}

	async summarize(sessionId: string): Promise<KeyPoints> {
		this.summarized.push(sessionId);
		if (this.failWith) throw this.failWith;
		return this.cards.get(sessionId) ?? card(sessionId, { generatedAt: this.clock });
	}
}

const created: HistoryRoutes[] = [];
afterEach(() => {
	for (const routes of created.splice(0)) routes.dispose();
});

function build(ports: HistoryPorts, sessions: PersistedSession[], options: { stateDir?: string; now?: () => number; workspaceOf?: (cwd: string) => string | undefined } = {}) {
	const stateDir = options.stateDir ?? makeTmp("deck-history-");
	const logs: string[] = [];
	const routes = createHistoryRoutes(ports, stateDir, {
		listPersisted: async () => sessions,
		pollMs: 0,
		listTtlMs: 0,
		now: options.now,
		workspaceOf: options.workspaceOf,
		log: message => logs.push(message),
	});
	created.push(routes);
	return { routes, stateDir, logs };
}

async function get(routes: HistoryRoutes, query = ""): Promise<HistoryResponse> {
	const url = new URL(`http://daemon/api/history${query}`);
	const res = await routes(new Request(url.toString()), url);
	expect(res?.status).toBe(200);
	return (await res!.json()) as HistoryResponse;
}

async function post(routes: HistoryRoutes, pathname: string): Promise<Response> {
	const url = new URL(`http://daemon${pathname}`);
	return (await routes(new Request(url.toString(), { method: "POST" }), url))!;
}

describe("history graph", () => {
	it("lists persisted sessions newest first, lets a live session's title and activity win, and adds live-only sessions", async () => {
		const ports = new FakePorts();
		ports.sessions = [live({ id: "p2", title: "Renamed while live", lastActivityAt: T0 }), live({ id: "fresh", title: "Brand new", createdAt: T0 - 2 * MIN, lastActivityAt: T0 - 30_000, sessionFile: "/sessions/fresh.jsonl" })];
		const { routes } = build(ports, [
			persisted({ id: "p1", title: "Port the parser", modifiedAt: T0 - 60 * MIN }),
			persisted({ id: "p2", title: "Old title", modifiedAt: T0 - 10 * MIN }),
			persisted({ id: "p3", firstMessage: "<system-reminder>ctx</system-reminder>fix the relay backoff", modifiedAt: T0 - 30 * MIN }),
		]);
		const { nodes } = await get(routes);
		expect(nodes.map(node => [node.sessionId, node.title, node.lastActivityAt])).toEqual([
			["p2", "Renamed while live", T0],
			["fresh", "Brand new", T0 - 30_000],
			["p3", "fix the relay backoff", T0 - 30 * MIN],
			["p1", "Port the parser", T0 - 60 * MIN],
		]);
		expect(nodes.find(node => node.sessionId === "fresh")?.sessionFile).toBe("/sessions/fresh.jsonl");
	});

	it("draws fork edges from the header parent, whether it names the parent's id or its file, and only between listed nodes", async () => {
		const { routes } = build(new FakePorts(), [
			persisted({ id: "root", title: "Root", modifiedAt: T0 - 90 * MIN }),
			persisted({ id: "by-id", title: "Fork by id", parentSession: "root", modifiedAt: T0 - 30 * MIN }),
			persisted({ id: "by-file", title: "Branch by file", parentSession: "/sessions/root.jsonl", modifiedAt: T0 - 20 * MIN }),
			persisted({ id: "orphan", title: "Parent was deleted", parentSession: "/sessions/deleted.jsonl", modifiedAt: T0 - 10 * MIN }),
		]);
		const all = await get(routes);
		expect(all.edges).toEqual(expect.arrayContaining([{ from: "root", to: "by-id", kind: "fork" }, { from: "root", to: "by-file", kind: "fork" }]));
		expect(all.edges).toHaveLength(2);
		// A limit that cuts the parent also cuts the edge to it.
		const limited = await get(routes, "?limit=2");
		expect(limited.nodes.map(node => node.sessionId)).toEqual(["orphan", "by-file"]);
		expect(limited.edges).toEqual([]);
	});

	it("filters by workspace through the resolver; without one the filter matches nothing", async () => {
		const sessions = [persisted({ id: "a1", cwd: "/work/a/x", title: "A one" }), persisted({ id: "b1", cwd: "/work/b", title: "B one" })];
		const workspaceOf = (cwd: string) => (cwd.startsWith("/work/a") ? "ws-a" : "ws-b");
		const { routes } = build(new FakePorts(), sessions, { workspaceOf });
		const filtered = await get(routes, "?workspace=ws-a");
		expect(filtered.nodes.map(node => [node.sessionId, node.workspaceId])).toEqual([["a1", "ws-a"]]);
		const { routes: bare } = build(new FakePorts(), sessions);
		expect((await get(bare, "?workspace=ws-a")).nodes).toEqual([]);
		expect((await get(bare)).nodes).toHaveLength(2);
	});

	it("records handoff, move and plan-run edges once, keeps them across a restart, and rejects a malformed edge", async () => {
		const sessions = [persisted({ id: "src", title: "Source" }), persisted({ id: "dst", title: "Destination" })];
		const first = build(new FakePorts(), sessions);
		await first.routes.recordEdge({ from: "src", to: "dst", kind: "handoff" });
		await first.routes.recordEdge({ from: "src", to: "dst", kind: "handoff" });
		await first.routes.recordEdge({ from: "src", to: "dst", kind: "plan-run" });
		await expect(first.routes.recordEdge({ from: "", to: "dst", kind: "move" })).rejects.toThrow("edge");
		await expect(first.routes.recordEdge({ from: "src", to: "dst", kind: "teleport" as never })).rejects.toThrow("edge");
		expect((await get(first.routes)).edges).toEqual([
			{ from: "src", to: "dst", kind: "handoff" },
			{ from: "src", to: "dst", kind: "plan-run" },
		]);
		const lines = fs.readFileSync(path.join(first.stateDir, "history-edges.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);

		const restarted = build(new FakePorts(), sessions, { stateDir: first.stateDir });
		expect((await get(restarted.routes)).edges).toHaveLength(2);
		// An edge to a session that is not listed is not drawn.
		await restarted.routes.recordEdge({ from: "src", to: "ghost", kind: "move" });
		expect((await get(restarted.routes)).edges.some(edge => edge.to === "ghost")).toBe(false);
	});

	it("rejects an out-of-range limit", async () => {
		const { routes } = build(new FakePorts(), []);
		for (const limit of ["0", "-3", "abc", "5000", "1.5"]) {
			const url = new URL(`http://daemon/api/history?limit=${limit}`);
			expect((await routes(new Request(url.toString()), url))?.status).toBe(400);
		}
	});
});

describe("history search", () => {
	it("ranks a title hit above any amount of card text, requires every term, and searches the card title too", async () => {
		const ports = new FakePorts();
		ports.cards.set("body-heavy", card("body-heavy", { title: "Queue work", decisions: ["redis redis redis", "redis again"], goal: "redis", files: ["redis.ts"], outcome: "redis" }));
		ports.cards.set("card-title", card("card-title", { title: "Redis failover notes" }));
		ports.sessions = ["body-heavy", "card-title", "title-hit", "other"].map(id => live({ id, title: id === "title-hit" ? "Redis retry queue" : id }));
		const { routes } = build(ports, [persisted({ id: "body-heavy", title: "body-heavy" }), persisted({ id: "card-title", title: "card-title" }), persisted({ id: "title-hit", title: "Redis retry queue" }), persisted({ id: "other", title: "other" })]);
		for (const id of ["body-heavy", "card-title"]) expect((await post(routes, `/api/sessions/${id}/key-points`)).status).toBe(202);
		await Bun.sleep(50);

		const redis = await get(routes, "?q=redis");
		// Both a session title and a card title count as title hits; the card-text-only session comes last despite its many hits.
		expect(redis.nodes.map(node => node.sessionId).slice(0, 2).sort()).toEqual(["card-title", "title-hit"]);
		expect(redis.nodes.map(node => node.sessionId).at(-1)).toBe("body-heavy");
		expect(redis.nodes).toHaveLength(3);

		// Every term must occur: "redis" AND "failover" leaves only the card whose title has both.
		expect((await get(routes, "?q=redis%20failover")).nodes.map(node => node.sessionId)).toEqual(["card-title"]);
		// A term in the card body only still finds the session.
		expect((await get(routes, "?q=redis.ts")).nodes.map(node => node.sessionId)).toEqual(["body-heavy"]);
		expect((await get(routes, "?q=nothing-matches")).nodes).toEqual([]);
		expect((await get(routes, "?q=%20%20")).nodes).toHaveLength(4);
	});
});

describe("key points", () => {
	it("POST answers 202 and stores the card the worker wrote; the history shows it; a torn file is ignored", async () => {
		const ports = new FakePorts();
		ports.sessions = [live({ id: "s1", title: "Session one" })];
		ports.cards.set("s1", card("s1", { title: "Parser port", decisions: ["Use Rust"] }));
		const { routes, stateDir } = build(ports, [persisted({ id: "s1", title: "Session one" })]);

		const res = await post(routes, "/api/sessions/s1/key-points");
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ sessionId: "s1" });
		await Bun.sleep(50);
		const stored = JSON.parse(fs.readFileSync(path.join(stateDir, "history", "s1.json"), "utf8")) as KeyPoints;
		expect(stored).toMatchObject({ sessionId: "s1", title: "Parser port", decisions: ["Use Rust"] });
		expect((await get(routes)).nodes[0]?.keyPoints?.title).toBe("Parser port");

		fs.writeFileSync(path.join(stateDir, "history", "torn.json"), '{"sessionId": "torn", "ti');
		fs.writeFileSync(path.join(stateDir, "history", "foreign.json"), JSON.stringify({ sessionId: "foreign", title: 7 }));
		expect((await get(routes)).nodes).toHaveLength(1);
	});

	it("an unknown session is a 404 and a failing worker leaves no card behind", async () => {
		const ports = new FakePorts();
		ports.sessions = [live({ id: "s1" })];
		ports.failWith = new SupervisorError("conflict", "the session has no conversation to summarise yet");
		const { routes, stateDir, logs } = build(ports, [persisted({ id: "s1", title: "One" })]);
		expect((await post(routes, "/api/sessions/nope/key-points")).status).toBe(404);
		expect((await post(routes, "/api/sessions/s1/key-points")).status).toBe(202);
		await Bun.sleep(50);
		expect(fs.existsSync(path.join(stateDir, "history", "s1.json"))).toBe(false);
		expect(logs.some(line => line.includes("no conversation"))).toBe(true);
		expect((await post(routes, "/api/sessions/%2F/key-points")).status).toBe(400);
		const get405 = new URL("http://daemon/api/sessions/s1/key-points");
		expect((await routes(new Request(get405.toString()), get405))?.status).toBe(405);
	});

	it("writes a model-free transcript checkpoint before sleep and leaves it stale for the next idle summary", async () => {
		const file = path.join(makeTmp("deck-history-sleep-"), "sleep.jsonl");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "Implement safe idle sleeping" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "The worker now resumes its saved transcript" } }),
			].join("\n") + "\n",
		);
		const ports = new FakePorts();
		ports.sessions = [live({ id: "sleep", title: "Sleep checkpoint", lastActivityAt: T0, sessionFile: file })];
		const { routes } = build(ports, [persisted({ id: "sleep", title: "Sleep checkpoint", file })]);

		await routes.beforeSleep("sleep");
		const keyPoints = (await get(routes)).nodes[0]?.keyPoints;
		expect(keyPoints).toMatchObject({
			title: "Sleep checkpoint",
			goal: "Implement safe idle sleeping",
			outcome: "The worker now resumes its saved transcript",
			generatedAt: T0 - 1,
		});
		expect(ports.summarized).toEqual([]);
	});
});

describe("idle and stop summaries", () => {
	// The summariser runs on a timer in production (30 s); these tests drive it with a short interval and a fake clock.
	it("summarises a session once per idle stretch, only when it is idle for the whole threshold and its card is missing or stale", async () => {
		const now = { t: T0 };
		const ports = new FakePorts();
		ports.sessions = [live({ id: "quiet", lastActivityAt: T0 - 11 * MIN }), live({ id: "recent", lastActivityAt: T0 - 5 * MIN }), live({ id: "busy", state: "streaming", lastActivityAt: T0 - 30 * MIN })];
		const stateDir = makeTmp("deck-history-");
		const routes = createHistoryRoutes(ports, stateDir, { listPersisted: async () => [], pollMs: 20, listTtlMs: 0, idleMs: 10 * MIN, now: () => now.t });
		created.push(routes);

		await Bun.sleep(150);
		expect(ports.summarized).toEqual(["quiet"]);
		// Same idle stretch: not again, however many polls pass.
		await Bun.sleep(100);
		expect(ports.summarized).toEqual(["quiet"]);

		// The session became active and idle again: a new stretch gets a fresh card.
		now.t = T0 + 30 * MIN;
		ports.sessions = [live({ id: "quiet", lastActivityAt: T0 + 5 * MIN }), live({ id: "recent", lastActivityAt: T0 + 6 * MIN })];
		ports.clock = now.t;
		await Bun.sleep(150);
		expect(ports.summarized).toEqual(["quiet", "quiet", "recent"]);

		// A card newer than the session's last activity needs no regeneration in a later stretch.
		now.t = T0 + 90 * MIN;
		ports.sessions = [live({ id: "quiet", lastActivityAt: T0 + 5 * MIN })];
		await Bun.sleep(100);
		expect(ports.summarized).toEqual(["quiet", "quiet", "recent"]);
	});

	it("a session the model cannot summarise is not retried within the same idle stretch", async () => {
		const now = { t: T0 };
		const ports = new FakePorts();
		ports.failWith = new SupervisorError("conflict", "the session has no conversation to summarise yet");
		ports.sessions = [live({ id: "empty", lastActivityAt: T0 - 20 * MIN })];
		const logs: string[] = [];
		const routes = createHistoryRoutes(ports, makeTmp("deck-history-"), { listPersisted: async () => [], pollMs: 20, listTtlMs: 0, idleMs: 10 * MIN, now: () => now.t, log: line => logs.push(line) });
		created.push(routes);
		await Bun.sleep(200);
		expect(ports.summarized).toEqual(["empty"]);
		expect(logs.filter(line => line.includes("empty")).length).toBe(1);
	});

	it("beforeStop writes a card for a stale session, skips a fresh one and never throws", async () => {
		const ports = new FakePorts();
		ports.sessions = [live({ id: "stale", lastActivityAt: T0 - MIN }), live({ id: "fresh", lastActivityAt: T0 - 2 * MIN })];
		ports.cards.set("fresh", card("fresh", { generatedAt: T0 }));
		const { routes, stateDir } = build(ports, []);
		await routes.beforeStop("stale");
		expect(ports.summarized).toEqual(["stale"]);
		expect(fs.existsSync(path.join(stateDir, "history", "stale.json"))).toBe(true);

		// Its card (generated at T0 by the fake clock) is newer than its last activity: nothing to do.
		await routes.beforeStop("stale");
		await routes.beforeStop("unknown");
		expect(ports.summarized).toEqual(["stale"]);

		ports.failWith = new Error("model unavailable");
		ports.sessions = [live({ id: "broken", lastActivityAt: T0 })];
		await expect(routes.beforeStop("broken")).resolves.toBeUndefined();
	});
});

describe("persisted sessions on disk", () => {
	it("the default lister reads a real fork's parent from its session header, and the graph draws the edge", async () => {
		const agentDir = makeTmp("deck-agent-");
		const cwd = makeTmp("deck-proj-");
		const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "fixtures", "history-fixture.ts"), cwd], {
			env: { ...(process.env as Record<string, string>), PI_CONFIG_DIR: ".omp-console-test-history-config", PI_CODING_AGENT_DIR: agentDir },
		});
		expect(run.exitCode).toBe(0);
		const out = JSON.parse(run.stdout.toString().trim().split("\n").pop()!) as { parentId: string; childId: string; listed: PersistedSession[] };
		expect(out.listed.map(session => session.id).sort()).toEqual([out.parentId, out.childId].sort());
		expect(out.listed.find(session => session.id === out.childId)?.parentSession).toBeDefined();

		const { routes } = build(new FakePorts(), out.listed);
		const graph = await get(routes);
		expect(graph.edges).toEqual([{ from: out.parentId, to: out.childId, kind: "fork" }]);
	});
});
