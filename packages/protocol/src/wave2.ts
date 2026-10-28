/**
 * Daemon control API types for workspaces, session controls and native-function gaps. Owned by main.
 * Every route lives under the `/api` auth guard. Each server area is a route module `createXRoutes(...)` in
 * `packages/daemon/src/<area>/routes.ts` returning `(req, url) => Promise<Response | undefined>`; main wires them.
 */

// ---- 6 workspaces -----------------------------------------------------------------------------

export type WorkspaceKind = "knowledge" | "project" | "scratch";

export interface WorkspaceRuleFile {
	/** Relative to the workspace root, e.g. `AGENTS.md`, `.omp/rules/testing.md`. */
	path: string;
	visibility: "private" | "shared";
}

export interface Workspace {
	/** Stable id: `knowledge`, `project:<repo-dir-name>`, `scratch:<id>`. */
	id: string;
	kind: WorkspaceKind;
	name: string;
	root: string;
	/** Hue in degrees assigned by `workspaceColor` (client computes colours; daemon stores overrides only). */
	hueOverride?: number;
	rules: WorkspaceRuleFile[];
	git?: { branch?: string; dirty: boolean; ahead?: number; behind?: number };
	liveSessions: number;
}

/** `GET /api/workspaces`. */
export interface ListWorkspacesResponse {
	workspaces: Workspace[];
}

/**
 * `POST /api/workspaces/:id/sessions`: start a session with cwd = workspace root. With `handoffFromSessionId`, the
 * first message is a handoff block built from that session's key points (section 12) and title. 201 `SessionSummary`.
 */
export interface StartWorkspaceSessionRequest {
	prompt?: string;
	handoffFromSessionId?: string;
	model?: string;
}

/**
 * Rules editor. `GET /api/workspaces/:id/rules/:path` → `RuleFileResponse`; `PUT` same path with `RuleFileWrite` → 204.
 * Private writes go under `.omp/rules/` and ensure a `.git/info/exclude` entry; shared writes are plain files shown
 * as a git diff and never committed by deck. Paths are validated: relative, no `..`, no symlink components, `.md`/`.mdc`.
 */
export interface RuleFileResponse {
	path: string;
	visibility: "private" | "shared";
	content: string;
	/** Git diff of the file against HEAD for shared files, when the repo has commits. */
	diff?: string;
}

export interface RuleFileWrite {
	visibility: "private" | "shared";
	content: string;
}

/** `PUT /api/workspaces/:id/color` body; `null` clears the override. 204. */
export interface WorkspaceColorRequest {
	hue: number | null;
}

/**
 * Knowledge quick-ask: `POST /api/quick-ask` starts (or reuses) a hidden session in the knowledge workspace and sends
 * the question with a fixed preamble naming the sources (SiYuan via siyuan-local MCP, knowledge repository files, web search, past
 * omp sessions via `GET /api/history`). 202 with the session id; the answer streams in that session's room.
 */
export type QuickAskSource = "siyuan" | "repo" | "web" | "history";

export interface QuickAskRequest {
	question: string;
	sources?: QuickAskSource[];
}

export interface QuickAskResponse {
	sessionId: string;
}

// ---- 8 quota, pacing, routing ------------------------------------------------------------------

export interface UsageWindowView {
	/** `5h`, `7d`, model-scoped ids, as omp reports them. */
	id: string;
	usedPct: number;
	resetsAt?: number;
	/** Reserve currently applied to this window (pct). */
	reservePct: number;
	/** Projected used pct at reset at the current burn rate; absent with < 3 fresh samples. */
	projectedPct?: number;
}

export interface UsageAccountView {
	provider: string;
	/** Display label only (never a credential or token). */
	account: string;
	windows: UsageWindowView[];
	fetchedAt: number;
	stale: boolean;
}

export interface ProviderFlowView {
	provider: string;
	headroomPct: number | null;
	/** Window that binds the provider right now. */
	bindingWindow?: string;
	/** Current cap on concurrent top-level subagent spawns. */
	cap: number;
	running: number;
	queued: number;
	state: "ok" | "throttled" | "paused" | "rate-limited" | "unknown";
	/** Burn per minute in pct of the binding window, local vs external estimate. */
	burnLocalPctPerMin?: number;
	burnExternalPctPerMin?: number;
	reason?: string;
	resumesAt?: number;
}

/** `GET /api/quota`. */
export interface QuotaResponse {
	accounts: UsageAccountView[];
	providers: ProviderFlowView[];
	equivalence: EquivalenceTable;
	cacheWarming: "off" | "streaming" | "idle";
	updatedAt: number;
}

/**
 * Same-or-higher-tier substitutes per tier; judgment tier entries may be empty (pause instead of downgrade).
 * `PUT /api/quota/equivalence` with this body → 204 (stored in the daemon state dir).
 */
export interface EquivalenceTable {
	tiers: Array<{ tier: string; roles: string[]; models: string[] }>;
}

/** `PUT /api/quota/cache-warming` → 204; writes omp's `providers.cacheWarming`. */
export interface CacheWarmingRequest {
	mode: "off" | "streaming" | "idle";
}

/** Spawn cost estimate used by the spawn dialog and draft graph: `GET /api/quota/estimate?profile=&model=`. */
export interface SpawnEstimate {
	tokens?: number;
	windowPct?: number;
	samples: number;
}

// ---- 9 safety: gate audit, drift, safe move ----------------------------------------------------

export interface GateAuditEntry {
	at: number;
	verdict: "allow" | "ask" | "deny" | "would-ask" | "would-deny";
	kinds: string[];
	summary: string;
	target?: string;
	sessionId?: string;
}

/** `GET /api/gate` → current modes (read from the gate's own config) and the latest audit entries. */
export interface GateStatusResponse {
	installed: boolean;
	version?: string;
	modes: Record<"interactive" | "subagent" | "scheduled", "shadow" | "enforce" | "deny-park">;
	audit: GateAuditEntry[];
	/** Research numbers shown next to the toggle (from the gate's docs). */
	evidence?: string;
}

/** Project-drift suggestion for a knowledge-workspace session: `GET /api/sessions/:id/drift` (null body when none). */
export interface DriftSuggestion {
	id: string;
	sessionId: string;
	/** Root inside the knowledge workspace where the project appeared. */
	sourceRoot: string;
	markers: string[];
	suggestedSlug: string;
	/** Daemon-computed facts. */
	files: number;
	bytes: number;
	excluded: Array<{ path: string; reason: "dependency-dir" | "secret" | "special-file" | "hardlink" | "too-large" }>;
	/** Agent-written text, if any, labelled as such in the UI. */
	agentReason?: string;
}

/** `POST /api/sessions/:id/drift/:suggestionId/dismiss` mutes that root. 204. */

/**
 * Move (copy) flow. `POST /api/moves` prepares a move from a suggestion and returns the preview with a nonce;
 * `GET /api/moves/:id` returns `MoveDetail` (what the Mac app's native dialog shows); `POST /api/moves/:id/confirm`
 * with `MoveConfirmRequest` executes it. The token is an Ed25519 signature made by the Mac app with a key that only
 * lives in its Keychain item; the daemon holds the public key only. Without a valid token the daemon answers 403.
 * `POST /api/moves/:id/undo` → 204, refused (409) if the copy changed or has commits. `GET /api/moves` lists records.
 */
export interface MovePrepareRequest {
	suggestionId: string;
	slug: string;
}

export interface MovePreview {
	id: string;
	destination: string;
	files: number;
	bytes: number;
	excluded: DriftSuggestion["excluded"];
	nonce: string;
	expiresAt: number;
}

export interface MoveConfirmRequest {
	nonce: string;
	/** base64url Ed25519 signature over `${moveId}.${nonce}` by the Mac app's confirmation key. */
	token: string;
}

export interface MoveRecord {
	id: string;
	sourceSessionId: string;
	sourceRoot: string;
	destination: string;
	newSessionId?: string;
	at: number;
	state: "prepared" | "done" | "undone" | "failed";
	error?: string;
	/** Where undo put the copy (inside the user's Trash). */
	trashPath?: string;
}

/** Daemon facts about one move; `nonce` only while the move can still be confirmed. */
export interface MoveDetail {
	id: string;
	state: MoveRecord["state"];
	sourceRoot: string;
	destination: string;
	files: number;
	bytes: number;
	excluded: DriftSuggestion["excluded"];
	expiresAt: number;
	nonce?: string;
}

// ---- 11 plugins and extension UI ---------------------------------------------------------------

export interface PluginInfo {
	id: string;
	kind: "plugin" | "extension" | "skill" | "mcp" | "hook" | "tool";
	name: string;
	enabled: boolean;
	source?: string;
	description?: string;
}

/** `GET /api/sessions/:id/plugins`; `POST /api/sessions/:id/plugins/:pluginId/{enable|disable}` → 204. */
export interface ListPluginsResponse {
	plugins: PluginInfo[];
}

/** Declarative omp-console panel an extension publishes with `setWidget("omp-console:<id>", descriptor)`. */
export type DeckPanelDescriptor =
	| { kind: "list"; title: string; items: Array<{ label: string; detail?: string }> }
	| { kind: "kv"; title: string; rows: Array<{ key: string; value: string }> }
	| { kind: "progress"; title: string; value: number; max: number; label?: string }
	| { kind: "markdown"; title: string; text: string }
	| { kind: "table"; title: string; columns: string[]; rows: string[][] }
	| { kind: "buttons"; title: string; buttons: Array<{ label: string; command: string }> };

export interface ExtensionUiState {
	statuses: Array<{ key: string; text: string }>;
	widgets: Array<{ key: string; lines: string[] }>;
	panels: Array<{ key: string; descriptor: DeckPanelDescriptor }>;
	notifications: Array<{ at: number; message: string; level: "info" | "warning" | "error" }>;
}

// ---- 12 titles and history ---------------------------------------------------------------------

export interface KeyPoints {
	sessionId: string;
	title: string;
	goal?: string;
	decisions: string[];
	files: string[];
	outcome?: string;
	openQuestions: string[];
	generatedAt: number;
}

export interface HistoryNode {
	sessionId: string;
	sessionFile?: string;
	workspaceId?: string;
	title: string;
	createdAt: number;
	lastActivityAt: number;
	keyPoints?: KeyPoints;
}

export interface HistoryEdge {
	from: string;
	to: string;
	kind: "fork" | "handoff" | "move" | "plan-run";
}

/** `GET /api/history?workspace=&q=&limit=`; `POST /api/sessions/:id/key-points` regenerates (202). */
export interface HistoryResponse {
	nodes: HistoryNode[];
	edges: HistoryEdge[];
}

// ---- 13 processes ------------------------------------------------------------------------------

export interface ProcessInfo {
	pid: number;
	ppid: number;
	kind: "omp-console-daemon" | "omp-console-worker" | "omp-terminal" | "omp-broker" | "omp-lsp" | "omp-eval" | "omp-browser" | "omp-helper";
	command: string;
	startedAt: number;
	/** Whole process tree. */
	rssBytes: number;
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	lastSessionWriteAt?: number;
	state: "active" | "idle" | "orphan";
	reason?: string;
}

/**
 * `GET /api/processes`. `POST /api/processes/:pid/stop` with `{confirm: true}` → 202: deck workers stop through the
 * supervisor; terminal omp sessions get SIGTERM only; orphans SIGTERM then SIGKILL after 3 s. Unknown pid 404.
 */
export interface ListProcessesResponse {
	processes: ProcessInfo[];
	policies: { idleStopAfterMs: number | null; rssWarnBytes: number };
}

/** `PUT /api/processes/policies` → 204. */
export interface ProcessPoliciesRequest {
	idleStopAfterMs: number | null;
	rssWarnBytes: number;
}

// ---- remaining native gaps: session operations --------------------------------------------------

/**
 * `POST /api/sessions/:id/ops` with one `SessionOp` → 200 `SessionOpResult`. Each op calls omp's own session API in
 * the worker (no prompt text is synthesised): plan mode toggle, goal controls, todo replacement, compaction, approval
 * mode, dequeue of queued messages, stats and tree reads.
 */
export type SessionOp =
	| { op: "plan-mode"; enabled: boolean }
	| { op: "goal"; action: "set"; objective: string; tokenBudget?: number }
	| { op: "goal"; action: "pause" | "resume" | "drop" }
	| { op: "goal"; action: "budget"; tokenBudget: number }
	| { op: "todos"; phases: Array<{ name: string; tasks: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked" }> }> }
	| { op: "compact"; mode?: "soft" | "remote" | "snap" }
	| { op: "approval-mode"; mode: "always-ask" | "always-ask-cached" | "write" | "yolo" }
	| { op: "dequeue"; index?: number }
	| { op: "stats" }
	| { op: "tree" }
	| { op: "context" };

export interface SessionStatsView {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
	cost: number;
	contextTokens: number;
	contextWindow: number;
	byAgent: Array<{ agentId: string; tokens: number; cost: number }>;
}

export interface SessionTreeNode {
	entryId: string;
	parentId: string | null;
	role: "user" | "assistant" | "other";
	preview: string;
	at: number;
	onCurrentBranch: boolean;
	/**
	 * Entry to pass as `forkFrom.entryId` for "fork here": the entry itself when omp can fork there (a transcript
	 * message), otherwise the nearest earlier one, so forking at a prompt keeps everything before it. Absent when there
	 * is nothing earlier to keep.
	 */
	forkEntryId?: string;
}

export interface ContextBreakdownView {
	total: number;
	window: number;
	parts: Array<{ label: string; tokens: number }>;
}

export type SessionOpResult =
	| { ok: true }
	| { ok: true; stats: SessionStatsView }
	| { ok: true; tree: SessionTreeNode[] }
	| { ok: true; context: ContextBreakdownView };

/**
 * Improvement report (spec 0.7): `POST /api/report` spawns a read-only agent over the journal, feedback and
 * plan-run logs (no transcripts) and writes a markdown report under the state dir; `GET /api/report` returns the last.
 */
export interface ImprovementReport {
	generatedAt: number;
	markdown: string;
	path: string;
}
