import { describe, expect, it } from "bun:test";
import type { DraftPlan, DraftRun } from "@omp-console/protocol";
import {
	autoLayout,
	connectError,
	DRAFT_NODE_WIDTH,
	type DraftState,
	draftReducer,
	draftToTaskCalls,
	EMPTY_DRAFT,
	findCycles,
	fromDraftPlan,
	parseDraft,
	pickRun,
	runNodeElapsedMs,
	runStateView,
	runSummary,
	serializeDraft,
	toDraftPlan,
	validateDraft,
} from "../src/lib/draft";

function node(id: string, extra: Partial<DraftPlan["nodes"][number]> = {}): DraftPlan["nodes"][number] {
	return { id, title: `Task ${id}`, instruction: `do ${id}`, profile: "task", ...extra };
}

function plan(nodes: DraftPlan["nodes"]): DraftPlan {
	return { name: "p", nodes };
}

function stateOf(p: DraftPlan): DraftState {
	return fromDraftPlan(p);
}

describe("draft validation", () => {
	it("names the whole cycle in run order, by title", () => {
		const issues = validateDraft(
			plan([
				node("n1", { title: "Build", dependsOn: ["n3"] }),
				node("n2", { title: "Test", dependsOn: ["n1"] }),
				node("n3", { title: "Ship", dependsOn: ["n2"] }),
			]),
		);
		const cycle = issues.find(issue => issue.kind === "cycle");
		expect(cycle?.message).toBe('Dependency cycle: "Test" → "Ship" → "Build" → "Test"');
		expect(cycle?.nodeIds.sort()).toEqual(["n1", "n2", "n3"]);
		expect(issues.filter(issue => issue.kind === "cycle")).toHaveLength(1);
	});

	it("finds a self-loop and two separate cycles", () => {
		expect(findCycles([node("a", { dependsOn: ["a"] })])).toEqual([["a", "a"]]);
		const two = findCycles([
			node("a", { dependsOn: ["b"] }),
			node("b", { dependsOn: ["a"] }),
			node("c", { dependsOn: ["d"] }),
			node("d", { dependsOn: ["c"] }),
		]);
		expect(two).toHaveLength(2);
	});

	it("accepts a diamond: shared dependencies are not cycles", () => {
		const issues = validateDraft(
			plan([node("a"), node("b", { dependsOn: ["a"] }), node("c", { dependsOn: ["a"] }), node("d", { dependsOn: ["b", "c"] })]),
			["task"],
		);
		expect(issues).toEqual([]);
	});

	it("asks for a profile, and only objects to an unknown one when the catalog is known", () => {
		const draft = plan([node("a", { profile: "" }), node("b", { profile: "ghost" })]);
		expect(validateDraft(draft).map(issue => issue.kind)).toEqual(["missing-profile"]);
		const known = validateDraft(draft, ["task", "plan"]);
		expect(known.map(issue => `${issue.kind}:${issue.nodeIds[0]}`)).toEqual(["missing-profile:a", "unknown-profile:b"]);
		expect(known[0]!.message).toContain("pick which agent runs it");
	});

	it("reports empty drafts, blank fields, unknown dependencies and duplicate ids", () => {
		expect(validateDraft(plan([]))[0]).toMatchObject({ kind: "empty" });
		const kinds = validateDraft(plan([node("a", { title: " ", instruction: "" }), node("b", { dependsOn: ["zzz"] }), node("b")])).map(
			issue => issue.kind,
		);
		expect(kinds).toEqual(expect.arrayContaining(["empty-title", "empty-instruction", "unknown-dependency", "duplicate-id"]));
	});
});

describe("drawing edges", () => {
	const chain = stateOf(plan([node("a"), node("b", { dependsOn: ["a"] }), node("c", { dependsOn: ["b"] })]));

	it("refuses self, duplicate, cycle-closing and dangling edges, with the reason", () => {
		expect(connectError(chain, "a", "a")).toBe("self");
		expect(connectError(chain, "a", "b")).toBe("duplicate");
		expect(connectError(chain, "c", "a")).toBe("cycle"); // c waits for a already, through b
		expect(connectError(chain, "a", "c")).toBeNull(); // redundant but harmless
		expect(connectError(chain, "a", "nope")).toBe("unknown");
	});

	it("leaves the draft unchanged when the reducer is asked for a cycle", () => {
		expect(draftReducer(chain, { type: "connect", from: "c", to: "a" })).toBe(chain);
		const next = draftReducer(chain, { type: "connect", from: "a", to: "c" });
		expect(next.nodes.find(n => n.id === "c")!.dependsOn).toEqual(["b", "a"]);
	});

	it("drops every edge of a deleted task and never hands its id out again", () => {
		const removed = draftReducer(chain, { type: "remove", id: "b" });
		expect(removed.nodes.map(n => n.id)).toEqual(["a", "c"]);
		expect(removed.nodes.find(n => n.id === "c")!.dependsOn).toEqual([]);
		const withNew = draftReducer(draftReducer(EMPTY_DRAFT, { type: "add" }), { type: "add" });
		const [first, second] = withNew.nodes;
		const afterDelete = draftReducer(draftReducer(withNew, { type: "remove", id: second!.id }), { type: "add" });
		expect(afterDelete.nodes.map(n => n.id)).toEqual([first!.id, "n3"]);
	});

	it("puts new tasks on free spots", () => {
		let state = EMPTY_DRAFT;
		for (let i = 0; i < 6; i++) state = draftReducer(state, { type: "add" });
		const spots = new Set(state.nodes.map(n => `${n.x},${n.y}`));
		expect(spots.size).toBe(6);
	});
});

describe("draft <-> DraftPlan", () => {
	const source: DraftPlan = {
		name: "Reconnect fix",
		nodes: [
			node("n1", { title: "Plan", profile: "plan" }),
			node("n2", { title: "Probe", files: ["src/a.ts", "docs/b c.md"], dependsOn: ["n1"], isolated: true }),
			node("n3", { title: "Docs", dependsOn: ["n1"] }),
			node("n4", { title: "Review", profile: "reviewer", dependsOn: ["n2", "n3"] }),
		],
	};

	it("round-trips through the editor state and back to the same wire plan", () => {
		expect(toDraftPlan(fromDraftPlan(source))).toEqual(source);
	});

	it("sends optional fields only when they carry something", () => {
		const state = fromDraftPlan(plan([node("n1", { files: [], isolated: false, dependsOn: [] })]));
		state.nodes[0]!.files = ["  ", ""];
		expect(toDraftPlan(state).nodes[0]).toEqual({ id: "n1", title: "Task n1", instruction: "do n1", profile: "task" });
	});

	it("lays a loaded plan out left to right by dependency depth, rows within a layer", () => {
		const { nodes } = fromDraftPlan(source);
		const at = (id: string) => nodes.find(n => n.id === id)!;
		expect(at("n1").x).toBeLessThan(at("n2").x);
		expect(at("n2").x).toBe(at("n3").x);
		expect(at("n2").y).not.toBe(at("n3").y);
		expect(at("n4").x).toBeGreaterThan(at("n2").x);
		expect(at("n2").x - at("n1").x).toBeGreaterThan(DRAFT_NODE_WIDTH);
		// Re-laying out after a manual move puts it back.
		const moved = draftReducer({ ...fromDraftPlan(source) }, { type: "move", id: "n3", x: 999, y: 999 });
		expect(autoLayout(moved.nodes).find(n => n.id === "n3")!.x).toBe(at("n3").x);
	});

	it("keeps counting ids after the highest loaded one", () => {
		const next = draftReducer(fromDraftPlan(source), { type: "add" });
		expect(next.nodes.at(-1)!.id).toBe("n5");
	});

	it("survives storage: serialize then parse gives the same draft, garbage gives null", () => {
		const state = fromDraftPlan(source);
		const back = parseDraft(serializeDraft(state))!;
		expect(toDraftPlan(back)).toEqual(toDraftPlan(state));
		expect(back.nodes.map(n => [n.x, n.y])).toEqual(state.nodes.map(n => [n.x, n.y]));
		expect(back.nextId).toBe(state.nextId);
		expect(parseDraft(null)).toBeNull();
		expect(parseDraft("not json")).toBeNull();
		expect(parseDraft(JSON.stringify({ v: 2, nodes: [] }))).toBeNull();
	});

	it("repairs a stored draft: duplicate ids dropped, dangling and self edges removed, id counter above existing", () => {
		const raw = JSON.stringify({
			v: 1,
			name: "x",
			nextId: 1,
			nodes: [
				{ id: "n7", title: "a", instruction: "", profile: "", dependsOn: ["n7", "ghost", "n8"], x: 1, y: 2 },
				{ id: "n8", title: "b", instruction: "", profile: "", x: "bad", y: 0 },
				{ id: "n8", title: "dup" },
			],
		});
		const parsed = parseDraft(raw)!;
		expect(parsed.nodes.map(n => n.id)).toEqual(["n7", "n8"]);
		expect(parsed.nodes[0]!.dependsOn).toEqual(["n8"]);
		expect(parsed.nodes[1]!.x).toBe(0);
		expect(parsed.nextId).toBe(9);
	});
});

describe("the omp equivalent", () => {
	it("lists one task call per node in a valid start order, files as @mentions", () => {
		const calls = draftToTaskCalls(
			plan([node("b", { dependsOn: ["a"], files: ["x y.ts", "z.ts"], isolated: true }), node("a", { profile: "plan" })]),
		);
		expect(calls.map(call => call.name)).toEqual(["Task a", "Task b"]);
		expect(calls[1]).toMatchObject({ agent: "task", isolated: true, task: 'do b\n\n@"x y.ts" @z.ts' });
		expect(calls[0]).toEqual({ name: "Task a", agent: "plan", task: "do a" });
	});

	it("leaves out nodes that can never start (a cycle) instead of looping", () => {
		const calls = draftToTaskCalls(plan([node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] }), node("c")]));
		expect(calls.map(call => call.name)).toEqual(["Task c"]);
	});
});

describe("run state mapping", () => {
	const run = (state: DraftRun["state"], startedAt: number, nodeStates: DraftRun["nodes"][number]["state"][]): DraftRun => ({
		runId: `r${startedAt}`,
		sessionId: "s",
		plan: plan([]),
		state,
		startedAt,
		nodes: nodeStates.map((s, i) => ({ id: `n${i}`, state: s })),
	});

	it("marks waiting and running as live and the rest as final", () => {
		expect(["waiting", "running", "done", "failed", "skipped", "cancelled"].map(s => runStateView(s as never).terminal)).toEqual([
			false,
			false,
			true,
			true,
			true,
			true,
		]);
		expect(runStateView("failed")).toMatchObject({ label: "failed", tone: "failed" });
	});

	it("summarises a run with only the counts that are not zero", () => {
		expect(runSummary(run("running", 1, ["done", "running", "running", "waiting", "waiting"]))).toBe("1 of 5 done · 2 running · 2 waiting");
		expect(runSummary(run("failed", 1, ["done", "failed", "skipped"]))).toBe("1 of 3 done · 1 failed · 1 skipped");
		expect(runSummary(run("done", 1, ["done", "done"]))).toBe("2 of 2 done");
	});

	it("shows an active run before a newer finished one, and the newest otherwise", () => {
		const old = run("running", 100, ["running"]);
		const newer = run("done", 200, ["done"]);
		expect(pickRun([old, newer])?.runId).toBe(old.runId);
		expect(pickRun([run("done", 100, ["done"]), newer])?.runId).toBe(newer.runId);
		expect(pickRun([])).toBeUndefined();
	});

	it("times a node from its start to its end, or to now while it runs, and not before it starts", () => {
		expect(runNodeElapsedMs({ id: "a", state: "running", startedAt: 1000 }, 4500)).toBe(3500);
		expect(runNodeElapsedMs({ id: "a", state: "done", startedAt: 1000, endedAt: 2000 }, 9000)).toBe(1000);
		expect(runNodeElapsedMs({ id: "a", state: "waiting" }, 9000)).toBeUndefined();
	});
});
