/**
 * Control API for the native-function spec: catalog, file mentions, slash commands, thinking, spawn-with-profile
 * and the subagent event stream. Fake worker; real HTTP; the file finder is omp's native one over real directories.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type {
	ApiError,
	CatalogResponse,
	FileSuggestionsResponse,
	SessionSummary,
	SetAgentModelResponse,
	SpawnAgentResponse,
} from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { isInsideCwd } from "../src/files";
import type { AgentEvent } from "../src/supervisor";
import { type TestDaemon, startTestDaemon, stopTestDaemons } from "./harness";
import { makeTmp, readJsonLines } from "./helpers";

afterEach(async () => {
	await stopTestDaemons();
});

async function createSession(t: TestDaemon, body: Record<string, unknown> = {}): Promise<SessionSummary> {
	const res = await t.post("/api/sessions", { cwd: t.dir, ...body });
	expect(res.status).toBe(201);
	return (await res.json()) as SessionSummary;
}

async function errorBody(response: Response): Promise<ApiError> {
	return (await response.json()) as ApiError;
}

async function until<T>(label: string, probe: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

describe("GET /api/sessions/:id/catalog", () => {
	it("returns the worker's catalog; unknown sessions are 404", async () => {
		const t = await startTestDaemon();
		const session = await createSession(t);
		const response = await t.get(`/api/sessions/${session.id}/catalog`);
		expect(response.status).toBe(200);
		const catalog = (await response.json()) as CatalogResponse;
		expect(catalog.commands.find(command => command.name === "tree")).toMatchObject({ remote: false, deckControl: "tree" });
		expect(catalog.commands.find(command => command.name === "compact")).toMatchObject({ remote: true });
		expect(catalog.profiles.map(profile => profile.name)).toEqual(["task"]);

		const missing = await t.get("/api/sessions/no-such-session/catalog");
		expect(missing.status).toBe(404);
		expect((await errorBody(missing)).code).toBe("not-found");
		expect((await t.post(`/api/sessions/${session.id}/catalog`)).status).toBe(405);
	});

	it("fails with 500 when the worker never answers, and 409 when the session is stopped meanwhile", async () => {
		const t = await startTestDaemon({ workerFlags: ["--ignore-requests"], catalogTimeoutMs: 250 });
		const session = await createSession(t);
		const timedOut = await t.get(`/api/sessions/${session.id}/catalog`);
		expect(timedOut.status).toBe(500);
		expect((await errorBody(timedOut)).error).toContain("timed out");

		// A request in flight when the worker goes away is failed at once, not left to time out.
		const slow = await startTestDaemon({ workerFlags: ["--ignore-requests"] });
		const other = await createSession(slow);
		const pending = slow.get(`/api/sessions/${other.id}/catalog`);
		await Bun.sleep(100);
		expect((await slow.del(`/api/sessions/${other.id}`)).status).toBe(204);
		const answered = await pending;
		expect(answered.status).toBe(409);
		expect((await errorBody(answered)).error).toContain("exited");
	});
});

describe("POST /api/sessions/:id/command", () => {
	it("accepts a command with 202 and maps the worker's refusals to 400, 409 and 500", async () => {
		const t = await startTestDaemon();
		const session = await createSession(t);
		const url = `/api/sessions/${session.id}/command`;

		const accepted = await t.post(url, { text: "  /compact soft  " });
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toEqual({ accepted: true });

		const busy = await t.post(url, { text: "/busy" });
		expect(busy.status).toBe(409);
		expect((await errorBody(busy)).code).toBe("conflict");
		const tui = await t.post(url, { text: "/tui" });
		expect(tui.status).toBe(400);
		expect((await errorBody(tui)).error).toContain("terminal UI");
		expect((await t.post(url, { text: "/boom" })).status).toBe(500);
		expect((await t.post("/api/sessions/nope/command", { text: "/compact" })).status).toBe(404);
	});

	it("rejects bodies that are not a slash command before anything reaches the worker", async () => {
		const dump = path.join(makeTmp(), "requests.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump-requests", dump] });
		const session = await createSession(t);
		const url = `/api/sessions/${session.id}/command`;
		for (const body of [{}, { text: 5 }, { text: "compact" }, { text: "/" }, { text: `/${"x".repeat(17_000)}` }, "[]"]) {
			expect((await t.post(url, body)).status).toBe(400);
		}
		expect((await t.post(url, "{broken")).status).toBe(400);
		expect(readJsonLines(dump).filter(line => line.t === "run-command")).toHaveLength(0);
	});

	it("times out with 500 when the worker never admits the command", async () => {
		const t = await startTestDaemon({ workerFlags: ["--ignore-requests"], commandTimeoutMs: 200 });
		const session = await createSession(t);
		const response = await t.post(`/api/sessions/${session.id}/command`, { text: "/compact" });
		expect(response.status).toBe(500);
		expect((await errorBody(response)).error).toContain("timed out");
	});
});

describe("POST /api/sessions/:id/agents", () => {
	it("spawns with 202, forwards the trimmed request, and streams the agent's lifecycle to listeners in order", async () => {
		const dump = path.join(makeTmp(), "requests.jsonl");
		const seen: Array<{ sessionId: string; event: AgentEvent }> = [];
		const t = await startTestDaemon({
			workerFlags: ["--dump-requests", dump],
			onAgentEvent: (sessionId, event) => seen.push({ sessionId, event }),
		});
		const late: AgentEvent[] = [];
		const unsubscribeLate = t.daemon.onAgentEvent((_sessionId, event) => late.push(event));
		t.daemon.onAgentEvent(() => {
			throw new Error("a broken listener must not stop the others");
		});
		const session = await createSession(t);

		const response = await t.post(`/api/sessions/${session.id}/agents`, {
			profile: " reviewer ",
			task: "  review the diff  ",
			name: "R1",
			isolated: true,
			files: ["src/a.ts", "docs/with space.md"],
			ignoredField: "dropped",
		});
		expect(response.status).toBe(202);
		const body = (await response.json()) as SpawnAgentResponse;
		expect(body).toEqual({ agentId: "R1" });
		const forwarded = readJsonLines(dump).find(line => line.t === "spawn-agent");
		expect(forwarded?.request).toEqual({
			profile: "reviewer",
			task: "review the diff",
			name: "R1",
			isolated: true,
			files: ["src/a.ts", "docs/with space.md"],
		});

		await until("completed agent line", () => seen.find(entry => entry.event.status === "completed"));
		expect(seen.map(entry => entry.event.status)).toEqual(["started", "completed"]);
		expect(seen[0]).toMatchObject({ sessionId: session.id, event: { agentId: "R1", profile: "reviewer", parentId: `root-${session.id}` } });
		expect(seen[1]?.event.summary).toBe("fake result");
		expect(late.map(event => event.status)).toEqual(["started", "completed"]);

		unsubscribeLate();
		await t.post(`/api/sessions/${session.id}/agents`, { profile: "task", task: "again" });
		await until("second spawn lines", () => seen.length >= 4);
		expect(late).toHaveLength(2);
	});

	it("validates the body and maps worker refusals: unknown profile 400, policy refusal 409, unknown session 404", async () => {
		const dump = path.join(makeTmp(), "requests.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump-requests", dump] });
		const session = await createSession(t);
		const url = `/api/sessions/${session.id}/agents`;

		for (const body of [
			{},
			{ profile: "task" },
			{ profile: "", task: "x" },
			{ profile: "task", task: "   " },
			{ profile: "task", task: "x", name: "n".repeat(65) },
			{ profile: "task", task: "x", isolated: "yes" },
			{ profile: "task", task: "x", files: "src/a.ts" },
			{ profile: "task", task: "x", files: ["ok", ""] },
			{ profile: "task", task: "x", files: Array.from({ length: 65 }, (_, index) => `f${index}`) },
		]) {
			expect((await t.post(url, body)).status).toBe(400);
		}
		expect(readJsonLines(dump).filter(line => line.t === "spawn-agent")).toHaveLength(0);

		const unknownProfile = await t.post(url, { profile: "missing", task: "x" });
		expect(unknownProfile.status).toBe(400);
		expect((await errorBody(unknownProfile)).error).toContain("unknown profile");
		expect((await t.post(url, { profile: "refused", task: "x" })).status).toBe(409);
		expect((await t.post("/api/sessions/nope/agents", { profile: "task", task: "x" })).status).toBe(404);
	});

	it("times out with 500 when the worker never registers the agent", async () => {
		const t = await startTestDaemon({ workerFlags: ["--ignore-requests"], spawnTimeoutMs: 200 });
		const session = await createSession(t);
		const response = await t.post(`/api/sessions/${session.id}/agents`, { profile: "task", task: "x" });
		expect(response.status).toBe(500);
	});
});

describe("POST /api/sessions/:id/agents/:agentId/thinking", () => {
	it("returns the level now in effect, and maps unknown agent 404, advisor 409, bad level 400", async () => {
		const t = await startTestDaemon();
		const session = await createSession(t);
		const url = (agent: string) => `/api/sessions/${session.id}/agents/${agent}/thinking`;

		const ok = await t.post(url("Main"), { level: "high" });
		expect(ok.status).toBe(200);
		expect((await ok.json()) as SetAgentModelResponse).toEqual({ agentId: "Main", model: "fake/model", thinkingLevel: "high" });
		expect((await t.post(url("Main"), { level: "auto" })).status).toBe(200);

		expect((await t.post(url("missing"), { level: "low" })).status).toBe(404);
		expect((await t.post(url("advisor"), { level: "low" })).status).toBe(409);
		for (const body of [{}, { level: "ludicrous" }, { level: 3 }, { level: "HIGH" }]) {
			expect((await t.post(url("Main"), body)).status).toBe(400);
		}
		expect((await t.post("/api/sessions/nope/agents/Main/thinking", { level: "low" })).status).toBe(404);
	});
});

describe("GET /api/sessions/:id/files", () => {
	function project(): string {
		const dir = makeTmp("deck-files-");
		const write = (relative: string): void => {
			fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
			fs.writeFileSync(path.join(dir, relative), "x");
		};
		fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n*.log\n");
		for (const file of [
			"src/alpha.ts",
			"src/nested/beta.ts",
			"README.md",
			"file with space.md",
			".hidden-config",
			"ignored/secret.ts",
			"debug.log",
		]) {
			write(file);
		}
		for (let index = 0; index < 30; index++) write(`bulk/item-${index}.txt`);
		return dir;
	}

	async function suggestions(t: TestDaemon, id: string, query: string, limit?: number): Promise<FileSuggestionsResponse> {
		const params = new URLSearchParams({ q: query });
		if (limit !== undefined) params.set("limit", String(limit));
		const response = await t.get(`/api/sessions/${id}/files?${params}`);
		expect(response.status).toBe(200);
		return (await response.json()) as FileSuggestionsResponse;
	}

	it("fuzzy-matches inside the session cwd, honours .gitignore, includes dotfiles, marks directories", async () => {
		const t = await startTestDaemon();
		const session = await createSession(t, { cwd: project() });

		const alpha = await suggestions(t, session.id, "alpha");
		expect(alpha.items).toContainEqual({ path: "src/alpha.ts", kind: "file" });
		const fuzzy = await suggestions(t, session.id, "bta");
		expect(fuzzy.items.map(item => item.path)).toContain("src/nested/beta.ts");
		const dirs = await suggestions(t, session.id, "nested");
		expect(dirs.items).toContainEqual({ path: "src/nested/", kind: "dir" });
		const spaced = await suggestions(t, session.id, "with space");
		expect(spaced.items.map(item => item.path)).toContain("file with space.md");
		const hidden = await suggestions(t, session.id, "hidden-config");
		expect(hidden.items.map(item => item.path)).toContain(".hidden-config");

		// Ignored paths never appear, whatever the query.
		for (const query of ["secret", "debug", "ignored"]) {
			expect((await suggestions(t, session.id, query)).items.map(item => item.path)).not.toContain("ignored/secret.ts");
		}
		expect((await suggestions(t, session.id, "debug")).items.map(item => item.path)).not.toContain("debug.log");
	});

	it("an empty query lists the top level only, directories first-class with a trailing slash", async () => {
		const t = await startTestDaemon();
		const session = await createSession(t, { cwd: project() });
		const top = await suggestions(t, session.id, "");
		const paths = top.items.map(item => item.path);
		expect(paths).toEqual(expect.arrayContaining(["src/", "bulk/", "README.md", ".hidden-config", "file with space.md", ".gitignore"]));
		expect(paths.every(candidate => candidate.replace(/\/$/, "").split("/").length === 1)).toBe(true);
		expect(paths).not.toContain("ignored/");
		expect(top.items.filter(item => item.kind === "dir").every(item => item.path.endsWith("/"))).toBe(true);
	});

	it("limit defaults to 50, caps at 200, and rejects anything else", async () => {
		const t = await startTestDaemon();
		const cwd = project();
		for (let index = 0; index < 250; index++) fs.writeFileSync(path.join(cwd, `many-${index}.txt`), "x");
		const session = await createSession(t, { cwd });

		expect((await suggestions(t, session.id, "item", 5)).items).toHaveLength(5);
		expect((await suggestions(t, session.id, "many")).items).toHaveLength(50);
		expect((await suggestions(t, session.id, "many", 200)).items).toHaveLength(200);
		for (const limit of ["0", "201", "-1", "1.5", "abc", ""]) {
			expect((await t.get(`/api/sessions/${session.id}/files?q=many&limit=${limit}`)).status).toBe(400);
		}
	});

	it("never returns anything outside the cwd, whatever the query", async () => {
		const outer = makeTmp("deck-outer-");
		const cwd = path.join(outer, "project");
		fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "src", "inside.ts"), "x");
		fs.writeFileSync(path.join(outer, "outside-secret.txt"), "TOP SECRET");
		fs.writeFileSync(path.join(outer, "sibling.ts"), "x");
		const t = await startTestDaemon();
		const session = await createSession(t, { cwd });

		for (const query of [
			"../",
			"../outside-secret",
			"../../",
			"..",
			"../sibling",
			"/etc/passwd",
			outer,
			path.join(outer, "outside-secret.txt"),
			"src/../../outside-secret",
			"%2e%2e/outside-secret",
		]) {
			const { items } = await suggestions(t, session.id, query);
			for (const item of items) {
				expect(item.path.split("/")).not.toContain("..");
				expect(path.isAbsolute(item.path)).toBe(false);
				expect(item.path).not.toContain("outside-secret");
				expect(item.path).not.toContain("sibling");
			}
		}
		// Control: the finder works on this session.
		expect((await suggestions(t, session.id, "inside")).items.map(item => item.path)).toContain("src/inside.ts");
	});

	it("rejects over-long or NUL queries, unknown sessions and non-GET methods", async () => {
		const t = await startTestDaemon();
		const session = await createSession(t, { cwd: project() });
		expect((await t.get(`/api/sessions/${session.id}/files?q=${"a".repeat(513)}`)).status).toBe(400);
		expect((await t.get(`/api/sessions/${session.id}/files?q=a%00b`)).status).toBe(400);
		expect((await t.get("/api/sessions/nope/files?q=a")).status).toBe(404);
		expect((await t.post(`/api/sessions/${session.id}/files`, {})).status).toBe(405);
	});
});

describe("isInsideCwd", () => {
	it("is a lexical containment check that sibling directories sharing a prefix do not pass", () => {
		expect(isInsideCwd("/work/proj", "src/a.ts")).toBe(true);
		expect(isInsideCwd("/work/proj", "src/")).toBe(true);
		expect(isInsideCwd("/work/proj", "../proj-evil/x.ts")).toBe(false);
		expect(isInsideCwd("/work/proj", "src/../../other")).toBe(false);
		expect(isInsideCwd("/work/proj", "/work/proj/src/a.ts")).toBe(false);
		expect(isInsideCwd("/work/proj", "")).toBe(false);
		expect(isInsideCwd("/work/proj", "a\0b")).toBe(false);
	});
});
