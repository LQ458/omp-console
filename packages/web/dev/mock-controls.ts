/**
 * Mock endpoints for the session controls (spec 1.9, 2.5, 2.6, 3.1): the profile catalog, main-session thinking and
 * spawn-with-profile. Registered from `mock-daemon.ts` with one call to `handleControlsMock`.
 *
 * Simulated, not real:
 * - `POST /api/sessions/:id/agents/:agentId/thinking` accepts every level except `xhigh` (400, "does not support")
 *   and never changes the host's `state` frame, so the header shows the accepted value until the host moves.
 * - `POST /api/sessions/:id/agents` registers no agent in the fixture room; it answers with the id of an existing
 *   subagent (`RelayProbe`) so "open the drawer" can be exercised. A task containing `#refuse` gets 409 (spawn
 *   policy), `#fail` gets 500, `#slow` waits 1.2 s.
 * - `GET /api/sessions/:id/catalog` is the single mock catalog: the composer mock's commands, tools, skills, roles and
 *   MCP, with this mock's profiles (config mock's profiles plus definition details).
 */
import type {
	AgentProfileDetail,
	ApiError,
	CatalogResponse,
	SetAgentThinkingRequest,
	SpawnAgentRequest,
	SpawnAgentResponse,
} from "@omp-console/protocol";
import { THINKING_LEVELS } from "../src/lib/session-model";
import { composerCatalog } from "./mock-composer";
import type { MockConfig } from "./mock-config";

export interface ControlsMockContext {
	hasSession(id: string): boolean;
	config: MockConfig;
}

interface ProfileExtras {
	tools?: string[];
	spawns?: string[] | "*";
	thinking?: string;
	skills?: string[];
	file?: string;
}

const EXTRAS: Record<string, ProfileExtras> = {
	task: { spawns: "*", thinking: "medium", skills: [] },
	explore: {
		tools: ["read", "grep", "glob", "bash"],
		spawns: [],
		thinking: "low",
		skills: [],
	},
	reviewer: {
		tools: ["read", "grep", "glob", "bash", "lsp", "ast_grep"],
		spawns: [],
		thinking: "high",
		skills: ["visual-review"],
		file: "/Users/dev/.omp/agent/agents/reviewer.md",
	},
	librarian: {
		tools: ["read", "grep", "fetch", "web_search"],
		spawns: [],
		thinking: "low",
		skills: [],
		file: "/Users/dev/.omp/agent/agents/librarian.md",
	},
};

const TOOLS = ["read", "grep", "glob", "edit", "write", "bash", "lsp", "ast_grep", "fetch", "web_search", "task"];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

/** Answers the routes above, or null when `route` is not one of them. */
export async function handleControlsMock(req: Request, route: string, ctx: ControlsMockContext): Promise<Response | null> {
	const method = req.method;

	const catalog = /^\/sessions\/([^/]+)\/catalog$/.exec(route);
	if (catalog && method === "GET") {
		if (!ctx.hasSession(decodeURIComponent(catalog[1]!))) return fail(404, "not-found", "no such live session");
		const { profiles, roles } = ctx.config.profiles();
		const detailed: AgentProfileDetail[] = profiles.map(profile => ({ ...profile, ...EXTRAS[profile.name] }));
		const base = composerCatalog();
		const toolNames = new Set([...base.tools.map(tool => tool.name), ...TOOLS]);
		const body: CatalogResponse = {
			...base,
			tools: [...toolNames].map(name => base.tools.find(tool => tool.name === name) ?? { name }),
			profiles: detailed,
			roles: { ...base.roles, ...roles },
			generatedAt: Date.now(),
		};
		return json(body);
	}

	const thinking = /^\/sessions\/([^/]+)\/agents\/([^/]+)\/thinking$/.exec(route);
	if (thinking && method === "POST") {
		if (!ctx.hasSession(decodeURIComponent(thinking[1]!))) return fail(404, "not-found", "no such live session");
		const body = (await req.json().catch(() => null)) as Partial<SetAgentThinkingRequest> | null;
		const level = body?.level;
		if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
			return fail(400, "bad-request", "level must be one of off, minimal, low, medium, high, xhigh, max, auto");
		}
		if (level === "xhigh") return fail(400, "bad-request", "claude-sonnet-5-5 does not support xhigh");
		return new Response(null, { status: 204 });
	}

	const spawn = /^\/sessions\/([^/]+)\/agents$/.exec(route);
	if (spawn && method === "POST") {
		if (!ctx.hasSession(decodeURIComponent(spawn[1]!))) return fail(404, "not-found", "no such live session");
		const body = (await req.json().catch(() => null)) as Partial<SpawnAgentRequest> | null;
		if (typeof body?.profile !== "string" || !ctx.config.hasProfile(body.profile)) {
			return fail(400, "bad-request", `unknown profile ${String(body?.profile)}`);
		}
		if (typeof body.task !== "string" || body.task.trim() === "") return fail(400, "bad-request", "task is empty");
		if (body.task.includes("#slow")) await Bun.sleep(1200);
		if (body.task.includes("#refuse")) return fail(409, "conflict", "spawn policy: max depth reached");
		if (body.task.includes("#fail")) return fail(500, "internal", "task tool crashed");
		const response: SpawnAgentResponse = { agentId: "RelayProbe" };
		return json(response, 202);
	}

	return null;
}
