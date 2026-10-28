import { describe, expect, it } from "bun:test";
import type { JournalEvent } from "@omp-console/protocol";
import { DeckApi, type FetchLike } from "../src/lib/api";
import {
	emptyRow,
	normalizePath,
	openAgent,
	openSpawnPanel,
	parseOpenAgentEvent,
	parseSpawnPanelEvent,
	type RowStatus,
	runSpawn,
	type SpawnRow,
	taskEquivalent,
	toSpawnRequest,
	validateRows,
	withPath,
	OPEN_PANEL_EVENT,
} from "../src/lib/spawn";

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, error: string): Response =>
	json({ error, code: status === 409 ? "conflict" : status === 400 ? "bad-request" : "internal" }, status);

function row(patch: Partial<SpawnRow>): SpawnRow {
	return { ...emptyRow("task"), task: "do it", ...patch };
}

const KNOWN = new Set(["task", "reviewer"]);

describe("validateRows", () => {
	it("flags each missing or wrong field on the row it belongs to", () => {
		const rows = [row({ profile: "" }), row({ task: "   " }), row({ profile: "nope" }), row({})];
		const problems = validateRows(rows, KNOWN);
		expect(problems.get(rows[0]!.key)).toEqual({ profile: "Choose an agent profile." });
		expect(problems.get(rows[1]!.key)).toEqual({ task: "Describe the task." });
		expect(problems.get(rows[2]!.key)).toEqual({ profile: 'Agent profile "nope" is not available in this session.' });
		expect(problems.has(rows[3]!.key)).toBe(false);
	});

	it("rejects a name already used by an earlier row of the batch, but not the same name twice as blank", () => {
		const rows = [row({ name: "Scout" }), row({ name: " Scout " }), row({ name: "" }), row({ name: "" })];
		const problems = validateRows(rows, KNOWN);
		expect(problems.get(rows[1]!.key)?.name).toMatch(/already uses/);
		expect(problems.has(rows[0]!.key)).toBe(false);
		expect(problems.has(rows[2]!.key)).toBe(false);
		expect(problems.has(rows[3]!.key)).toBe(false);
	});
});

describe("file paths", () => {
	it("normalizes @mentions and quotes, and rejects blanks and line breaks", () => {
		expect(normalizePath('  @"my dir/a b.ts" ')).toEqual({ ok: true, path: "my dir/a b.ts" });
		expect(normalizePath("@src/x.ts")).toEqual({ ok: true, path: "src/x.ts" });
		expect(normalizePath("   ").ok).toBe(false);
		expect(normalizePath("a\nb").ok).toBe(false);
	});

	it("does not list the same path twice", () => {
		const once = withPath([], "@src/x.ts");
		expect(once).toEqual({ files: ["src/x.ts"], error: null });
		const twice = withPath(once.files, "src/x.ts");
		expect(twice.files).toEqual(["src/x.ts"]);
		expect(twice.error).toMatch(/already listed/);
	});
});

describe("request body and omp equivalent", () => {
	it("sends only what the person filled in, with the task trimmed", () => {
		expect(toSpawnRequest(row({ task: "  look  " }))).toEqual({ profile: "task", task: "look" });
		expect(toSpawnRequest(row({ name: " Probe ", isolated: true, files: ["a.ts", "my dir/b.ts"] }))).toEqual({
			profile: "task",
			task: "do it",
			name: "Probe",
			isolated: true,
			files: ["a.ts", "my dir/b.ts"],
		});
	});

	it("shows one row as a single task call and several as one batch call, files as @mentions", () => {
		const single = taskEquivalent([row({ profile: "reviewer", files: ["a.ts", "my dir/b.ts"], isolated: true })]);
		expect(single.startsWith("task(")).toBe(true);
		const singleJson = JSON.parse(single.slice("task(".length, -1)) as Record<string, unknown>;
		expect(singleJson).toMatchObject({ agent: "reviewer", isolated: true });
		expect(singleJson.task).toBe('do it\n\n@a.ts @"my dir/b.ts"');

		const batch = taskEquivalent([row({ profile: "task" }), row({ profile: "reviewer", name: "R" })]);
		const batchJson = JSON.parse(batch.slice("task(".length, -1)) as { tasks: Array<Record<string, unknown>> };
		expect(batchJson.tasks.map(t => t.agent)).toEqual(["task", "reviewer"]);
		expect(batchJson.tasks[1]?.name).toBe("R");
	});
});

interface Sent {
	body: { profile: string; task: string };
}

describe("runSpawn", () => {
	function setup(responders: Array<(sent: Sent) => Response | Promise<Response>>) {
		const sent: Sent[] = [];
		const inFlight: number[] = [];
		let active = 0;
		const fetch: FetchLike = async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as Sent["body"];
			sent.push({ body });
			active++;
			inFlight.push(active);
			try {
				const next = responders.shift();
				if (!next) throw new Error("unexpected request");
				return await next({ body });
			} finally {
				active--;
			}
		};
		const statuses: Array<[string, RowStatus["state"]]> = [];
		const events: Array<Omit<JournalEvent, "at">> = [];
		const deps = {
			api: new DeckApi({ fetch, base: "/api" }),
			sessionId: "s1",
			record: (event: Omit<JournalEvent, "at">) => events.push(event),
			onStatus: (key: string, status: RowStatus) => statuses.push([key, status.state]),
		};
		return { deps, sent, inFlight, statuses, events };
	}

	it("starts the rows one after another in the order listed", async () => {
		const gate = Promise.withResolvers<Response>();
		const { deps, sent, inFlight } = setup([() => gate.promise, () => json({ agentId: "B" }, 202)]);
		const rows = [row({ task: "first" }), row({ task: "second" })];
		const run = runSpawn(deps, rows);
		await Bun.sleep(5);
		expect(sent.map(s => s.body.task)).toEqual(["first"]);
		gate.resolve(json({ agentId: "A" }, 202));
		const result = await run;
		expect(sent.map(s => s.body.task)).toEqual(["first", "second"]);
		expect(Math.max(...inFlight)).toBe(1);
		expect(result).toEqual({ agentIds: ["A", "B"], failed: 0 });
	});

	it("keeps going after a refused row and reports it; a retry starts only the failed row", async () => {
		const first = setup([
			() => json({ agentId: "A" }, 202),
			() => apiError(409, "spawn policy: max depth reached"),
			() => json({ agentId: "C" }, 202),
		]);
		const rows = [row({ task: "one" }), row({ task: "two" }), row({ task: "three" })];
		const result = await runSpawn(first.deps, rows);
		expect(result).toEqual({ agentIds: ["A", "C"], failed: 1 });
		expect(first.statuses.filter(([, state]) => state === "error").map(([key]) => key)).toEqual([rows[1]!.key]);

		// What the dialog kept from the first run.
		const previous = new Map<string, RowStatus>([
			[rows[0]!.key, { state: "done", agentId: "A" }],
			[rows[1]!.key, { state: "error", message: "refused" }],
			[rows[2]!.key, { state: "done", agentId: "C" }],
		]);
		const retry = setup([() => json({ agentId: "B" }, 202)]);
		const second = await runSpawn(retry.deps, rows, previous);
		expect(retry.sent.map(s => s.body.task)).toEqual(["two"]);
		expect(second).toEqual({ agentIds: ["A", "B", "C"], failed: 0 });
	});

	it("journals each row and one batch summary, and never the task text", async () => {
		const { deps, events } = setup([() => json({ agentId: "A" }, 202), () => apiError(400, "unknown profile")]);
		const rows = [row({ task: "secret plan one" }), row({ profile: "reviewer", task: "secret plan two" })];
		await runSpawn(deps, rows);
		expect(events.map(e => [e.feature, e.outcome, e.detail])).toEqual([
			["2.5.spawn", "ok", "task"],
			["2.5.spawn", "error", "reviewer"],
			["2.6.batch-spawn", "error", "rows=2 started=1 failed=1"],
		]);
		expect(JSON.stringify(events)).not.toContain("secret");
	});

	it("maps a daemon refusal to the failed row's message", async () => {
		const { deps, statuses } = setup([() => apiError(409, "spawn policy: max depth reached")]);
		const messages: string[] = [];
		const withMessages = {
			...deps,
			onStatus: (key: string, status: RowStatus) => {
				deps.onStatus(key, status);
				if (status.state === "error") messages.push(status.message);
			},
		};
		await runSpawn(withMessages, [row({})]);
		expect(messages).toEqual(["omp's spawn policy refused it: spawn policy: max depth reached"]);
		expect(statuses.map(([, s]) => s)).toEqual(["spawning", "error"]);
	});
});

describe("window events", () => {
	it("reports whether a dialog took the request, so Settings can say when no session is open", () => {
		const target = new EventTarget();
		expect(openSpawnPanel({ profile: "reviewer" }, target)).toBe(false);
		let seen: unknown = null;
		target.addEventListener(OPEN_PANEL_EVENT, event => {
			seen = parseSpawnPanelEvent(event);
			event.preventDefault();
		});
		expect(openSpawnPanel({ profile: "reviewer", task: "t", files: ["a.ts"] }, target)).toBe(true);
		expect(seen).toEqual({ panel: "spawn", profile: "reviewer", task: "t", files: ["a.ts"] });
	});

	it("ignores other panels and malformed details", () => {
		expect(parseSpawnPanelEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: { panel: "catalog" } }))).toBeNull();
		expect(parseSpawnPanelEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: "spawn" }))).toBeNull();
		expect(parseSpawnPanelEvent(new Event(OPEN_PANEL_EVENT))).toBeNull();
		expect(parseSpawnPanelEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: { panel: "spawn", profile: 5, files: ["a", 3] } }))).toEqual({
			panel: "spawn",
			files: ["a"],
		});
	});

	it("carries the agent id of a spawned agent to the drawer", () => {
		const target = new EventTarget();
		const ids: Array<string | null> = [];
		target.addEventListener("omp-console:open-agent", event => ids.push(parseOpenAgentEvent(event)));
		openAgent("RelayProbe", target);
		target.dispatchEvent(new CustomEvent("omp-console:open-agent", { detail: {} }));
		expect(ids).toEqual(["RelayProbe", null]);
	});
});
