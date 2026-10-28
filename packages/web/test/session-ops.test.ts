import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { CreateSessionRequest, SessionSummary, SessionTreeNode } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { startMockDaemon, type MockDaemon } from "../dev/mock-daemon";
import { DeckApi, DeckApiError } from "../src/lib/api";
import { parseTodoPhases, readGoalProgress, readLatestPlan, readTodoSnapshot, reduceTodoPhases, todoOperation, type EditableTodoPhase } from "../src/lib/session-ops";
import { flattenSessionTree, forkRequestForEntry } from "../src/components/session-ops/SessionTreePanel";

function toolResult(id: string, toolName: string, details: unknown, text = "ok"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "toolResult", toolCallId: `call-${id}`, toolName, content: [{ type: "text", text }], details, isError: false, timestamp: 1 },
	};
}

const initialTodos: EditableTodoPhase[] = [
	{ name: "Build", tasks: [{ content: "Implement", status: "in_progress" }, { content: "Verify", status: "pending" }] },
	{ name: "Ship", tasks: [{ content: "Review", status: "blocked" }] },
];

describe("session operation transformations", () => {
	it("preserves blocked todos and applies edits, statuses and ordering without mutating the saved board", () => {
		const parsed = parseTodoPhases([{ name: "Ship", tasks: [{ content: "Review", status: "blocked" }, { content: "???", status: "unknown" }] }]);
		expect(parsed[0]!.tasks.map(task => task.status)).toEqual(["blocked", "pending"]);
		const edited = reduceTodoPhases(initialTodos, { type: "task:status", phase: 0, task: 1, status: "completed" });
		const reordered = reduceTodoPhases(edited, { type: "phase:move", phase: 0, direction: 1 });
		expect(reordered.map(phase => phase.name)).toEqual(["Ship", "Build"]);
		expect(reordered[1]!.tasks.map(task => task.status)).toEqual(["in_progress", "completed"]);
		expect(initialTodos[0]!.tasks[1]!.status).toBe("pending");
	});

	it("serializes the edited board with the user-visible blocked status and trims saved task text", () => {
		expect(todoOperation([{ name: "Ship", tasks: [{ content: " Review ", status: "blocked" }, { content: "   ", status: "pending" }] }])).toEqual({
			op: "todos",
			phases: [{ name: "Ship", tasks: [{ content: "Review", status: "blocked" }] }],
		});
	});

	it("reads the latest goal and plan content from the replicated tool result", () => {
		const entries = [
			toolResult("goal-1", "goal", { goal: { objective: "Ship the release", status: "active", tokensUsed: 300, tokenBudget: 1_000 } }),
			toolResult("plan-1", "read", { path: "/tmp/PLAN.md" }, "# Release plan\n- Verify tests"),
		];
		expect(readGoalProgress(entries)).toMatchObject({ objective: "Ship the release", active: true, tokensUsed: 300, tokenBudget: 1_000 });
		expect(readLatestPlan(entries)).toMatchObject({ entryId: "plan-1", path: "/tmp/PLAN.md", content: "# Release plan\n- Verify tests" });
		expect(readTodoSnapshot(entries)).toBeNull();
	});

	it("lists only conversation entries, keeps a linear chain flat, indents once per fork, and binds a fork request to the chosen entry", () => {
		const tree: SessionTreeNode[] = [
			{ entryId: "root", parentId: null, role: "user", preview: "start", at: 1, onCurrentBranch: true },
			{ entryId: "tool", parentId: "root", role: "other", preview: "tool_execution_start", at: 2, onCurrentBranch: true },
			{ entryId: "reply", parentId: "tool", role: "assistant", preview: "first answer", at: 3, onCurrentBranch: true },
			{ entryId: "calls", parentId: "reply", role: "assistant", preview: "", at: 4, onCurrentBranch: true },
			{ entryId: "main", parentId: "calls", role: "user", preview: "go on", at: 5, onCurrentBranch: true },
			{ entryId: "alt", parentId: "calls", role: "user", preview: "try instead", at: 6, onCurrentBranch: false },
			{ entryId: "child", parentId: "alt", role: "assistant", preview: "nested", at: 7, onCurrentBranch: false },
		];
		expect(flattenSessionTree(tree).map(row => [row.node.entryId, row.depth])).toEqual([
			["root", 0],
			["reply", 0],
			["main", 1],
			["alt", 1],
			["child", 1],
		]);
		const summary: SessionSummary = { id: "session", cwd: "/work", sessionFile: "/work/session.jsonl", state: "idle", createdAt: 1, lastActivityAt: 1, agentCount: 0, goalActive: false, awaitingAnswer: false };
		const request: CreateSessionRequest | null = forkRequestForEntry(summary, "child");
		expect(request).toEqual({ cwd: "/work", forkFrom: { sessionFile: "/work/session.jsonl", entryId: "child" } });
		expect(forkRequestForEntry({ ...summary, sessionFile: undefined }, "child")).toBeNull();
	});
});

describe("mock-backed session operations", () => {
	let daemon: MockDaemon;
	let api: DeckApi;
	let sessionId: string;

	beforeAll(async () => {
		daemon = await startMockDaemon({ features: ["peers"] });
		api = new DeckApi({ base: `${daemon.url}/api` });
		sessionId = daemon.liveIds()[0]!;
	});

	afterAll(async () => {
		await daemon.stop();
	});


	it("serves the keybindings and peer metadata used by the shell", async () => {
		const bindings = await api.keybindings();
		expect(bindings.bindings["app.interrupt"]).toEqual(["escape"]);
		expect(bindings.bindings["app.history.search"]).toEqual(["ctrl+r"]);
		expect(bindings.bindings["app.goal.pause"]).toBeUndefined();
		expect(await api.peers()).toEqual({
			self: { id: "local", name: "Local" },
			peers: [{ id: "example-host", name: "Example host", reachable: false, reason: "mock peer" }],
		});
	});

	it("lists current-branch prompts and removes the rewound exchange", async () => {
		const pointsResult = await api.sessionOpV3(sessionId, { op: "rewind-points" });
		if (!("points" in pointsResult)) throw new Error("mock did not return rewind points");
		expect(pointsResult.points.find(point => point.entryId === "e01")).toMatchObject({
			preview: "the guest socket sometimes stays dead after a relay redeploy — can you audit the reconnect path in relay-client.ts?",
		});

		const rewindResult = await api.sessionOpV3(sessionId, { op: "rewind", entryId: "e01" });
		expect(rewindResult).toEqual({
			ok: true,
			text: "the guest socket sometimes stays dead after a relay redeploy — can you audit the reconnect path in relay-client.ts?",
		});
		expect(await api.sessionOpV3(sessionId, { op: "rewind-points" })).toEqual({ ok: true, points: [] });

		let failure: unknown;
		try {
			await api.sessionOpV3(sessionId, { op: "rewind", entryId: "e01" });
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toBeInstanceOf(DeckApiError);
		expect(failure).toMatchObject({ kind: "bad-request", status: 400 });
	});
	it("accepts every session operation and updates goal state visible in the session list", async () => {
		await api.sessionOp(sessionId, { op: "plan-mode", enabled: true });
		for (const mode of ["always-ask", "always-ask-cached", "write", "yolo"] as const) {
			await api.sessionOp(sessionId, { op: "approval-mode", mode });
		}
		await api.sessionOp(sessionId, { op: "goal", action: "set", objective: "Ship the release", tokenBudget: 900 });
		expect((await api.listSessions()).live.find(session => session.id === sessionId)).toMatchObject({ goalActive: true, goalObjective: "Ship the release" });
		await api.sessionOp(sessionId, { op: "goal", action: "budget", tokenBudget: 1_200 });
		await api.sessionOp(sessionId, { op: "goal", action: "pause" });
		expect((await api.listSessions()).live.find(session => session.id === sessionId)?.goalActive).toBe(false);
		await api.sessionOp(sessionId, { op: "goal", action: "resume" });
		expect((await api.listSessions()).live.find(session => session.id === sessionId)?.goalActive).toBe(true);
		await api.sessionOp(sessionId, { op: "todos", phases: [{ name: "Ship", tasks: [{ content: "Review", status: "blocked" }] }] });
		await api.sessionOp(sessionId, { op: "compact", mode: "soft" });
		await api.sessionOp(sessionId, { op: "compact", mode: "remote" });
		await api.sessionOp(sessionId, { op: "compact", mode: "snap" });
		await api.sessionOp(sessionId, { op: "dequeue", index: 0 });
		await api.sessionOp(sessionId, { op: "goal", action: "drop" });
		expect((await api.listSessions()).live.find(session => session.id === sessionId)?.goalActive).toBe(false);
	});

	it("returns context, token/cost and branch data in the shapes consumed by the status panels", async () => {
		const context = await api.sessionOp(sessionId, { op: "context" });
		const stats = await api.sessionOp(sessionId, { op: "stats" });
		const tree = await api.sessionOp(sessionId, { op: "tree" });
		expect(context).toMatchObject({ context: { total: 49_600, window: 128_000 } });
		expect("context" in context ? context.context.parts[0] : undefined).toEqual({ label: "System", tokens: 12_400 });
		expect(stats).toMatchObject({ stats: { tokens: { input: 41_200 }, cost: 0.1842, byAgent: [{ agentId: "Main" }] } });
		expect(tree).toMatchObject({ tree: [{ entryId: "mock-root", parentId: null }, { entryId: "mock-current", parentId: "mock-root" }, { entryId: "mock-branch", onCurrentBranch: false }] });
	});

	it("maps unknown sessions and malformed operation bodies to API errors", async () => {
		let failure: unknown;
		try {
			await api.sessionOp("missing-session", { op: "context" });
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toBeInstanceOf(DeckApiError);
		expect(failure).toMatchObject({ kind: "not-found", status: 404 });
		const response = await fetch(`${daemon.url}/api/sessions/${encodeURIComponent(sessionId)}/ops`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ op: "compact", mode: "unsafe" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "bad-request" });
	});

	it("generates reports and round-trips, then clears the usage journal", async () => {
		expect(await api.report()).toBeNull();
		await api.recordJournal([{ at: 1, feature: "0.7.report", action: "generate", outcome: "ok", screen: "settings" }]);
		await api.recordFeedback({ at: 2, screen: "settings", feature: "0.7.report", text: "Improve the report view" });
		expect(await api.readJournal()).toMatchObject({ events: [{ feature: "0.7.report" }], feedback: [{ text: "Improve the report view" }] });
		await api.requestReport();
		expect(await api.report()).toMatchObject({ markdown: expect.stringContaining("mock usage journal"), path: "mock/state/report.md" });
		await api.clearJournal();
		expect(await api.readJournal()).toEqual({ events: [], feedback: [] });
	});
});
