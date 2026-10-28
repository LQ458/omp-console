/** Daemon assembly: one loopback HTTP server for the relay (`/r/*`), control API (`/api/*`) and static web. */
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import type { DaemonCapabilities, OptionalFeatureName, QuickAskSource, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createApi, errorResponse, json, type RestartNotice } from "./api";
import { type AreaOptions, type Areas, createAreas } from "./areas";
import { createDaemonConfigRoutes, MAX_CONFIG_BODY_BYTES } from "./config-routes";
import type { ConfigFlagField, FeatureSettings } from "./config";
import { computerUseSupported } from "./platform";
import { checkFetchSite, checkRequest, normalizeAllowedHosts } from "./auth";
import { Journal } from "./journal";
import { PushStore } from "./push";
import { type PushFetch, PushSender } from "./push-sender";
import { PushAnswerTokenStore } from "./push-answer";
import type { RecentSessionLister } from "./recent";
import { Relay, type RelaySocketData } from "./relay";
import { serveStatic } from "./static";
import { DEFAULT_SLEEP_AFTER_MINUTES, type AgentEventListener, type CrashEvent, type NotifyEvent, Supervisor } from "./supervisor";
import { ModelControl } from "./model-control";
import { createPeerRoutes, type PeerDaemon, peerRelayUpgrade, peerRelayWebSocket } from "./peers";
import { LiveSocketHub, withLiveWebSocket } from "./live-websocket";
import { createPlanRoutes } from "./plans/routes";
import { WIDGET_FRAME_PATH, widgetFrameResponse } from "./widget-frame";
import { ArchiveStore } from "./archive";
import { HostedSessionStore } from "./hosted-sessions";
import { PinStore } from "./pins/store";
import { moveSessionToTrash } from "./trash";
import { excludeArchivedLibrarianRows } from "./librarian/archive-filter";
import { readLatestAgentReply } from "./librarian/transcript";
import { compressApiJsonResponse } from "./compression";
import { parseUsageReports } from "./quota/model";
import { OvernightController, isTerminalOvernightState } from "./overnight/controller";
import { createOvernightRoutes, type OvernightRoutes } from "./overnight/routes";
import { OvernightStore } from "./overnight/store";

import { DeviceAuthStore, isDeviceToken, type PairingCodeInfo } from "./device-auth";
import { PairingRequestWatcher } from "./pairing-control";
import { createPairingRoutes } from "./pairing-routes";
import { loadStateEnvironment } from "./setup/env";
import { createSetupRoute } from "./setup/routes";

import { atomicWriteFile } from "./workspaces/files";
import { createClaudeImportRoutes } from "./claude-import/routes";
/** The raw-body upload route (here or proxied to a peer): exempt from the JSON content type and the 1 MiB cap. */
const UPLOAD_PATH = /^\/api\/(?:peers\/[^/]+\/)?sessions\/[^/]+\/uploads$/;
/** Every other request body: JSON, at most 1 MiB (routes apply their own smaller `readJson` limits). */
const MAX_JSON_REQUEST_BYTES = 1024 * 1024;
const MAX_SLEEP_AFTER_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

/** Reads a chunked body up to `max` bytes into a new request with a Content-Length; null when it is larger. */
async function capChunkedBody(req: Request, max: number): Promise<Request | null> {
	const reader = req.body!.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const body = Buffer.concat(chunks, size);
	const headers = new Headers(req.headers);
	headers.set("content-length", String(size));
	return new Request(req.url, { method: req.method, headers, body, signal: req.signal });
}
const SECURITY_HEADERS = {
	"Content-Security-Policy":
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

function withSecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function loadPeerCredentials(peers: readonly PeerDaemon[]): Promise<PeerDaemon[]> {
	return Promise.all(peers.map(async peer => {
		if (peer.tokenFile === undefined) {
			if (peer.token === undefined || !isDeviceToken(peer.token)) throw new Error(`peer ${peer.id} needs a device token file`);
			return peer;
		}
		try {
			const stat = await fs.lstat(peer.tokenFile);
			if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
				throw new Error("tokenFile must be a regular file with mode 0600");
			}
			const token = (await fs.readFile(peer.tokenFile, "utf8")).trim();
			if (!isDeviceToken(token)) throw new Error("tokenFile does not contain a 32-byte base64url device token");
			return { ...peer, token };
		} catch (error) {
			throw new Error(`peer ${peer.id} tokenFile is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}));
}
export interface DaemonOptions {
	/** 0 picks a free port (tests). */
	port: number;
	stateDir: string;
	/** Tailscale login allowed through `tailscale serve` (`Tailscale-User-Login`). */
	owner?: string;
	webDir?: string;
	/** Worker executable plus leading args; contract flags are appended. */
	workerCmd: string[];
	/** Persisted sessions for `GET /api/sessions` (`listPersistedSessions` in production). */
	listRecent: RecentSessionLister;
	stalledAfterMs?: number;
	readyTimeoutMs?: number;
	stopGraceMs?: number;
	maxWorkers?: number;
	/** Completed turns at or under this length send no push; default 5 minutes. Questions and approvals always push. */
	notifyTurnsOverMs?: number;
	/** Where deleted sessions go; default the macOS Trash (none elsewhere). `null` keeps them in `<stateDir>/trash`. */
	systemTrashDir?: string | null;
	termGraceMs?: number;
	/** Longest a stop waits for the session's key points (default 8 s). */
	beforeStopTimeoutMs?: number;
	/** Automatic worker sleep after this many idle minutes; 0 disables it (default 120). */
	sleepAfterMinutes?: number;
	/** Test seam for the automatic sleep scan cadence. */
	sleepPollMs?: number;
	restartBackoffMs?: readonly number[];
	pingIntervalMs?: number;
	pongTimeoutMs?: number;
	/** Maximum waits for the worker's replies to catalog, run-command and spawn-agent requests (defaults 10, 30, 30 s). */
	catalogTimeoutMs?: number;
	commandTimeoutMs?: number;
	spawnTimeoutMs?: number;
	/** Extra env for workers (for example an isolated `PI_CONFIG_DIR` in tests). */
	workerEnv?: Record<string, string>;
	/** Host platform used for Linux-specific lifecycle and worker scheduling; defaults to process.platform. */
	platform?: string;
	/** Test seam for Linux's optional ionice executable. */
	ioniceAvailable?: boolean;
	/** Active omp agent directory; defaults to `PI_CODING_AGENT_DIR`. */
	agentDir?: string;
	onNotify?: (event: NotifyEvent) => void;
	onCrash?: (event: CrashEvent) => void;
	/** Called for every subagent lifecycle line of every worker; `Daemon.onAgentEvent` adds listeners later. */
	onAgentEvent?: AgentEventListener;
	/** Journal and feedback files rotate past this size (default 10 MB; tests lower it). */
	journalMaxFileBytes?: number;
	/**
	 * Host names (without scheme) the daemon answers to besides `localhost`, `127.0.0.1` and `[::1]`, for example
	 * the machine's `*.ts.net` name. Any other `Host` or `X-Forwarded-Host` is refused with 421.
	 */
	allowHosts?: string[];
	/** VAPID `sub` contact (`mailto:` or `https:`). */
	pushSubject?: string;
	pushTtlSeconds?: number;
	/** At most one push per session and reason in this window. */
	pushCoalesceMs?: number;
	pushTimeoutMs?: number;
	/** Test seam: transport for push requests (the real push services are https-only). */
	pushFetch?: PushFetch;
	log?: (message: string) => void;
	/** Test seam for exercising overnight behavior without real provider credentials. */
	modelAvailability?: (model?: string) => Promise<{ available: boolean; detail: string }>;
	/** Receives the startup code; interactive main prints a one-click link, services log only its file path. */
	onPairingCode?: (pairing: PairingCodeInfo) => void;

	/** Explicit installation roots; absent roots never fall back to personal home-directory paths. */
	knowledgeRoot?: string;
	projectRoots?: readonly string[];
	/** Effective feature flags after config validation. */
	features?: FeatureSettings;
	/** Feature values explicitly selected by CLI flags or the computer-use environment override. */
	featureOverrides?: Partial<Record<OptionalFeatureName, boolean>>;
	/** `config.json` fields set by CLI flags (see `ConfigFlagField`). */
	configFlagFields?: ReadonlySet<ConfigFlagField>;
	quickAskSources?: readonly QuickAskSource[];
	/** Librarian models (see `AreaOptions.backgroundModels`); called only when librarian is enabled and rooted. */
	backgroundModels?: AreaOptions["backgroundModels"];
	scheduleConfig?: string;
	agendaHub?: AreaOptions["agendaHub"];
	/** Called after a supervised restart request has returned its 202 response. */
	requestRestart?: () => void;
	/** This machine's id and name, shown on its sessions in a multi-machine deck. */
	machine?: { id: string; name: string };
	/** Peer daemons reachable over explicit configuration. */
	peers?: readonly PeerDaemon[];
	/** Background timers of the areas (quota poll, idle summaries, idle stops); tests turn them off. */
	areaTimers?: boolean;
	/**
	 * Test seam: where the request came from. The default is the socket peer address; the real server only
	 * ever sees loopback peers, so tests use this to exercise the non-loopback rejection.
	 */
	remoteAddress?: (req: Request, server: Bun.Server<RelaySocketData>) => string | undefined;
}

export interface Daemon {
	readonly port: number;
	/** `http://127.0.0.1:<port>` */
	readonly url: string;
	readonly supervisor: Supervisor;
	readonly relay: Relay;
	/** Subscribe to every worker's subagent lifecycle lines; returns the unsubscribe function. */
	onAgentEvent(listener: AgentEventListener): () => void;
	/** Stops every worker, closes all rooms and the server. Idempotent. */
	stop(): Promise<void>;
}

interface StoredSession {
	id: string;
	cwd: string;
	sessionFile: string;
	state: SessionSummary["state"];
	createdAt?: number;
	lastActivityAt?: number;
	model?: string;
	title?: string;
	hidden?: boolean;
	pinned?: boolean;
}

interface StoredSessionState {
	version: 1;
	sessions: StoredSession[];
	asleep: StoredSession[];
	restartNotice: RestartNotice | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readSleepAfterMinutes(file: string, fallback: number, log: (message: string) => void): Promise<number> {
	try {
		const value: unknown = JSON.parse(await Bun.file(file).text());
		if (
			isRecord(value) &&
			typeof value.minutes === "number" &&
			Number.isSafeInteger(value.minutes) &&
			value.minutes >= 0 &&
			value.minutes <= MAX_SLEEP_AFTER_MINUTES
		) {
			return value.minutes;
		}
		log("sleep settings are invalid; using the configured default");
	} catch (error) {
		if (!(isRecord(error) && error.code === "ENOENT")) log("sleep settings could not be read; using the configured default");
	}
	return fallback;
}

function isSessionState(value: unknown): value is SessionSummary["state"] {
	return value === "starting" || value === "waking" || value === "idle" || value === "streaming" || value === "asking" || value === "stopped" || value === "crashed" || value === "asleep";
}

function parseStoredSession(value: unknown): StoredSession | null {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.sessionFile !== "string" ||
		!isSessionState(value.state)
	) {
		return null;
	}
	if (value.createdAt !== undefined && (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt))) return null;
	if (value.lastActivityAt !== undefined && (typeof value.lastActivityAt !== "number" || !Number.isFinite(value.lastActivityAt))) return null;
	if (value.model !== undefined && typeof value.model !== "string") return null;
	if (value.title !== undefined && typeof value.title !== "string") return null;
	if (value.hidden !== undefined && typeof value.hidden !== "boolean") return null;
	if (value.pinned !== undefined && typeof value.pinned !== "boolean") return null;
	return {
		id: value.id,
		cwd: value.cwd,
		sessionFile: value.sessionFile,
		state: value.state === "waking" ? "asleep" : value.state,
		...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
		...(typeof value.lastActivityAt === "number" ? { lastActivityAt: value.lastActivityAt } : {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(typeof value.title === "string" ? { title: value.title } : {}),
		...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
		...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}),
	};
}

function parseRestartNotice(value: unknown): RestartNotice | null {
	if (
		!isRecord(value) ||
		typeof value.at !== "number" ||
		!Number.isFinite(value.at) ||
		typeof value.resumed !== "number" ||
		!Number.isInteger(value.resumed) ||
		!Array.isArray(value.interruptedTitles)
	) {
		return null;
	}
	const interruptedTitles: string[] = [];
	for (const title of value.interruptedTitles) {
		if (typeof title !== "string") return null;
		interruptedTitles.push(title);
	}
	return { at: value.at, resumed: value.resumed, interruptedTitles };
}

async function readStoredSessionState(file: string, log: (message: string) => void): Promise<{ exists: boolean; state: StoredSessionState }> {
	const empty: StoredSessionState = { version: 1, sessions: [], asleep: [], restartNotice: null };
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { exists: false, state: empty };
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		log("live session state is invalid JSON; starting without recovery state");
		return { exists: true, state: empty };
	}
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions) || (value.asleep !== undefined && !Array.isArray(value.asleep))) {
		log("live session state has an unsupported format; starting without recovery state");
		return { exists: true, state: empty };
	}
	const sessions: StoredSession[] = [];
	const asleep: StoredSession[] = [];
	for (const entry of value.sessions) {
		const session = parseStoredSession(entry);
		if (!session) {
			log("live session state has an invalid session; dropping that entry");
			continue;
		}
		if (session.state === "asleep") asleep.push(session);
		else sessions.push(session);
	}
	for (const entry of value.asleep ?? []) {
		const session = parseStoredSession(entry);
		if (!session || session.state !== "asleep") {
			log("live session state has an invalid asleep session; dropping that entry");
			continue;
		}
		asleep.push(session);
	}
	const restartNotice = value.restartNotice === null ? null : parseRestartNotice(value.restartNotice);
	if (value.restartNotice !== null && restartNotice === null) {
		log("live session state has an invalid restart notice; starting without recovery state");
		return { exists: true, state: empty };
	}
	return { exists: true, state: { version: 1, sessions, asleep, restartNotice } };
}

function storedSession(summary: SessionSummary): StoredSession | null {
	// Hidden sessions (agenda, quick-ask, reports) carry launch restrictions (tool allowlist, profile) that a resume
	// would not restore; their owners recreate them on demand, so they are never resumed after a restart.
	if (!summary.sessionFile || summary.hidden) return null;
	return {
		id: summary.id,
		cwd: summary.cwd,
		sessionFile: summary.sessionFile,
		state: summary.state === "waking" ? "asleep" : summary.state,
		createdAt: summary.createdAt,
		lastActivityAt: summary.lastActivityAt,
		...(summary.model === undefined ? {} : { model: summary.model }),
		...(summary.title === undefined ? {} : { title: summary.title }),
		...(summary.hidden === undefined ? {} : { hidden: summary.hidden }),
		...(summary.pinned === undefined ? {} : { pinned: summary.pinned }),
	};
}

function asleepSummary(session: StoredSession): SessionSummary {
	const now = Date.now();
	return {
		id: session.id,
		cwd: session.cwd,
		sessionFile: session.sessionFile,
		state: "asleep",
		createdAt: session.createdAt ?? now,
		lastActivityAt: session.lastActivityAt ?? session.createdAt ?? now,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...(session.title === undefined ? {} : { title: session.title }),
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.pinned === undefined ? {} : { pinned: session.pinned }),
	};
}

async function validateStoredSession(session: StoredSession, sessionsDir: string, requireFile: boolean): Promise<void> {
	if (!path.isAbsolute(session.sessionFile)) throw new Error("session path is not absolute");
	const [root, parent, cwdInfo] = await Promise.all([
		fs.realpath(sessionsDir),
		fs.realpath(path.dirname(session.sessionFile)),
		fs.stat(session.cwd),
	]);
	const parentRelative = path.relative(root, parent);
	if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new Error("outside the session store");
	if (!cwdInfo.isDirectory()) throw new Error("cwd is not a directory");
	if (requireFile) {
		const [realFile, fileInfo] = await Promise.all([fs.realpath(session.sessionFile), fs.stat(session.sessionFile)]);
		const fileRelative = path.relative(root, realFile);
		if (!fileInfo.isFile() || fileRelative.startsWith("..") || path.isAbsolute(fileRelative)) {
			throw new Error("session file is gone or outside the session store");
		}
	}
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
	const envKeys = await loadStateEnvironment(options.stateDir);
	const log = options.log ?? (() => {});
	const platform = options.platform ?? process.platform;
	const auth = { owner: options.owner, allowedHosts: normalizeAllowedHosts(options.allowHosts) };
	const configuredFeatures: Partial<FeatureSettings> = options.features ?? {};
	const quickAskSources = [...new Set(options.quickAskSources ?? [])];
	const peersHaveCredentials = (options.peers ?? []).every(peer => peer.tokenFile !== undefined || peer.token !== undefined);
	const librarianEnabled =
		configuredFeatures.librarian === true &&
		options.knowledgeRoot !== undefined &&
		(options.projectRoots?.length ?? 0) > 0 &&
		options.backgroundModels !== undefined;
	const computerUseRequested = configuredFeatures.computerUse === true || process.env.OMP_CONSOLE_COMPUTER_USE === "1";
	const computerUseAvailable = computerUseSupported(platform);
	if (computerUseRequested && !computerUseAvailable) log(`computer use unavailable on ${platform}; computer use is macOS-only`);
	const features: FeatureSettings = {
		librarian: librarianEnabled,
		agenda: configuredFeatures.agenda === true && options.agendaHub !== undefined,
		quickAsk: configuredFeatures.quickAsk === true && options.knowledgeRoot !== undefined && quickAskSources.length > 0,
		peers: configuredFeatures.peers === true && peersHaveCredentials,
		openrouterDecisions: configuredFeatures.openrouterDecisions === true && librarianEnabled,
		computerUse: computerUseRequested && computerUseAvailable,
		overnight: configuredFeatures.overnight === true,
	};
	const capabilities: DaemonCapabilities = {
		features: { ...features },
		quickAskSources: features.quickAsk ? quickAskSources : [],
	};
	await fs.mkdir(options.stateDir, { recursive: true, mode: 0o700 });
	const pairingFile = path.join(options.stateDir, "pairing-code");
	const defaultPairingFile = path.join(process.env.HOME ?? "", ".omp-console", "pairing-code");
	const displayPairingFile = path.resolve(pairingFile) === path.resolve(defaultPairingFile) ? "~/.omp-console/pairing-code" : pairingFile;
	const onPairingCode = options.onPairingCode ?? (() => process.stdout.write(`pairing code issued, see ${displayPairingFile}\n`));
	const deviceAuth = await DeviceAuthStore.open(options.stateDir, onPairingCode);

	const pairingWatcher = new PairingRequestWatcher(options.stateDir, deviceAuth);
	const archiveStore = await ArchiveStore.open(options.stateDir, log);
	const hostedSessions = await HostedSessionStore.open(options.stateDir);
	const stateFile = path.join(options.stateDir, "live-sessions.json");
	const loadedState = await readStoredSessionState(stateFile, log);
	const sessionsDir = process.env.OMP_CONSOLE_SESSIONS_DIR || getSessionsDir(options.agentDir);
	const claudeImportRoutes = await createClaudeImportRoutes({
		agentDir: options.agentDir ?? getAgentDir(),
		sessionDir: sessionsDir,
		stateDir: options.stateDir,
		onImported: file => hostedSessions.remember([file]),
	});
	const sleepSettingsFile = path.join(options.stateDir, "sleep-settings.json");
	const sleepAfterMinutes = await readSleepAfterMinutes(
		sleepSettingsFile,
		options.sleepAfterMinutes ?? DEFAULT_SLEEP_AFTER_MINUTES,
		log,
	);
	// The snapshot is daemon-written, but resume only a persisted transcript inside the active session store, with an
	// existing cwd and no hidden sessions. Asleep sessions remain persisted without starting workers.
	const sessionsToResume: StoredSession[] = [];
	for (const session of loadedState.state.sessions) {
		if (session.hidden || archiveStore.isArchived(session.id)) continue;
		try {
			// Opening a missing transcript creates a blank session with a new id; it is not a recovery.
			await validateStoredSession(session, sessionsDir, true);
			sessionsToResume.push(session);
		} catch {
			log(`not resuming session ${session.id}: its file or directory is gone or outside the session store`);
		}
	}
	const sessionsToRestoreAsleep: StoredSession[] = [];
	for (const session of loadedState.state.asleep) {
		if (session.hidden || archiveStore.isArchived(session.id)) continue;
		try {
			await validateStoredSession(session, sessionsDir, true);
			sessionsToRestoreAsleep.push(session);
		} catch {
			log(`not restoring asleep session ${session.id}: its file or directory is gone or outside the session store`);
		}
	}
	const interruptedTitles = sessionsToResume
		.filter(session => session.state === "streaming" || session.state === "asking")
		.map(session => session.title ?? path.basename(session.cwd));
	// A restart with nothing running is not news: the notice is for sessions that were live when deck went down.
	let restartNotice: RestartNotice | null =
		loadedState.exists && sessionsToResume.length > 0 ? { at: Date.now(), resumed: 0, interruptedTitles } : null;
	const restartNoticeReady = Promise.withResolvers<void>();
	const recoveryPending = new Map(sessionsToResume.map(session => [session.id, session]));
	let stateWriteTail: Promise<void> = Promise.resolve();
	const persistSessionSet = (sessions: SessionSummary[]): Promise<void> => {
		for (const session of sessions) recoveryPending.delete(session.id);
		const records = new Map(recoveryPending);
		const asleepRecords = new Map<string, StoredSession>();
		for (const summary of sessions) {
			if (archiveStore.isArchived(summary.id)) continue;
			const stored = storedSession(summary);
			if (!stored) continue;
			if (summary.state === "asleep" || summary.state === "waking") asleepRecords.set(summary.id, stored);
			else records.set(summary.id, stored);
		}
		const snapshot: StoredSessionState = {
			version: 1,
			sessions: [...records.values()],
			asleep: [...asleepRecords.values()],
			restartNotice,
		};
		const write = stateWriteTail.catch(() => {}).then(() => atomicWriteFile(stateFile, `${JSON.stringify(snapshot)}\n`, 0o600));
		stateWriteTail = write;
		return write;
	};
	const push = new PushStore(options.stateDir);
	const pushAnswerTokens = new PushAnswerTokenStore();
	let supervisor: Supervisor;
	const sender = await PushSender.open({
		stateDir: options.stateDir,
		store: push,
		subject: options.pushSubject,
		ttlSeconds: options.pushTtlSeconds,
		coalesceMs: options.pushCoalesceMs,
		timeoutMs: options.pushTimeoutMs,
		fetch: options.pushFetch,
		turnFinishedThresholdMs: options.notifyTurnsOverMs,
		log,
		answerTokens: pushAnswerTokens,
		listUiRequests: async sessionId => {
			const result = await supervisor.sessionOp(sessionId, { op: "ui-requests" });
			return "uiRequests" in result ? result.uiRequests : [];
		},
		// Named as the session list names it (the librarian card), with the agent's last reply for "finished" pushes.
		describe: async (sessionId, reason) => {
			const sessionFile = reason === "turn-finished" ? supervisor.get(sessionId)?.sessionFile : undefined;
			return {
				title: areas.sessionTitle(sessionId),
				latestReply: sessionFile ? await readLatestAgentReply(sessionFile) : undefined,
			};
		},
	});
	const journal = new Journal(options.stateDir, { maxFileBytes: options.journalMaxFileBytes });
	const agentListeners = new Set<AgentEventListener>();
	let port = options.port;
	const relay = new Relay({ pingIntervalMs: options.pingIntervalMs, pongTimeoutMs: options.pongTimeoutMs });
	const liveSockets = new LiveSocketHub();
	const pinStore = new PinStore(options.stateDir, log);
	let overnightController: OvernightController | undefined;
	let overnightRoutes: OvernightRoutes | undefined;
	supervisor = new Supervisor({
		isPinned: sessionId => pinStore.has(sessionId),
		onHostedSessionFile: file => void hostedSessions.remember([file]),
		workerCmd: options.workerCmd,
		relayUrl: () => `ws://127.0.0.1:${port}`,
		issueWorkerToken: sessionId => deviceAuth.createWorkerToken(sessionId),
		revokeWorkerToken: token => deviceAuth.revokeWorkerToken(token),
		maxWorkers: options.maxWorkers,
		sleepAfterMinutes,
		sleepPollMs: options.sleepPollMs,
		sleepBlocked: summary => summary.roomId !== undefined && relay.hasGuests(summary.roomId),
		agendaToolsEnabled: features.agenda,
		computerUseEnabled: features.computerUse,
		platform,
		ioniceAvailable: options.ioniceAvailable,
		stalledAfterMs: options.stalledAfterMs,
		readyTimeoutMs: options.readyTimeoutMs,
		stopGraceMs: options.stopGraceMs,
		termGraceMs: options.termGraceMs,
		beforeStopTimeoutMs: options.beforeStopTimeoutMs ?? 8_000,
		restartBackoffMs: options.restartBackoffMs,
		catalogTimeoutMs: options.catalogTimeoutMs,
		commandTimeoutMs: options.commandTimeoutMs,
		spawnTimeoutMs: options.spawnTimeoutMs,
		env:
			options.agentDir === undefined
				? options.workerEnv
				: { ...options.workerEnv, PI_CODING_AGENT_DIR: options.agentDir },
		onNotify: event => {
			areas.onNotify(event);
			void sender.notify(event);
			options.onNotify?.(event);
		},
		onCrash: event => {
			void sender.crashed(event);
			options.onCrash?.(event);
			overnightController?.onWorkerCrash(event);
		},
		onOvernightStatus: (sessionId, status) => overnightController?.onWorkerStatus(sessionId, status),
		onOvernightPromptFailure: (sessionId, message) => overnightController?.onInitialPromptFailure(sessionId, message),
		onAgentEvent: (sessionId, event) => {
			options.onAgentEvent?.(sessionId, event);
			for (const listener of [...agentListeners]) {
				try {
					listener(sessionId, event);
				} catch (error) {
					log(`agent event listener failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		},
		// The areas are built after the supervisor (they need it); no hook can fire before startDaemon resolves.
		onUsageSample: (sessionId, sample) => areas.onUsageSample(sessionId, sample),
		onLiveAudio: (sessionId, audio) => liveSockets.publishAudio(sessionId, audio),
		onLiveLevels: (sessionId, input, output) => liveSockets.publishLevels(sessionId, input, output),
		onLiveModeStatus: (sessionId, status) => liveSockets.publishState(sessionId, status),
		onCreated: async (summary, request) => {
			await areas.onCreated(summary, request);
			await overnightRoutes?.onCreated(summary, request);
		},
		beforeStop: sessionId => areas.beforeStop(sessionId),
		beforeSleep: sessionId => areas.beforeSleep(sessionId),
		// Writes are queued in persistSessionSet; the supervisor awaits the sleep transition's durable snapshot, while
		// other state changes remain fire-and-forget so a slow disk cannot delay status handling.
		onSessionsChanged: sessions => persistSessionSet(sessions),
		log,
	});
	supervisor.restoreAsleep(sessionsToRestoreAsleep.map(asleepSummary));
	const agentDir = options.agentDir ?? getAgentDir();
	const modelControl = new ModelControl(agentDir);
	const setupRoute = createSetupRoute({
		agentDir,
		sessionsDir,
		envKeys,
		listRecent: options.listRecent,
		modelControl,
	});
	const areas: Areas = await createAreas(supervisor, modelControl, {
		stateDir: options.stateDir,
		agentDir: options.agentDir,
		knowledgeRoot: options.knowledgeRoot,
		projectRoots: options.projectRoots,
		features,
		quickAskSources,
		backgroundModels: features.librarian ? options.backgroundModels : undefined,
		scheduleConfig: options.scheduleConfig,
		agendaHub: options.agendaHub,
		timers: options.areaTimers,
		quotaPollMs: options.areaTimers === false ? 0 : undefined,
		log,
	});
	agentListeners.add((sessionId, event) => areas.onAgentEvent(sessionId, event));

	if (features.overnight) {
		const overnightStore = new OvernightStore(options.stateDir, log);
		const overnight = new OvernightController({
			supervisor,
			store: overnightStore,
			notify: (sessionId, phase, title) => sender.notifyOvernight(sessionId, phase, title),
			log,
			platform,
		});
		overnightController = overnight;
		await overnight.load();
		overnightRoutes = createOvernightRoutes({
			controller: overnight,
			store: overnightStore,
			supervisor,
			preflightOptions: cwd => ({
				platform,
				// Workers enable computer use exactly when this feature is on (`launch.computerUse`), so check the same flag.
				computerUseEnabled: features.computerUse,
				modelAvailability: async model => {
					if (options.modelAvailability) return options.modelAvailability(model);
					const currentModel = supervisor.list().find(session => session.cwd === cwd && session.model)?.model;
					const selector = model ?? currentModel ?? (await modelControl.modelRoles()).default;
					const provider = selector?.split("/", 1)[0];
					if (!provider) {
						return { available: false, detail: "No model selection is available to check authentication; no model call was made." };
					}
					const available = await modelControl.hasProviderAuth(provider);
					return {
						available,
						detail: available
							? `An authentication source is configured for ${provider}; no model call was made.`
							: `No authentication source is configured for ${provider}; no model call was made.`,
					};
				},
				usageWindowPercent: async () => {
					const session = supervisor.list().find(candidate =>
						candidate.model && (candidate.state === "idle" || candidate.state === "streaming" || candidate.state === "asking"),
					);
					if (!session) return undefined;
					const reports = await supervisor.usage(session.id, 3_000);
					const windows = parseUsageReports(reports, Date.now())
						.filter(account => !account.view.stale)
						.flatMap(account => account.view.windows.map(window => window.usedPct));
					return windows.length === 0 ? undefined : Math.max(...windows);
				},
				activeOvernightCount: () => overnight.states().filter(state => !isTerminalOvernightState(state)).length,
			}),
		});
	}

	// Draft plans run by deck itself (spec 4.5 v2): spawns through the worker, progress from its agent lifecycle lines.
	const plans = createPlanRoutes(
		{
			spawn: async (sessionId, request) => ({ agentId: await supervisor.spawnAgent(sessionId, request) }),
			cancelAgent: (sessionId, agentId) => supervisor.cancelAgent(sessionId, agentId),
			onAgentEvent: listener => {
				agentListeners.add(listener);
				return () => {
					agentListeners.delete(listener);
				};
			},
			knownProfiles: async sessionId => (await supervisor.catalog(sessionId)).profiles.map(profile => profile.name),
			now: () => Date.now(),
		},
		options.stateDir,
	);

	const api = createApi({
		// OMP_CONSOLE_SESSIONS_DIR: a separate session store (the scenario sandbox); workers honour the same variable.
		sessionsDir,
		uploadStateDir: options.stateDir,
		pinStore,
		modelControl,
		journal,
		supervisor,
		overnight: overnightRoutes,
		relay,
		push,
		sender,
		pushAnswerTokens,
		startedAt: Date.now(),
		listRecent: options.listRecent,
		archiveStore,
		hostedSessions,
		trashSessionFile: file => moveSessionToTrash(file, { stateDir: options.stateDir, systemTrashDir: options.systemTrashDir }),
		isHiddenSessionFile: file => areas.isHiddenSessionFile(file),
		createRoots: areas.roots,
		fallbackHost: () => `127.0.0.1:${port}`,
		log,
		setSleepAfterMinutes: async minutes => {
			const previous = supervisor.sleepAfterMinutes;
			supervisor.setSleepAfterMinutes(minutes);
			try {
				await atomicWriteFile(sleepSettingsFile, `${JSON.stringify({ minutes })}\n`, 0o600);
			} catch (error) {
				supervisor.setSleepAfterMinutes(previous);
				throw error;
			}
		},
		restartNotice: async () => {
			await restartNoticeReady.promise;
			return restartNotice;
		},
	});

	// Other machines' daemons (the VPS): their API under /api/peers/<id>/..., their relay under /peers/<id>/r/...
	const peers: readonly PeerDaemon[] = features.peers ? await loadPeerCredentials(options.peers ?? []) : [];
	const peerRoutes = features.peers
		? createPeerRoutes({ self: options.machine ?? { id: "local", name: "This machine" }, peers, log })
		: undefined;
	const configRoutes = createDaemonConfigRoutes({
		stateDir: options.stateDir,
		capabilities,
		knowledgeRoot: options.knowledgeRoot,
		projectRoots: options.projectRoots,
		quickAskSources,
		flagFields: options.configFlagFields,
		machineId: options.machine?.id ?? "local",
		computerUseSupported: computerUseAvailable,
		checkPeers: async candidates => {
			await loadPeerCredentials(candidates);
		},
		agendaHub: options.agendaHub,
		peers: options.peers,
		featureOverrides: options.featureOverrides,
		supervisor,
		restartSupported: process.env.OMP_CONSOLE_SUPERVISED === "1" && options.requestRestart !== undefined,
		requestRestart: options.requestRestart,
	});
	const socketsByDevice = new Map<string, Set<Bun.ServerWebSocket<RelaySocketData>>>();
	const closeDeviceSockets = (id: string): void => {
		const sockets = socketsByDevice.get(id);
		if (!sockets) return;
		socketsByDevice.delete(id);
		for (const socket of sockets) socket.close(4001, "device revoked");
	};
	const pairingRoutes = createPairingRoutes({
		store: deviceAuth,
		isSecure: req => {
			const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
			return forwarded === "https" || new URL(req.url).protocol === "https:";
		},
		onRevoked: closeDeviceSockets,
	});
	const relayWebSocket = withLiveWebSocket(peerRelayWebSocket(relay.websocket), liveSockets);
	const websocket: Bun.WebSocketHandler<RelaySocketData> = {
		...relayWebSocket,
		open(socket): void | Promise<void> {
			const deviceId = socket.data.deviceId;
			if (deviceId !== undefined) {
				if (!deviceAuth.isActiveIdentity(deviceId)) {
					socket.close(4001, "device revoked");
					return;
				}
				let sockets = socketsByDevice.get(deviceId);
				if (!sockets) socketsByDevice.set(deviceId, (sockets = new Set()));
				sockets.add(socket);
			}
			return relayWebSocket.open?.(socket);
		},
		close(socket, code, reason): void | Promise<void> {
			const deviceId = socket.data.deviceId;
			if (deviceId !== undefined) {
				const sockets = socketsByDevice.get(deviceId);
				sockets?.delete(socket);
				if (sockets?.size === 0) socketsByDevice.delete(deviceId);
			}
			return relayWebSocket.close?.(socket, code, reason);
		},
	};

	const server = Bun.serve<RelaySocketData>({
		hostname: "127.0.0.1",
		port: options.port,
		// POST /api/sessions waits for a worker to boot, which can exceed Bun's 10 s default.
		idleTimeout: 255,
		// Session uploads (`uploads.ts`) take up to 50 MiB; every other body is held to 1 MiB in `fetch` below. Bun's own
		// cap sits above the upload limit: when Bun cuts a body itself the handler never finishes and cannot remove the
		// partial file, so `uploads.ts` must always be the one that refuses an oversized upload.
		maxRequestBodySize: 64 * 1024 * 1024,
		async fetch(incoming, srv): Promise<Response | undefined> {
			let req = incoming;
			const remote = options.remoteAddress ? options.remoteAddress(req, srv) : srv.requestIP(req)?.address;
			const denial = checkRequest(req.headers, remote, auth);
			if (denial) {
				// Header values are attacker-controlled: logged as quoted, truncated JSON strings.
				// req.url is not parsed: Bun builds it from the Host header, so a malformed Host leaves it relative.
				const quoted = (value: string | null): string => JSON.stringify(value?.slice(0, 120) ?? null);
				log(`denied ${denial.status} ${req.method} url=${quoted(req.url)} host=${quoted(req.headers.get("host"))} origin=${quoted(req.headers.get("origin"))}`);
				return withSecurityHeaders(errorResponse(denial.status, denial.status === 401 ? "unauthorized" : "forbidden", denial.message));
			}
			const requestUrl = new URL(req.url);
			const { pathname } = requestUrl;
			const publicPairingRequest = (pathname === "/api/pair" && req.method === "POST") ||
				(pathname === "/api/pair/status" && req.method === "GET");
			const protectedPath = pathname === "/api" || pathname.startsWith("/api/") ||
				pathname.startsWith("/r/") || pathname.startsWith("/live/") || pathname.startsWith("/peers/");
			let deviceId: string | undefined;
			if (pathname === "/api/pair/status" && req.method === "GET") {
				deviceId = await deviceAuth.authenticate(req.headers);
			} else if (protectedPath && !publicPairingRequest) {
				deviceId = await deviceAuth.authenticate(req.headers);
				if (deviceId === undefined || !deviceAuth.isActiveIdentity(deviceId)) {
					return withSecurityHeaders(errorResponse(401, "unauthorized", "unauthorized"));
				}
			}
			const fetchSiteDenial = checkFetchSite(req.headers, pathname);
			if (fetchSiteDenial) {
				log(`denied ${fetchSiteDenial.status} ${req.method} url=${JSON.stringify(req.url.slice(0, 120))} sec-fetch-site=${JSON.stringify(req.headers.get("sec-fetch-site"))}`);
				return withSecurityHeaders(errorResponse(fetchSiteDenial.status, "forbidden", fetchSiteDenial.message));
			}
			const upload = req.method === "POST" && UPLOAD_PATH.test(pathname);
			const bodyLimit = pathname === "/api/config" && req.method === "PUT" ? MAX_CONFIG_BODY_BYTES : MAX_JSON_REQUEST_BYTES;
			if (!upload && Number(req.headers.get("content-length") ?? "0") > bodyLimit) {
				return withSecurityHeaders(errorResponse(413, "bad-request", "request body too large"));
			}
			// A chunked body has no length to check up front: read it here with the cap, so no route buffers more.
			if (!upload && req.body !== null && req.headers.get("content-length") === null) {
				const capped = await capChunkedBody(req, bodyLimit);
				if (capped === null) return withSecurityHeaders(errorResponse(413, "bad-request", "request body too large"));
				req = capped;
			}
			if (!upload && (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") && req.body !== null) {
				const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
				if (mediaType !== "application/json") {
					return withSecurityHeaders(errorResponse(415, "bad-request", "Content-Type must be application/json"));
				}
			}
			const liveUpgrade = liveSockets.upgrade(req, srv, supervisor, deviceId);
			if (liveUpgrade !== null) return liveUpgrade ? withSecurityHeaders(liveUpgrade) : undefined;
			if (pathname.startsWith("/r/")) {
				const response = relay.handle(req, srv, deviceId);
				return response ? withSecurityHeaders(response) : undefined;
			}
			// `/peers/<id>/r/...`: a guest of a session on another machine; bridged to that daemon's relay.
			const peerUpgrade = peerRelayUpgrade(req, srv, peers, log, deviceId);
			if (peerUpgrade !== null) return peerUpgrade ? withSecurityHeaders(peerUpgrade) : undefined;
			if (pathname === "/api" || pathname.startsWith("/api/")) {
				const url = requestUrl;
				if (deviceId !== undefined && !deviceAuth.isActiveIdentity(deviceId)) {
					return withSecurityHeaders(errorResponse(401, "unauthorized", "unauthorized"));
				}
				if (restartNotice !== null && req.method === "POST" && /^\/api\/sessions\/[^/]+\/room$/.test(pathname)) {
					await restartNoticeReady.promise;
				}
				const capabilitiesResponse =
					pathname === "/api/capabilities"
						? req.method === "GET"
							? json(200, capabilities)
							: errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET" })
						: undefined;
				const apiResponse =
					(await pairingRoutes(req, url, deviceId)) ??
					capabilitiesResponse ??
					(await setupRoute(req, url)) ??
					(await configRoutes(req, url)) ??
					(await plans(req, url)) ??
					(await areas.handle(req, url)) ??
					(await peerRoutes?.(req, url)) ??
					(await claudeImportRoutes(req, url)) ??
					(await api(req));
				const filteredResponse = await excludeArchivedLibrarianRows(apiResponse, pathname, id => archiveStore.isArchived(id));
				return withSecurityHeaders(await compressApiJsonResponse(req, filteredResponse));
			}
			if (pathname === WIDGET_FRAME_PATH && (req.method === "GET" || req.method === "HEAD")) return widgetFrameResponse();
			return withSecurityHeaders(await serveStatic(req, options.webDir));
		},
		websocket,
	});
	port = server.port ?? options.port;
	await pairingWatcher.start();
	if (restartNotice !== null) {
		let resumed = 0;
		await Promise.all(
			sessionsToResume.map(async session => {
				try {
					await supervisor.create({
						cwd: session.cwd,
						resumeSessionFile: session.sessionFile,
						...(session.model === undefined ? {} : { model: session.model }),
						...(session.title === undefined ? {} : { title: session.title }),
						...(session.hidden === undefined ? {} : { hidden: session.hidden }),
					});
					resumed++;
				} catch (error) {
					// Dropped, not retried on every start: the session stays in the recent list for a manual resume.
					recoveryPending.delete(session.id);
					log(`could not resume session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}),
		);
		restartNotice = { at: restartNotice.at, resumed, interruptedTitles: restartNotice.interruptedTitles };
		await persistSessionSet(supervisor.list());
	} else if (loadedState.exists) {
		await persistSessionSet(supervisor.list());
	}
	await overnightController?.reconcile();
	restartNoticeReady.resolve();

	let stopping: Promise<void> | undefined;
	return {
		port,
		url: `http://127.0.0.1:${port}`,
		supervisor,
		relay,
		onAgentEvent(listener: AgentEventListener): () => void {
			agentListeners.add(listener);
			return () => {
				agentListeners.delete(listener);
			};
		},
		stop(): Promise<void> {
			stopping ??= (async () => {
				// Workers first: their exit closes their rooms; new sessions are refused from here on.
				await supervisor.shutdown();
				await overnightController?.close();
				await stateWriteTail.catch(() => {});
				await areas.close();
				await sender.close();
				relay.stop();
				await server.stop(true);
				await pairingWatcher.close();
				await deviceAuth.close();
				await modelControl.close();
			})();
			return stopping;
		},
	};
}
