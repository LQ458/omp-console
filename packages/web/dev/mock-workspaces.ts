/**
 * Mock endpoints for workspaces, rules, quick-ask, the gate audit, project drift and the safe-move flow (grand-list
 * 6, 7, 9). Registered from `mock-daemon.ts` and active only with `--workspaces`, so other mock states keep their
 * existing look.
 *
 * Simulated, not real:
 * - Workspaces are a fixed fixture (one knowledge folder, four projects, one scratch dir); `liveSessions` is counted
 *   from the live mock sessions by working-directory prefix. A move adds its destination as a project.
 * - Rules live in memory; a shared file's diff is "all old lines removed, all new lines added" against the first content.
 * - Quick-ask starts a knowledge session whose transcript already holds a canned, cited answer.
 * - The gate is always `installed` in shadow mode with a fixed audit log.
 * - Drift: the knowledge session always has one suggestion until it is dismissed or moved.
 * - Moves: `confirm` accepts any non-empty token (the daemon's Keychain check is not simulated, only the 403 for a
 *   missing token); `undo` always succeeds unless the copy's slug is `edited` (then 409).
 */
import type {
	ApiError,
	DriftSuggestion,
	GateAuditEntry,
	GateStatusResponse,
	ListWorkspacesResponse,
	MoveConfirmRequest,
	MovePrepareRequest,
	MovePreview,
	MoveRecord,
	QuickAskRequest,
	QuickAskSource,
	QuickAskResponse,
	RuleFileResponse,
	RuleFileWrite,
	SessionSummary,
	StartWorkspaceSessionRequest,
	Workspace,
	WorkspaceColorRequest,
} from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { ModeSignals } from "../src/lib/mode-badges";
import { validateSlug } from "../src/lib/move";
import { validateRulePath, workspaceOf } from "../src/lib/workspaces";
import { fixtureModel } from "./fixture";

export const KNOWLEDGE_ROOT = "/Users/alice/Knowledge";
const PROJECTS_ROOT = "/Users/alice/Projects";

export interface WorkspacesMockContext {
	sessions(): SessionSummary[];
	startSession(cwd: string, title: string, entries?: readonly SessionEntry[]): Promise<SessionSummary>;
	quickAskSources: readonly QuickAskSource[];
}

export interface WorkspacesMock {
	/** Answers workspace, quick-ask, gate, drift and move routes; `undefined` for anything else. `route` has no `/api`. */
	handle(req: Request, route: string): Promise<Response | undefined>;
	/** Adds the plan/vibe/phone signals a real daemon would report. */
	decorate(summary: SessionSummary): SessionSummary;
	/** Starts the knowledge and scratch sessions the screenshots need. */
	seed(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

interface RuleFile {
	visibility: "private" | "shared";
	content: string;
	committed: string;
}

const RELAY_TESTING = "# Testing\n\n- Run `bun test` in packages/relay before pushing.\n- Never mock the relay socket; use the local relay fixture.\n";
const RELAY_STYLE = "# Style (private)\n\n- Prefer early returns.\n- No default exports.\n";
const RELAY_AGENTS = "# relay\n\nBackoff constants live in relay-client.ts. Keep fatal close codes in protocol.ts.\n";
const RELAY_ARCH = "# Architecture\n\nRooms are end-to-end encrypted; the relay never sees plaintext.\n";
const KNOWLEDGE_AGENTS = "# Knowledge base\n\nThe configured notes source is the source of truth; files in this repository are drafts.\n";
const KNOWLEDGE_ROLES = "# Roles\n\nplanner, reviewer, critic: judgment tier.\n";
const DOCS_AGENTS = "# docs\n\nOne sentence per line. Link, do not paste.\n";

function seedRules(): Map<string, Map<string, RuleFile>> {
	const file = (visibility: RuleFile["visibility"], content: string): RuleFile => ({ visibility, content, committed: content });
	return new Map([
		[
			"project:relay",
			new Map([
				[".omp/rules/testing.md", file("private", RELAY_TESTING)],
				[".omp/rules/style.md", file("private", RELAY_STYLE)],
				["AGENTS.md", file("shared", RELAY_AGENTS)],
				["docs/architecture.md", file("shared", RELAY_ARCH)],
			]),
		],
		[
			"knowledge",
			new Map([
				["AGENTS.md", file("shared", KNOWLEDGE_AGENTS)],
				["ROLES.md", file("shared", KNOWLEDGE_ROLES)],
			]),
		],
		["project:docs", new Map([["AGENTS.md", file("shared", DOCS_AGENTS)]])],
		["project:site", new Map()],
		["project:api", new Map()],
		["scratch:a1", new Map()],
	]);
}

const BASE_WORKSPACES: ReadonlyArray<Omit<Workspace, "rules" | "liveSessions" | "hueOverride">> = [
	{ id: "knowledge", kind: "knowledge", name: "Knowledge", root: KNOWLEDGE_ROOT, git: { branch: "main", dirty: false } },
	{ id: "project:relay", kind: "project", name: "relay", root: `${PROJECTS_ROOT}/relay`, git: { branch: "feat/backoff", dirty: true, ahead: 2 } },
	{ id: "project:docs", kind: "project", name: "docs", root: `${PROJECTS_ROOT}/docs`, git: { branch: "main", dirty: false, behind: 1 } },
	{ id: "project:site", kind: "project", name: "site", root: `${PROJECTS_ROOT}/site`, git: { branch: "main", dirty: false } },
	{ id: "project:api", kind: "project", name: "api", root: `${PROJECTS_ROOT}/api`, git: { branch: "rate-limit", dirty: true } },
	{ id: "scratch:a1", kind: "scratch", name: "scratch a1", root: "/tmp/omp-console-scratch/a1" },
];

const AGENT_TITLES = { relay: "Refactor relay backoff", docs: "Docs sweep", knowledge: "Knowledge: notes triage", scratch: "Scratch: regex check" };

/** Plan/vibe/phone signals per seeded session title, so every badge is visible in screenshots. */
const MODES: Record<string, ModeSignals> = {
	[AGENT_TITLES.relay]: { drivenBy: "phone" },
	[AGENT_TITLES.docs]: { planMode: true },
	[AGENT_TITLES.knowledge]: { planMode: true, vibe: true },
};

const NOW = Date.now();
const MIN = 60_000;

function audit(): GateAuditEntry[] {
	const e = (minAgo: number, verdict: GateAuditEntry["verdict"], kinds: string[], summary: string, target?: string): GateAuditEntry => ({
		at: NOW - minAgo * MIN,
		verdict,
		kinds,
		summary,
		target,
	});
	return [
		e(1, "would-ask", ["git push"], "git push origin feat/backoff", "example.com/org/relay"),
		e(4, "allow", ["read"], "read relay-client.ts"),
		e(9, "would-deny", ["delete"], "rm -rf dist node_modules", "/Users/alice/Projects/relay"),
		e(14, "would-ask", ["external-http-write"], "POST https://hooks.slack.test/T0/B1", "hooks.slack.test"),
		e(22, "allow", ["write"], "write docs/architecture.md"),
		e(31, "would-ask", ["email"], "send mail: weekly summary", "team@example.test"),
		e(47, "ask", ["publish"], "npm publish @example/relay", "registry.npmjs.test"),
		e(63, "would-deny", ["write-outside-workspace"], "write ~/.zshrc", "/Users/alice/.zshrc"),
		e(80, "allow", ["read"], "read notes/guide.md"),
		e(121, "deny", ["form-submit"], "submit form at careers.example.test", "careers.example.test"),
		e(180, "would-ask", ["git push"], "git push --force origin main", "example.com/org/docs"),
		e(240, "allow", ["write"], "write AGENTS.md"),
	];
}

const GATE_EVIDENCE =
	"Held-out set: 71% of unauthorized actions were stopped and 86% of benign ones ran unprompted; enforcement needs at most 2.25 prompts per message and the measured rate is 2.31, so shadow stays on.";

const ANSWER_TEXT = `The project deadline is **12 March**.

- Notes block \`doc-2026-01\` (Planning / Submission): "Submit by 12 March and include the signed form."
- \`notes/submission-checklist.md\` in the Knowledge repository repeats the date and lists the required documents.
- A past session ("Submission checklist review", 2026-01-14) moved the reminder to the calendar.

Nothing in the sources contradicts the date.`;

function answerEntries(question: string): SessionEntry[] {
	const at = Date.now();
	const iso = (t: number): string => new Date(t).toISOString();
	return [
		{
			id: "qa01",
			parentId: null,
			timestamp: iso(at - 4000),
			type: "message",
			message: { role: "user", content: question, timestamp: at - 4000 },
		},
		{
			id: "qa02",
			parentId: "qa01",
			timestamp: iso(at - 1000),
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: ANSWER_TEXT }],
				model: fixtureModel.id,
				usage: { input: 3_200, output: 180, cacheRead: 9_000, cacheWrite: 0, totalTokens: 12_380, cost: { total: 0.006 } },
				stopReason: "stop",
				timestamp: at - 1000,
			},
		},
	];
}

function driftFor(sourceRoot: string): DriftSuggestion {
	return {
		id: "drift-1",
		sessionId: "",
		sourceRoot,
		markers: ["package.json", ".git/", "src/ (14 code files)"],
		suggestedSlug: "notes-tool",
		files: 214,
		bytes: 1_843_200,
		excluded: [
			{ path: "node_modules", reason: "dependency-dir" },
			{ path: "dist", reason: "dependency-dir" },
			{ path: ".env", reason: "secret" },
		],
		agentReason: "I scaffolded a small CLI here to batch-rename notes. It has nothing to do with the knowledge base itself.",
	};
}

export function createWorkspacesMock(ctx: WorkspacesMockContext): WorkspacesMock {
	const rules = seedRules();
	const hues = new Map<string, number>();
	const extraWorkspaces: Workspace[] = [];
	const dismissed = new Set<string>();
	const previews = new Map<string, { preview: MovePreview; suggestionId: string; slug: string; sessionId: string }>();
	const moves: MoveRecord[] = [
		{ id: "mv-old-1", sourceSessionId: "old", sourceRoot: `${KNOWLEDGE_ROOT}/pdf-tool`, destination: `${PROJECTS_ROOT}/pdf-tool`, at: NOW - 5 * 86_400_000, state: "done" },
		{ id: "mv-old-2", sourceSessionId: "old", sourceRoot: `${KNOWLEDGE_ROOT}/tiny-site`, destination: `${PROJECTS_ROOT}/tiny-site`, at: NOW - 9 * 86_400_000, state: "undone" },
	];
	let moveCounter = 0;

	function workspaces(): Workspace[] {
		const live = ctx.sessions();
		const all: Workspace[] = [
			...BASE_WORKSPACES.map(base => ({ ...base, rules: [], liveSessions: 0 })),
			...extraWorkspaces,
		];
		for (const workspace of all) {
			workspace.rules = [...(rules.get(workspace.id) ?? new Map()).entries()].map(([path, file]) => ({ path, visibility: file.visibility }));
			const hue = hues.get(workspace.id);
			if (hue !== undefined) workspace.hueOverride = hue;
		}
		for (const session of live) {
			const owner = workspaceOf(all, session.cwd);
			if (owner) owner.liveSessions++;
		}
		return all;
	}

	function knowledgeSession(sessionId: string): SessionSummary | undefined {
		return ctx.sessions().find(s => s.id === sessionId && s.cwd.startsWith(KNOWLEDGE_ROOT));
	}

	function diffOf(file: RuleFile): string | undefined {
		if (file.visibility !== "shared" || file.content === file.committed) return undefined;
		const lines = (text: string): string[] => text.replace(/\n$/, "").split("\n");
		return [
			"--- a/file",
			"+++ b/file",
			`@@ -1,${lines(file.committed).length} +1,${lines(file.content).length} @@`,
			...lines(file.committed).map(l => `-${l}`),
			...lines(file.content).map(l => `+${l}`),
		].join("\n");
	}

	async function ruleRoutes(req: Request, route: string): Promise<Response | undefined> {
		const match = /^\/workspaces\/([^/]+)\/rules\/(.+)$/.exec(route);
		if (!match) return undefined;
		const workspaceId = decodeURIComponent(match[1]!);
		const path = decodeURIComponent(match[2]!);
		const files = rules.get(workspaceId);
		if (!files) return fail(404, "not-found", `no workspace ${workspaceId}`);
		const check = validateRulePath(path);
		if (!check.ok) return fail(400, "bad-request", check.message);
		if (req.method === "GET") {
			const file = files.get(path);
			if (!file) return fail(404, "not-found", `no rule file ${path}`);
			const body: RuleFileResponse = { path, visibility: file.visibility, content: file.content, diff: diffOf(file) };
			return json(body);
		}
		if (req.method === "PUT") {
			const body = (await req.json().catch(() => null)) as Partial<RuleFileWrite> | null;
			if (typeof body?.content !== "string" || (body.visibility !== "private" && body.visibility !== "shared")) {
				return fail(400, "bad-request", "visibility and content are required");
			}
			const existing = files.get(path);
			files.set(path, { visibility: body.visibility, content: body.content, committed: existing?.committed ?? body.content });
			return new Response(null, { status: 204 });
		}
		return undefined;
	}

	return {
		decorate(summary) {
			const modes = MODES[summary.title ?? ""];
			return modes === undefined ? summary : { ...summary, ...modes };
		},

		async seed() {
			await ctx.startSession(KNOWLEDGE_ROOT, AGENT_TITLES.knowledge);
			await ctx.startSession("/tmp/omp-console-scratch/a1", AGENT_TITLES.scratch);
		},

		async handle(req, route) {
			const method = req.method;
			if (route === "/workspaces" && method === "GET") {
				const body: ListWorkspacesResponse = { workspaces: workspaces() };
				return json(body);
			}
			const start = /^\/workspaces\/([^/]+)\/sessions$/.exec(route);
			if (start && method === "POST") {
				const workspace = workspaces().find(w => w.id === decodeURIComponent(start[1]!));
				if (!workspace) return fail(404, "not-found", "no such workspace");
				const body = (await req.json().catch(() => ({}))) as StartWorkspaceSessionRequest;
				const source = body.handoffFromSessionId === undefined ? undefined : ctx.sessions().find(s => s.id === body.handoffFromSessionId);
				const title = source ? `Handoff: ${source.title ?? "session"}` : `${workspace.name} session`;
				const summary = await ctx.startSession(workspace.root, title);
				return json(summary, 201);
			}
			const rule = await ruleRoutes(req, route);
			if (rule) return rule;
			const color = /^\/workspaces\/([^/]+)\/color$/.exec(route);
			if (color && method === "PUT") {
				const id = decodeURIComponent(color[1]!);
				if (!workspaces().some(w => w.id === id)) return fail(404, "not-found", "no such workspace");
				const body = (await req.json().catch(() => null)) as Partial<WorkspaceColorRequest> | null;
				if (body === null || (body.hue !== null && typeof body.hue !== "number")) return fail(400, "bad-request", "hue must be a number or null");
				if (body.hue === null || body.hue === undefined) hues.delete(id);
				else hues.set(id, body.hue);
				return new Response(null, { status: 204 });
			}
			if (route === "/quick-ask" && method === "POST") {
				const body = (await req.json().catch(() => null)) as Partial<QuickAskRequest> | null;
				if (body?.sources !== undefined && (!Array.isArray(body.sources) || body.sources.some(source => !ctx.quickAskSources.includes(source)))) {
					return fail(400, "bad-request", "sources must be enabled in the mock quick-ask allowlist");
				}
				if (typeof body?.question !== "string" || body.question.trim() === "") return fail(400, "bad-request", "question is required");
				const summary = await ctx.startSession(KNOWLEDGE_ROOT, `Quick ask: ${body.question.trim().slice(0, 40)}`, answerEntries(body.question.trim()));
				const response: QuickAskResponse = { sessionId: summary.id };
				return json(response, 202);
			}
			if (route === "/gate" && method === "GET") {
				const body: GateStatusResponse = {
					installed: true,
					version: "0.6.2",
					modes: { interactive: "shadow", subagent: "shadow", scheduled: "shadow" },
					audit: audit(),
					evidence: GATE_EVIDENCE,
				};
				return json(body);
			}
			const drift = /^\/sessions\/([^/]+)\/drift$/.exec(route);
			if (drift && method === "GET") {
				const sessionId = decodeURIComponent(drift[1]!);
				const session = knowledgeSession(sessionId);
				const done = moves.some(m => m.id.startsWith("mv-new") && m.state === "done");
				if (!session || dismissed.has(sessionId) || done) return json(null);
				return json({ ...driftFor(`${KNOWLEDGE_ROOT}/notes-cli`), sessionId });
			}
			const dismiss = /^\/sessions\/([^/]+)\/drift\/([^/]+)\/dismiss$/.exec(route);
			if (dismiss && method === "POST") {
				dismissed.add(decodeURIComponent(dismiss[1]!));
				return new Response(null, { status: 204 });
			}
			if (route === "/moves" && method === "GET") return json({ moves });
			if (route === "/moves" && method === "POST") {
				const body = (await req.json().catch(() => null)) as Partial<MovePrepareRequest> | null;
				if (typeof body?.suggestionId !== "string" || typeof body.slug !== "string") return fail(400, "bad-request", "suggestionId and slug are required");
				const slug = validateSlug(body.slug);
				if (!slug.ok) return fail(400, "bad-request", slug.message);
				const id = `mv-new-${++moveCounter}`;
				const suggestion = driftFor("");
				const preview: MovePreview = {
					id,
					destination: `${PROJECTS_ROOT}/${body.slug}`,
					files: suggestion.files,
					bytes: suggestion.bytes,
					excluded: suggestion.excluded,
					nonce: crypto.randomUUID(),
					expiresAt: Date.now() + 5 * MIN,
				};
				previews.set(id, { preview, suggestionId: body.suggestionId, slug: body.slug, sessionId: ctx.sessions().find(s => s.cwd.startsWith(KNOWLEDGE_ROOT))?.id ?? "" });
				return json(preview);
			}
			const confirm = /^\/moves\/([^/]+)\/confirm$/.exec(route);
			if (confirm && method === "POST") {
				const id = decodeURIComponent(confirm[1]!);
				const prepared = previews.get(id);
				if (!prepared) return fail(404, "not-found", "no such prepared move");
				const body = (await req.json().catch(() => null)) as Partial<MoveConfirmRequest> | null;
				if (typeof body?.token !== "string" || body.token === "" || body.nonce !== prepared.preview.nonce) {
					return fail(403, "unauthorized", "move confirmation was not signed by the Mac app");
				}
				const summary = await ctx.startSession(prepared.preview.destination, `Project: ${prepared.slug}`);
				const record: MoveRecord = {
					id,
					sourceSessionId: prepared.sessionId,
					sourceRoot: `${KNOWLEDGE_ROOT}/notes-cli`,
					destination: prepared.preview.destination,
					newSessionId: summary.id,
					at: Date.now(),
					state: "done",
				};
				moves.unshift(record);
				extraWorkspaces.push({
					id: `project:${prepared.slug}`,
					kind: "project",
					name: prepared.slug,
					root: prepared.preview.destination,
					rules: [],
					liveSessions: 0,
					git: { branch: "main", dirty: true },
				});
				previews.delete(id);
				return json(record);
			}
			const undo = /^\/moves\/([^/]+)\/undo$/.exec(route);
			if (undo && method === "POST") {
				const record = moves.find(m => m.id === decodeURIComponent(undo[1]!));
				if (!record) return fail(404, "not-found", "no such move");
				if (record.state !== "done") return fail(409, "conflict", "only a finished move can be undone");
				if (record.destination.endsWith("/edited")) return fail(409, "conflict", "the copy has changed");
				record.state = "undone";
				const index = extraWorkspaces.findIndex(w => w.root === record.destination);
				if (index >= 0) extraWorkspaces.splice(index, 1);
				return new Response(null, { status: 204 });
			}
			return undefined;
		},
	};
}
