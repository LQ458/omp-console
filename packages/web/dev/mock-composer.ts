/**
 * Mock of the composer, discovery and journal endpoints of the control API (packages/protocol/src/features.ts):
 * `GET /sessions/:id/catalog`, `GET /sessions/:id/files`, `POST /sessions/:id/command`, `/recipes`, `/journal`, and `/feedback`.
 * Registered with one call in `mock-daemon.ts`; state lives for the daemon's lifetime.
 */
import type {
	ApiError,
	CatalogCommand,
	CatalogResponse,
	FeedbackEntry,
	FileSuggestion,
	JournalEvent,
	JournalResponse,
} from "@omp-console/protocol";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

const COMMANDS: CatalogCommand[] = [
	{ name: "compact", description: "Compact the conversation to free context", source: "builtin", usage: "[soft|remote|snap]", remote: true },
	{ name: "shake", description: "Strip tool results and large blocks from context", source: "builtin", usage: "[elide|images|thinking]", remote: true },
	{ name: "handoff", description: "Write a handoff and continue in a fresh session", source: "builtin", remote: true },
	{ name: "context", description: "Show a context usage breakdown", source: "builtin", remote: true },
	{ name: "usage", description: "Show provider usage and limits", source: "builtin", remote: true },
	{ name: "goal", description: "Set, pause or drop the session goal", source: "builtin", usage: "<objective>", remote: true },
	{ name: "loop", description: "Repeat a prompt until a condition holds", source: "builtin", usage: "[count|duration] [--while|--until <command>] [prompt]", remote: false, deckControl: "session-modes" },
	{ name: "vibe", description: "Restrict tools and direct fast/good worker sessions", source: "builtin", usage: "[prompt]", remote: false, deckControl: "session-modes" },
	{ name: "model", description: "Switch model for this session", source: "builtin", aliases: ["models"], remote: false, deckControl: "model" },
	{ name: "agents", description: "Open the agents hub (per-agent model, prewalk, advisor)", source: "builtin", remote: false, deckControl: "agents" },
	{ name: "todo", description: "Show the todo list", source: "builtin", remote: false, deckControl: "status" },
	{ name: "tan", description: "Fork the session into a background agent", source: "builtin", usage: "<task>", remote: false, deckControl: "tan" },
	{ name: "omfg", description: "Generate a reviewable TTSR rule from recent history", source: "builtin", usage: "<complaint>", remote: false, deckControl: "omfg" },
	{ name: "cleanse", description: "Run diagnostics and repair selected issues", source: "builtin", usage: "[scope]", remote: false, deckControl: "cleanse" },
	{ name: "tree", description: "Browse and branch the session tree", source: "builtin", remote: false },
	{ name: "skills", description: "Search, install and update registry skills", source: "builtin", usage: "[search|install|installed|update]", remote: false, deckControl: "skills" },
	{ name: "git", description: "Inspect, stage and commit the session repository", source: "builtin", usage: "[rev]", remote: false, deckControl: "git" },
	{ name: "record", description: "Record the current omp console display", source: "builtin", remote: false, deckControl: "record" },
	{ name: "live", description: "Open realtime voice for this session", source: "builtin", remote: false, deckControl: "live" },
	{ name: "debug", description: "Open the DAP debug selector for this session", source: "builtin", remote: false, deckControl: "debug" },
	{ name: "pause", description: "Pause or resume the agent at a safe boundary", source: "builtin", remote: false, deckControl: "pause" },
	{ name: "queue", description: "Queue follow-up messages behind the active turn", source: "builtin", usage: "[text]", remote: false, deckControl: "queue" },
	{ name: "restart", description: "Restart this session worker from its saved transcript", source: "builtin", usage: "[anyway]", remote: false, deckControl: "restart" },
	{ name: "collab", description: "Share or inspect this session's collaboration room", source: "builtin", usage: "[view|list|status|stop]", remote: false, deckControl: "collab" },
	{ name: "join", description: "Join a collaboration link", source: "builtin", usage: "<link>", remote: false, deckControl: "join" },
	{ name: "leave", description: "Leave this session pane", source: "builtin", remote: false, deckControl: "leave" },
	{ name: "open", description: "Open the latest transcript link", source: "builtin", remote: false, deckControl: "open" },
	{ name: "copy", description: "Copy transcript text, code, commands or links", source: "builtin", usage: "[code|cmd|link]", remote: false, deckControl: "copy" },
	{ name: "hotkeys", description: "Show keyboard shortcuts", source: "builtin", remote: false, deckControl: "hotkeys" },
	{ name: "extensions", description: "Open the extensions panel", source: "builtin", remote: false, deckControl: "extensions" },
	{ name: "exit", description: "Leave this session pane", source: "builtin", remote: false, deckControl: "leave" },
	{ name: "quit", description: "Leave this session pane", source: "builtin", remote: false, deckControl: "leave" },
	{ name: "release-notes", description: "Summarize what changed since the last release", source: "user", remote: true },
	{ name: "deploy-check", description: "Run the project's pre-deploy checklist", source: "project", usage: "[env]", remote: true },
	{ name: "skill:visual-review", description: "Review a visual artifact with the visual-review skill", source: "skill", remote: true },
	{ name: "skill:research", description: "Multi-source research with citations", source: "skill", remote: true },
	{ name: "review-pr", description: "Prompt template: review a pull request", source: "template", usage: "<number>", remote: true },
];

/** Commands, tools, skills, roles and MCP of the fixture catalog; profiles come from the controls mock (one catalog route). */
export function composerCatalog(): CatalogResponse {
	return {
		commands: COMMANDS,
		tools: [
			{ name: "read", description: "Read a file, directory, URL or archive member" },
			{ name: "edit", description: "Apply a hashline patch to an existing file" },
			{ name: "bash", description: "Run a shell command in a persistent session" },
			{ name: "task", description: "Spawn subagents of a chosen profile" },
			{ name: "ask", description: "Ask the user a question with options" },
		],
		profiles: [
			{
				name: "reviewer",
				source: "bundled",
				description: "Reviews completed work and ends with a verdict",
				definitionModels: ["@judge"],
				effectiveModel: "anthropic/claude-opus-5-5",
				tools: ["read", "grep", "bash"],
				spawns: [],
				thinking: "high",
			},
			{
				name: "scout",
				source: "bundled",
				description: "Answers one bounded local question about the codebase",
				definitionModels: ["@explore"],
				effectiveModel: "openai-codex/gpt-6-luna",
				tools: ["read", "grep", "glob"],
				spawns: [],
			},
			{
				name: "task",
				source: "bundled",
				description: "General implementation worker",
				definitionModels: ["@task"],
				effectiveModel: "anthropic/claude-sonnet-5-5",
				spawns: "*",
			},
			{ name: "release-writer", source: "user", description: "Drafts release notes from the git log", definitionModels: [] },
		],
		skills: [
			{ name: "visual-review", description: "Quarto HTML review artifacts with a browser smoke check", source: "user" },
			{ name: "research", description: "Source wave, draft, then fact-check", source: "user" },
			{ name: "commit-style", description: "Conventional commit messages for this repo", source: "project" },
		],
		roles: {
			default: "anthropic/claude-sonnet-5-5",
			smol: "openai-codex/gpt-6-luna",
			plan: "anthropic/claude-opus-5-5",
			slow: "anthropic/claude-opus-5-5",
		},
		mcp: [
			{ name: "siyuan", connected: true, toolCount: 18 },
			{ name: "playwright", connected: false },
		],
		generatedAt: Date.now(),
	};
}

const FILES: FileSuggestion[] = [
	{ path: "README.md", kind: "file" },
	{ path: "package.json", kind: "file" },
	{ path: "docs/", kind: "dir" },
	{ path: "docs/architecture.md", kind: "file" },
	{ path: "docs/release notes.md", kind: "file" },
	{ path: "src/", kind: "dir" },
	{ path: "src/index.ts", kind: "file" },
	{ path: "src/relay/", kind: "dir" },
	{ path: "src/relay/backoff.ts", kind: "file" },
	{ path: "src/relay/socket.ts", kind: "file" },
	{ path: "src/relay/socket.test.ts", kind: "file" },
	{ path: "test/", kind: "dir" },
	{ path: "test/backoff.test.ts", kind: "file" },
];

function suggest(query: string, limit: number): FileSuggestion[] {
	const q = query.toLowerCase().replace(/^["']/, "");
	const direct = q.endsWith("/") ? FILES.filter(f => f.path.toLowerCase().startsWith(q) && f.path.toLowerCase() !== q) : [];
	const hits = direct.length > 0 ? direct : FILES.filter(f => f.path.toLowerCase().includes(q));
	return hits.slice(0, limit);
}

export interface ComposerMock {
	/** Returns undefined for routes this mock does not own. */
	handle(req: Request, route: string, hasSession: (id: string) => boolean): Promise<Response | undefined>;
	/** Slash commands received through `POST /sessions/:id/command`, oldest first. */
	commands(): string[];
}

export function createComposerMock(): ComposerMock {
	const events: JournalEvent[] = [];
	const feedback: FeedbackEntry[] = [];
	const commands: string[] = [];

	return {
		commands: () => [...commands],
		async handle(req, route, hasSession) {
			const method = req.method;
			if (route === "/recipes" && method === "GET") return json({ recipes: [] });
			const session = /^\/sessions\/([^/]+)\/(catalog|files|command)$/.exec(route);
			if (session) {
				const id = decodeURIComponent(session[1]!);
				if (!hasSession(id)) return fail(404, "not-found", "no such live session");
				const kind = session[2];
				if (kind === "catalog") return undefined;
				if (kind === "files" && method === "GET") {
					const url = new URL(req.url);
					const limit = Number(url.searchParams.get("limit") ?? "50");
					return json({ items: suggest(url.searchParams.get("q") ?? "", Number.isFinite(limit) ? limit : 50) });
				}
				if (kind === "command" && method === "POST") {
					const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
					if (typeof body?.text !== "string" || !body.text.startsWith("/")) return fail(400, "bad-request", "text must be a slash command");
					const name = body.text.slice(1).split(/\s+/)[0] ?? "";
					const command = COMMANDS.find(c => c.name === name || c.aliases?.includes(name));
					if (!command) return fail(400, "bad-request", `unknown command /${name}`);
					if (!command.remote) return fail(400, "bad-request", `/${name} is not remotely invokable`);
					commands.push(body.text);
					return json({ accepted: true }, 202);
				}
			}
			if (route === "/mock/commands" && method === "GET") return json(commands);
			if (route === "/journal" && method === "POST") {
				const body = (await req.json().catch(() => null)) as { events?: JournalEvent[] } | null;
				if (!Array.isArray(body?.events) || body.events.length > 200) return fail(400, "bad-request", "events must be an array of at most 200");
				events.push(...body.events);
				return new Response(null, { status: 204 });
			}
			if (route === "/feedback" && method === "POST") {
				const body = (await req.json().catch(() => null)) as FeedbackEntry | null;
				if (typeof body?.text !== "string" || typeof body.screen !== "string") return fail(400, "bad-request", "screen and text are required");
				feedback.push(body);
				return new Response(null, { status: 204 });
			}
			if (route === "/journal" && method === "GET") {
				const limit = Number(new URL(req.url).searchParams.get("limit") ?? "500");
				const response: JournalResponse = { events: events.slice(-limit), feedback: feedback.slice(-limit) };
				return json(response);
			}
			if (route === "/journal" && method === "DELETE") {
				events.length = 0;
				feedback.length = 0;
				return new Response(null, { status: 204 });
			}
			return undefined;
		},
	};
}
