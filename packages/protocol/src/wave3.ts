/**
 * Control API for wave 3 (simplicity round, 2026-10-23): session cards and the librarian, new-session suggestions,
 * the return brief, the agenda link to tasks-hub, rewind and shell input. Owned by main. Every route lives under the
 * `/api` auth guard; each server area is a route module wired by main (see wave2.ts header).
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { QuickAskSource } from "./wave2";

/** `GET /api/capabilities`: effective features after config and required-resource checks. */
export interface DaemonCapabilities {
	features: {
		librarian: boolean;
		agenda: boolean;
		quickAsk: boolean;
		peers: boolean;
		openrouterDecisions: boolean;
		computerUse: boolean;
		overnight: boolean;
	};
	/** Explicitly configured sources available to quick-ask; never inferred from installed MCPs. */
	quickAskSources: QuickAskSource[];
}

export const OPTIONAL_FEATURE_NAMES = ["librarian", "agenda", "quickAsk", "peers", "openrouterDecisions", "computerUse", "overnight"] as const;
export type OptionalFeatureName = (typeof OPTIONAL_FEATURE_NAMES)[number];

/** Parsed `<state-dir>/config.json`; all configured paths are absolute after parsing. */
export interface ConfiguredPeer {
	id: string;
	name: string;
	url: string;
	/** Path to a 0600 device-token file for the peer daemon. */
	tokenFile?: string;
}

export interface DaemonConfigFile {
	features?: Partial<Record<OptionalFeatureName, boolean>>;
	quickAsk?: { sources?: QuickAskSource[] };
	knowledgeRoot?: string;
	projectRoots?: string[];
	scheduleFile?: string;
	agendaHub?: string;
	peers?: ConfiguredPeer[];
}

export interface DaemonConfigFeatureStatus {
	configured: boolean;
	effective: boolean;
	missing: string[];
	overriddenByFlag: boolean;
}

/** Response from `GET /api/config`; `effective` matches `GET /api/capabilities`. */
export interface DaemonConfigResponse {
	file: DaemonConfigFile;
	effective: DaemonCapabilities;
	features: Record<OptionalFeatureName, DaemonConfigFeatureStatus>;
	restart: { supported: boolean };
}

export interface DaemonBusySession {
	id: string;
	cwd: string;
	title?: string;
}

export interface DaemonRestartConflict {
	error: string;
	code: "conflict";
	busySessions: DaemonBusySession[];
}

// ---- librarian: session cards -------------------------------------------------------------------

/** `waiting`: the agent is waiting on the user (ask, approval, a question in its last reply). `unfinished`: work was left
 * open. `done`: the task finished. */
export type CardStatus = "waiting" | "unfinished" | "done";

export type TitleSource = "omp" | "deck" | "user";

export interface TitleRevision {
	title: string;
	source: TitleSource;
	at: number;
}

/**
 * omp console's own view of one omp session (live or persisted). Stored in omp console's state dir only; omp session files are never
 * written. A `user` title is never changed automatically.
 */
export interface SessionCard {
	sessionId: string;
	cwd: string;
	/** Absolute omp session file, for resuming a card that is not in the recent list. */
	sessionFile?: string;
	/** Workspace id (`knowledge`, `project:<dir>`) when the cwd falls under a known root. */
	workspaceId?: string;
	title: string;
	titleSource: TitleSource;
	/** Earlier titles, oldest first; `POST .../title/undo` restores the last one. */
	titleHistory: TitleRevision[];
	status: CardStatus;
	/** One line: where the session stopped (the latest topic). */
	stoppedAt?: string;
	/** One line: the next step, when there is one. */
	nextStep?: string;
	/** One label from `CardsResponse.topics`. */
	topic?: string;
	/** Started by the local scheduler (its first prompt matches a scheduled task prompt). */
	scheduled: boolean;
	/** Protected from automatic sleep and retained in the pinned card group. */
	pinned?: boolean;
	/** Live in a deck worker right now. */
	live: boolean;
	/** Nothing has been said in it yet; such cards are left out of lists and the brief. */
	empty?: boolean;
	lastActivityAt: number;
	/** When the card's text and decisions were last computed. */
	cardUpdatedAt?: number;
	/** Activity happened after `cardUpdatedAt`; a refresh is queued. */
	stale: boolean;
}

/** `GET /api/cards?limit=&workspace=&includeScheduled=` → newest first. */
export interface CardsResponse {
	cards: SessionCard[];
	/** Topic labels in display order (configurable; default from the knowledge-base areas). */
	topics: string[];
	/** Cards waiting for the background pass. */
	pending: number;
	/** Which model makes the decisions: `jev` (OpenRouter key present) or `luna` (fallback, no key). */
	decisionBackend: "jev" | "luna";
}

/** `POST /api/cards/:id/title` (the user renames; becomes `user`). `POST /api/cards/:id/title/undo` → the updated card. */
export interface SetCardTitleRequest {
	title: string;
}

/** `POST /api/cards/refresh` → 202. Without ids: every stale card. */
export interface RefreshCardsRequest {
	sessionIds?: string[];
}

// ---- return brief --------------------------------------------------------------------------------

export interface BriefLine {
	sessionId: string;
	/** The session card's title, so a line says which session it is about. */
	title: string;
	/** Where to resume it when it is not live. */
	cwd: string;
	sessionFile?: string;
	/** One sentence: where it stopped and what is next. */
	text: string;
	status: CardStatus;
	/** Maximum of the session activity and card update timestamps. */
	changedAt: number;
	/** User action or latest known lifecycle; crashed/stalled state is not available on cards. */
	kind: "needs-you" | "finished" | "unfinished";
}

/** `GET /api/brief?since=<ms>` → changes since a caller-owned cursor, bounded to a seven-day lookback. */
export interface ReturnBrief {
	since: number;
	generatedAt: number;
	lines: BriefLine[];
	/** Today's agenda items that link to a session or are due today. */
	agenda: AgendaItem[];
}

// ---- new-session suggestions ---------------------------------------------------------------------

export interface WorkspaceUsage {
	/** Absolute directory. */
	cwd: string;
	/** Display name (folder name; the knowledge root is named after its workspace). */
	name: string;
	workspaceId?: string;
	sessions30d: number;
	lastUsedAt: number;
}

/** `GET /api/new-session/suggestions` → workspaces from recent sessions, under configured roots or the home fallback. */
export interface NewSessionSuggestions {
	recent: WorkspaceUsage[];
	/** The roots a new directory may be created in (knowledge root, projects root). */
	roots: Array<{ path: string; kind: "knowledge" | "project" }>;
}

/** `GET /api/new-session/paths?q=` → bounded directory suggestions, plus an optional new or expanded typed path. */
export interface PathSuggestions {
	matches: Array<{ path: string; exists: true; reason?: string }>;
	/** A path that does not exist yet, built from `q` under the best-fitting root; created only on session start. */
	create?: { path: string; root: string };
	/** Absolute expansion of a typed `~/...` path, including when it does not exist yet. */
	typedPath?: string;
}

// ---- agenda (tasks-hub) --------------------------------------------------------------------------

export interface AgendaItem {
	/** tasks-hub task uid. */
	uid: string;
	title: string;
	list: string;
	/** Epoch ms. */
	due?: number;
	completed: boolean;
	/** `omp-console://session/<id>` when the task links to a session. */
	url?: string;
	sessionId?: string;
	/** The task's note text (user data; the agenda tool caps and labels it). */
	notes?: string;
}

/** `GET /api/agenda/today` → `{ items: AgendaItem[]; available: boolean; reason?: string }`. */
export interface AgendaToday {
	items: AgendaItem[];
	/** False when tasks-hub is not configured or unreachable; `reason` says which. */
	available: boolean;
	reason?: string;
}

/** `POST /api/agenda/todos` → 201 `AgendaItem`. Links the session when `sessionId` is given. */
export interface CreateAgendaTodoRequest {
	title: string;
	list?: string;
	due?: number;
	sessionId?: string;
	notes?: string;
}

/** `POST /api/agenda/todos/:uid/link` links an existing task to a newly started session. */
export interface LinkAgendaTodoRequest {
	sessionId: string;
}

/** `POST /api/agenda/todos/complete` completes the open task linked to this session. */
export interface CompleteAgendaTodoRequest {
	sessionId: string;
	/** A task from the agenda to complete; absent: the one open task linked to `sessionId`. */
	uid?: string;
}

export interface CompleteAgendaTodoResponse {
	uid: string;
	sessionId: string;
	completed: true;
	title?: string;
}

/** `POST /api/agenda/ask` (natural language from reminders-board or omp console) → `{ answer, sessionId }`. Runs a hidden
 * omp console session in the knowledge root with the agenda tools. */
export interface AgendaAskRequest {
	text: string;
}

export interface AgendaAskResponse {
	answer: string;
	sessionId: string;
}

/** Deep link form used everywhere: `omp-console://session/<id>`; the web app accepts `#session=<id>`. */
export const OMP_CONSOLE_SESSION_URL_PREFIX = "omp-console://session/";

// ---- session input: rewind and shell -------------------------------------------------------------

/** One earlier message the session can rewind to: a user request (omp's double-Escape rewind selector) or an agent answer. */
export interface RewindPoint {
	entryId: string;
	/** `user`: the session goes back to just before it and the text returns to the composer. `agent`: the answer stays, everything after it leaves the branch. */
	kind: "user" | "agent";
	preview: string;
	at: number;
}

/** Headless `/loop` progress. `iteration` counts automatic continuation prompts after the first turn. */
export interface LoopModeStatus {
	active: boolean;
	iteration: number;
	limit?: string;
	condition?: string;
	waitingForPrompt: boolean;
	message?: string;
}

/** Headless `/vibe` state and live worker ids in this session's registry scope. */
export interface VibeModeStatus {
	active: boolean;
	workers: string[];
}

/**
 * Wave-3 session ops, sent through `POST /api/sessions/:id/ops` like `SessionOp`:
 *  - `loop-mode`: omp `/loop` parsing, iteration/time limits, shell conditions and prompt continuation; `disable`
 *    remains available during a streaming turn.
 *  - `vibe-mode`: omp's restricted Vibe toolset, context and worker registry; exit tears down its owned scope and
 *    restores the previous tools.
 *  - `rewind-points`: user messages and agent answers on the current branch, newest first.
 *  - `rewind`: in place, as omp's rewind does. A user message: back to just before it, and its text returns for the
 *    composer. An agent answer: the answer (with the results of its tool calls) stays, everything after it leaves
 *    the branch; `keptThrough` is the new last entry and `text` is empty.
 *  - `shell`: omp's `!cmd` / `!!cmd` / `$code` / `$$code` input, run by omp's own executors; `excludeFromContext` is
 *    the doubled prefix.
 *  - `btw`: omp's side question; answered without entering the main context.
 *  - `handoff`: omp's `/handoff` (`session.handoff(focus)`): writes a handoff document from the live context and
 *    commits it as this session's compaction, then returns the document. Daemon-internal (project move, workspace
 *    switch): the HTTP ops route does not accept it.
 */
/** One process's Codex live session; transcript text is a bounded preview of the latest turn. */
export interface LiveModeStatus {
	active: boolean;
	phase: "idle" | "connecting" | "listening" | "speaking" | "working" | "muted" | "error";
	transcript?: { role: "user" | "assistant"; text: string; final: boolean };
	error?: string;
}

export const LIVE_INPUT_SAMPLE_RATE = 16_000;
export const LIVE_INPUT_MAX_FRAME_BYTES = 2_560;
export const LIVE_AUDIO_EVENT_MAX_CHARS = 16_000;

export interface DebugAdapterOption {
	name: string;
	command: string;
	available: boolean;
	reason?: string;
	languages: string[];
	fileTypes: string[];
}

export interface DebugSource {
	name?: string;
	path?: string;
}

export interface DebugThread {
	id: number;
	name: string;
}

export interface DebugStackFrame {
	id: number;
	name: string;
	line?: number;
	column?: number;
	source?: DebugSource;
}

export interface DebugScope {
	name: string;
	variablesReference: number;
	expensive?: boolean;
}

export interface DebugVariable {
	name: string;
	value: string;
	type?: string;
	variablesReference: number;
}

export interface DebugSessionSummary {
	id: string;
	adapter: string;
	cwd: string;
	program?: string;
	status: "launching" | "configuring" | "stopped" | "running" | "terminated";
	launchedAt: string;
	lastUsedAt: string;
	threadId?: number;
	frameId?: number;
	stopReason?: string;
	stopDescription?: string;
	frameName?: string;
	source?: DebugSource;
	line?: number;
	column?: number;
	breakpointCount: number;
	parentSessionId?: string;
	childSessionIds?: string[];
}
export type DebugDiagnosticAction =
	| "artifacts"
	| "performance-start"
	| "performance-stop"
	| "work"
	| "dump"
	| "memory"
	| "logs"
	| "raw-sse"
	| "remote-debugger"
	| "system"
	| "terminal"
	| "protocols"
	| "transcript"
	| "clear-cache";

export interface DebugDiagnosticDownload {
	filename: string;
	mimeType: string;
	byteLength: number;
	path: string;
	/** Present only when the file fits the bounded wire payload. */
	base64?: string;
	unavailableReason?: string;
}

export interface DebugDiagnosticSnapshot {
	action: DebugDiagnosticAction;
	text?: string;
	path?: string;
	download?: DebugDiagnosticDownload;
	cache?: { fileCount: number; totalBytes: number; oldestAt?: string };
	remoteDebugger?: { host: string; port: number; stopSupported: false };
	confirmationRequired?: boolean;
}

export type DebugDiagnosticsOp = {
	op: "debug-diagnostics";
	action: DebugDiagnosticAction;
	confirmed?: true;
};

export type DebugDiagnosticsResult = { ok: true; debugDiagnostic: DebugDiagnosticSnapshot };


export type DebugSessionOp =
	| { op: "debug"; action: "adapters" | "sessions" }
	| { op: "debug"; action: "select"; sessionId: string }
	| { op: "debug"; action: "launch"; program: string; args?: string[]; adapter?: string; confirmed: true }
	| { op: "debug"; action: "attach"; pid?: number; port?: number; host?: string; adapter?: string; confirmed: true }
	| { op: "debug"; action: "threads" | "stack" | "continue" | "step-over" | "step-in" | "step-out" | "pause" | "terminate" | "output" }
	| { op: "debug"; action: "scopes"; frameId?: number }
	| { op: "debug"; action: "variables"; reference: number }
	| { op: "debug"; action: "evaluate"; expression: string; context?: "watch" | "repl" | "hover"; frameId?: number };

export type DebugSessionOpResult =
	| { ok: true; debugAdapters: DebugAdapterOption[] }
	| { ok: true; debugSessions: DebugSessionSummary[]; activeSessionId?: string }
	| { ok: true; debugSession: DebugSessionSummary }
	| { ok: true; debugSession: DebugSessionSummary; debugThreads: DebugThread[] }
	| { ok: true; debugSession: DebugSessionSummary; debugStack: DebugStackFrame[] }
	| { ok: true; debugSession: DebugSessionSummary; debugScopes: DebugScope[] }
	| { ok: true; debugSession: DebugSessionSummary; debugVariables: DebugVariable[] }
	| { ok: true; debugSession: DebugSessionSummary; debugValue: string }
	| { ok: true; debugSession: DebugSessionSummary; debugOutput: string };

export type SessionOpV3 =
	| { op: "loop-mode"; action: "toggle"; args?: string }
	| { op: "loop-mode"; action: "disable" | "status" }
	| { op: "vibe-mode"; action: "toggle"; args?: string }
	| { op: "vibe-mode"; action: "disable" | "status" }
	| { op: "rewind-points" }
	| { op: "rewind"; entryId: string }
	| { op: "shell"; kind: "bash" | "python"; code: string; excludeFromContext: boolean }
	/** Queue follow-up prompt(s) after the current turn, matching omp `/queue`; images attach only to the first. */
	| { op: "queue"; text: string; images?: ImageContent[] }
	/** Pause every agent loop in this worker process at its next safe boundary; does not abort in-flight work. */
	| { op: "pause"; action: "pause" | "resume" | "toggle" }
	/** Current participants on this session's mandatory omp console room. */
	| { op: "collab-status" }
	/** `recordId`: a follow-up in that earlier side-question topic (omp's btw history); omitted starts a new topic. */
	| { op: "btw"; question: string; recordId?: string }
	| { op: "handoff"; focus: string }
	/** The session's open host questions (ask, tool approval, extension dialogs): answerable without joining the room. */
	| { op: "ui-requests" }
	/** Answer one open host question as the user would in the composer. `value` null cancels it. */
	| { op: "ui-answer"; reqId: string; value: string | null }
	/**
	 * 0-3 short next-step replies the user would plausibly send after the agent answer `entryId`, generated with the
	 * smol role and cached per entry. Empty when the entry is not the latest agent answer or generation fails.
	 */
	| { op: "quick-replies"; entryId: string }
	| { op: "skills-search"; query: string }
	| { op: "skills-installed" }
	| { op: "skills-install"; specs: string[]; global: boolean; approvalId?: string }
	| { op: "skills-update"; names: string[]; global: boolean; approvalId?: string }
	| { op: "git-view"; revision?: string }
	| { op: "git-diff"; revision?: string; path: string; area: "unstaged" | "staged" | "commit" }
	| { op: "git-stage"; action: "stage" | "unstage"; paths: string[] }
	| { op: "git-hunk"; action: "stage" | "unstage"; path: string; area: "unstaged" | "staged"; hunkIndex: number; patchHash: string }
	| { op: "git-commit"; message: string }
	| { op: "live-mode"; action: "start"; offer: string }
	| { op: "live-mode"; action: "stop" | "status" }
	| DebugDiagnosticsOp
	| DebugSessionOp
	| { op: "tan-start"; work: string }
	| { op: "omfg-generate"; requestId: string; complaint: string }
	| {
			op: "omfg-save";
			requestId: string;
			fileContent: string;
			scope: "project" | "user";
			overwrite: boolean;
			acceptUnvalidated: boolean;
	  }
	| { op: "omfg-cancel"; requestId: string }
	| { op: "cleanse-discover"; includeTests: boolean }
	| {
			op: "cleanse-start";
			runId: string;
			scope: { kind: "all" } | { kind: "checker"; id: string } | { kind: "request"; request: string };
			includeTests: boolean;
			maxAgents?: number;
			model?: string;
	  }
	| { op: "cleanse-cancel"; runId: string }
	| { op: "cleanse-state" };
export interface OmfgCandidate {
	requestId: string;
	name: string;
	fileContent: string;
	validated: boolean;
	validationMessage?: string;
}
export type OmfgSaveOutcome =
	| { kind: "saved"; path: string }
	| { kind: "confirm-overwrite"; path: string }
	| { kind: "confirm-unvalidated"; message: string };


export type CleanseRunStatus = "running" | "clean" | "unresolved" | "unsupported" | "cancelled" | "failed";

export interface CleanseStateSummary {
	runId: string;
	status: CleanseRunStatus;
	phase?: string;
}

export interface CleanseCheckerDescriptor {
	id: string;
	label: string;
	language: string;
	cwd: string;
	command: string;
}
export interface CleanseCheckerSummary {
	id: string;
	label: string;
	language?: string;
	cwd?: string;
	command?: string;
}

export interface CleanseSkippedChecker {
	label: string;
	language: string;
	reason: string;
}

export interface CleanseDiagnosticView {
	checker: string;
	file?: string;
	line?: number;
	code?: string;
	severity: "error" | "warning" | "info";
	message: string;
}

export interface CleanseCheckView {
	id: string;
	label: string;
	exitCode?: number | null;
	durationMs?: number;
	diagnosticCount?: number;
	diagnostics?: CleanseDiagnosticView[];
}

export interface CleanseAgentView {
	name: string;
	status: "running" | "completed" | "failed" | "aborted";
	files: string[];
	weight: number;
	progress?: {
		lastIntent?: string;
		currentTool?: string;
		recentOutput: string[];
		toolCount: number;
	};
	output?: string;
	error?: string;
}

export interface CleanseRunSnapshot {
	runId: string;
	status: CleanseRunStatus;
	phase?: string;
	error?: string;
	checkers: Array<{
		checker: CleanseCheckerSummary;
		status: "pending" | "running" | "completed";
		result?: CleanseCheckView;
	}>;
	agents: CleanseAgentView[];
	logs: string[];
	result?: {
		exitCode: number;
		status: Exclude<CleanseRunStatus, "running" | "failed">;
		checks: CleanseCheckView[];
		diagnostics: CleanseDiagnosticView[];
		skipped: string[];
		sessionFile?: string;
	};
}

export interface CollabSessionStatus {
	roomId: string;
	participants: Array<{ name: string; role: "host" | "guest"; readOnly?: boolean }>;
}

export type SessionOpV3Result =
	| { ok: true; loopMode: LoopModeStatus }
	| { ok: true; vibeMode: VibeModeStatus }
	/** `ui-answer`: accepted. */
	| { ok: true }
	| { ok: true; points: RewindPoint[] }
	| { ok: true; text: string; keptThrough?: string }
	| { ok: true; output: string; exitCode?: number }
	| { ok: true; answer: string; recordId?: string }
	| { ok: true; document: string }
	| { ok: true; uiRequests: PendingUiRequest[] }
	| { ok: true; replies: string[] }
	| { ok: true; jobId: string; agentId: string }
	| { ok: true; candidate: OmfgCandidate }
	| { ok: true; save: OmfgSaveOutcome }
	| { ok: true; checkers: CleanseCheckerDescriptor[]; skipped: CleanseSkippedChecker[] }
	| { ok: true; runId: string }
	| { ok: true; state: CleanseRunSnapshot | null }
	| { ok: true; skillSearch: SkillSearchResult }
	| { ok: true; installedSkills: InstalledSkill[] }
	| { ok: true; skillChanges: SkillChange[]; warnings: string[]; installedSkills: InstalledSkill[] }
	| { ok: true; git: GitStatusSnapshot }
	| { ok: true; gitDiff: GitFileDiff }
	| { ok: true; paused: boolean; pausedAt?: number }
	| { ok: true; queued: number }
	| ({ ok: true } & CollabSessionStatus)
	| { ok: true; liveMode: LiveModeStatus; browserAnswer?: string }
	| DebugDiagnosticsResult
	| DebugSessionOpResult;

export interface SkillSearchHit {
	scope: string;
	name: string;
	version: string;
	description?: string;
	weeklyDownloads: number;
	updatedAt: number;
	publisher: { username: string };
	keywords: string[];
	deprecated?: string;
}

export interface SkillSearchResult {
	hits: SkillSearchHit[];
	page: number;
	perPage: number;
	total: number;
}

export interface InstalledSkill {
	id: string;
	range?: string;
	version?: string;
	scope: "project" | "user";
	stored: boolean;
}

export interface SkillChange {
	id: string;
	from?: string;
	to: string;
	range: string;
	restored: boolean;
}

export interface GitChangedFile {
	path: string;
	origPath?: string;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
	area: "unstaged" | "staged" | "commit";
	additions?: number;
	deletions?: number;
}

export interface GitCommitSummary {
	sha: string;
	shortSha: string;
	subject: string;
	body: string;
	authorName: string;
	authorDate: string;
	parents: string[];
}

export interface GitStatusSnapshot {
	branch: string | null;
	clean: boolean;
	readOnly: boolean;
	revision?: string;
	unstaged: GitChangedFile[];
	staged: GitChangedFile[];
	commitFiles: GitChangedFile[];
	headCommit: GitCommitSummary | null;
}

export interface GitImagePreview {
	data: string;
	mimeType: "image/png";
	sourceMimeType: string;
	widthPx: number;
	heightPx: number;
	byteLength: number;
}

export interface GitAssetPreview {
	kind: "empty" | "text" | "image" | "binary" | "tooLarge" | "lfsMissing";
	byteLength?: number;
	oid?: string;
	image?: GitImagePreview;
}

export interface GitDiffLine {
	kind: "add" | "del" | "context";
	text: string;
}

export interface GitDiffHunk {
	header: string;
	patchHash: string;
	lines: GitDiffLine[];
}

export type GitFileDiff =
	| { kind: "text"; hunks: GitDiffHunk[]; canPatch: boolean }
	| { kind: "asset"; old: GitAssetPreview; new: GitAssetPreview };

/**
 * One open host question, as the collab `ui-request` carries it (packages/wire `CollabUiRequest`): `select` is answered
 * with one option label (a tap), `editor` with free text. `initialIndex` is the recommended option; `checkedIndices` /
 * `markableCount` mark a multi-select in progress (answering toggles one option; the host re-asks).
 */
export interface PendingUiRequest {
	reqId: string;
	kind: "select" | "editor";
	title: string;
	options?: Array<{ label: string; description?: string }>;
	initialIndex?: number;
	checkedIndices?: number[];
	markableCount?: number;
	helpText?: string;
	prefill?: string;
	/** Epoch ms the host opened it. */
	at: number;
}

// ---- keybindings -----------------------------------------------------------------------------------

/**
 * `GET /api/keybindings` → omp's own app keybindings (`packages/tui/src/app-keybindings.ts` defaults merged with the
 * user's omp keybinding overrides, resolved by omp's keybinding manager), plus the double-Escape setting. Keys use omp's
 * notation (`ctrl+p`, `alt+shift+p`, `escape`). The web maps them to deck actions; `alt+<letter>` is matched on the
 * physical key (macOS Option produces special characters).
 */
export interface KeybindingsResponse {
	bindings: Record<string, string[]>;
	doubleEscapeAction: "rewind" | "tree" | "none";
}

// ---- machines (peer daemons) ------------------------------------------------------------------------

/**
 * Another omp console daemon this one reaches over the tailnet (`--peer <id>=<https url>`, e.g. the VPS). The browser only
 * ever talks to the daemon that served it: `/api/peers/<id>/<rest>` is forwarded to the peer's `/api/<rest>` and the
 * WebSocket path `/peers/<id>/r/<rest>` to the peer's relay `/r/<rest>`, so the UI treats a peer like a second
 * daemon behind a path prefix.
 */
export interface PeerInfo {
	/** Short machine id used in session keys and labels (`vps`). */
	id: string;
	/** Display name (`VPS`). */
	name: string;
	reachable: boolean;
	/** Why it is not reachable, when it is not. */
	reason?: string;
}

/** `GET /api/peers` → this daemon's own machine id and name plus its peers. */
export interface PeersResponse {
	self: { id: string; name: string };
	peers: PeerInfo[];
}
