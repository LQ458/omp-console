/**
 * Control API for the native-function spec. Owned by main.
 * All routes are under the same auth guard as the rest of `/api`.
 */
import type { AgentProfileSummary } from "./index";

// ---- 0.1 capability catalog -------------------------------------------------------------------

export type CatalogCommandSource = "builtin" | "user" | "project" | "extension" | "skill" | "template" | "mcp";

export interface CatalogCommand {
	/** Without the leading slash, e.g. `compact`, `skill:visual-review`. */
	name: string;
	description?: string;
	source: CatalogCommandSource;
	/** Argument hint as omp shows it, e.g. `[soft|remote|snap]`. */
	usage?: string;
	aliases?: string[];
	/**
	 * True when the command has a text-mode handler and can run through `POST /api/sessions/:id/command`.
	 * TUI-only commands are listed so users can learn about them; `deckControl` names the omp console panel that covers one.
	 */
	remote: boolean;
	deckControl?: string;
}

export interface CatalogTool {
	name: string;
	description?: string;
}

export interface CatalogSkill {
	name: string;
	description?: string;
	source?: string;
}

export interface CatalogMcpServer {
	name: string;
	connected: boolean;
	toolCount?: number;
}

/** Everything a task-agent profile definition declares. */
export interface AgentProfileDetail extends AgentProfileSummary {
	tools?: string[];
	/** Profiles this one may spawn; `"*"` for any. */
	spawns?: string[] | "*";
	thinking?: string;
	skills?: string[];
	/** Absolute path of the definition file, when it is a file. */
	file?: string;
}

/** `GET /api/sessions/:id/catalog`: generated from the live session's own registries, never hand-written. */
export interface CatalogResponse {
	commands: CatalogCommand[];
	tools: CatalogTool[];
	profiles: AgentProfileDetail[];
	skills: CatalogSkill[];
	roles: Record<string, string>;
	mcp: CatalogMcpServer[];
	generatedAt: number;
}

// ---- 5.1 file mentions ------------------------------------------------------------------------

/** `GET /api/sessions/:id/files?q=<query>&limit=<n>`: omp's native fuzzy finder over the session cwd (respects .gitignore). */
export interface FileSuggestion {
	/** Relative to the session cwd; directories end with `/`. */
	path: string;
	kind: "file" | "dir";
}

export interface FileSuggestionsResponse {
	items: FileSuggestion[];
}

// ---- 5.2 command palette ----------------------------------------------------------------------

/** `POST /api/sessions/:id/command`: runs one remote-invokable slash command in the session. 202, 400 when not remote, 409 when busy and the command needs an idle session. */
export interface RunCommandRequest {
	/** Full text including the slash, e.g. `/compact soft`. */
	text: string;
}

export interface RunCommandResponse {
	accepted: true;
}

// ---- 1.9 main-session model and thinking -------------------------------------------------------

/** `POST /api/sessions/:id/agents/:agentId/thinking`. Same status codes as the model endpoint. */
export interface SetAgentThinkingRequest {
	level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
}

// ---- 2.5 spawn an agent of a chosen profile ----------------------------------------------------

/**
 * `POST /api/sessions/:id/agents`: spawns a subagent of `profile` with `task` directly (omp's task tool, executed by
 * the worker, not by asking the main model). 202 once the agent is registered; 400 unknown profile or empty task;
 * 409 when the spawn policy refuses it. The result is also posted into the session as a visible message, so the main
 * agent can see it.
 */
export interface SpawnAgentRequest {
	profile: string;
	task: string;
	/** Display name; omp picks one when absent. */
	name?: string;
	/** Run in an isolated worktree when the session's settings allow it. */
	isolated?: boolean;
	/** Files to hand to the agent as `@path` mentions in its task. */
	files?: string[];
}

export interface SpawnAgentResponse {
	agentId: string;
}

// ---- 4.5 draft graph run by deck (v2) ----------------------------------------------------------

export interface DraftNode {
	/** Stable id inside the draft. */
	id: string;
	title: string;
	instruction: string;
	profile: string;
	files?: string[];
	/** Draft ids that must finish successfully before this node starts. */
	dependsOn?: string[];
	isolated?: boolean;
}

export interface DraftPlan {
	name: string;
	nodes: DraftNode[];
}

export type DraftNodeState = "waiting" | "running" | "done" | "failed" | "skipped" | "cancelled";

export interface DraftRunNode {
	id: string;
	state: DraftNodeState;
	/** Registry id of the spawned agent, once running. */
	agentId?: string;
	startedAt?: number;
	endedAt?: number;
	/** First lines of the agent's result or error. */
	summary?: string;
}

export interface DraftRun {
	runId: string;
	sessionId: string;
	plan: DraftPlan;
	nodes: DraftRunNode[];
	state: "running" | "done" | "failed" | "cancelled";
	startedAt: number;
}

/**
 * `POST /api/sessions/:id/plans` (body `DraftPlan`) starts a run: 202 `DraftRun`; 400 for a cycle, unknown dependency,
 * duplicate id or unknown profile. `GET /api/sessions/:id/plans` lists runs; `GET .../plans/:runId` one run;
 * `DELETE .../plans/:runId` cancels (running agents are cancelled, waiting nodes skipped).
 * A node starts when all its dependencies are `done`; a failed dependency skips its dependents.
 * Drafts are saved as templates with `PUT /api/plan-templates/:name` (body `DraftPlan`), listed with `GET /api/plan-templates`.
 */
export interface ListDraftRunsResponse {
	runs: DraftRun[];
}

export interface ListPlanTemplatesResponse {
	templates: DraftPlan[];
}

// ---- 0.5 / 0.6 usage journal and feedback ------------------------------------------------------

/**
 * One UI event. Never carries prompt text, file contents, transcript text or credentials: `feature` and `action` are
 * fixed identifiers from the client, `detail` is a short non-content tag (e.g. a command name).
 */
export interface JournalEvent {
	at: number;
	/** Spec id or feature key, e.g. `5.2.palette`, `2.5.spawn`. */
	feature: string;
	action: string;
	outcome: "ok" | "error" | "abandoned";
	latencyMs?: number;
	via?: "catalog" | "suggestion" | "palette" | "graph" | "composer" | "direct";
	screen?: string;
	detail?: string;
	sessionId?: string;
}

export interface FeedbackEntry {
	at: number;
	screen: string;
	feature?: string;
	text: string;
}

/**
 * `POST /api/journal` (body `{ events: JournalEvent[] }`, at most 200 per call) 204. `POST /api/feedback` (body
 * `FeedbackEntry`) 204. `GET /api/journal?limit=` → `JournalResponse`. `DELETE /api/journal` wipes both 204.
 * Stored as append-only JSONL under the daemon state dir, mode 0600.
 */
export interface JournalResponse {
	events: JournalEvent[];
	feedback: FeedbackEntry[];
}
