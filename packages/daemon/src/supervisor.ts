/**
 * Worker supervisor: one `packages/session-host` process per AgentSession (contract: `@omp-console/protocol` worker.ts).
 *
 * Lifecycle per worker: `starting` -> (`ready`) `idle|streaming|asking` -> `stopped` (we asked) or `crashed`
 * (it exited on its own). A crashed worker is relaunched up to `restartBackoffMs.length` times (default 2)
 * with the given backoff, resuming its session file when it has one, then stays `crashed`.
 *
 * POSIX workers run in their own process group; Windows workers are hidden and their trees are terminated with taskkill.
 * Room secrets travel on the worker's first stdin line, never in env.
 */
import { DEFAULT_OVERNIGHT_POLICY, LIVE_AUDIO_EVENT_MAX_CHARS, LIVE_INPUT_MAX_FRAME_BYTES } from "@omp-console/protocol";
import type {
	ApiError,
	CatalogResponse,
	CreateSessionRequest,
	ExtensionUiState,
	KeyPoints,
	LiveModeStatus,
	LoopModeStatus,
	VibeModeStatus,
	PluginInfo,
	SessionOp,
	SessionOpResult,
	SessionOpV3,
	SessionOpV3Result,
	SessionState,
	SessionSummary,
	SleepCandidate,
	SetAgentThinkingRequest,
	SpawnAgentRequest,
	WorkerLaunchSecrets,
	WorkerCommand,
	WorkerHealth,
	WorkerModelResult,
	WorkerRequestResult,
	WorkerStatus,
	WorkerAbortResult,
	OvernightSummary,
	WorkerOvernightOptions,
} from "@omp-console/protocol";
import { ROOM_ID_BYTES, ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { totalmem } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { sessionPathKey } from "./session-key";

/** Live-session limit for one daemon, from its machine's memory: one slot per 1.5 GB, at least 8, at most 32.
 * Each daemon counts only the sessions it runs itself (a 36 GB Mac gets 25; a 7.7 GB VPS keeps 8). A worker idles at
 * about 130 MB and reaches 300-450 MB when busy, before subagents. */
export function defaultMaxWorkers(memoryBytes: number = totalmem()): number {
	return Math.min(32, Math.max(8, Math.floor(memoryBytes / 1.5e9)));
}
export const DEFAULT_MAX_WORKERS = defaultMaxWorkers();
export const DEFAULT_SLEEP_AFTER_MINUTES = 120;
export const DEFAULT_STALLED_AFTER_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_TERM_GRACE_MS = 3_000;
const FIRST_STATE_WAIT_MS = 1_000;
/** How long a Windows rss read (one PowerShell process) is reused by health polls. */
const WINDOWS_RSS_CACHE_MS = 10_000;
/** Longest a Windows rss read may take before health reports 0 instead of waiting. */
const WINDOWS_RSS_TIMEOUT_MS = 5_000;
/** Longest #terminate waits for a Windows worker's exit after taskkill, and again after the direct kill fallback. */
const WINDOWS_KILL_EXIT_WAIT_MS = 10_000;
const DEFAULT_RESTART_BACKOFF_MS: readonly number[] = [500, 2_000];
const DEFAULT_MODEL_CHANGE_TIMEOUT_MS = 10_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_OP_TIMEOUT_MS = 30_000;
/** Skills may spend two minutes awaiting approval and additional time resolving and downloading packages. */
const DEFAULT_SKILLS_TIMEOUT_MS = 300_000;
/** Compaction summarises the whole conversation with a model call. */
const DEFAULT_COMPACT_TIMEOUT_MS = 180_000;
const DEFAULT_USAGE_TIMEOUT_MS = 30_000;
const DEFAULT_SUMMARIZE_TIMEOUT_MS = 90_000;
const DEFAULT_PLUGINS_TIMEOUT_MS = 30_000;
const DEFAULT_BEFORE_STOP_TIMEOUT_MS = 20_000;
const EMPTY_EXT_UI: ExtensionUiState = { statuses: [], widgets: [], panels: [], notifications: [] };

export class SupervisorError extends Error {
	constructor(
		readonly code: ApiError["code"],
		message: string,
		readonly sleepCandidate?: SleepCandidate,
	) {
		super(message);
		this.name = "SupervisorError";
	}
}

export interface NotifyEvent {
	sessionId: string;
	title?: string;
	reason: Extract<WorkerStatus, { t: "notify" }>["reason"];
	summary?: string;
	durationMs?: number;
}

/** One `{t:"agent"}` worker line: a subagent lifecycle transition in a session (see the daemon README). */
export type AgentEvent = Extract<WorkerStatus, { t: "agent" }>;

/** Called for every subagent lifecycle line of every worker, in the order the worker emitted them. */
export type AgentEventListener = (sessionId: string, event: AgentEvent) => void;

/** A policy entry as the daemon pushes it to every worker (`quota-policy`). */
export type QuotaPolicyEntry = Extract<WorkerCommand, { t: "quota-policy" }>["providers"][number];

/** Called with the whole extension UI state of a session each time its worker publishes one. */
export type ExtUiListener = (sessionId: string, state: ExtensionUiState) => void;

/** One finished model request of any agent in a session, for the quota burn estimate. */
export type UsageSampleEvent = Extract<WorkerStatus, { t: "usage-sample" }>;
export type UsageSampleListener = (sessionId: string, sample: UsageSampleEvent) => void;

/** The session's title changed (generated, refined or renamed); also stored on the session summary. */
export type TitleListener = (sessionId: string, title: string) => void;

export interface CrashEvent {
	sessionId: string;
	title?: string;
	exitCode: number | null;
	signal: string | null;
	/** Restarts performed so far (not counting the one that may follow). */
	restarts: number;
	willRestart: boolean;
}

export interface SupervisorOptions {
	/** Executable plus leading args; the contract flags are appended. */
	workerCmd: string[];
	/** Relay URL workers connect to (called at spawn time; the port may not be known at construction). */
	relayUrl: () => string;
	/** Creates a process-lifetime daemon credential; passed only in the launch stdin record. */
	issueWorkerToken?: (sessionId: string) => string;
	/** Called with a worker's session file once it reports ready: the daemon hosts that file from now on. */
	onHostedSessionFile?: (sessionFile: string) => void;
	/** Revokes the process credential as soon as that worker exits. */
	revokeWorkerToken?: (token: string) => void;
	maxWorkers?: number;
	sleepAfterMinutes?: number;
	/** Sleep timer cadence; overridable for deterministic lifecycle tests. */
	sleepPollMs?: number;
	/** Returns true when external policy (for example a connected guest) forbids sleep. */
	sleepBlocked?: (session: SessionSummary) => boolean | Promise<boolean>;
	/** Feature gates for worker-scoped tools; false in a fresh daemon. */
	agendaToolsEnabled?: boolean;
	computerUseEnabled?: boolean;
	/** Host platform used for worker scheduling wrappers; defaults to process.platform. */
	platform?: string;
	/** Test seam for Linux's optional ionice executable; defaults to Bun.which("ionice"). */
	ioniceAvailable?: boolean;
	/** Pin-store adapter; absent stores treat every session as unpinned. */
	isPinned?: (sessionId: string) => boolean;
	stalledAfterMs?: number;
	readyTimeoutMs?: number;
	/** Maximum wait for a worker's model-set/model-error reply. */
	modelChangeTimeoutMs?: number;
	/** Maximum wait for the capability catalog (default 10 s). */
	catalogTimeoutMs?: number;
	/** Maximum wait for a slash command to be admitted (default 30 s). */
	commandTimeoutMs?: number;
	/** Maximum wait for a spawned agent to be registered (default 30 s). */
	spawnTimeoutMs?: number;
	/** Maximum wait for a session operation (default 30 s; compaction and skills get dedicated limits). */
	sessionOpTimeoutMs?: number;
	/** Maximum wait for skill install/update, including the 120 s script approval window (default 5 min). */
	skillsTimeoutMs?: number;
	/** Maximum wait for a manual compaction (default 180 s). */
	compactTimeoutMs?: number;
	/** Maximum wait for the usage reports (default 30 s). */
	usageTimeoutMs?: number;
	/** Maximum wait for key points (default 90 s). */
	summarizeTimeoutMs?: number;
	/** Maximum wait for the plugin list or a plugin toggle (default 30 s). */
	pluginsTimeoutMs?: number;
	/** Writes a model-free history checkpoint before the worker is put to sleep. */
	beforeSleep?: (sessionId: string) => Promise<void> | void;

	/**
	 * Runs while a session is being stopped by `stop(id)`, before its worker is told to stop, so the history area can
	 * write the session's key points while the worker still holds the transcript. Bounded by `beforeStopTimeoutMs`.
	 */
	beforeStop?: (sessionId: string) => Promise<void>;
	beforeStopTimeoutMs?: number;
	/** Time between the `stop` command and SIGTERM. */
	stopGraceMs?: number;
	/** Time between SIGTERM and SIGKILL. */
	termGraceMs?: number;
	/** Delay before each automatic restart; its length is the restart budget. */
	restartBackoffMs?: readonly number[];
	/** Extra worker env (for example an isolated `PI_CONFIG_DIR` in tests). */
	env?: Record<string, string>;
	onNotify?: (event: NotifyEvent) => void;
	onCrash?: (event: CrashEvent) => void;
	onOvernightStatus?: (sessionId: string, status: Extract<WorkerStatus, { t: "state" | "turn-end" | "auto-answer" }>) => void;
	/** Called when an initial handoff prompt is rejected; consumers may filter for active overnight sessions. */
	onOvernightPromptFailure?: (sessionId: string, message: string) => void;
	onAgentEvent?: AgentEventListener;
	onExtUi?: ExtUiListener;
	onUsageSample?: UsageSampleListener;
	onTitle?: TitleListener;
	onLiveAudio?: (sessionId: string, audio: string) => void;
	onLiveLevels?: (sessionId: string, input: number, output: number) => void;
	onLiveModeStatus?: (sessionId: string, status: LiveModeStatus) => void;
	/** Persists each registered-session set or state change. */
	onSessionsChanged?: (sessions: SessionSummary[]) => Promise<void> | void;
	/**
	 * A session was created and registered (before its handoff prompt is sent), so per-session baselines (drift) are
	 * taken before the agent changes anything. Awaited; a rejection is logged, never fails the create.
	 */
	onCreated?: (summary: SessionSummary, request: CreateSessionRequest) => Promise<void> | void;
	log?: (message: string) => void;
}

export interface RoomSecrets {
	roomId: string;
	key: Uint8Array;
	writeToken: Uint8Array;
}

type Subprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

/**
 * Writes one line to a worker's stdin. A synchronous failure still throws to the caller. A worker that has already
 * exited closes the pipe, and on Windows that surfaces as an EPIPE rejection of write()/flush()/end() rather than a
 * throw, which went unobserved (an unhandled error in the Windows test run); those promises are observed here.
 */
function writeWorkerLine(stdin: Subprocess["stdin"], line: string, end = false): void {
	ignoreRejection(stdin.write(line));
	ignoreRejection(stdin.flush());
	if (end) ignoreRejection(stdin.end());
}

function ignoreRejection(result: unknown): void {
	if (result instanceof Promise) result.catch(() => {});
}
interface PendingModelChange {
	id: string;
	response: PromiseWithResolvers<WorkerModelResult>;
	timer: Timer;
}

/** A request-style command (`catalog`, `run-command`, `spawn-agent`) waiting for its reply, matched by `id`. */
interface PendingRequest {
	response: PromiseWithResolvers<WorkerRequestResult>;
	timer: Timer;
}

interface PendingAbort {
	id: string;
	response: PromiseWithResolvers<WorkerAbortResult>;
	timer: Timer;
}

/** How the first launch starts the session; restarts resume the reported session file instead. */
interface LaunchSpec {
	resume?: string;
	/** `<sessionFile>[:<entryId>]` */
	fork?: string;
	model?: string;
	/** Restricted tool set; kept on restarts too (unlike resume/fork/model, it is a property of the session). */
	tools?: readonly string[];
	overnight?: WorkerOvernightOptions;
}

export interface WorkerLaunchPlan {
	command: string[];
	env: Record<string, string | undefined>;
}

/** Builds the exact argv and environment passed to Bun.spawn for a worker launch. */
export function buildWorkerLaunchPlan(options: {
	workerCmd: readonly string[];
	cwd: string;
	relayUrl: string;
	roomId: string;
	registered: boolean;
	sessionFile?: string;
	spec: {
		resume?: string;
		fork?: string;
		model?: string;
		tools?: readonly string[];
		overnight?: WorkerOvernightOptions;
	};
	env: Readonly<Record<string, string | undefined>>;
	agendaToolsEnabled?: boolean;
	computerUseEnabled?: boolean;
	platform?: string;
	ioniceAvailable?: boolean;
}): WorkerLaunchPlan {
	const env = { ...options.env };
	delete env.OMP_CONSOLE_ROOM_KEY;
	delete env.OMP_CONSOLE_WRITE_TOKEN;
	const overnight = options.spec.overnight;
	if (overnight) {
		env.GIT_TERMINAL_PROMPT = "0";
		env.GIT_SSH_COMMAND ??= "ssh -o BatchMode=yes";
		env.GH_PROMPT_DISABLED = "1";
		env.npm_config_yes = "true";
		env.HOMEBREW_NO_AUTO_UPDATE = "1";
		env.OMP_CONSOLE_OVERNIGHT = "1";
	}
	const command = [...options.workerCmd, "--cwd", options.cwd, "--relay", options.relayUrl, "--room", options.roomId];
	if (options.agendaToolsEnabled !== undefined) {
		command.push(
			"--agenda-tools",
			options.agendaToolsEnabled ? "on" : "off",
			"--computer-use",
			options.computerUseEnabled === true ? "on" : "off",
		);
	}
	const resume = options.registered ? options.sessionFile : undefined;
	if (resume) {
		command.push("--resume", resume);
	} else {
		if (options.spec.resume) command.push("--resume", options.spec.resume);
		if (options.spec.fork) command.push("--fork", options.spec.fork);
		if (options.spec.model) command.push("--model", options.spec.model);
	}
	if (options.spec.tools) command.push("--tools", options.spec.tools.join(","));
	const platform = options.platform ?? process.platform;
	if (overnight && overnight.quiet !== "normal" && platform !== "win32") {
		// Not every Linux has /usr/bin/nice (e.g. NixOS); resolve it from PATH there.
		const niceBin = platform === "darwin" ? "/usr/bin/nice" : (Bun.which("nice") ?? "nice");
		const nice = [niceBin, "-n", overnight.quiet === "quiet" ? "10" : "15"];
		if (platform === "darwin") {
			return {
				command: [
					"/usr/sbin/taskpolicy",
					"-c",
					overnight.quiet === "quiet" ? "utility" : "background",
					...nice,
					...command,
				],
				env,
			};
		}
		if (platform === "linux") {
			const ioniceAvailable = options.ioniceAvailable ?? Bun.which("ionice") !== null;
			return {
				command: [
					...(overnight.quiet === "silent" && ioniceAvailable ? ["ionice", "-c3"] : []),
					...nice,
					...command,
				],
				env,
			};
		}
	}
	return { command, env };
}

class Worker {
	id: string;
	proc: Subprocess | undefined;
	restarts = 0;
	readonly cwd: string;
	readonly secrets: RoomSecrets;
	readonly spec: LaunchSpec;
	/** Set once the worker reported a session file; restarts resume it instead of repeating new/fork args. */
	sessionFile: string | undefined;
	title: string | undefined;
	model: string | undefined;
	thinkingLevel: string | undefined;
	rootAgentId: string | undefined;
	state: SessionState = "starting";
	awaitingAnswer = false;
	pendingQuestion: string | undefined;
	pendingKind: "ask" | "approval" | undefined;
	paused = false;
	pausedAt: number | undefined;
	/** When the running turn began (it spans streaming and waiting on an answer); undefined while idle. */
	turnStartedAt: number | undefined;
	lastTurnDurationMs: number | undefined;
	goalActive = false;
	goalObjective: string | undefined;
	loopMode: LoopModeStatus | undefined;
	vibeMode: VibeModeStatus | undefined;
	liveMode: LiveModeStatus | undefined;
	modeStatusSignature = "";
	agentCount = 0;
	/** Internal session (quick-ask): excluded from the session lists. */
	hidden = false;
	/** A move is in progress: the worker holds prompts and spawns. */
	frozen = false;
	idempotencyKey: string | undefined;
	/** The newest whole-state `ext-ui` line of the current process. */
	extUi: ExtensionUiState | undefined;
	readonly createdAt: number;
	startedAt = Date.now();
	lastEventAt = Date.now();
	lastPid = 0;
	overnight: OvernightSummary | undefined;
	deviceToken: string | undefined;
	readonly modelChanges = new Map<string, PendingModelChange>();
	readonly requests = new Map<string, PendingRequest>();
	abortRequest: PendingAbort | undefined;
	/** True once the first `ready` arrived; before that the worker is only a candidate. */
	registered = false;
	/** Settles when both output pipes of the current process hit EOF. */
	pumps: Promise<unknown> = Promise.resolve();
	/** Resolved by the first `state` line of the first launch, so create() can return model and title. */
	firstState: PromiseWithResolvers<void> = Promise.withResolvers<void>();
	stopping = false;
	fatalMessage: string | undefined;
	crashReason: string | undefined;
	restartTimer: Timer | undefined;
	readyTimer: Timer | undefined;
	ready: PromiseWithResolvers<void> | undefined = Promise.withResolvers<void>();
	/** Resolved after a worker leaves `#stopping`, including sleep rollback paths. */
	stopped: PromiseWithResolvers<void> = Promise.withResolvers<void>();
	/** Resolved when the current process exited. */
	exited: PromiseWithResolvers<void> = Promise.withResolvers<void>();

	constructor(id: string, cwd: string, secrets: RoomSecrets, spec: LaunchSpec, sessionFile: string | undefined, createdAt = Date.now()) {
		this.id = id;
		this.cwd = cwd;
		this.secrets = secrets;
		this.spec = spec;
		this.sessionFile = sessionFile;
		this.createdAt = createdAt;
		// A rejection nobody awaits (restarts) must not become an unhandled rejection.
		this.ready?.promise.catch(() => {});
	}
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function isModelResult(value: unknown): value is WorkerModelResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as { t?: unknown; id?: unknown; agentId?: unknown; model?: unknown; thinkingLevel?: unknown; message?: unknown };
	if (typeof result.id !== "string" || typeof result.agentId !== "string") return false;
	if (result.t === "model-set") {
		return typeof result.model === "string" && (result.thinkingLevel === undefined || typeof result.thinkingLevel === "string");
	}
	return result.t === "model-error" && typeof result.message === "string";
}

function isAbortResult(value: unknown): value is WorkerAbortResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as { t?: unknown; id?: unknown; aborted?: unknown };
	return result.t === "aborted" && typeof result.id === "string" && typeof result.aborted === "boolean";
}
function isRequestResult(value: unknown): value is WorkerRequestResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as {
		t?: unknown;
		id?: unknown;
		code?: unknown;
		message?: unknown;
		agentId?: unknown;
		catalog?: unknown;
		result?: unknown;
		reports?: unknown;
		keyPoints?: unknown;
		plugins?: unknown;
	};
	if (typeof result.id !== "string") return false;
	switch (result.t) {
		case "catalog":
			return typeof result.catalog === "object" && result.catalog !== null;
		case "accepted":
			return true;
		case "spawned":
			return typeof result.agentId === "string";
		case "session-op":
			return typeof result.result === "object" && result.result !== null;
		case "usage":
			return Array.isArray(result.reports);
		case "key-points":
			return typeof result.keyPoints === "object" && result.keyPoints !== null;
		case "plugins":
			return Array.isArray(result.plugins);
		case "request-error":
			return (
				typeof result.message === "string" &&
				(result.code === "bad-request" || result.code === "not-found" || result.code === "conflict" || result.code === "internal")
			);
		default:
			return false;
	}
}

function isAgentStatus(value: unknown): value is AgentEvent {
	if (typeof value !== "object" || value === null) return false;
	const line = value as { t?: unknown; agentId?: unknown; profile?: unknown; status?: unknown; parentId?: unknown; summary?: unknown };
	return (
		line.t === "agent" &&
		typeof line.agentId === "string" &&
		typeof line.profile === "string" &&
		(line.status === "started" || line.status === "completed" || line.status === "failed" || line.status === "aborted") &&
		(line.parentId === undefined || typeof line.parentId === "string") &&
		(line.summary === undefined || typeof line.summary === "string")
	);
}

function isExtUiStatus(value: unknown): value is Extract<WorkerStatus, { t: "ext-ui" }> {
	if (typeof value !== "object" || value === null) return false;
	const state = (value as { state?: unknown }).state;
	if (typeof state !== "object" || state === null) return false;
	const record = state as Record<string, unknown>;
	return (
		Array.isArray(record.statuses) &&
		Array.isArray(record.widgets) &&
		Array.isArray(record.panels) &&
		Array.isArray(record.notifications)
	);
}

function isUsageSampleStatus(value: unknown): value is UsageSampleEvent {
	if (typeof value !== "object" || value === null) return false;
	const line = value as Record<string, unknown>;
	return (
		typeof line.agentId === "string" &&
		typeof line.provider === "string" &&
		typeof line.model === "string" &&
		typeof line.tokens === "number" &&
		typeof line.cacheReadTokens === "number" &&
		typeof line.at === "number"
	);
}

function isStatus(value: unknown): value is WorkerStatus {
	if (typeof value !== "object" || value === null) return false;
	const t = (value as { t?: unknown }).t;
	if (t === "agent") return isAgentStatus(value);
	if (t === "turn-end") {
		const turn = (value as { lastTurn?: unknown }).lastTurn;
		if (typeof turn !== "object" || turn === null || Array.isArray(turn)) return false;
		const lastTurn = turn as Record<string, unknown>;
		return typeof lastTurn.endedAt === "number" && Number.isFinite(lastTurn.endedAt) &&
			typeof lastTurn.stopReason === "string" && typeof lastTurn.toolCalls === "number" && Number.isSafeInteger(lastTurn.toolCalls) &&
			lastTurn.toolCalls >= 0 && typeof lastTurn.textTail === "string" && lastTurn.textTail.length <= 500 &&
			(lastTurn.errorMessage === undefined || typeof lastTurn.errorMessage === "string") &&
			(lastTurn.retryAfterMs === undefined || (typeof lastTurn.retryAfterMs === "number" && Number.isFinite(lastTurn.retryAfterMs) && lastTurn.retryAfterMs >= 0));
	}
	if (t === "auto-answer") {
		const line = value as { at?: unknown; question?: unknown; answer?: unknown };
		return typeof line.at === "number" && Number.isFinite(line.at) && typeof line.question === "string" && typeof line.answer === "string";
	}
	if (t === "agent") return isAgentStatus(value);
	if (t === "ext-ui") return isExtUiStatus(value);
	if (t === "usage-sample") return isUsageSampleStatus(value);
	if (t === "title") return typeof (value as { title?: unknown }).title === "string";
	if (t === "live-audio") {
		const audio = (value as { audio?: unknown }).audio;
		return typeof audio === "string" && audio.length > 0 && audio.length <= LIVE_AUDIO_EVENT_MAX_CHARS &&
			/^[A-Za-z0-9+/]+={0,2}$/.test(audio);
	}
	if (t === "live-levels") {
		const { input, output } = value as { input?: unknown; output?: unknown };
		return typeof input === "number" && Number.isFinite(input) && input >= 0 && input <= 1 &&
			typeof output === "number" && Number.isFinite(output) && output >= 0 && output <= 1;
	}
	return t === "ready" || t === "state" || t === "notify" || t === "fatal";
}

export class Supervisor {
	readonly stalledAfterMs: number;
	readonly #opts: SupervisorOptions;
	readonly #workers = new Map<string, Worker>();
	readonly #candidates = new Set<Worker>();
	/** Creates in flight or done, by idempotency key, so a retried create returns the same session. */
	readonly #byIdempotencyKey = new Map<string, Promise<SessionSummary>>();
	readonly #stopping = new Set<Worker>();
	readonly #asleep = new Map<string, SessionSummary>();
	readonly #waking = new Map<string, Promise<SessionSummary>>();
	readonly #wakingSummaries = new Map<string, SessionSummary>();
	readonly #backoff: readonly number[];
	#sleepAfterMs: number;
	#sleepTimer: Timer | undefined;
	#sleepSweepPending = false;
	#closed = false;
	/** The newest policy pushed with `pushQuotaPolicy`; every worker gets it when it becomes ready. */
	#quotaPolicy: readonly QuotaPolicyEntry[] | undefined;

	constructor(options: SupervisorOptions) {
		this.#opts = options;
		this.stalledAfterMs = options.stalledAfterMs ?? DEFAULT_STALLED_AFTER_MS;
		this.#backoff = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
		this.#sleepAfterMs = (options.sleepAfterMinutes ?? DEFAULT_SLEEP_AFTER_MINUTES) * 60_000;
		this.#refreshSleepTimer();
	}

	async #notifySessionsChanged(durable = false): Promise<void> {
		try {
			const pending = this.#opts.onSessionsChanged?.(this.list());
			if (pending === undefined) return;
			if (durable) {
				await pending;
				return;
			}
			void pending.catch(error =>
				this.#log(`session persistence failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		} catch (error) {
			this.#log(`session persistence failed: ${error instanceof Error ? error.message : String(error)}`);
			if (durable) throw error;
		}
	}

	#log(message: string): void {
		this.#opts.log?.(message);
	}

	get sleepAfterMinutes(): number {
		return this.#sleepAfterMs / 60_000;
	}

	setSleepAfterMinutes(minutes: number): void {
		if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > Math.floor(Number.MAX_SAFE_INTEGER / 60_000)) {
			throw new SupervisorError("bad-request", "sleep-after minutes must be a non-negative safe integer");
		}
		this.#sleepAfterMs = minutes * 60_000;
		this.#refreshSleepTimer();
	}

	#refreshSleepTimer(): void {
		if (this.#sleepTimer !== undefined) clearInterval(this.#sleepTimer);
		this.#sleepTimer = undefined;
		if (this.#closed || this.#sleepAfterMs === 0) return;
		this.#sleepTimer = setInterval(() => {
			void this.#sleepIdleSessions().catch(error => this.#log(`automatic sleep sweep failed: ${error instanceof Error ? error.message : String(error)}`));
		}, this.#opts.sleepPollMs ?? 60_000);
	}

	async #isSleepable(worker: Worker, allowStopping = false): Promise<boolean> {
		if (
			(!allowStopping && worker.stopping) ||
			this.#waking.has(worker.id) ||
			worker.state !== "idle" ||
			worker.awaitingAnswer ||
			worker.hidden ||
			worker.frozen ||
			worker.paused ||
			(worker.overnight !== undefined && !["complete", "deadline", "blocked", "stopped"].includes(worker.overnight.phase)) ||
			worker.requests.size > 0 ||
			worker.sessionFile === undefined
		) {
			return false;
		}
		const summary = this.#summary(worker);
		if (summary.pinned === true) return false;
		try {
			if (!(await Bun.file(worker.sessionFile).exists())) return false;
			return !(await this.#opts.sleepBlocked?.(summary));
		} catch (error) {
			this.#log(`sleep eligibility check for ${worker.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async sleep(id: string): Promise<boolean> {
		if (this.#waking.has(id)) throw new SupervisorError("conflict", `session ${id} is waking`);
		if (this.#asleep.has(id)) return true;
		const worker = this.#workers.get(id);
		if (!worker) return false;
		if (!(await this.#isSleepable(worker))) {
			throw new SupervisorError("conflict", `session ${id} is not eligible for sleep`);
		}
		const slept = await this.#sleepWorker(worker);
		if (this.#waking.has(id)) throw new SupervisorError("conflict", `session ${id} is waking`);
		if (!slept && this.#workers.get(id) === worker) throw new SupervisorError("conflict", `session ${id} is no longer eligible for sleep`);
		return slept;
	}

	async sleepCandidate(): Promise<SleepCandidate | undefined> {
		const now = Date.now();
		let candidate: SleepCandidate | undefined;
		let oldestActivity = Number.POSITIVE_INFINITY;
		for (const worker of this.#workers.values()) {
			if (worker.state !== "idle" || worker.lastEventAt >= oldestActivity || !(await this.#isSleepable(worker))) continue;
			oldestActivity = worker.lastEventAt;
			candidate = {
				id: worker.id,
				title: worker.title ?? worker.cwd.split(/[\\/]/).at(-1) ?? worker.cwd,
				idleMinutes: Math.max(0, Math.floor((now - worker.lastEventAt) / 60_000)),
			};
		}
		return candidate;
	}

	async #sleepIdleSessions(): Promise<void> {
		if (this.#sleepSweepPending || this.#closed || this.#sleepAfterMs === 0) return;
		this.#sleepSweepPending = true;
		try {
			const now = Date.now();
			for (const worker of this.#workers.values()) {
				if (now - worker.lastEventAt < this.#sleepAfterMs || !(await this.#isSleepable(worker))) continue;
				await this.#sleepWorker(worker);
			}
		} finally {
			this.#sleepSweepPending = false;
		}
	}

	async #sleepWorker(worker: Worker): Promise<boolean> {
		if (this.#workers.get(worker.id) !== worker || worker.state !== "idle" || worker.stopping) return false;
		if (!(await this.#isSleepable(worker))) return false;
		const beforeSleep = this.#opts.beforeSleep;
		if (beforeSleep !== undefined) {
			// A stalled transcript read must not wedge the sleep sweep or `POST /sleep`.
			await waitOrTimeout(
				Promise.resolve()
					.then(() => beforeSleep(worker.id))
					.catch((err: unknown) =>
						this.#log(`before-sleep handler for ${worker.id} failed: ${err instanceof Error ? err.message : String(err)}`),
					),
				this.#opts.beforeStopTimeoutMs ?? DEFAULT_BEFORE_STOP_TIMEOUT_MS,
			);
		}
		if (
			this.#workers.get(worker.id) !== worker ||
			worker.state !== "idle" ||
			worker.requests.size > 0 ||
			worker.stopping ||
			!(await this.#isSleepable(worker))
		) {
			return false;
		}
		worker.stopping = true;
		this.#workers.delete(worker.id);
		const asleep = this.#asleepSummary(this.#summary(worker));
		this.#asleep.set(worker.id, asleep);
		worker.stopped = Promise.withResolvers<void>();
		this.#stopping.add(worker);
		const releaseStopping = (): void => {
			this.#stopping.delete(worker);
			worker.stopped.resolve();
		};
		const rollback = (): void => {
			this.#asleep.delete(worker.id);
			this.#workers.set(worker.id, worker);
			worker.stopping = false;
		};
		try {
			await this.#notifySessionsChanged(true);
		} catch (error) {
			rollback();
			releaseStopping();
			void this.#notifySessionsChanged();
			throw error;
		}
		if (!(await this.#isSleepable(worker, true))) {
			rollback();
			try {
				await this.#notifySessionsChanged(true);
			} finally {
				releaseStopping();
			}
			return false;
		}
		if (worker.idempotencyKey !== undefined) this.#byIdempotencyKey.delete(worker.idempotencyKey);
		try {
			await this.#terminate(worker);
			return this.#asleep.has(worker.id);
		} finally {
			releaseStopping();
		}
	}
	#asleepSummary(summary: SessionSummary): SessionSummary {
		const asleep: SessionSummary = {
			...summary,
			state: "asleep",
			agentCount: 0,
			awaitingAnswer: false,
		};
		delete asleep.roomId;
		delete asleep.turnStartedAt;
		delete asleep.pendingQuestion;
		delete asleep.pendingKind;
		return asleep;
	}
	async #waitForStopping(sessionId: string | undefined, sessionFile?: string): Promise<void> {
		const key = sessionFile === undefined ? undefined : sessionPathKey(sessionFile);
		for (;;) {
			const pending = [...this.#stopping].filter(
				worker => worker.id === sessionId || (key !== undefined && worker.sessionFile !== undefined && sessionPathKey(worker.sessionFile) === key),
			);
			if (pending.length === 0) return;
			await Promise.all(pending.map(worker => worker.stopped.promise));
		}
	}

	restoreAsleep(sessions: readonly SessionSummary[]): void {
		for (const summary of sessions) {
			if (summary.sessionFile === undefined || summary.hidden === true) continue;
			this.#asleep.set(summary.id, this.#asleepSummary(summary));
		}
	}

	async wake(id: string): Promise<SessionSummary> {
		const existing = this.#waking.get(id);
		if (existing) return existing;
		const live = this.#workers.get(id);
		if (live) return this.#summary(live);
		const asleep = this.#asleep.get(id);
		if (!asleep) throw new SupervisorError("not-found", `no live or sleeping session ${id}`);
		const deferred = Promise.withResolvers<SessionSummary>();
		const pending = deferred.promise;
		this.#waking.set(id, pending);
		this.#wakingSummaries.set(id, { ...asleep, state: "waking" });
		void this.#wakeAsleep(asleep).then(deferred.resolve, deferred.reject);
		try {
			return await pending;
		} finally {
			if (this.#waking.get(id) === pending) {
				this.#waking.delete(id);
				this.#wakingSummaries.delete(id);
				void this.#notifySessionsChanged();
			}
		}
	}

	async #wakeAsleep(asleep: SessionSummary): Promise<SessionSummary> {
		try {
			await this.#waitForStopping(asleep.id, asleep.sessionFile);
			const live = this.#workers.get(asleep.id);
			if (live) return this.#summary(live);
			this.#asleep.delete(asleep.id);
			const request: CreateSessionRequest = {
				cwd: asleep.cwd,
				resumeSessionFile: asleep.sessionFile!,
			};
			if (asleep.title !== undefined) request.title = asleep.title;
			if (asleep.hidden === true) request.hidden = true;
			if (asleep.model !== undefined) request.model = asleep.model;
			const summary = await this.#create(request, asleep.createdAt);
			if (summary.id !== asleep.id) {
				await this.stop(summary.id);
				throw new SupervisorError("conflict", `resuming ${asleep.id} changed its session id to ${summary.id}`);
			}
			return summary;
		} catch (error) {
			this.#asleep.set(asleep.id, asleep);
			await this.#notifySessionsChanged();
			throw error;
		}
	}

	#usesWorkerSlot(worker: Worker): boolean {
		return worker.proc !== undefined || worker.state === "starting" || worker.restartTimer !== undefined;
	}

	#activeWorkerCount(): number {
		let count = 0;
		for (const worker of this.#workers.values()) if (this.#usesWorkerSlot(worker)) count++;
		for (const worker of this.#candidates) if (this.#usesWorkerSlot(worker)) count++;
		for (const worker of this.#stopping) if (this.#usesWorkerSlot(worker)) count++;
		return count;
	}

	/** Starts a worker and resolves once it reported `ready`. Rejects with the worker's `fatal` text if it fails first. */
	async create(request: CreateSessionRequest): Promise<SessionSummary> {
		const key = request.idempotencyKey;
		if (key === undefined) return this.#create(request);
		const existing = this.#byIdempotencyKey.get(key);
		if (existing) {
			const summary = await existing;
			const live = this.#workers.get(summary.id);
			if (live) return this.#summary(live);
		}
		const pending = this.#create(request);
		this.#byIdempotencyKey.set(key, pending);
		pending.catch(() => {
			if (this.#byIdempotencyKey.get(key) === pending) this.#byIdempotencyKey.delete(key);
		});
		return pending;
	}

	async #create(request: CreateSessionRequest, createdAt = Date.now()): Promise<SessionSummary> {
		if (this.#closed) throw new SupervisorError("conflict", "daemon is shutting down");
		const sessionFile = request.resumeSessionFile;
		if (sessionFile) {
			const key = sessionPathKey(sessionFile);
			const asleep = [...this.#asleep.values()].find(summary => summary.sessionFile !== undefined && sessionPathKey(summary.sessionFile) === key);
			if (asleep) {
				const summary = await this.wake(asleep.id);
				const worker = this.#workers.get(summary.id);
				if (worker && request.idempotencyKey !== undefined) worker.idempotencyKey = request.idempotencyKey;
				if (request.handoff !== undefined && request.handoff.trim().length > 0) await this.sendPrompt(summary.id, request.handoff);
				return this.get(summary.id)!;
			}
			await this.#waitForStopping(undefined, sessionFile);
			if (this.findBySessionFile(sessionFile)) {
				throw new SupervisorError("conflict", `session file is already hosted: ${sessionFile}`);
			}
		}
		const limit = this.#opts.maxWorkers ?? DEFAULT_MAX_WORKERS;
		if (this.#activeWorkerCount() >= limit) {
			const sleepCandidate = await this.sleepCandidate();
			throw new SupervisorError(
				"conflict",
				`This machine has reached its limit of ${limit} live sessions. End or sleep one to start another, or raise --max-workers.`,
				sleepCandidate,
			);
		}
		const spec: LaunchSpec = {};
		if (request.resumeSessionFile) spec.resume = request.resumeSessionFile;
		if (request.forkFrom) {
			const { sessionFile: file, entryId } = request.forkFrom;
			spec.fork = entryId ? `${file}:${entryId}` : file;
		}
		if (request.model) spec.model = request.model;
		if (request.toolAllowlist) spec.tools = request.toolAllowlist;
		if (request.overnight) {
			const policy = request.overnight.policy;
			const askTimeoutSec = policy?.askTimeoutSec ?? DEFAULT_OVERNIGHT_POLICY.askTimeoutSec;
			const quiet = policy?.quiet ?? DEFAULT_OVERNIGHT_POLICY.quiet;
			if (!Number.isSafeInteger(askTimeoutSec) || askTimeoutSec < 1 || askTimeoutSec > 86_400 ||
				(quiet !== "normal" && quiet !== "quiet" && quiet !== "silent")) {
				throw new SupervisorError("bad-request", "invalid overnight worker options");
			}
			spec.overnight = { askTimeoutSec, quiet };
		}
		const secrets: RoomSecrets = {
			roomId: b64url(randomBytes(ROOM_ID_BYTES)),
			key: randomBytes(ROOM_KEY_BYTES),
			writeToken: randomBytes(WRITE_TOKEN_BYTES),
		};
		const worker = new Worker(`pending-${crypto.randomUUID()}`, request.cwd, secrets, spec, sessionFile, createdAt);
		this.#candidates.add(worker);
		const readyPromise = worker.ready!.promise;
		try {
			this.#launch(worker);
			await readyPromise;
			// The contract sends `state` right after `ready`; give it a moment so the summary is complete.
			await waitOrTimeout(worker.firstState.promise, FIRST_STATE_WAIT_MS);
			const clash = this.#workers.get(worker.id);
			if (clash) throw new SupervisorError("conflict", `session ${worker.id} is already hosted`);
		} catch (err) {
			worker.stopping = true;
			await this.#terminate(worker);
			throw err instanceof SupervisorError
				? err
				: new SupervisorError("internal", err instanceof Error ? err.message : String(err));
		} finally {
			this.#candidates.delete(worker);
		}
		worker.registered = true;
		worker.hidden = request.hidden === true;
		worker.idempotencyKey = request.idempotencyKey;
		if (request.title !== undefined && request.title.trim().length > 0) worker.title = request.title.trim();
		this.#workers.set(worker.id, worker);
		await this.#notifySessionsChanged();
		if (this.#opts.onCreated) {
			try {
				await this.#opts.onCreated(this.#summary(worker), request);
			} catch (err) {
				this.#log(`created handler for ${worker.id} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (request.handoff !== undefined && request.handoff.trim().length > 0) {
			try {
				await this.sendPrompt(worker.id, request.handoff);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.#log(`handoff prompt for ${worker.id} failed: ${message}`);
				if (request.overnight !== undefined) {
					try {
						this.#opts.onOvernightPromptFailure?.(worker.id, message);
					} catch (callbackError) {
						this.#log(`overnight prompt failure handler failed for ${worker.id}: ${String(callbackError)}`);
					}
				}
			}
		}
		return this.#summary(worker);
	}

	list(): SessionSummary[] {
		const sessions = [...this.#workers.values()].map(worker => {
			const summary = this.#summary(worker);
			if (this.#waking.has(worker.id)) summary.state = "waking";
			return summary;
		});
		for (const [id, summary] of this.#wakingSummaries) {
			if (!this.#workers.has(id) && !this.#asleep.has(id)) sessions.push(summary);
		}
		return sessions.concat([...this.#asleep.values()]);
	}

	get(id: string): SessionSummary | undefined {
		const worker = this.#workers.get(id);
		return worker ? this.#summary(worker) : this.#asleep.get(id);
	}

	setOvernightSummary(sessionId: string, summary: OvernightSummary | undefined): void {
		const worker = this.#workers.get(sessionId);
		if (worker) {
			worker.overnight = summary === undefined ? undefined : { ...summary };
			if (worker.registered) void this.#notifySessionsChanged();
			return;
		}
		const asleep = this.#asleep.get(sessionId);
		if (asleep) {
			if (summary === undefined) delete asleep.overnight;
			else asleep.overnight = { ...summary };
			void this.#notifySessionsChanged();
		}
	}

	isWaking(id: string): boolean {
		return this.#waking.has(id);
	}
	/** Changes one agent's model and waits for the worker's matching reply. */
	setAgentModel(sessionId: string, agentId: string, selector: string): Promise<WorkerModelResult> {
		return this.#changeAgent(sessionId, agentId, "model", requestId => ({
			t: "set-agent-model",
			id: requestId,
			agentId,
			selector,
		}));
	}

	/** Changes one agent's thinking level (session-only) and waits for the worker's matching reply. */
	setAgentThinking(sessionId: string, agentId: string, level: SetAgentThinkingRequest["level"]): Promise<WorkerModelResult> {
		return this.#changeAgent(sessionId, agentId, "thinking level", requestId => ({
			t: "set-agent-thinking",
			id: requestId,
			agentId,
			level,
		}));
	}

	/** Model and thinking changes share one reply shape and one pending slot per agent. */
	#changeAgent(
		sessionId: string,
		agentId: string,
		what: string,
		build: (requestId: string) => WorkerCommand,
	): Promise<WorkerModelResult> {
		const worker = this.#workers.get(sessionId);
		if (!worker) throw new SupervisorError("not-found", `no live session ${sessionId}`);
		const proc = worker.proc;
		if (!proc || worker.state === "starting" || worker.state === "stopped" || worker.state === "crashed") {
			throw new SupervisorError("conflict", `session ${sessionId} is not running`);
		}
		if (worker.modelChanges.has(agentId)) {
			throw new SupervisorError("conflict", `a model or thinking change is already pending for agent ${agentId}`);
		}

		const response = Promise.withResolvers<WorkerModelResult>();
		const requestId = crypto.randomUUID();
		const timeoutMs = this.#opts.modelChangeTimeoutMs ?? DEFAULT_MODEL_CHANGE_TIMEOUT_MS;
		const timer = setTimeout(() => {
			const pending = worker.modelChanges.get(agentId);
			if (pending?.id !== requestId) return;
			worker.modelChanges.delete(agentId);
			response.reject(new SupervisorError("conflict", `timed out waiting for agent ${agentId} ${what} change`));
		}, timeoutMs);
		const pending: PendingModelChange = { id: requestId, response, timer };
		worker.modelChanges.set(agentId, pending);

		try {
			writeWorkerLine(proc.stdin, `${JSON.stringify(build(requestId))}\n`);
		} catch {
			clearTimeout(timer);
			worker.modelChanges.delete(agentId);
			throw new SupervisorError("conflict", `worker for session ${sessionId} is unavailable`);
		}
		return response.promise;
	}

	/** The capability catalog of a live session, from the worker's own registries (cached 10 s worker-side). */
	async catalog(sessionId: string): Promise<CatalogResponse> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "catalog", id }),
			this.#opts.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
			"catalog",
		);
		if (reply.t !== "catalog") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to catalog`);
		return reply.catalog;
	}

	/** Runs one remote-invokable slash command; resolves once the worker admitted it. */
	async runCommand(sessionId: string, text: string): Promise<void> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "run-command", id, text }),
			this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			"command",
		);
		if (reply.t !== "accepted") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to run-command`);
	}

	/** Spawns a subagent of a profile; resolves with its registry id as soon as the worker registered it. */
	async spawnAgent(sessionId: string, request: SpawnAgentRequest): Promise<string> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "spawn-agent", id, request }),
			this.#opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
			"spawn",
		);
		if (reply.t !== "spawned") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to spawn-agent`);
		return reply.agentId;
	}

	/** Prompts the main agent as the host user; resolves once omp admitted it (it may run as a follow-up). */
	async sendPrompt(sessionId: string, text: string): Promise<void> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "send-prompt", id, text }),
			this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			"send-prompt",
		);
		if (reply.t !== "accepted") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to send-prompt`);
	}

	/** Applies or removes the live overnight dialog policy; launch environment and scheduling reset on next restart. */
	async setOvernightOptions(sessionId: string, options: WorkerOvernightOptions | null): Promise<void> {
		const worker = this.#workers.get(sessionId);
		if (!worker) throw new SupervisorError("not-found", `no live session ${sessionId}`);
		const proc = worker.proc;
		if (proc && proc.exitCode === null && !worker.stopping) {
			const reply = await this.#request(
				sessionId,
				id => ({ t: "overnight-options", id, options }),
				this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
				"overnight-options",
			);
			if (reply.t !== "accepted") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to overnight-options`);
		}
		worker.spec.overnight = options === null ? undefined : { ...options };
	}

	/** Freezes (holds prompts and spawns, aborts the turn) or unfreezes a live session. Idempotent. */
	async freeze(sessionId: string, frozen: boolean): Promise<void> {
		const worker = this.#workers.get(sessionId);
		if (!worker) throw new SupervisorError("not-found", `no live session ${sessionId}`);
		if (worker.frozen === frozen) return;
		const reply = await this.#request(
			sessionId,
			id => ({ t: "freeze", id, frozen }),
			this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			"freeze",
		);
		if (reply.t !== "accepted") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to freeze`);
		worker.frozen = frozen;
	}

	/** Stops one subagent of a live session (abort + aborted tombstone in the worker). */
	async cancelAgent(sessionId: string, agentId: string): Promise<void> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "cancel-agent", id, agentId }),
			this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			"cancel-agent",
		);
		if (reply.t !== "accepted") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to cancel-agent`);
	}

	/** One session operation through omp's session API in the worker; refusals arrive as `SupervisorError`s. */
	async sessionOp(sessionId: string, op: SessionOp | SessionOpV3, signal?: AbortSignal): Promise<SessionOpResult | SessionOpV3Result> {
		// Skills can wait for approval; diagnostics, debugger, and live startup may own resources.
		const isSkillMutation = op.op === "skills-install" || op.op === "skills-update";
		const isAbortableOperation =
			isSkillMutation ||
			op.op === "debug" ||
			op.op === "debug-diagnostics" ||
			(op.op === "live-mode" && op.action === "start");
		const timeoutMs =
			op.op === "compact" || op.op === "handoff"
				? (this.#opts.compactTimeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS)
				: op.op === "btw" || op.op === "quick-replies"
					? (this.#opts.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS)
					: isSkillMutation
						? (this.#opts.skillsTimeoutMs ?? DEFAULT_SKILLS_TIMEOUT_MS)
						: (this.#opts.sessionOpTimeoutMs ?? DEFAULT_SESSION_OP_TIMEOUT_MS);
		const requestOptions = isAbortableOperation
			? {
					...(signal === undefined ? {} : { signal }),
					onAbandon: (requestId: string) => this.#cancelSessionOp(sessionId, requestId),
				}
			: {};
		const reply = await this.#request(sessionId, id => ({ t: "session-op", id, op }), timeoutMs, `${op.op} operation`, requestOptions);
		if (reply.t !== "session-op") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to session-op`);
		if (op.op === "live-mode" && "liveMode" in reply.result) {
			const liveMode = reply.result.liveMode;
			const previous = this.#workers.get(sessionId)?.liveMode;
			const worker = this.#workers.get(sessionId);
			if (worker) worker.liveMode = { active: liveMode.active, phase: liveMode.phase };
			try {
				this.#opts.onLiveModeStatus?.(sessionId, liveMode);
			} catch (error) {
				this.#log(`live status handler failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (worker?.registered && (previous?.active !== liveMode.active || previous?.phase !== liveMode.phase)) {
				await this.#notifySessionsChanged();
			}
		}
		return reply.result;
	}

	/** Writes one bounded browser PCM frame to the owner session's worker; no reply is generated. */
	sendLiveAudio(sessionId: string, data: string): void {
		const maxBase64Chars = Math.ceil(LIVE_INPUT_MAX_FRAME_BYTES / 3) * 4;
		if (data.length === 0 || data.length > maxBase64Chars || data.length % 4 !== 0 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
			throw new SupervisorError("bad-request", "invalid live audio frame");
		}
		const worker = this.#workers.get(sessionId);
		if (!worker) throw new SupervisorError("not-found", `no live session ${sessionId}`);
		if (worker.stopping || !worker.proc || worker.proc.exitCode !== null) throw new SupervisorError("conflict", "live session worker is not running");
		if (!worker.liveMode?.active) throw new SupervisorError("conflict", "live mode is not active");
		writeWorkerLine(worker.proc.stdin, `${JSON.stringify({ t: "live-audio", data })}\n`);
	}

	/** The session's usage reports (`fetchUsageReports()`), already stripped of anything credential-shaped by the worker. */
	async usage(sessionId: string, timeoutMs?: number): Promise<unknown[]> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "usage", id }),
			timeoutMs ?? this.#opts.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
			"usage",
		);
		if (reply.t !== "usage") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to usage`);
		return reply.reports;
	}

	/** Key points of the session's transcript, written by the worker with the smol role. */
	async summarize(sessionId: string): Promise<KeyPoints> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "summarize", id }),
			this.#opts.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS,
			"summarize",
		);
		if (reply.t !== "key-points") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to summarize`);
		return reply.keyPoints;
	}

	/** Asks the worker to (re)generate the session title; resolves once admitted, the result arrives through `onTitle`. */
	async refineTitle(sessionId: string): Promise<void> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "refine-title", id }),
			this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			"refine-title",
		);
		if (reply.t !== "accepted") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to refine-title`);
	}

	async plugins(sessionId: string): Promise<PluginInfo[]> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "plugins", id }),
			this.#opts.pluginsTimeoutMs ?? DEFAULT_PLUGINS_TIMEOUT_MS,
			"plugins",
		);
		if (reply.t !== "plugins") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to plugins`);
		return reply.plugins;
	}

	async togglePlugin(sessionId: string, pluginId: string, enabled: boolean): Promise<void> {
		const reply = await this.#request(
			sessionId,
			id => ({ t: "plugin-toggle", id, pluginId, enabled }),
			this.#opts.pluginsTimeoutMs ?? DEFAULT_PLUGINS_TIMEOUT_MS,
			"plugin toggle",
		);
		if (reply.t !== "accepted") throw new SupervisorError("internal", `unexpected worker reply ${reply.t} to plugin-toggle`);
	}

	/**
	 * The newest extension UI state of a live session (statuses, widgets, omp console panels, notifications): empty until the
	 * worker publishes one.
	 */
	extensionUi(sessionId: string): ExtensionUiState {
		const worker = this.#workers.get(sessionId);
		if (!worker) throw new SupervisorError("not-found", `no live session ${sessionId}`);
		return worker.extUi ?? EMPTY_EXT_UI;
	}

	/**
	 * Pushes the flow-control policy to every running worker and remembers it for workers that start later. Providers
	 * a policy does not list are admitted. Workers enforce it on the spawns and prompts of their main agent.
	 */
	pushQuotaPolicy(providers: readonly QuotaPolicyEntry[]): void {
		this.#quotaPolicy = providers.map(entry => ({ ...entry }));
		for (const worker of this.#workers.values()) this.#sendQuotaPolicy(worker);
		for (const worker of this.#candidates) this.#sendQuotaPolicy(worker);
	}

	#sendQuotaPolicy(worker: Worker): void {
		const proc = worker.proc;
		if (!proc || !this.#quotaPolicy || worker.stopping) return;
		const command: WorkerCommand = { t: "quota-policy", providers: [...this.#quotaPolicy] };
		try {
			writeWorkerLine(proc.stdin, `${JSON.stringify(command)}\n`);
		} catch {
			// The worker is on its way out; a restarted one gets the policy when it reports ready.
		}
	}

	/** Fire-and-forget `freeze` for a restarted worker; replies to this id are ignored (no pending request). */
	#sendFreeze(worker: Worker): void {
		const proc = worker.proc;
		if (!proc || worker.stopping) return;
		const command: WorkerCommand = { t: "freeze", id: `refreeze-${crypto.randomUUID()}`, frozen: true };
		try {
			writeWorkerLine(proc.stdin, `${JSON.stringify(command)}\n`);
		} catch {
			// Exiting again; the next ready re-sends it.
		}
	}

	#cancelSessionOp(sessionId: string, requestId: string): void {
		const proc = this.#workers.get(sessionId)?.proc;
		if (!proc) return;
		const command: WorkerCommand = { t: "cancel-session-op", id: requestId };
		try {
			writeWorkerLine(proc.stdin, `${JSON.stringify(command)}\n`);
		} catch {
			// The worker may already be exiting.
		}
	}

	/**
	 * Sends one request-style command and waits for the reply carrying its id. A `request-error` reply becomes a
	 * `SupervisorError` with the worker's code; a worker that exits or does not answer in time fails the request.
	 */
	async #request(
		sessionId: string,
		build: (requestId: string) => WorkerCommand,
		timeoutMs: number,
		what: string,
		options: { signal?: AbortSignal; onAbandon?: (requestId: string) => void } = {},
	): Promise<WorkerRequestResult> {
		const worker = this.#workers.get(sessionId);
		if (!worker) throw new SupervisorError("not-found", `no live session ${sessionId}`);
		const proc = worker.proc;
		if (!proc || worker.state === "starting" || worker.state === "stopped" || worker.state === "crashed") {
			throw new SupervisorError("conflict", `session ${sessionId} is not running`);
		}
		if (options.signal?.aborted) throw new SupervisorError("conflict", `${what} was cancelled`);
		const requestId = crypto.randomUUID();
		const response = Promise.withResolvers<WorkerRequestResult>();
		const abandon = (error: SupervisorError): void => {
			const pending = worker.requests.get(requestId);
			if (!pending) return;
			clearTimeout(pending.timer);
			worker.requests.delete(requestId);
			try {
				options.onAbandon?.(requestId);
			} catch {
				// Cancellation is best-effort when the worker is already exiting.
			}
			response.reject(error);
		};
		const timer = setTimeout(() => abandon(new SupervisorError("internal", `timed out waiting for the worker's ${what} reply`)), timeoutMs);
		const onAbort = (): void => abandon(new SupervisorError("conflict", `${what} was cancelled`));
		worker.requests.set(requestId, { response, timer });
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		try {
			if (worker.requests.has(requestId)) {
				writeWorkerLine(proc.stdin, `${JSON.stringify(build(requestId))}\n`);
			}
		} catch {
			clearTimeout(timer);
			worker.requests.delete(requestId);
			options.signal?.removeEventListener("abort", onAbort);
			throw new SupervisorError("conflict", `worker for session ${sessionId} is unavailable`);
		}
		try {
			const reply = await response.promise;
			if (reply.t === "request-error") throw new SupervisorError(reply.code, reply.message);
			return reply;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * Restarts a persisted session under the same id and room credentials. A live turn is refused unless restartAnyway
	 * is explicit; confirmed restarts abort that turn before replacing the worker.
	 */
	async restart(id: string, restartAnyway = false, overnightOptions?: WorkerOvernightOptions): Promise<SessionSummary> {
		if (this.#asleep.has(id)) return this.wake(id);

		const worker = this.#workers.get(id);
		if (!worker) throw new SupervisorError("not-found", `no live session ${id}`);
		if (worker.stopping || worker.state === "starting" || worker.state === "waking") {
			throw new SupervisorError("conflict", `session ${id} is already changing state`);
		}
		if (worker.frozen) throw new SupervisorError("conflict", `session ${id} is frozen and cannot be restarted`);
		if (!worker.registered || !worker.sessionFile || !(await Bun.file(worker.sessionFile).exists())) {
			throw new SupervisorError("conflict", `session ${id} has no persisted session file to restart from`);
		}
		if (worker.requests.size > 0 || worker.modelChanges.size > 0 || worker.abortRequest) {
			throw new SupervisorError("conflict", `session ${id} has a pending operation and cannot be restarted`);
		}

		const busy = worker.state === "streaming" || worker.state === "asking" || worker.awaitingAnswer;
		if (busy && !restartAnyway) {
			throw new SupervisorError("conflict", `session ${id} is busy; confirm restartAnyway to abort its active turn`);
		}
		if (busy) {
			const aborted = await this.abort(id);
			if (!aborted) throw new SupervisorError("conflict", `session ${id} no longer has an active turn to abort`);
			const deadline = Date.now() + 10_000;
			while (worker.state === "streaming" || worker.state === "asking" || worker.awaitingAnswer) {
				if (Date.now() >= deadline) {
					throw new SupervisorError("conflict", `session ${id} did not become idle after abort`);
				}
				await Bun.sleep(10);
			}
		}
		// A Stop that landed during the abort wait owns the session now: never relaunch a forgotten one.
		if (this.#workers.get(id) !== worker) throw new SupervisorError("conflict", `session ${id} was stopped during the restart`);
		const previousOvernight = worker.spec.overnight;
		if (overnightOptions !== undefined) worker.spec.overnight = { ...overnightOptions };
		worker.stopping = true;
		worker.stopped = Promise.withResolvers<void>();
		this.#stopping.add(worker);
		try {
			await this.#terminate(worker);
			if (this.#workers.get(id) !== worker) throw new SupervisorError("conflict", `session ${id} was stopped during the restart`);
			worker.state = "starting";
			worker.stopping = false;
			worker.restarts = 0;
			worker.ready = Promise.withResolvers<void>();
			worker.ready.promise.catch(() => {});
			worker.firstState = Promise.withResolvers<void>();
			const ready = worker.ready;
			const firstState = worker.firstState;
			this.#launch(worker);
			await ready.promise;
			if (!(await waitOrTimeout(firstState.promise, FIRST_STATE_WAIT_MS))) {
				throw new SupervisorError("internal", `worker for session ${id} did not publish its initial state`);
			}
			await this.#notifySessionsChanged();
			return this.#summary(worker);
		} catch (error) {
			worker.spec.overnight = previousOvernight;
			worker.stopping = true;
			if (worker.proc) await this.#terminate(worker);
			worker.stopping = false;
			worker.ready = undefined;
			worker.state = "crashed";
			worker.paused = false;
			worker.pausedAt = undefined;
			void this.#notifySessionsChanged().catch(err => {
				this.#log(`session list update after restart failure for ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			throw error;
		} finally {
			this.#stopping.delete(worker);
			worker.stopped.resolve();
		}
	}

	/** Aborts the active turn; resolves false when the worker is idle. */
	async abort(id: string): Promise<boolean> {
		const worker = this.#workers.get(id);
		if (!worker) throw new SupervisorError("not-found", `no live session ${id}`);
		const proc = worker.proc;
		if (!proc || worker.state === "starting" || worker.state === "stopped" || worker.state === "crashed") {
			throw new SupervisorError("conflict", `session ${id} is not running`);
		}
		if (worker.abortRequest) return worker.abortRequest.response.promise.then(result => result.aborted);

		const response = Promise.withResolvers<WorkerAbortResult>();
		const requestId = crypto.randomUUID();
		const timeoutMs = 10_000;
		const timer = setTimeout(() => {
			const pending = worker.abortRequest;
			if (pending?.id !== requestId) return;
			worker.abortRequest = undefined;
			response.reject(new SupervisorError("conflict", `timed out waiting for session ${id} abort`));
		}, timeoutMs);
		worker.abortRequest = { id: requestId, response, timer };
		try {
			const command: WorkerCommand = { t: "abort", id: requestId };
			writeWorkerLine(proc.stdin, `${JSON.stringify(command)}\n`);
		} catch {
			clearTimeout(timer);
			worker.abortRequest = undefined;
			throw new SupervisorError("conflict", `worker for session ${id} is unavailable`);
		}
		return response.promise.then(result => result.aborted);
	}

	findBySessionFile(file: string): SessionSummary | undefined {
		const key = sessionPathKey(file);
		for (const summary of this.#asleep.values()) {
			if (summary.sessionFile !== undefined && sessionPathKey(summary.sessionFile) === key) return summary;
		}
		for (const worker of [...this.#workers.values(), ...this.#candidates, ...this.#stopping]) {
			if (worker.sessionFile !== undefined && sessionPathKey(worker.sessionFile) === key) return this.#summary(worker);
		}
		return undefined;
	}

	/** Room id, key and write token of a live session; `undefined` for unknown sessions. */
	roomSecrets(id: string): RoomSecrets | undefined {
		return this.#workers.get(id)?.secrets;
	}

	/** Stops a session (stop command, SIGTERM, SIGKILL) and forgets it. Returns false for unknown ids. */
	async stop(id: string): Promise<boolean> {
		for (;;) {
			const waking = this.#waking.get(id);
			if (waking) {
				try {
					await waking;
				} catch {
					// A failed wake restores the asleep entry; stop still removes that session below.
				}
				continue;
			}
			const stopping = [...this.#stopping].find(worker => worker.id === id);
			if (stopping) {
				await stopping.stopped.promise;
				continue;
			}
			const asleep = this.#asleep.get(id);
			if (!asleep) break;
			this.#asleep.delete(id);
			try {
				await this.#notifySessionsChanged(true);
			} catch (error) {
				this.#asleep.set(id, asleep);
				void this.#notifySessionsChanged();
				throw error;
			}
			return true;
		}
		const worker = this.#workers.get(id);
		if (!worker) return false;
		const beforeStop = this.#opts.beforeStop;
		if (beforeStop && worker.proc && !worker.stopping && (worker.state === "idle" || worker.state === "streaming" || worker.state === "asking")) {
			// While the worker still holds the transcript (key points are written from it). Never blocks the stop for long.
			await waitOrTimeout(
				beforeStop(id).catch(err => this.#log(`before-stop handler for ${id} failed: ${err instanceof Error ? err.message : String(err)}`)),
				this.#opts.beforeStopTimeoutMs ?? DEFAULT_BEFORE_STOP_TIMEOUT_MS,
			);
			// A concurrent stop or shutdown may have taken the worker while the handler ran.
			if (this.#workers.get(id) !== worker || worker.stopping) return false;
		}
		worker.stopping = true;
		this.#workers.delete(id);
		await this.#notifySessionsChanged();
		if (worker.idempotencyKey !== undefined) this.#byIdempotencyKey.delete(worker.idempotencyKey);
		worker.stopped = Promise.withResolvers<void>();
		this.#stopping.add(worker);
		try {
			await this.#terminate(worker);
			return true;
		} finally {
			this.#stopping.delete(worker);
			worker.stopped.resolve();
		}
	}

	async health(): Promise<WorkerHealth[]> {
		const workers = [...this.#workers.values()];
		// The stall verdict is taken at the call, not after the rss read, which spawns a process and can take a second on
		// Windows.
		const now = Date.now();
		const rss = await this.#readRss(workers.flatMap(worker => (worker.proc ? [worker.proc.pid] : [])));
		return workers.map(worker => ({
			sessionId: worker.id,
			pid: worker.proc?.pid ?? worker.lastPid,
			state: worker.state,
			rssBytes: worker.proc ? (rss.get(worker.proc.pid) ?? 0) : 0,
			startedAt: worker.startedAt,
			lastEventAt: worker.lastEventAt,
			// A paused turn emits nothing on purpose; it is not stalled.
			stalled: worker.state === "streaming" && !worker.paused && now - worker.lastEventAt > this.stalledAfterMs,
			restarts: worker.restarts,
		}));
	}

	/** Stops every worker (including ones still starting) and refuses new sessions. Idempotent. */
	async shutdown(): Promise<void> {
		this.#closed = true;
		if (this.#sleepTimer !== undefined) clearInterval(this.#sleepTimer);
		this.#sleepTimer = undefined;
		const all = [...this.#workers.values(), ...this.#candidates];
		for (const worker of all) worker.stopping = true;
		this.#workers.clear();
		await Promise.all(all.map(worker => this.#terminate(worker)));
	}

	#summary(worker: Worker): SessionSummary {
		const summary: SessionSummary = {
			id: worker.id,
			cwd: worker.cwd,
			state: worker.state,
			createdAt: worker.createdAt,
			lastActivityAt: worker.lastEventAt,
			roomId: worker.secrets.roomId,
			agentCount: worker.agentCount,
			goalActive: worker.goalActive,
			awaitingAnswer: worker.awaitingAnswer,
		};
		if (worker.pendingQuestion !== undefined) summary.pendingQuestion = worker.pendingQuestion;
		if (worker.pendingKind !== undefined) summary.pendingKind = worker.pendingKind;
		if (worker.turnStartedAt !== undefined) summary.turnStartedAt = worker.turnStartedAt;
		if (worker.title !== undefined) summary.title = worker.title;
		if (worker.goalObjective !== undefined) summary.goalObjective = worker.goalObjective;
		if (worker.loopMode !== undefined) summary.loopMode = worker.loopMode;
		if (worker.vibeMode !== undefined) summary.vibeMode = worker.vibeMode;
		if (worker.liveMode !== undefined) summary.liveMode = worker.liveMode;
		if (worker.overnight !== undefined) summary.overnight = { ...worker.overnight };
		if (worker.sessionFile !== undefined) summary.sessionFile = worker.sessionFile;
		if (worker.model !== undefined) summary.model = worker.model;
		if (worker.thinkingLevel !== undefined) summary.thinkingLevel = worker.thinkingLevel;
		if (worker.rootAgentId !== undefined) summary.rootAgentId = worker.rootAgentId;
		if (worker.hidden) summary.hidden = true;
		if (worker.frozen) summary.frozen = true;
		if (worker.paused) summary.paused = true;
		if (worker.pausedAt !== undefined) summary.pausedAt = worker.pausedAt;
		if (this.#opts.isPinned?.(worker.id)) summary.pinned = true;
		return summary;
	}

	/** Windows rss comes from a PowerShell process (hundreds of ms to start); health is polled, so reuse a recent read. */
	#windowsRss: { at: number; pids: string; result: Promise<Map<number, number>> } | undefined;

	async #readRss(pids: number[]): Promise<Map<number, number>> {
		if (pids.length === 0) return new Map();
		if (process.platform === "win32") {
			const key = [...pids].sort((a, b) => a - b).join(",");
			const cached = this.#windowsRss;
			if (cached && cached.pids === key && Date.now() - cached.at < WINDOWS_RSS_CACHE_MS) return cached.result;
			const result = this.#readWindowsRss(pids);
			this.#windowsRss = { at: Date.now(), pids: key, result };
			return result;
		}
		const result = new Map<number, number>();
		try {
			const out = await $`ps -o pid=,rss= -p ${pids.join(",")}`.quiet().nothrow().text();
			for (const line of out.split("\n")) {
				const [pid, kb] = line.trim().split(/\s+/);
				if (pid && kb) result.set(Number(pid), Number(kb) * 1024);
			}
		} catch {
			// rss is informational; absence is reported as 0
		}
		return result;
	}

	async #readWindowsRss(pids: number[]): Promise<Map<number, number>> {
		const result = new Map<number, number>();
		try {
			const child = Bun.spawn(
				[
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					// SilentlyContinue: one worker that exited in the meantime must not drop every other reading.
					`Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`,
				],
				{ stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true },
			);
			const output = new Response(child.stdout).text();
			if (!(await waitOrTimeout(child.exited, WINDOWS_RSS_TIMEOUT_MS))) {
				child.kill();
				return result;
			}
			const text = await output;
			if (text.trim() !== "") {
				const parsed: unknown = JSON.parse(text);
				for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
					if (typeof value !== "object" || value === null) continue;
					const row = value as { Id?: unknown; WorkingSet64?: unknown };
					const pid = Number(row.Id);
					const rssBytes = Number(row.WorkingSet64);
					if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(rssBytes) && rssBytes >= 0) result.set(pid, rssBytes);
				}
			}
		} catch {
			// rss is informational; absence is reported as 0
		}
		return result;
	}

	#launch(worker: Worker): void {
		const { command: spawnCommand, env: workerEnv } = buildWorkerLaunchPlan({
			workerCmd: this.#opts.workerCmd,
			cwd: worker.cwd,
			relayUrl: this.#opts.relayUrl(),
			roomId: worker.secrets.roomId,
			registered: worker.registered,
			...(worker.sessionFile === undefined ? {} : { sessionFile: worker.sessionFile }),
			spec: worker.spec,
			env: { ...process.env, ...this.#opts.env },
			agendaToolsEnabled: this.#opts.agendaToolsEnabled === true,
			computerUseEnabled: this.#opts.computerUseEnabled === true,
			platform: this.#opts.platform,
			ioniceAvailable: this.#opts.ioniceAvailable,
		});
		const overnight = worker.spec.overnight;
		worker.state = "starting";
		worker.awaitingAnswer = false;
		worker.pendingQuestion = undefined;
		worker.pendingKind = undefined;
		worker.paused = false;
		worker.pausedAt = undefined;
		worker.startedAt = Date.now();
		worker.lastEventAt = worker.startedAt;
		worker.exited = Promise.withResolvers<void>();
		worker.fatalMessage = undefined;
		worker.extUi = undefined;
		let proc: Subprocess;
		try {
			proc = Bun.spawn(spawnCommand, {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				detached: process.platform !== "win32",
				windowsHide: process.platform === "win32",
				env: workerEnv,
			});
		} catch (err) {
			const message = `failed to spawn worker: ${err instanceof Error ? err.message : String(err)}`;
			worker.exited.resolve();
			if (worker.ready) worker.ready.reject(new SupervisorError("internal", message));
			else this.#onCrash(worker, null, null, message);
			return;
		}
		worker.proc = proc;
		worker.lastPid = proc.pid;
		const deviceToken = this.#opts.issueWorkerToken?.(worker.id) ?? Buffer.from(randomBytes(32)).toString("base64url");
		worker.deviceToken = deviceToken;
		const launchSecrets: WorkerLaunchSecrets = {
			t: "launch",
			roomKey: b64url(worker.secrets.key),
			writeToken: b64url(worker.secrets.writeToken),
			deviceToken,
			...(overnight === undefined ? {} : { overnight }),
		};
		try {
			writeWorkerLine(proc.stdin, `${JSON.stringify(launchSecrets)}\n`);
		} catch (err) {
			this.#log(`worker ${worker.id}: could not send launch secrets: ${err instanceof Error ? err.message : String(err)}`);
		}
		const readyTimeout = this.#opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		worker.readyTimer = setTimeout(() => {
			worker.fatalMessage ??= `worker did not become ready within ${readyTimeout} ms`;
			worker.ready?.reject(new SupervisorError("internal", worker.fatalMessage));
			if (process.platform === "win32") void killWindowsProcessTree(proc.pid);
			else killGroup(proc.pid, "SIGKILL");
		}, readyTimeout);
		worker.pumps = Promise.all([this.#pumpStdout(worker, proc), this.#pumpStderr(worker, proc)]);
		void proc.exited.then(code => this.#onExit(worker, proc, code));
	}

	async #pumpStdout(worker: Worker, proc: Subprocess): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const raw of readLines(proc.stdout)) {
				const line = decoder.decode(raw).trim();
				if (!line) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					this.#log(`worker ${worker.id}: non-JSON stdout line ignored`);
					continue;
				}
				if (worker.proc !== proc) return;
				if (isStatus(parsed)) await this.#onStatus(worker, parsed);
				if (isModelResult(parsed)) {
					this.#onModelResult(worker, parsed);
					continue;
				}
				if (isRequestResult(parsed)) {
					this.#onRequestResult(worker, parsed);
					continue;
				}
				if (isAbortResult(parsed)) {
					this.#onAbortResult(worker, parsed);
					continue;
				}
			}
		} catch (err) {
			this.#log(`worker ${worker.id}: stdout read failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async #pumpStderr(worker: Worker, proc: Subprocess): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const raw of readLines(proc.stderr)) {
				this.#log(`[worker ${worker.id}] ${decoder.decode(raw)}`);
			}
		} catch {
			// stream closed with the process
		}
	}

	async #onStatus(worker: Worker, status: WorkerStatus): Promise<void> {
		switch (status.t) {
			case "ready": {
				clearTimeout(worker.readyTimer);
				if (status.roomId !== worker.secrets.roomId) {
					this.#log(`worker ${worker.id}: ready reported room ${status.roomId}, expected ${worker.secrets.roomId}`);
				}
				const previousId = worker.id;
				const collision = this.#workers.get(status.sessionId);
				if (collision && collision !== worker) {
					const reason = `ready session id ${status.sessionId} is already held by another live worker`;
					worker.fatalMessage = reason;
					worker.crashReason = reason;
					worker.state = "crashed";
					worker.stopping = true;
					this.#log(`worker ${previousId}: refusing ready rename: ${reason}`);
					worker.ready?.reject(new SupervisorError("conflict", reason));
					void this.#terminate(worker);
					return;
				}
				worker.id = status.sessionId;
				if (status.sessionFile) {
					worker.sessionFile = status.sessionFile;
					this.#opts.onHostedSessionFile?.(status.sessionFile);
				}
				worker.rootAgentId = status.rootAgentId;
				worker.state = "idle";
				worker.lastEventAt = Date.now();
				if (worker.registered && previousId !== worker.id) {
					// A restart of a never-persisted session comes back as a new session id.
					this.#workers.delete(previousId);
					this.#workers.set(worker.id, worker);
				}
				if (worker.registered) await this.#notifySessionsChanged();
				worker.ready?.resolve();
				worker.ready = undefined;
				this.#sendQuotaPolicy(worker);
				// A restarted process starts unfrozen; a session frozen for a move must stay frozen.
				if (worker.frozen) this.#sendFreeze(worker);
				return;
			}
			case "state": {
				worker.firstState.resolve();
				const modeSignature = JSON.stringify([status.loopMode, status.vibeMode, status.liveMode && {
					active: status.liveMode.active,
					phase: status.liveMode.phase,
				}]);
				const summaryChanged =
					worker.state !== status.state ||
					worker.awaitingAnswer !== status.awaitingAnswer ||
					worker.pendingQuestion !== status.pendingQuestion ||
					worker.pendingKind !== status.pendingKind ||
					worker.paused !== status.paused ||
					worker.pausedAt !== status.pausedAt ||
					worker.goalActive !== status.goalActive ||
					worker.goalObjective !== status.goalObjective ||
					worker.agentCount !== status.agentCount ||
					worker.lastEventAt !== status.lastEventAt ||
					(status.model !== undefined && worker.model !== status.model) ||
					(status.thinkingLevel !== undefined && worker.thinkingLevel !== status.thinkingLevel) ||
					(status.title !== undefined && worker.title !== status.title) ||
					worker.modeStatusSignature !== modeSignature;
				const busy = (state: SessionState): boolean => state === "streaming" || state === "asking";
				if (busy(status.state) && !busy(worker.state)) {
					worker.turnStartedAt = Date.now();
					worker.lastTurnDurationMs = undefined;
				} else if (!busy(status.state)) {
					if (busy(worker.state) && worker.turnStartedAt !== undefined) {
						worker.lastTurnDurationMs = Math.max(0, Date.now() - worker.turnStartedAt);
					}
					worker.turnStartedAt = undefined;
				}
				worker.state = status.state;
				worker.awaitingAnswer = status.awaitingAnswer;
				worker.pendingQuestion = status.pendingQuestion;
				worker.pendingKind = status.pendingKind;
				worker.paused = status.paused;
				worker.pausedAt = status.pausedAt;
				worker.goalActive = status.goalActive;
				worker.goalObjective = status.goalObjective;
				worker.loopMode = status.loopMode;
				worker.vibeMode = status.vibeMode;
				worker.liveMode = status.liveMode ? { active: status.liveMode.active, phase: status.liveMode.phase } : undefined;
				worker.modeStatusSignature = modeSignature;
				worker.agentCount = status.agentCount;
				worker.lastEventAt = status.lastEventAt;
				if (status.model !== undefined) worker.model = status.model;
				if (status.thinkingLevel !== undefined) worker.thinkingLevel = status.thinkingLevel;
				if (status.title !== undefined) worker.title = status.title;
				if (status.liveMode) {
					try {
						this.#opts.onLiveModeStatus?.(worker.id, status.liveMode);
					} catch (error) {
						this.#log(`live status handler failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				if (worker.registered && summaryChanged) await this.#notifySessionsChanged();
				try {
					this.#opts.onOvernightStatus?.(worker.id, status);
				} catch (error) {
					this.#log(`overnight state handler failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}
			case "turn-end":
			case "auto-answer": {
				try {
					this.#opts.onOvernightStatus?.(worker.id, status);
				} catch (error) {
					this.#log(`overnight status handler failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			case "live-audio": {
				try {
					this.#opts.onLiveAudio?.(worker.id, status.audio);
				} catch (error) {
					this.#log(`live audio handler failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}
			case "live-levels": {
				try {
					this.#opts.onLiveLevels?.(worker.id, status.input, status.output);
				} catch (error) {
					this.#log(`live levels handler failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}
			case "notify": {
				const event: NotifyEvent = { sessionId: worker.id, reason: status.reason };
				if (status.reason === "turn-finished") {
					const durationMs =
						worker.turnStartedAt === undefined
							? worker.lastTurnDurationMs
							: Math.max(0, Date.now() - worker.turnStartedAt);
					if (durationMs !== undefined) event.durationMs = durationMs;
				}
				if (worker.title !== undefined) event.title = worker.title;
				if (status.summary !== undefined) event.summary = status.summary;
				try {
					this.#opts.onNotify?.(event);
				} catch (err) {
					this.#log(`notify handler failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			case "fatal": {
				worker.fatalMessage = status.message;
				worker.ready?.reject(new SupervisorError("internal", status.message));
				return;
			}
			case "ext-ui": {
				worker.extUi = status.state;
				try {
					this.#opts.onExtUi?.(worker.id, status.state);
				} catch (err) {
					this.#log(`ext-ui handler failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			case "usage-sample": {
				try {
					this.#opts.onUsageSample?.(worker.id, status);
				} catch (err) {
					this.#log(`usage sample handler failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			case "title": {
				worker.title = status.title;
				try {
					this.#opts.onTitle?.(worker.id, status.title);
				} catch (err) {
					this.#log(`title handler failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				if (worker.registered) await this.#notifySessionsChanged();
				return;
			}
			case "agent": {
				worker.lastEventAt = Date.now();
				try {
					this.#opts.onAgentEvent?.(worker.id, status);
				} catch (err) {
					this.#log(`agent event handler failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
		}
	}
	#onModelResult(worker: Worker, result: WorkerModelResult): void {
		const pending = worker.modelChanges.get(result.agentId);
		if (!pending || pending.id !== result.id) {
			this.#log(`worker ${worker.id}: dropping unmatched model reply ${result.id}`);
			return;
		}
		worker.modelChanges.delete(result.agentId);
		clearTimeout(pending.timer);
		pending.response.resolve(result);
	}

	#onRequestResult(worker: Worker, result: WorkerRequestResult): void {
		const pending = worker.requests.get(result.id);
		if (!pending) {
			this.#log(`worker ${worker.id}: dropping unmatched ${result.t} reply ${result.id}`);
			return;
		}
		worker.requests.delete(result.id);
		clearTimeout(pending.timer);
		pending.response.resolve(result);
	}

	#onAbortResult(worker: Worker, result: WorkerAbortResult): void {
		const pending = worker.abortRequest;
		if (!pending || pending.id !== result.id) {
			this.#log(`worker ${worker.id}: dropping unmatched abort reply ${result.id}`);
			return;
		}
		worker.abortRequest = undefined;
		clearTimeout(pending.timer);
		pending.response.resolve(result);
	}

	async #onExit(worker: Worker, proc: Subprocess, exitCode: number | null): Promise<void> {
		clearTimeout(worker.readyTimer);
		const deviceToken = worker.deviceToken;
		worker.deviceToken = undefined;
		if (deviceToken !== undefined) this.#opts.revokeWorkerToken?.(deviceToken);
		// Sweep worker subprocesses after every exit. POSIX kills the worker's process group, which outlives its leader.
		// Windows has no groups and reuses PIDs: a tree kill rooted at an exited PID could hit an unrelated process, so
		// Windows trees are only killed while the worker is alive (#terminate).
		if (process.platform !== "win32") killGroup(proc.pid, "SIGKILL");
		// Drain buffered stdout so a `fatal` line printed just before exit is not lost.
		await waitOrTimeout(worker.pumps, 1_000);
		if (worker.proc !== proc) return;
		worker.proc = undefined;
		for (const [agentId, pending] of worker.modelChanges) {
			clearTimeout(pending.timer);
			worker.modelChanges.delete(agentId);
			pending.response.reject(new SupervisorError("conflict", `worker exited before agent ${agentId} model change completed`));
		}
		for (const [requestId, pending] of worker.requests) {
			clearTimeout(pending.timer);
			worker.requests.delete(requestId);
			pending.response.reject(new SupervisorError("conflict", `worker exited before session ${worker.id} answered`));
		}
		if (worker.abortRequest) {
			clearTimeout(worker.abortRequest.timer);
			worker.abortRequest.response.reject(new SupervisorError("conflict", `worker exited before session ${worker.id} abort completed`));
			worker.abortRequest = undefined;
		}
		worker.exited.resolve();
		const how = `code ${exitCode ?? "none"}, signal ${proc.signalCode ?? "none"}`;
		if (worker.stopping) {
			worker.state = worker.crashReason ? "crashed" : "stopped";
			worker.ready?.reject(new SupervisorError("conflict", "worker stopped before it became ready"));
			return;
		}
		if (worker.ready) {
			worker.ready.reject(new SupervisorError("internal", worker.fatalMessage ?? `worker exited before ready (${how})`));
			return;
		}
		this.#onCrash(worker, exitCode, proc.signalCode, worker.fatalMessage ?? `worker exited unexpectedly (${how})`);
	}

	#onCrash(worker: Worker, exitCode: number | null, signal: string | null, message: string): void {
		worker.state = "crashed";
		worker.awaitingAnswer = false;
		worker.pendingQuestion = undefined;
		worker.pendingKind = undefined;
		const willRestart = !this.#closed && !worker.stopping && worker.restarts < this.#backoff.length;
		this.#log(`worker ${worker.id} crashed: ${message}${willRestart ? " (restarting)" : " (giving up)"}`);
		const event: CrashEvent = {
			sessionId: worker.id,
			exitCode,
			signal,
			restarts: worker.restarts,
			willRestart,
		};
		if (worker.title !== undefined) event.title = worker.title;
		try {
			this.#opts.onCrash?.(event);
		} catch (err) {
			this.#log(`crash handler failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!willRestart) return;
		const delay = this.#backoff[worker.restarts] ?? 0;
		worker.restartTimer = setTimeout(() => {
			worker.restartTimer = undefined;
			if (worker.stopping || this.#closed) return;
			worker.restarts++;
			this.#launch(worker);
		}, delay);
	}

	/** Sends stop, then terminates the process tree if the worker does not exit. */
	async #terminate(worker: Worker): Promise<void> {
		clearTimeout(worker.restartTimer);
		worker.restartTimer = undefined;
		clearTimeout(worker.readyTimer);
		const proc = worker.proc;
		if (!proc) {
			worker.state = "stopped";
			return;
		}
		const exited = worker.exited.promise;
		const send = (command: WorkerCommand): void => {
			try {
				writeWorkerLine(proc.stdin, `${JSON.stringify(command)}\n`, true);
			} catch {
				// stdin already closed: the process is on its way out
			}
		};
		send({ t: "stop" });
		if (await waitOrTimeout(exited, this.#opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)) return;
		if (process.platform === "win32") {
			this.#log(`worker ${worker.id} ignored stop; killing its process tree`);
			await killWindowsProcessTree(proc.pid);
			// The exit is reported shortly after taskkill returns; the grace configured for POSIX signals (tests use a few
			// hundred ms) is too short for that, and returning before the exit lets a wake race the dying worker.
			if (await waitOrTimeout(exited, WINDOWS_KILL_EXIT_WAIT_MS)) return;
			// taskkill can fail (access denied, a hung tree); never let stop or shutdown wait forever.
			this.#log(`worker ${worker.id} survived taskkill; terminating the process`);
			try {
				proc.kill();
			} catch {
				// already gone
			}
			await waitOrTimeout(exited, WINDOWS_KILL_EXIT_WAIT_MS);
			return;
		}
		this.#log(`worker ${worker.id} ignored stop; sending SIGTERM`);
		try {
			proc.kill("SIGTERM");
		} catch {
			// already gone
		}
		if (await waitOrTimeout(exited, this.#opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS)) return;
		this.#log(`worker ${worker.id} ignored SIGTERM; sending SIGKILL`);
		killGroup(proc.pid, "SIGKILL");
		await exited;
	}
}


function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// group already gone
	}
}

async function killWindowsProcessTree(pid: number): Promise<void> {
	try {
		const taskkill = Bun.spawn([path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), "/PID", String(pid), "/T", "/F"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		// taskkill walks every process; never let one stuck walk hold up stop or shutdown.
		if (!(await waitOrTimeout(taskkill.exited, WINDOWS_KILL_EXIT_WAIT_MS))) taskkill.kill();
	} catch {
		// The worker or its tree already exited.
	}
}

/** Resolves true when `promise` settled before the timeout. */
async function waitOrTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
	const { promise: timeout, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	try {
		return await Promise.race([promise.then(() => true), timeout]);
	} finally {
		clearTimeout(timer);
	}
}
