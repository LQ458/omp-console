import { afterEach, describe, expect, it } from "bun:test";
import type { ApiError, DraftNode, DraftPlan, DraftRun, SpawnAgentRequest } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PlanAgentEvent, PlanPorts } from "../src/plans/ports";
import { PlanRunner } from "../src/plans/runner";
import { createPlanRoutes } from "../src/plans/routes";
import { makeTmp } from "./helpers";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = makeTmp("deck-plans-");
	roots.push(root);
	return root;
}

interface SpawnCall {
	sessionId: string;
	request: SpawnAgentRequest;
	agentId: string;
}

type SpawnImplementation = (sessionId: string, request: SpawnAgentRequest, agentId: string) => Promise<{ agentId: string }>;

class FakePorts implements PlanPorts {
	readonly calls: SpawnCall[] = [];
	readonly cancellations: Array<{ sessionId: string; agentId: string }> = [];
	profiles = ["worker", "reviewer"];
	spawnImplementation: SpawnImplementation = (_sessionId, _request, agentId) => Promise.resolve({ agentId });
	readonly #listeners = new Set<(sessionId: string, event: PlanAgentEvent) => void>();
	#clock = 0;

	spawn(sessionId: string, request: SpawnAgentRequest): Promise<{ agentId: string }> {
		const agentId = `agent-${this.calls.length + 1}`;
		this.calls.push({ sessionId, request, agentId });
		return this.spawnImplementation(sessionId, request, agentId);
	}

	async cancelAgent(sessionId: string, agentId: string): Promise<void> {
		this.cancellations.push({ sessionId, agentId });
	}

	onAgentEvent(listener: (sessionId: string, event: PlanAgentEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async knownProfiles(_sessionId: string): Promise<string[]> {
		return [...this.profiles];
	}

	now(): number {
		this.#clock += 1;
		return this.#clock;
	}

	emit(event: PlanAgentEvent, sessionId = "session"): void {
		for (const listener of this.#listeners) listener(sessionId, event);
	}
}

function node(id: string, dependsOn?: string[], extras: Partial<DraftNode> = {}): DraftNode {
	return {
		id,
		title: extras.title ?? id,
		instruction: extras.instruction ?? `Do ${id}`,
		profile: extras.profile ?? "worker",
		...(dependsOn === undefined ? {} : { dependsOn }),
		...extras,
	};
}

function plan(nodes: DraftNode[], name = "test plan"): DraftPlan {
	return { name, nodes };
}

function event(agentId: string, status: PlanAgentEvent["status"], summary?: string): PlanAgentEvent {
	return {
		t: "agent",
		agentId,
		profile: "worker",
		status,
		...(summary === undefined ? {} : { summary }),
	};
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`timed out waiting for ${message}`);
}

function callByName(ports: FakePorts, name: string): SpawnCall {
	const call = ports.calls.find(candidate => candidate.request.name === name);
	if (!call) throw new Error(`missing spawn call for ${name}`);
	return call;
}

async function requestRoute(
	routes: (req: Request, url: URL) => Promise<Response | undefined>,
	method: string,
	pathName: string,
	body?: unknown,
): Promise<Response | undefined> {
	const init: RequestInit = {
		method,
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	};
	const url = new URL(pathName, "http://deck.test");
	return routes(new Request(url.href, init), url);
}
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected promise to reject");
}

describe("draft plan runner", () => {
	it("runs a linear dependency chain and passes completed context and file mentions", async () => {
		const ports = new FakePorts();
		const runner = new PlanRunner(ports, tempDir());
		const draft = plan([
			node("base", undefined, { title: "Build base", instruction: "Build the shared base" }),
			node("finish", ["base"], {
				title: "Finish feature",
				instruction: "Finish the feature",
				files: ["src/main.ts", "docs/usage guide.md"],
			}),
		]);
		const started = await runner.start("session", draft);
		await waitFor(() => ports.calls.length === 1, "first node spawn");
		expect(started.state).toBe("running");
		expect(ports.calls[0]!.request.task).toBe("Build the shared base");

		ports.emit(event(ports.calls[0]!.agentId, "completed", "base module exported"));
		await waitFor(() => ports.calls.length === 2, "dependent node spawn");
		const secondTask = ports.calls[1]!.request.task;
		expect(secondTask).toContain("Finish the feature");
		expect(secondTask).toContain("Finished dependencies:\n- Build base: base module exported");
		expect(secondTask).toContain("@src/main.ts");
		expect(secondTask).toContain("@docs/usage guide.md");

		ports.emit(event(ports.calls[1]!.agentId, "completed", "feature complete"));
		expect(runner.get("session", started.runId)).toMatchObject({ state: "done", nodes: [{ id: "base", state: "done" }, { id: "finish", state: "done" }] });
		await runner.flush();
		const logFile = path.join(roots[0]!, "plan-runs.jsonl");
		const rows = fs.readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { state: string; nodes: Array<{ state: string }> });
		expect(rows.length).toBeGreaterThan(3);
		expect(rows.some(row => row.state === "done")).toBe(true);
		if (process.platform !== "win32") expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(logFile, "utf8")).not.toContain("Build the shared base");
	});

	it("runs a diamond only after both branches complete", async () => {
		const ports = new FakePorts();
		const runner = new PlanRunner(ports, tempDir());
		const started = await runner.start(
			"session",
			plan([node("root"), node("left", ["root"]), node("right", ["root"]), node("join", ["left", "right"])]),
		);
		await waitFor(() => ports.calls.length === 1, "root spawn");
		ports.emit(event(ports.calls[0]!.agentId, "completed", "root done"));
		await waitFor(() => ports.calls.length === 3, "both branches spawn");
		const left = callByName(ports, "left");
		const right = callByName(ports, "right");
		ports.emit(event(left.agentId, "completed", "left done"));
		expect(ports.calls).toHaveLength(3);
		ports.emit(event(right.agentId, "completed", "right done"));
		await waitFor(() => ports.calls.length === 4, "join spawn");
		ports.emit(event(callByName(ports, "join").agentId, "completed", "joined"));
		expect(runner.get("session", started.runId)?.state).toBe("done");
	});

	it("enforces the configured per-run concurrency limit", async () => {
		const ports = new FakePorts();
		const resolvers = new Map<string, (value: { agentId: string }) => void>();
		ports.spawnImplementation = (_sessionId, request, _agentId) => {
			const pending = Promise.withResolvers<{ agentId: string }>();
			resolvers.set(request.name!, pending.resolve);
			return pending.promise;
		};
		const runner = new PlanRunner(ports, tempDir(), { maxConcurrent: 2 });
		await runner.start("session", plan([node("one"), node("two"), node("three"), node("four")]));
		expect(ports.calls).toHaveLength(2);

		resolvers.get("one")!({ agentId: "agent-one" });
		await waitFor(() => ports.calls[0]!.agentId === "agent-1", "spawn registration");
		await waitFor(() => runner.list("session")[0]!.nodes[0]!.agentId === "agent-one", "first agent assignment");
		ports.emit(event("agent-one", "completed", "one done"));
		await waitFor(() => ports.calls.length === 3, "third node scheduled after a slot opens");
		expect(ports.calls.map(call => call.request.name)).toEqual(["one", "two", "three"]);
	});

	it("buffers a terminal lifecycle event that arrives before spawn resolves", async () => {
		const ports = new FakePorts();
		const pending = Promise.withResolvers<{ agentId: string }>();
		ports.spawnImplementation = () => pending.promise;
		const runner = new PlanRunner(ports, tempDir());
		const started = await runner.start("session", plan([node("fast")]));
		ports.emit(event("early-agent", "completed", "finished before registration"));
		pending.resolve({ agentId: "early-agent" });
		await waitFor(() => runner.get("session", started.runId)?.state === "done", "buffered completion");
		expect(runner.get("session", started.runId)?.nodes[0]).toMatchObject({ state: "done", summary: "finished before registration" });
	});

	it("marks failed nodes and transitive dependents skipped while independent work finishes", async () => {
		const ports = new FakePorts();
		const runner = new PlanRunner(ports, tempDir());
		const started = await runner.start("session", plan([node("root"), node("child", ["root"]), node("grandchild", ["child"]), node("independent")]));
		await waitFor(() => ports.calls.length === 2, "root and independent spawns");
		const root = callByName(ports, "root");
		const independent = callByName(ports, "independent");
		ports.emit(event(root.agentId, "failed", "root failed"));
		expect(runner.get("session", started.runId)?.nodes).toMatchObject([
			{ id: "root", state: "failed", summary: "root failed" },
			{ id: "child", state: "skipped" },
			{ id: "grandchild", state: "skipped" },
			{ id: "independent", state: "running" },
		]);
		expect(runner.get("session", started.runId)?.state).toBe("running");
		ports.emit(event(independent.agentId, "completed", "other branch done"));
		expect(runner.get("session", started.runId)?.state).toBe("failed");
	});

	it("treats aborted lifecycle events as failures and skips their dependents", async () => {
		const ports = new FakePorts();
		const runner = new PlanRunner(ports, tempDir());
		const started = await runner.start("session", plan([node("aborted"), node("after-abort", ["aborted"])]));
		await waitFor(() => ports.calls.length === 1, "agent spawn");
		ports.emit(event(ports.calls[0]!.agentId, "aborted", "agent aborted"));
		expect(runner.get("session", started.runId)).toMatchObject({
			state: "failed",
			nodes: [{ id: "aborted", state: "failed", summary: "agent aborted" }, { id: "after-abort", state: "skipped" }],
		});
	});

	it("cancels running agents and skips waiting nodes on DELETE", async () => {
		const ports = new FakePorts();
		const runner = new PlanRunner(ports, tempDir(), { maxConcurrent: 1 });
		const started = await runner.start("session", plan([node("active"), node("waiting")]));
		await waitFor(() => ports.calls.length === 1, "active node spawn");
		await waitFor(() => runner.get("session", started.runId)?.nodes[0]?.agentId !== undefined, "active agent id");
		const cancelled = await runner.cancel("session", started.runId);
		expect(cancelled).toMatchObject({
			state: "cancelled",
			nodes: [{ id: "active", state: "cancelled" }, { id: "waiting", state: "skipped" }],
		});
		expect(ports.cancellations).toEqual([{ sessionId: "session", agentId: ports.calls[0]!.agentId }]);
	});

	it("rejects dependency cycles with the cycle path and rejects unknown dependencies", async () => {
		const runner = new PlanRunner(new FakePorts(), tempDir());
		const cycle = await rejectionMessage(runner.start("session", plan([node("a", ["b"]), node("b", ["a"])])));
		expect(cycle).toContain("a -> b -> a");
		const missing = await rejectionMessage(runner.start("session", plan([node("orphan", ["missing"])])));
		expect(missing).toContain('unknown node "missing"');
	});

	it("rejects unknown profiles before spawning", async () => {
		const ports = new FakePorts();
		const runner = new PlanRunner(ports, tempDir());
		expect(await rejectionMessage(runner.start("session", plan([node("task", undefined, { profile: "missing" })])))).toContain("unknown profile");
		expect(ports.calls).toHaveLength(0);
	});

	it("rejects duplicate ids and more than 50 nodes, and retains only the latest 50 runs", async () => {
		const runner = new PlanRunner(new FakePorts(), tempDir());
		const duplicate = await rejectionMessage(runner.start("session", plan([node("same"), node("same")])));
		expect(duplicate).toContain("duplicate node id");
		const oversized = await rejectionMessage(runner.start("session", plan(Array.from({ length: 51 }, (_, index) => node(`node-${index}`)))));
		expect(oversized).toContain("at most 50 nodes");

		const runIds: string[] = [];
		for (let index = 0; index < 51; index++) {
			const run = await runner.start("session", plan([], `run ${index}`));
			runIds.push(run.runId);
		}
		expect(runner.list("session").map(run => run.runId)).toEqual(runIds.slice(1));
		await runner.flush();
	});

	it("records spawn failures and skips dependents", async () => {
		const ports = new FakePorts();
		ports.spawnImplementation = (_sessionId, request, agentId) =>
			request.name === "root" ? Promise.reject(new Error("spawn policy rejected task")) : Promise.resolve({ agentId });
		const runner = new PlanRunner(ports, tempDir());
		const started = await runner.start("session", plan([node("root"), node("dependent", ["root"])]));
		await waitFor(() => runner.get("session", started.runId)?.state === "failed", "failed run state");
		expect(runner.get("session", started.runId)?.nodes).toMatchObject([
			{ id: "root", state: "failed", summary: "spawn policy rejected task" },
			{ id: "dependent", state: "skipped" },
		]);
	});
});

describe("draft plan HTTP routes and templates", () => {
	it("saves and lists named templates with private file permissions", async () => {
		const root = tempDir();
		const routes = createPlanRoutes(new FakePorts(), root);
		const saved = await requestRoute(routes, "PUT", "/api/plan-templates/Reusable%20plan", plan([]));
		expect(saved?.status).toBe(200);
		expect(await saved!.json()).toEqual({ name: "Reusable plan", nodes: [] });
		const file = path.join(root, "plan-templates", "Reusable plan.json");
		if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

		const listed = await requestRoute(routes, "GET", "/api/plan-templates");
		expect(listed?.status).toBe(200);
		expect(await listed!.json()).toEqual({ templates: [{ name: "Reusable plan", nodes: [] }] });

		const invalid = await requestRoute(routes, "PUT", "/api/plan-templates/bad%2Fname", plan([]));
		expect(invalid?.status).toBe(400);
		expect((await invalid!.json()) as ApiError).toMatchObject({ code: "bad-request" });
	});

	it("serves run collection/detail, supports cancellation, and rejects unmatched paths", async () => {
		const ports = new FakePorts();
		const pending = Promise.withResolvers<{ agentId: string }>();
		ports.spawnImplementation = () => pending.promise;
		const routes = createPlanRoutes(ports, tempDir());
		const post = await requestRoute(routes, "POST", "/api/sessions/session/plans", plan([node("active")]));
		expect(post?.status).toBe(202);
		const run = (await post!.json()) as DraftRun;
		const listed = await requestRoute(routes, "GET", "/api/sessions/session/plans");
		expect(listed?.status).toBe(200);
		expect(await listed!.json()).toMatchObject({ runs: [{ runId: run.runId, state: "running" }] });
		const detail = await requestRoute(routes, "GET", `/api/sessions/session/plans/${run.runId}`);
		expect(detail?.status).toBe(200);
		const deleted = await requestRoute(routes, "DELETE", `/api/sessions/session/plans/${run.runId}`);
		expect(deleted?.status).toBe(200);
		expect(await deleted!.json()).toMatchObject({ state: "cancelled" });
		pending.resolve({ agentId: "late-agent" });
		await waitFor(() => ports.cancellations.some(call => call.agentId === "late-agent"), "late spawned agent cancellation");

		const unsupported = await requestRoute(routes, "POST", `/api/sessions/session/plans/${run.runId}`);
		expect(unsupported?.status).toBe(405);
		expect((await unsupported!.json()) as ApiError).toMatchObject({ code: "bad-request" });
		const unmatched = await requestRoute(routes, "GET", "/api/other");
		expect(unmatched).toBeUndefined();
	});
});
