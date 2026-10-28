/**
 * Mock of the graph features' daemon side for `mock-daemon.ts` (B8): the capability catalog's profile list, draft runs
 * (`/sessions/:id/plans`) and plan templates (`/plan-templates`), plus a `graph` session whose transcript carries a
 * todo board and agent-to-agent messages, so the plan graph and the message edges have something to draw.
 *
 * Draft runs are simulated from the clock, not from timers: a node's state is a pure function of the run's start
 * time, its dependencies and a per-node duration, so a screenshot or test sees the same picture whenever it asks.
 * An instruction containing `[fail]` makes its node fail; its dependents are then skipped.
 */
import type {
	ApiError,
	CatalogResponse,
	DraftNodeState,
	DraftPlan,
	DraftRun,
	DraftRunNode,
	FeedbackEntry,
	JournalEvent,
	JournalResponse,
	ListDraftRunsResponse,
	ListPlanTemplatesResponse,
} from "@omp-console/protocol";
import type { CustomMessageEntry, MessageEntry, SessionEntry } from "@oh-my-pi/pi-wire";
import { validateDraft } from "../src/lib/draft";
import { fixtureEntries } from "./fixture";

export const GRAPH_SESSION_ID = "graph";

const MIN = 60_000;
const DEFAULT_NODE_MS = 4_000;
const SEEDED_RUN_ID = "run-seeded";

const PROFILES: CatalogResponse["profiles"] = [
	{ name: "task", source: "bundled", description: "General implementation worker", definitionModels: ["@task"], tools: ["read", "edit", "bash"] },
	{ name: "plan", source: "bundled", description: "Plans a change before any edit", definitionModels: ["@plan"], tools: ["read", "grep"] },
	{ name: "explore", source: "bundled", description: "Read-only codebase exploration", definitionModels: ["@explore"], tools: ["read", "grep", "glob"] },
	{ name: "reviewer", source: "bundled", description: "Reviews a finished change and runs its tests", definitionModels: ["@judge"], tools: ["read", "bash"] },
	{ name: "designer", source: "user", description: "UI and layout work", definitionModels: [] },
];

const SEEDED_TEMPLATE: DraftPlan = {
	name: "Review pipeline",
	nodes: [
		{ id: "n1", title: "Implement", instruction: "Implement the change described in the task.", profile: "task" },
		{ id: "n2", title: "Review", instruction: "Review the diff and run the tests.", profile: "reviewer", dependsOn: ["n1"] },
		{ id: "n3", title: "Docs", instruction: "Update the docs for the change.", profile: "task", dependsOn: ["n1"] },
	],
};

// ---- the `graph` session's transcript ------------------------------------------------------------------------------

function iso(at: number): string {
	return new Date(at).toISOString();
}

/** A todo board whose in-progress tasks read like what RelayProbe and DocSweep were given, plus IRC traffic. */
export function graphEntries(now: number): SessionEntry[] {
	let parent: string | null = fixtureEntries[fixtureEntries.length - 1]?.id ?? null;
	let seq = 0;
	const out: SessionEntry[] = [];
	const push = (entry: (Omit<MessageEntry, "id" | "parentId" | "timestamp"> | Omit<CustomMessageEntry, "id" | "parentId" | "timestamp">) & { at: number }): void => {
		const id = `gx${++seq}`;
		const { at, ...rest } = entry;
		out.push({ ...rest, id, parentId: parent, timestamp: iso(at) } as SessionEntry);
		parent = id;
	};
	const result = (at: number, toolName: string, text: string, details: Record<string, unknown>): void =>
		push({
			at,
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: `call-gx${seq + 1}`,
				toolName,
				content: [{ type: "text", text }],
				details,
				isError: false,
				timestamp: at,
			},
		});
	const custom = (at: number, customType: string, content: string, details: Record<string, unknown>): void =>
		push({ at, type: "custom_message", customType, content, details, display: true });
	const send = (at: number, to: string, receipts: Array<{ to: string; outcome: string }>): void =>
		result(at, "write", `Delivered to ${to}.`, { message: { op: "send", from: "Main", to, receipts } });

	result(now - 25 * MIN, "todo", "Todo updated.", {
		phases: [
			{
				name: "Investigate",
				tasks: [
					{ content: "Plan the reconnect fix", status: "completed" },
					{ content: "Probe relay reconnect behaviour", status: "in_progress" },
				],
			},
			{
				name: "Fix",
				tasks: [
					{ content: "Sweep collab docs for close code 1006", status: "in_progress" },
					{ content: "Treat close code 1001 as transient", status: "pending" },
					{ content: "Cap pending sends while reconnecting", status: "pending" },
					{ content: "Drop the legacy fatal-code table", status: "abandoned" },
				],
			},
			{
				name: "Verify",
				tasks: [
					{ content: "Add a reconnect regression test", status: "pending" },
					{ content: "Run the collab suite against a restarted relay", status: "pending" },
				],
			},
		],
	});
	send(now - 24 * MIN, "Planner", [{ to: "Planner", outcome: "revived" }]);
	send(now - 14 * MIN, "RelayProbe", [{ to: "RelayProbe", outcome: "woken" }]);
	send(now - 8 * MIN, "RelayProbe", [{ to: "RelayProbe", outcome: "injected" }]);
	custom(now - 7 * MIN, "irc:incoming", "[i1] RelayProbe: close code 1001 reproduced", {
		id: "i1",
		from: "RelayProbe",
		message: "close code 1001 reproduced on redeploy",
	});
	custom(now - 6 * MIN, "irc:incoming", "[i2] RelayProbe (reply to m1): yes, 3 retries", {
		id: "i2",
		from: "RelayProbe",
		message: "yes, three retries before it sticks",
		replyTo: "m1",
	});
	custom(now - 5 * MIN, "irc:incoming", "[i3] DocSweep: 4 docs mention 1006", { id: "i3", from: "DocSweep", message: "4 docs still mention 1006" });
	custom(now - 5 * MIN + 20_000, "irc:relay", "[IRC RelayProbe -> DocSweep]", { from: "RelayProbe", to: "DocSweep", body: "which docs list the fatal codes?" });
	custom(now - 4 * MIN, "irc:relay", "[IRC DocSweep -> RelayProbe]", { from: "DocSweep", to: "RelayProbe", body: "collab.md and collab-protocol.md" });
	custom(now - 3 * MIN, "irc:relay", "[IRC RelayProbe -> DocSweep]", { from: "RelayProbe", to: "DocSweep", body: "thanks, add 1001 to the transient list" });
	custom(now - 2 * MIN, "irc:relay", "[IRC RelayProbe -> DocSweep]", { from: "RelayProbe", to: "DocSweep", body: "also check docs/relay.md" });
	send(now - 90_000, "all", [
		{ to: "RelayProbe", outcome: "injected" },
		{ to: "DocSweep", outcome: "injected" },
	]);
	return out;
}

// ---- draft runs ----------------------------------------------------------------------------------------------------

interface MockRun {
	runId: string;
	sessionId: string;
	plan: DraftPlan;
	startedAt: number;
	cancelledAt?: number;
	durations: Map<string, number>;
	agents: Map<string, string>;
}

interface Timeline {
	state: DraftNodeState;
	startAt?: number;
	endAt?: number;
}

function simulate(run: MockRun, now: number): DraftRun {
	const byId = new Map(run.plan.nodes.map(node => [node.id, node]));
	const timeline = new Map<string, Timeline>();
	const resolve = (id: string, guard: Set<string>): Timeline => {
		const known = timeline.get(id);
		if (known) return known;
		const node = byId.get(id);
		if (!node || guard.has(id)) return { state: "skipped" };
		guard.add(id);
		let startAt = run.startedAt;
		let blocked = false;
		for (const dep of node.dependsOn ?? []) {
			const d = resolve(dep, guard);
			if (d.state === "failed" || d.state === "skipped" || d.state === "cancelled") blocked = true;
			startAt = Math.max(startAt, d.endAt ?? Number.POSITIVE_INFINITY);
		}
		guard.delete(id);
		let result: Timeline;
		const cut = run.cancelledAt;
		if (blocked) {
			result = { state: "skipped" };
		} else if (cut !== undefined && startAt > cut) {
			result = { state: "skipped" };
		} else {
			const endAt = startAt + (run.durations.get(id) ?? DEFAULT_NODE_MS);
			const fails = node.instruction.includes("[fail]");
			if (cut !== undefined && endAt > cut && cut <= now) result = { state: "cancelled", startAt, endAt: cut };
			else if (now >= endAt) result = { state: fails ? "failed" : "done", startAt, endAt };
			else if (now >= startAt) result = { state: "running", startAt };
			else result = { state: "waiting", startAt };
		}
		timeline.set(id, result);
		return result;
	};
	const nodes: DraftRunNode[] = run.plan.nodes.map(node => {
		const t = resolve(node.id, new Set());
		const out: DraftRunNode = { id: node.id, state: t.state };
		if (t.state !== "waiting" && t.startAt !== undefined && Number.isFinite(t.startAt)) {
			out.startedAt = t.startAt;
			out.agentId = run.agents.get(node.id) ?? `Draft-${run.runId}-${node.id}`;
		}
		if (t.endAt !== undefined && Number.isFinite(t.endAt) && t.state !== "running") out.endedAt = t.endAt;
		if (t.state === "done") out.summary = `${node.title}: finished.`;
		if (t.state === "failed") out.summary = `${node.title} failed:\nAssertionError: expected the socket to reconnect`;
		if (t.state === "skipped") out.summary = "Skipped: a dependency did not finish.";
		return out;
	});
	const states = nodes.map(node => node.state);
	const anyActive = states.some(state => state === "running" || state === "waiting");
	const state: DraftRun["state"] = anyActive
		? "running"
		: run.cancelledAt !== undefined
			? "cancelled"
			: states.includes("failed")
				? "failed"
				: "done";
	return { runId: run.runId, sessionId: run.sessionId, plan: run.plan, nodes, state, startedAt: run.startedAt };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

type StartSession = (
	cwd: string,
	title: string,
	model: string | undefined,
	sessionFile: string | undefined,
	simulated: { awaitingAnswer: boolean; goalActive: boolean },
	fixture: { id?: string; entries?: SessionEntry[]; agentTree?: boolean },
) => Promise<unknown>;

export interface GraphMock {
	/** Answers the graph routes under `/api` (path without the prefix); null for anything else. */
	handle(req: Request, route: string): Promise<Response | null>;
	/** Starts the `graph` session through the daemon's own session starter. */
	seed(startSession: StartSession): Promise<void>;
}

export function createGraphMock(): GraphMock {
	const runs = new Map<string, MockRun>();
	const templates = new Map<string, DraftPlan>([[SEEDED_TEMPLATE.name, SEEDED_TEMPLATE]]);
	let nextRun = 1;
	const journal: JournalResponse = { events: [], feedback: [] };

	const seedRun = (): void => {
		const plan: DraftPlan = {
			name: "Fix reconnect",
			nodes: [
				{ id: "n1", title: "Plan the fix", instruction: "Plan the reconnect fix.", profile: "plan" },
				{ id: "n2", title: "Probe relay reconnect", instruction: "Reproduce the dead socket.", profile: "task", dependsOn: ["n1"] },
				{ id: "n3", title: "Sweep collab docs", instruction: "Find docs that mention 1006.", profile: "explore", dependsOn: ["n1"] },
				{ id: "n4", title: "Regression test", instruction: "Add a reconnect test.", profile: "task", dependsOn: ["n2"], isolated: true },
				{ id: "n5", title: "Review", instruction: "Review the fix and run the suite.", profile: "reviewer", dependsOn: ["n3", "n4"] },
			],
		};
		runs.set(SEEDED_RUN_ID, {
			runId: SEEDED_RUN_ID,
			sessionId: GRAPH_SESSION_ID,
			plan,
			startedAt: Date.now() - 20_000,
			durations: new Map([
				["n1", 10_000],
				["n2", 30 * MIN],
				["n3", 30 * MIN],
				["n4", MIN],
				["n5", MIN],
			]),
			agents: new Map([
				["n1", "Planner"],
				["n2", "RelayProbe"],
				["n3", "DocSweep"],
			]),
		});
	};

	return {
		async seed(startSession) {
			seedRun();
			await startSession(
				"/Users/dev/relay",
				"Graph: plan and messages",
				"claude-opus-5-5",
				undefined,
				{ awaitingAnswer: false, goalActive: false },
				{ id: GRAPH_SESSION_ID, entries: [...fixtureEntries, ...graphEntries(Date.now())], agentTree: true },
			);
		},

		async handle(req, route) {
			const method = req.method;
			const session = /^\/sessions\/([^/]+)\/(catalog|plans)(?:\/([^/]+))?$/.exec(route);
			if (session) {
				const sessionId = decodeURIComponent(session[1]!);
				if (session[2] === "catalog" && method === "GET") {
					const catalog: CatalogResponse = {
						commands: [],
						tools: [],
						profiles: PROFILES,
						skills: [],
						roles: {},
						mcp: [],
						generatedAt: Date.now(),
					};
					return json(catalog);
				}
				if (session[2] !== "plans") return null;
				const runId = session[3];
				if (runId === undefined && method === "GET") {
					const body: ListDraftRunsResponse = {
						runs: [...runs.values()].filter(run => run.sessionId === sessionId).map(run => simulate(run, Date.now())),
					};
					return json(body);
				}
				if (runId === undefined && method === "POST") {
					const plan = (await req.json().catch(() => null)) as DraftPlan | null;
					if (!plan || !Array.isArray(plan.nodes)) return fail(400, "bad-request", "a draft plan is required");
					const refused = validateDraft(plan, PROFILES.map(profile => profile.name)).find(
						issue => issue.kind === "cycle" || issue.kind === "unknown-dependency" || issue.kind === "duplicate-id" || issue.kind === "unknown-profile" || issue.kind === "empty",
					);
					if (refused) return fail(400, "bad-request", refused.message);
					const run: MockRun = {
						runId: `run-${nextRun++}`,
						sessionId,
						plan,
						startedAt: Date.now(),
						durations: new Map(),
						agents: new Map(),
					};
					runs.set(run.runId, run);
					return json(simulate(run, Date.now()), 202);
				}
				const found = runId === undefined ? undefined : runs.get(decodeURIComponent(runId));
				if (!found || found.sessionId !== sessionId) return fail(404, "not-found", "no such run");
				if (method === "GET") return json(simulate(found, Date.now()));
				if (method === "DELETE") {
					found.cancelledAt ??= Date.now();
					return new Response(null, { status: 204 });
				}
				return null;
			}
			if (route === "/journal" && method === "POST") {
				const body = (await req.json().catch(() => null)) as { events?: JournalEvent[] } | null;
				if (!body || !Array.isArray(body.events)) return fail(400, "bad-request", "events are required");
				journal.events.push(...body.events);
				return new Response(null, { status: 204 });
			}
			if (route === "/journal" && method === "GET") return json(journal);
			if (route === "/journal" && method === "DELETE") {
				journal.events.length = 0;
				journal.feedback.length = 0;
				return new Response(null, { status: 204 });
			}
			if (route === "/feedback" && method === "POST") {
				journal.feedback.push((await req.json()) as FeedbackEntry);
				return new Response(null, { status: 204 });
			}
			if (route === "/plan-templates" && method === "GET") {
				const body: ListPlanTemplatesResponse = { templates: [...templates.values()] };
				return json(body);
			}
			const template = /^\/plan-templates\/([^/]+)$/.exec(route);
			if (template && method === "PUT") {
				const plan = (await req.json().catch(() => null)) as DraftPlan | null;
				if (!plan || typeof plan.name !== "string" || plan.name === "") return fail(400, "bad-request", "a named draft plan is required");
				const cycle = validateDraft(plan).find(issue => issue.kind === "cycle");
				if (cycle) return fail(400, "bad-request", cycle.message);
				templates.set(decodeURIComponent(template[1]!), plan);
				return new Response(null, { status: 204 });
			}
			return null;
		},
	};
}
