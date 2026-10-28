import { afterEach, describe, expect, it } from "bun:test";
import type { CreateSessionRequest, HistoryEdge, KeyPoints, RuleFileResponse, SessionSummary, Workspace } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverWorkspaces, workspaceOf } from "../src/workspaces/discover";
import type { QuickAskSessionRequest, WorkspacePorts } from "../src/workspaces/ports";
import { createWorkspaceRoutes } from "../src/workspaces/routes";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-workspaces-"));
	roots.push(root);
	return root;
}

function git(root: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString();
}

function initRepo(root: string): void {
	fs.mkdirSync(root, { recursive: true });
	const initialized = Bun.spawnSync(["git", "init", "-q", root], { stdout: "pipe", stderr: "pipe" });
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
	git(root, "config", "user.name", "omp console test");
	git(root, "config", "user.email", "omp-console-test@example.invalid");
	fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
	git(root, "add", "README.md");
	git(root, "commit", "-m", "fixture");
}

function workspace(id: string, root: string): Workspace {
	return { id, kind: "project", name: path.basename(root), root, rules: [], liveSessions: 0 };
}

function makeSession(id: string, cwd: string, sessionFile?: string): SessionSummary {
	return {
		id,
		cwd,
		...(sessionFile === undefined ? {} : { sessionFile }),
		title: id,
		state: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	};
}

class FakeWorkspacePorts implements WorkspacePorts {
	readonly created: CreateSessionRequest[] = [];
	readonly quickAskRequests: QuickAskSessionRequest[] = [];
	readonly quickAskSessions: Array<{ request: QuickAskSessionRequest; session: SessionSummary }> = [];
	readonly prompts: Array<{ sessionId: string; text: string }> = [];
	readonly edges: HistoryEdge[] = [];
	readonly sessions: SessionSummary[] = [];
	points: KeyPoints | undefined;
	/** omp's handoff result for the source; an Error stands for a busy source or a failed model call. */
	handoffResult: string | Error = new Error("session is busy; a handoff needs an idle session");
	readonly handoffs: Array<{ sessionId: string; focus: string }> = [];

	async createSession(request: CreateSessionRequest): Promise<SessionSummary> {
		this.created.push(request);
		const session = makeSession(`workspace-${this.created.length}`, request.cwd, path.join(request.cwd, `workspace-${this.created.length}.jsonl`));
		this.sessions.push(session);
		return session;
	}

	async createQuickAskSession(request: QuickAskSessionRequest): Promise<SessionSummary> {
		this.quickAskRequests.push(request);
		const resumed = request.resumeSessionFile
			? this.quickAskSessions.find(entry => entry.session.sessionFile === request.resumeSessionFile)?.session
			: undefined;
		if (resumed) {
			this.sessions.push(resumed);
			return resumed;
		}
		const index = this.quickAskRequests.length;
		const session = makeSession(`quick-ask-${index}`, request.cwd, path.join(request.cwd, `quick-ask-${index}.jsonl`));
		session.title = request.title;
		this.quickAskSessions.push({ request, session });
		this.sessions.push(session);
		return session;
	}

	async sendPrompt(sessionId: string, text: string): Promise<void> {
		this.prompts.push({ sessionId, text });
	}

	async keyPoints(_sessionId: string): Promise<KeyPoints | undefined> {
		return this.points;
	}

	async handoffDocument(sessionId: string, focus: string): Promise<string> {
		this.handoffs.push({ sessionId, focus });
		if (this.handoffResult instanceof Error) throw this.handoffResult;
		return this.handoffResult;
	}

	liveSessions(): SessionSummary[] {
		return [...this.sessions];
	}

	recordEdge(edge: HistoryEdge): void {
		this.edges.push(edge);
	}
}

async function callRoute(
	route: (req: Request, url: URL) => Promise<Response | undefined>,
	method: string,
	pathname: string,
	body?: unknown,
): Promise<Response | undefined> {
	const url = new URL(pathname, "http://127.0.0.1");
	const request = new Request(url.toString(), {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return route(request, url);
}

describe("workspace discovery", () => {
	it("finds direct Git children and additional roots without following symlink loops or nested repositories", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		const project = path.join(projectsRoot, "alpha");
		const nested = path.join(project, "nested");
		const nonRepository = path.join(projectsRoot, "plain");
		const hiddenNested = path.join(nonRepository, "nested-repo");
		const extra = path.join(root, "extra-project");
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		initRepo(project);
		initRepo(nested);
		fs.mkdirSync(nonRepository, { recursive: true });
		initRepo(hiddenNested);
		initRepo(extra);
		fs.symlinkSync(projectsRoot, path.join(projectsRoot, "loop"), "dir");

		const workspaces = await discoverWorkspaces({ knowledgeRoot, projectRoots: [projectsRoot, extra] });
		expect(workspaces.map(item => item.id).sort()).toEqual(["knowledge", "project:alpha", "project:extra-project"]);
		const alphaWorkspace = workspaces.find(item => item.id === "project:alpha");
		expect(alphaWorkspace?.git?.branch).toBe(git(project, "branch", "--show-current").trim());
		expect(alphaWorkspace?.git?.dirty).toBe(git(project, "status", "--porcelain").trim().length > 0);
		expect(workspaces.every(item => item.root !== nested && item.root !== hiddenNested)).toBe(true);
	});

	it("uses the longest containing workspace and respects path-component boundaries", () => {
		const broad = workspace("project:b", "/work/a/b");
		const nested = workspace("project:n", "/work/a/b/nested");
		expect(workspaceOf("/work/a/b/nested/file.ts", [broad, nested])?.id).toBe("project:n");
		expect(workspaceOf("/work/a/bc/file.ts", [broad])).toBeUndefined();
	});
});

describe("workspace routes", () => {
	it("keeps private rules out of Git status and returns shared edits as a HEAD diff", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		const repo = path.join(projectsRoot, "repo");
		initRepo(repo);
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "docs", "guide.md"), "original guide\n");
		git(repo, "add", "docs/guide.md");
		git(repo, "commit", "-m", "add guide");
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		const ports = new FakeWorkspacePorts();
		const routes = createWorkspaceRoutes(ports, path.join(root, "state"), { discovery: { knowledgeRoot, projectRoots: [projectsRoot] } });
		const base = `/api/workspaces/${encodeURIComponent("project:repo")}/rules`;

		const privateWrite = await callRoute(routes, "PUT", `${base}/.omp/rules/private.md`, { visibility: "private", content: "private guidance\n" });
		expect(privateWrite?.status).toBe(204);
		expect(git(repo, "status", "--porcelain").trim()).toBe("");
		const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
		expect(exclude.split(/\r?\n/).filter(line => line === ".omp/rules/")).toHaveLength(1);
		const privateRead = await callRoute(routes, "GET", `${base}/.omp/rules/private.md`);
		expect(await privateRead?.json()).toMatchObject({ path: ".omp/rules/private.md", visibility: "private", content: "private guidance\n" });

		const sharedWrite = await callRoute(routes, "PUT", `${base}/docs/guide.md`, { visibility: "shared", content: "revised guide\n" });
		expect(sharedWrite?.status).toBe(204);
		const sharedRead = await callRoute(routes, "GET", `${base}/docs/guide.md`);
		const response = (await sharedRead?.json()) as RuleFileResponse;
		expect(response.content).toBe("revised guide\n");
		expect(response.diff).toContain("+revised guide");
		expect(response.diff).toContain("-original guide");
		expect(git(repo, "status", "--porcelain")).toContain(" M docs/guide.md");
	});

	it("rejects traversal and symlink rule paths as bad requests", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		const repo = path.join(projectsRoot, "repo");
		initRepo(repo);
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.symlinkSync(path.join(repo, "README.md"), path.join(repo, "docs", "linked.md"));
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		const routes = createWorkspaceRoutes(new FakeWorkspacePorts(), path.join(root, "state"), { discovery: { knowledgeRoot, projectRoots: [projectsRoot] } });
		const base = `/api/workspaces/${encodeURIComponent("project:repo")}/rules`;

		const traversal = await callRoute(routes, "GET", `${base}/docs%2F..%2FREADME.md`);
		expect(traversal?.status).toBe(400);
		const symlink = await callRoute(routes, "GET", `${base}/docs/linked.md`);
		expect(symlink?.status).toBe(400);
	});
	it("accepts rules at 256 KB and rejects larger writes without replacing the file", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		const repo = path.join(projectsRoot, "repo");
		initRepo(repo);
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		const routes = createWorkspaceRoutes(new FakeWorkspacePorts(), path.join(root, "state"), { discovery: { knowledgeRoot, projectRoots: [projectsRoot] } });
		const base = `/api/workspaces/${encodeURIComponent("project:repo")}/rules`;
		const content = "x".repeat(256 * 1024);

		const allowed = await callRoute(routes, "PUT", `${base}/docs/rule.md`, { visibility: "shared", content });
		expect(allowed?.status).toBe(204);
		const read = await callRoute(routes, "GET", `${base}/docs/rule.md`);
		const response = (await read?.json()) as RuleFileResponse;
		expect(response.content.length).toBe(256 * 1024);
		expect(Bun.hash(response.content)).toBe(Bun.hash(content));

		const rejected = await callRoute(routes, "PUT", `${base}/docs/rule.md`, { visibility: "shared", content: `${content}x` });
		expect(rejected?.status).toBe(400);
		const after = await callRoute(routes, "GET", `${base}/docs/rule.md`);
		const preserved = (await after?.json()) as RuleFileResponse;
		expect(Bun.hash(preserved.content)).toBe(Bun.hash(content));
	});

	it("falls back to a key-point block when the source cannot hand off, and records the relation", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		const project = path.join(projectsRoot, "target");
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		initRepo(project);
		const ports = new FakeWorkspacePorts();
		ports.sessions.push(makeSession("source", knowledgeRoot));
		ports.points = {
			sessionId: "source",
			title: "Source learning session",
			goal: "understand the API",
			decisions: ["keep protocol stable"],
			files: ["src/index.ts"],
			outcome: "mapped contracts",
			openQuestions: ["which route owns it?"],
			generatedAt: 10,
		};
		const routes = createWorkspaceRoutes(ports, path.join(root, "state"), { discovery: { knowledgeRoot, projectRoots: [projectsRoot] } });
		const response = await callRoute(routes, "POST", `/api/workspaces/${encodeURIComponent("project:target")}/sessions`, {
			handoffFromSessionId: "source",
			prompt: "Implement the route",
		});
		const session = (await response?.json()) as SessionSummary;
		expect(response?.status).toBe(201);
		expect(ports.prompts[0]?.sessionId).toBe(session.id);
		expect(ports.handoffs.map(call => call.sessionId)).toEqual(["source"]);
		expect(ports.prompts[0]?.text.startsWith("<handoff>")).toBe(true);
		expect(ports.prompts[0]?.text).toContain("Source learning session");
		expect(ports.prompts[0]?.text).toContain("keep protocol stable");
		expect(ports.prompts[0]?.text.endsWith("Implement the route")).toBe(true);
		expect(ports.edges).toEqual([{ from: "source", to: session.id, kind: "handoff" }]);
		expect(ports.created[0]?.cwd).toBe(project);
	});

	it("starts from the source's omp handoff, keeps its model, and continues when no prompt was typed", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		const project = path.join(projectsRoot, "target");
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		initRepo(project);
		const ports = new FakeWorkspacePorts();
		const source = makeSession("source", knowledgeRoot);
		source.model = "openai-codex/gpt-6-luna";
		ports.sessions.push(source);
		ports.handoffResult = "## Next step\nWire the route in src/api.ts";
		const routes = createWorkspaceRoutes(ports, path.join(root, "state"), { discovery: { knowledgeRoot, projectRoots: [projectsRoot] } });
		const response = await callRoute(routes, "POST", `/api/workspaces/${encodeURIComponent("project:target")}/sessions`, {
			handoffFromSessionId: "source",
		});
		expect(response?.status).toBe(201);
		expect(ports.handoffs[0]?.focus).toContain(project);
		expect(ports.created[0]?.model).toBe("openai-codex/gpt-6-luna");
		const text = ports.prompts[0]?.text ?? "";
		expect(text).toContain("<handoff>\n## Next step\nWire the route in src/api.ts\n</handoff>");
		expect(text).toContain("Continue the work from this handoff in this workspace");
	});

	it("refuses a handoff from a session that is not live", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		const ports = new FakeWorkspacePorts();
		const routes = createWorkspaceRoutes(ports, path.join(root, "state"), { discovery: { knowledgeRoot, projectRoots: [path.join(root, "Projects")] } });
		const response = await callRoute(routes, "POST", "/api/workspaces/knowledge/sessions", { handoffFromSessionId: "gone" });
		expect(response?.status).toBe(404);
		expect(ports.created).toEqual([]);
		expect(ports.handoffs).toEqual([]);
	});
	it("does not count asleep sessions or accept them as workspace handoff sources", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		const project = path.join(projectsRoot, "target");
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		initRepo(project);
		const ports = new FakeWorkspacePorts();
		const asleep = makeSession("asleep", knowledgeRoot);
		asleep.state = "asleep";
		ports.sessions.push(asleep, makeSession("live", knowledgeRoot));
		const routes = createWorkspaceRoutes(ports, path.join(root, "state"), { discovery: { knowledgeRoot, projectRoots: [projectsRoot] } });

		const list = await callRoute(routes, "GET", "/api/workspaces");
		const body = (await list?.json()) as { workspaces: Workspace[] };
		expect(body.workspaces.find(item => item.id === "knowledge")?.liveSessions).toBe(1);
		const handoff = await callRoute(routes, "POST", `/api/workspaces/${encodeURIComponent("project:target")}/sessions`, {
			handoffFromSessionId: "asleep",
		});
		expect(handoff?.status).toBe(404);
		expect(ports.created).toEqual([]);
		expect(ports.handoffs).toEqual([]);
	});

	it("reuses and resumes one hidden kb quick-ask session per UTC day", async () => {
		const root = tempDir();
		const knowledgeRoot = path.join(root, "Knowledge");
		const projectsRoot = path.join(root, "Projects");
		fs.mkdirSync(knowledgeRoot, { recursive: true });
		const ports = new FakeWorkspacePorts();
		let now = Date.UTC(2026, 9, 23, 12);
		const routes = createWorkspaceRoutes(ports, path.join(root, "state"), {
			discovery: { knowledgeRoot, projectRoots: [projectsRoot] },
			quickAsk: { enabled: true, sources: ["repo", "web"] },
			now: () => now,
		});
		const disallowed = await callRoute(routes, "POST", "/api/quick-ask", { question: "Not configured", sources: ["siyuan"] });
		expect(disallowed?.status).toBe(400);
		expect(ports.quickAskRequests).toHaveLength(0);

		const first = await callRoute(routes, "POST", "/api/quick-ask", { question: "Where is the retry rule?", sources: ["repo", "web"] });
		const firstBody = (await first?.json()) as { sessionId: string };
		const second = await callRoute(routes, "POST", "/api/quick-ask", { question: "What changed?" });
		const secondBody = (await second?.json()) as { sessionId: string };
		expect(first?.status).toBe(202);
		expect(second?.status).toBe(202);
		expect(secondBody.sessionId).toBe(firstBody.sessionId);
		expect(ports.quickAskRequests).toHaveLength(1);
		expect(ports.quickAskRequests[0]).toMatchObject({ cwd: knowledgeRoot, title: "quick-ask", profile: "kb", hidden: true });
		expect(ports.prompts[0]?.text).toContain("the knowledge repository");
		expect(ports.prompts[0]?.text).toContain("web search");
		expect(ports.prompts[0]?.text).not.toContain("SiYuan through");
		expect(ports.prompts[1]?.text).toContain("the knowledge repository");
		expect(ports.prompts[1]?.text).toContain("web search");
		expect(ports.prompts[1]?.text).not.toContain("SiYuan through");

		const sessionFile = ports.sessions[0]?.sessionFile;
		ports.sessions.length = 0;
		const resumed = await callRoute(routes, "POST", "/api/quick-ask", { question: "Resume today's question session" });
		const resumedBody = (await resumed?.json()) as { sessionId: string };
		expect(resumed?.status).toBe(202);
		expect(resumedBody.sessionId).toBe(firstBody.sessionId);
		expect(ports.quickAskRequests).toHaveLength(2);
		expect(ports.quickAskRequests[1]).toMatchObject({ resumeSessionFile: sessionFile, title: "quick-ask", profile: "kb", hidden: true });

		now += 24 * 60 * 60 * 1000;
		const nextDay = await callRoute(routes, "POST", "/api/quick-ask", { question: "Different day" });
		expect(nextDay?.status).toBe(202);
		expect(ports.quickAskRequests).toHaveLength(3);
	});
});
