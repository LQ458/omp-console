/** Control API (`@omp-console/protocol` plus the local restart notice): JSON under `/api`. Auth is enforced by the caller (server.ts). */
import {
	type AbortSessionResponse,
	type ArchiveSessionRecord,
	type ArchiveSessionRequest,
	type ApiError,
	type TrashSessionResponse,
	type CreateSessionRequest,
	type CreateSessionResponse,
	type CatalogResponse,
	OMP_CONSOLE_API_VERSION,
	type DaemonHealth,
	type FileSuggestionsResponse,
	type ListModelsResponse,
	type ListProfilesResponse,
	type ListPinnedSessionsResponse,
	type ListSessionsResponse,
	type ListSessionRecipesResponse,
	type NewSessionSuggestions,
	type NewSessionBrowseResponse,
	type PathSuggestions,
	type PinSessionResponse,
	type PushPublicKeyResponse,
	type RestartSessionRequest,
	type RoomLinkRequest,
	type RoomLinkResponse,
	type RunCommandRequest,
	type RunCommandResponse,
	type SetAgentThinkingRequest,
	type SpawnAgentRequest,
	type SpawnAgentResponse,
	type SetAgentModelRequest,
	type SetAgentModelResponse,
	type SetModelRoleRequest,
	type SetProfileModelRequest,
	type SleepSessionResponse,
	type SleepSettingsRequest,
	type SleepSettingsResponse,
	type SessionSummary,
	type SessionRecipeInput,
	type SessionRecipeSource,
	type SetSessionPinnedRequest,
	type WorkerModelResult,
	type TranscriptSearchResponse,
	type SessionTranscriptResponse,
	type StartOvernightRequest,
} from "@omp-console/protocol";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PathSuggestionError, suggestPaths, workspaceSuggestions, type WorkspaceRoots } from "./librarian/paths";
import { NewSessionBrowseError, browseNewSessionDirectory } from "./new-session-browse";
import { searchTranscriptFiles } from "./history/transcript-search";
import { formatRoomLink, originFromRequest } from "./link";
import type { OvernightRoutes } from "./overnight/routes";
import { type PushStore, parsePushSubscription } from "./push";
import { createPushAnswerOptionsRoute, createPushAnswerRoute, type PushAnswerTokenStore } from "./push-answer";
import type { PushSender } from "./push-sender";
import type { Relay } from "./relay";
import type { ArchiveStore, ArchiveRecord } from "./archive";
import { canonicalSessionFile, type HostedSessionStore } from "./hosted-sessions";
import { sessionPathKey } from "./session-key";
import { type ModelControl, ModelControlError } from "./model-control";
import { type Supervisor, SupervisorError } from "./supervisor";
import {
	DEFAULT_FILE_LIMIT,
	FileSearchTimeoutError,
	MAX_FILE_LIMIT,
	MAX_FILE_QUERY_LENGTH,
	suggestFiles,
} from "./files";
import { type Journal, JournalValidationError, parseFeedbackEntry, parseJournalEvents } from "./journal";
import { createUploadsRoutes } from "./uploads";
import { firstPromptFromHead, RecentSessionScanError, type RecentSessionLister } from "./recent";
import { PinStore } from "./pins/store";
import { RecipeStore } from "./recipes/store";
import { readSessionTranscript } from "./session-transcript";
function selectorRequest(body: unknown, allowClear: true): string | null;
function selectorRequest(body: unknown, allowClear: false): string;
function selectorRequest(body: unknown, allowClear: boolean): string | null {
	if (!isObject(body) || !Object.hasOwn(body, "selector")) {
		throw new HttpError(400, "bad-request", 'body must include a "selector" field');
	}
	if (body.selector === null && allowClear) return null;
	if (typeof body.selector !== "string" || body.selector.trim() === "") {
		throw new HttpError(
			400,
			"bad-request",
			allowClear ? "selector must be a non-empty string or null" : "selector must be a non-empty string",
		);
	}
	return body.selector.trim();
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CREATE_BODY_BYTES = 256 * 1024;
const MAX_RECIPE_BODY_BYTES = 128 * 1024;
/** A journal batch of 200 events with every optional field at its length limit stays under this. */
const MAX_JOURNAL_BODY_BYTES = 256 * 1024;
const MAX_COMMAND_TEXT = 16 * 1024;
const DEFAULT_JOURNAL_LIMIT = 500;
const MAX_JOURNAL_LIMIT = 5000;
const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const DEFAULT_RECENT_LIMIT = 100;
const MAX_RECENT_LIMIT = 1000;

/** Latest daemon restart summary, persisted until the next restart. */
export interface RestartNotice {
	at: number;
	resumed: number;
	interruptedTitles: string[];
}

export interface ApiDeps {
	sessionsDir: string;
	/** Daemon state directory; main passes it for session upload storage and startup pruning. */
	uploadStateDir?: string;
	/** Shared with the supervisor, which keeps pinned sessions awake; defaults to one under `uploadStateDir`. */
	pinStore?: PinStore;
	/** Moves a stopped session's transcript out of the store (see trash.ts); returns where it went. */
	trashSessionFile?: (sessionFile: string) => Promise<string>;
	supervisor: Supervisor;
	overnight?: OvernightRoutes;
	journal: Journal;
	modelControl: ModelControl;
	relay: Relay;
	push: PushStore;
	sender: PushSender;
	pushAnswerTokens: PushAnswerTokenStore;
	startedAt: number;
	listRecent: RecentSessionLister;
	archiveStore: ArchiveStore;
	/** Session files this daemon has hosted; any other saved session is a terminal session and opens as a copy. */
	hostedSessions?: HostedSessionStore;
	/** Persisted internal sessions (quick-ask) that must not show in the recent list. */
	isHiddenSessionFile?: (sessionFile: string) => boolean;
	/** Roots a new session may create its directory under (`CreateSessionRequest.createDirectory`). */
	createRoots?: readonly string[];
	/** `host:port` used in room links when the request carries no usable Host header. */
	fallbackHost: () => string;
	log: (message: string) => void;
	setSleepAfterMinutes?: (minutes: number) => Promise<void>;
	restartNotice: () => Promise<RestartNotice | null>;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiError["code"],
		message: string,
		readonly headers?: Record<string, string>,
	) {
		super(message);
	}
}

const STATUS_BY_CODE: Record<ApiError["code"], number> = {
	"bad-request": 400,
	"not-found": 404,
	conflict: 409,
	unauthorized: 401,
	forbidden: 403,
	internal: 500,
};

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
	});
}

export function errorResponse(
	status: number,
	code: ApiError["code"],
	error: string,
	headers?: Record<string, string>,
	sleepCandidate?: ApiError["sleepCandidate"],
): Response {
	const body: ApiError = { error, code, ...(sleepCandidate === undefined ? {} : { sleepCandidate }) };
	return json(status, body, headers);
}

async function readJson(req: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > maxBytes) throw new HttpError(413, "bad-request", "request body too large");
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new HttpError(413, "bad-request", "request body too large");
	if (bytes.byteLength === 0) return undefined;
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new HttpError(400, "bad-request", "body is not valid JSON");
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "" || value.length > 4096) {
		throw new HttpError(400, "bad-request", `${key} must be a non-empty string`);
	}
	return value;
}

async function requireSessionFile(file: string, sessionsDir: string): Promise<string> {
	const message = "session file must be a regular file in the active sessions directory";
	if (!path.isAbsolute(file)) throw new HttpError(400, "bad-request", message);
	try {
		const [root, resolved] = await Promise.all([fs.realpath(sessionsDir), fs.realpath(file)]);
		const [rootInfo, fileInfo] = await Promise.all([fs.stat(root), fs.stat(resolved)]);
		const relative = path.relative(root, resolved);
		if (
			!rootInfo.isDirectory() ||
			!fileInfo.isFile() ||
			relative === "" ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new Error("invalid session file");
		}
		return resolved;
	} catch {
		throw new HttpError(400, "bad-request", message);
	}
}

/** True when `target` is strictly inside one of `roots` after resolving the deepest existing ancestor's symlinks. */
async function insideRoots(target: string, roots: readonly string[]): Promise<boolean> {
	let existing = target;
	const missing: string[] = [];
	for (;;) {
		try {
			existing = await fs.realpath(existing);
			break;
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return false;
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
	const resolved = path.join(existing, ...missing);
	for (const root of roots) {
		let real: string;
		try {
			real = await fs.realpath(root);
		} catch {
			continue;
		}
		const relative = path.relative(real, resolved);
		if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
	}
	return false;
}

async function parseCreateRequest(
	body: unknown,
	sessionsDir: string,
	createRoots: readonly string[],
	parseOvernight?: (value: unknown) => StartOvernightRequest,
): Promise<CreateSessionRequest> {
	if (!isObject(body)) throw new HttpError(400, "bad-request", "body must be a JSON object");
	const cwd = optionalString(body, "cwd");
	if (!cwd) throw new HttpError(400, "bad-request", "cwd is required");
	if (!path.isAbsolute(cwd)) throw new HttpError(400, "bad-request", "cwd must be an absolute path");
	if (body.createDirectory !== undefined && typeof body.createDirectory !== "boolean") {
		throw new HttpError(400, "bad-request", "createDirectory must be a boolean");
	}
	if (body.createDirectory === true) {
		if (body.resumeSessionFile !== undefined || body.forkFrom !== undefined) {
			throw new HttpError(400, "bad-request", "createDirectory is only for new sessions");
		}
		if (path.normalize(cwd) !== cwd || !(await insideRoots(cwd, createRoots))) {
			throw new HttpError(400, "bad-request", "createDirectory needs a path under the knowledge or projects root");
		}
		await fs.mkdir(cwd, { recursive: true });
	}
	try {
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new HttpError(400, "bad-request", `cwd is not an existing directory: ${cwd}`);
	}
	const request: CreateSessionRequest = { cwd };
	const model = optionalString(body, "model");
	if (model) request.model = model;
	const resume = optionalString(body, "resumeSessionFile");
	if (resume) request.resumeSessionFile = await requireSessionFile(resume, sessionsDir);
	if (body.forkFrom !== undefined) {
		if (resume) throw new HttpError(400, "bad-request", "resumeSessionFile and forkFrom are mutually exclusive");
		if (!isObject(body.forkFrom)) throw new HttpError(400, "bad-request", "forkFrom must be an object");
		const file = optionalString(body.forkFrom, "sessionFile");
		if (!file) throw new HttpError(400, "bad-request", "forkFrom.sessionFile is required");
		const resolved = await requireSessionFile(file, sessionsDir);
		const entryId = optionalString(body.forkFrom, "entryId");
		request.forkFrom = entryId ? { sessionFile: resolved, entryId } : { sessionFile: resolved };
	}
	const title = optionalString(body, "title");
	if (title !== undefined) {
		if (title.length > 200) throw new HttpError(400, "bad-request", "title must be at most 200 characters");
		request.title = title;
	}
	if (body.hidden !== undefined) {
		if (typeof body.hidden !== "boolean") throw new HttpError(400, "bad-request", "hidden must be a boolean");
		if (body.hidden) request.hidden = true;
	}
	if (body.handoff !== undefined) {
		if (typeof body.handoff !== "string" || body.handoff.trim() === "" || body.handoff.length > 64 * 1024) {
			throw new HttpError(400, "bad-request", "handoff must be a non-empty string of at most 64 KB");
		}
		request.handoff = body.handoff;
	}
	if (body.overnight !== undefined) {
		if (!parseOvernight) throw new HttpError(400, "bad-request", "Overnight run is off. Turn it on in Settings → Advanced → Optional features, then restart the daemon.");
		try {
			request.overnight = parseOvernight(body.overnight);
		} catch (error) {
			throw new HttpError(400, "bad-request", error instanceof Error ? error.message : String(error));
		}
		if (request.resumeSessionFile || request.forkFrom) {
			throw new HttpError(400, "bad-request", "An Overnight run needs a new session.");
		}
		if (request.hidden) throw new HttpError(400, "bad-request", "An Overnight run cannot use a hidden session.");
		if (request.handoff !== undefined) throw new HttpError(400, "bad-request", "An Overnight run cannot be combined with Continue in a new session.");
	}
	const idempotencyKey = optionalString(body, "idempotencyKey");
	if (idempotencyKey !== undefined) {
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new HttpError(400, "bad-request", "idempotencyKey must be 1-128 of [A-Za-z0-9._:-]");
		request.idempotencyKey = idempotencyKey;
	}
	return request;
}

function parseRecipeInput(body: unknown): SessionRecipeInput {
	if (!isObject(body)) throw new HttpError(400, "bad-request", "body must be a JSON object");
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (name === "" || name.length > 128) throw new HttpError(400, "bad-request", "name must be 1-128 characters");
	const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
	if (cwd === "" || cwd.length > 4096 || !path.isAbsolute(cwd)) {
		throw new HttpError(400, "bad-request", "cwd must be an absolute path");
	}
	const machineId = typeof body.machineId === "string" ? body.machineId.trim() : "";
	if (machineId === "" || machineId.length > 128) throw new HttpError(400, "bad-request", "machineId must be 1-128 characters");
	if (typeof body.prompt !== "string" || body.prompt.trim() === "" || body.prompt.length > 64 * 1024) {
		throw new HttpError(400, "bad-request", "prompt must be 1-65536 characters");
	}
	const input: SessionRecipeInput = { name, cwd, machineId, prompt: body.prompt };
	const model = optionalString(body, "model");
	if (model !== undefined) input.model = model;
	if (body.thinkingLevel !== undefined) {
		if (typeof body.thinkingLevel !== "string" || !THINKING_LEVELS.has(body.thinkingLevel)) {
			throw new HttpError(400, "bad-request", `thinkingLevel must be one of ${[...THINKING_LEVELS].join(", ")}`);
		}
		input.thinkingLevel = body.thinkingLevel as SessionRecipeInput["thinkingLevel"];
	}
	return input;
}

async function validateRecipeInput(body: unknown): Promise<SessionRecipeInput> {
	const input = parseRecipeInput(body);
	try {
		if (!(await fs.stat(input.cwd)).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new HttpError(400, "bad-request", `cwd is not an existing directory: ${input.cwd}`);
	}
	return input;
}

function parseLimit(url: URL): number {
	const raw = url.searchParams.get("limit");
	if (raw === "") throw new HttpError(400, "bad-request", `limit must be an integer between 0 and ${MAX_RECENT_LIMIT}`);
	if (raw === null) return DEFAULT_RECENT_LIMIT;
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 0 || limit > MAX_RECENT_LIMIT) {
		throw new HttpError(400, "bad-request", `limit must be an integer between 0 and ${MAX_RECENT_LIMIT}`);
	}
	return limit;
}

/** `?limit=`: an integer in [1, max], `fallback` when absent. */
function parseBoundedLimit(url: URL, max: number, fallback: number): number {
	const raw = url.searchParams.get("limit");
	if (raw === null) return fallback;
	const limit = Number(raw);
	if (raw === "" || !Number.isInteger(limit) || limit < 1 || limit > max) {
		throw new HttpError(400, "bad-request", `limit must be an integer between 1 and ${max}`);
	}
	return limit;
}

function parseRunCommand(body: unknown): RunCommandRequest {
	if (!isObject(body) || typeof body.text !== "string") throw new HttpError(400, "bad-request", 'body must be {"text": string}');
	const text = body.text.trim();
	if (!text.startsWith("/") || text.length < 2 || text.length > MAX_COMMAND_TEXT) {
		throw new HttpError(400, "bad-request", `text must be a slash command of at most ${MAX_COMMAND_TEXT} characters`);
	}
	return { text };
}

function parseSpawnRequest(body: unknown): SpawnAgentRequest {
	if (!isObject(body)) throw new HttpError(400, "bad-request", "body must be a JSON object");
	const profile = typeof body.profile === "string" ? body.profile.trim() : "";
	if (profile === "" || profile.length > 128) throw new HttpError(400, "bad-request", "profile must be a non-empty string");
	const task = typeof body.task === "string" ? body.task.trim() : "";
	if (task === "") throw new HttpError(400, "bad-request", "task must be a non-empty string");
	const request: SpawnAgentRequest = { profile, task };
	if (body.name !== undefined) {
		if (typeof body.name !== "string" || body.name.trim() === "" || body.name.length > 64) {
			throw new HttpError(400, "bad-request", "name must be a string of 1 to 64 characters");
		}
		request.name = body.name.trim();
	}
	if (body.isolated !== undefined) {
		if (typeof body.isolated !== "boolean") throw new HttpError(400, "bad-request", "isolated must be a boolean");
		request.isolated = body.isolated;
	}
	if (body.files !== undefined) {
		if (
			!Array.isArray(body.files) ||
			body.files.length > 64 ||
			body.files.some(file => typeof file !== "string" || file.trim() === "" || file.length > 4096)
		) {
			throw new HttpError(400, "bad-request", "files must be an array of at most 64 non-empty paths");
		}
		request.files = body.files as string[];
	}
	return request;
}

/** Worker model-error text to the status the model and thinking endpoints answer with. */
function modelErrorStatus(message: string): HttpError {
	if (message.startsWith("unknown agent ")) return new HttpError(404, "not-found", message);
	if (
		message === "session is not running" ||
		message.includes("has no live session") ||
		message.includes("is an advisor and cannot be")
	) {
		return new HttpError(409, "conflict", message);
	}
	return new HttpError(400, "bad-request", message);
}

/** The 200 body (or the mapped error) for a worker's reply to a model or thinking change. */
function agentChangeResponse(result: WorkerModelResult): Response {
	if (result.t === "model-error") throw modelErrorStatus(result.message);
	const response: SetAgentModelResponse = { agentId: result.agentId, model: result.model };
	if (result.thinkingLevel !== undefined) response.thinkingLevel = result.thinkingLevel;
	return json(200, response);
}

const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)$/;
const SESSION_TRANSCRIPT_ROUTE = /^\/api\/sessions\/([^/]+)\/transcript$/;
const SLEEP_SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/sleep$/;
const SLEEP_SETTINGS_PATH = "/api/settings/sleep";
const ROOM_ROUTE = /^\/api\/sessions\/([^/]+)\/room$/;
const CATALOG_ROUTE = /^\/api\/sessions\/([^/]+)\/catalog$/;
const FILES_ROUTE = /^\/api\/sessions\/([^/]+)\/files$/;
const UPLOADS_ROUTE = /^\/api\/sessions\/([^/]+)\/uploads$/;
const COMMAND_ROUTE = /^\/api\/sessions\/([^/]+)\/command$/;
const AGENTS_ROUTE = /^\/api\/sessions\/([^/]+)\/agents$/;
const AGENT_MODEL_ROUTE = /^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/model$/;
const AGENT_THINKING_ROUTE = /^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/thinking$/;
const RESTART_SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/restart$/;
const ABORT_SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/abort$/;
const ARCHIVE_SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/archive$/;
const TRASH_SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/trash$/;
const PROFILE_MODEL_ROUTE = /^\/api\/profiles\/([^/]+)\/model$/;
const MODEL_ROLE_ROUTE = /^\/api\/model-roles\/([^/]+)$/;
const PIN_ROUTE = /^\/api\/pins\/([^/]+)$/;
const RECIPE_SOURCE_ROUTE = /^\/api\/recipes\/source\/([^/]+)$/;
const RECIPE_START_ROUTE = /^\/api\/recipes\/([^/]+)\/start$/;
const RECIPE_ROUTE = /^\/api\/recipes\/([^/]+)$/;

function decodePathSegment(raw: string, label: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new HttpError(400, "bad-request", `malformed ${label}`);
	}
}
const CONTROL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_CONTROL_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function controlName(raw: string, label: string): string {
	const name = decodePathSegment(raw, label);
	if (!CONTROL_NAME.test(name) || RESERVED_CONTROL_NAMES.has(name)) {
		throw new HttpError(400, "bad-request", `invalid ${label}`);
	}
	return name;
}


function allow(req: Request, ...methods: string[]): void {
	if (!methods.includes(req.method)) {
		throw new HttpError(405, "bad-request", `method ${req.method} not allowed`, { Allow: methods.join(", ") });
	}
}

function sessionId(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new HttpError(400, "bad-request", "malformed session id");
	}
}

function recordId(raw: string, label: string): string {
	const id = sessionId(raw);
	if (id.length === 0 || id.length > 512 || id.includes("\0")) throw new HttpError(400, "bad-request", `invalid ${label}`);
	return id;
}

export function createApi(deps: ApiDeps): (req: Request) => Promise<Response> {
	const { supervisor, pinStore } = deps;
	const configuredCreateRoots = deps.createRoots ?? [];
	const createRoots = configuredCreateRoots.length > 0 ? configuredCreateRoots : [os.homedir()];
	const recipeStore = deps.uploadStateDir === undefined ? undefined : new RecipeStore(deps.uploadStateDir, deps.log);
	const recipeStarts = new Map<string, Promise<SessionSummary>>();
	const RECIPE_START_REPLAY_MS = 10_000;
	// Resolved session files being moved to the Trash, and ones a resume or fork is starting from. Each side refuses
	// while the other holds the file, so a delete never races a resume of the same transcript.
	const deletingFiles = new Set<string>();
	// Counted: two forks of one file each hold it until they finish.
	const startingFiles = new Map<string, number>();
	const uploads =
		deps.uploadStateDir === undefined
			? undefined
			: createUploadsRoutes(deps.uploadStateDir, {
					isSessionLive: id => supervisor.get(id) !== undefined,
					log: deps.log,
				});
	const pushAnswer = createPushAnswerRoute({
		tokens: deps.pushAnswerTokens,
		readJson,
		json,
		errorResponse,
		sessionOp: (sessionId, op) => supervisor.sessionOp(sessionId, op),
	});
	const pushAnswerOptions = createPushAnswerOptionsRoute({
		tokens: deps.pushAnswerTokens,
		readJson,
		json,
		errorResponse,
		sessionOp: (sessionId, op) => supervisor.sessionOp(sessionId, op),
	});

	async function route(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const { pathname } = url;
		const overnightResponse = await deps.overnight?.handle(req, url);
		if (overnightResponse) return overnightResponse;

		if (pathname === SLEEP_SETTINGS_PATH) {
			allow(req, "GET", "PUT");
			if (req.method === "GET") {
				const body: SleepSettingsResponse = { minutes: supervisor.sleepAfterMinutes };
				return json(200, body);
			}
			const input = await readJson(req);
			if (
				!isObject(input) ||
				typeof input.minutes !== "number" ||
				!Number.isSafeInteger(input.minutes) ||
				input.minutes < 0 ||
				input.minutes > Math.floor(Number.MAX_SAFE_INTEGER / 60_000)
			) {
				throw new HttpError(400, "bad-request", "minutes must be a non-negative safe integer");
			}
			const request: SleepSettingsRequest = { minutes: input.minutes };
			if (deps.setSleepAfterMinutes) await deps.setSleepAfterMinutes(request.minutes);
			else supervisor.setSleepAfterMinutes(request.minutes);
			const body: SleepSettingsResponse = { minutes: supervisor.sleepAfterMinutes };
			return json(200, body);
		}

		if (pathname === "/api/restart-notice") {
			allow(req, "GET");
			return json(200, await deps.restartNotice());
		}

		if (pathname === "/api/pins") {
			allow(req, "GET");
			if (pinStore === undefined) throw new HttpError(503, "internal", "pins are not configured on this daemon");
			const body: ListPinnedSessionsResponse = { sessionIds: await pinStore.list() };
			return json(200, body);
		}

		const pin = PIN_ROUTE.exec(pathname);
		if (pin) {
			allow(req, "PUT");
			if (pinStore === undefined) throw new HttpError(503, "internal", "pins are not configured on this daemon");
			const body = await readJson(req);
			if (!isObject(body) || typeof body.pinned !== "boolean") {
				throw new HttpError(400, "bad-request", 'body must be {"pinned": boolean}');
			}
			const id = recordId(pin[1]!, "session id");
			const visible = [...supervisor.list(), ...(await deps.listRecent())].some(session =>
				session.id === id &&
				!session.hidden &&
				!(session.sessionFile && deps.isHiddenSessionFile?.(session.sessionFile)) &&
				!deps.archiveStore.isArchived(session.id),
			);
			// Unpinning never needs the session to exist: a pin left by a session removed outside omp console must stay clearable.
			if (body.pinned && !visible && !deps.archiveStore.isArchived(id)) {
				throw new HttpError(404, "not-found", `session ${id} not found`);
			}
			const request: SetSessionPinnedRequest = { pinned: body.pinned };
			const result: PinSessionResponse = { pinned: await pinStore.set(id, request.pinned) };
			return json(200, result);
		}

		if (pathname === "/api/recipes") {
			allow(req, "GET", "POST");
			if (recipeStore === undefined) throw new HttpError(503, "internal", "recipes are not configured on this daemon");
			if (req.method === "GET") {
				const body: ListSessionRecipesResponse = { recipes: (await recipeStore.list()).sort((a, b) => b.updatedAt - a.updatedAt) };
				return json(200, body);
			}
			const recipe = await recipeStore.create(await validateRecipeInput(await readJson(req, MAX_RECIPE_BODY_BYTES)));
			return json(201, recipe);
		}

		const recipeSource = RECIPE_SOURCE_ROUTE.exec(pathname);
		if (recipeSource) {
			allow(req, "GET");
			if (recipeStore === undefined) throw new HttpError(503, "internal", "recipes are not configured on this daemon");
			const id = recordId(recipeSource[1]!, "session id");
			const session = [...supervisor.list(), ...(await deps.listRecent())].find(candidate =>
				candidate.id === id &&
				!candidate.hidden &&
				!(candidate.sessionFile && deps.isHiddenSessionFile?.(candidate.sessionFile)) &&
				!deps.archiveStore.isArchived(candidate.id)
			);
			if (!session?.sessionFile) throw new HttpError(404, "not-found", `session ${id} has no saved first prompt`);
			const file = await requireSessionFile(session.sessionFile, deps.sessionsDir);
			const prompt = firstPromptFromHead(await Bun.file(file).slice(0, 64 * 1024).text());
			if (!prompt) throw new HttpError(404, "not-found", `session ${id} has no saved first prompt`);
			const source: SessionRecipeSource = {
				name: session.title ?? prompt.split(/\r?\n/, 1)[0]!.slice(0, 128),
				cwd: session.cwd,
				prompt,
			};
			if (session.model !== undefined) source.model = session.model;
			if (session.thinkingLevel !== undefined && THINKING_LEVELS.has(session.thinkingLevel)) {
				source.thinkingLevel = session.thinkingLevel as SessionRecipeInput["thinkingLevel"];
			}
			return json(200, source);
		}

		const recipeStart = RECIPE_START_ROUTE.exec(pathname);
		if (recipeStart) {
			allow(req, "POST");
			if (recipeStore === undefined) throw new HttpError(503, "internal", "recipes are not configured on this daemon");
			const id = recordId(recipeStart[1]!, "recipe id");
			const recipe = await recipeStore.get(id);
			if (!recipe) throw new HttpError(404, "not-found", `recipe ${id} not found`);
			const body = await readJson(req);
			if (body !== undefined && !isObject(body)) throw new HttpError(400, "bad-request", "body must be an object");
			const requestInput: Record<string, unknown> = {
				cwd: recipe.cwd,
				title: recipe.name,
				...(recipe.model === undefined ? {} : { model: recipe.model }),
			};
			// The client's key is scoped to this recipe, so the same key on another recipe never replays this one.
			if (isObject(body) && typeof body.idempotencyKey === "string") {
				requestInput.idempotencyKey = `recipe:${recipe.id}:${body.idempotencyKey}`;
			} else if (isObject(body) && body.idempotencyKey !== undefined) {
				requestInput.idempotencyKey = body.idempotencyKey;
			}
			const request = await parseCreateRequest(requestInput, deps.sessionsDir, createRoots);
			const startKey = request.idempotencyKey;
			const existing = startKey === undefined ? undefined : recipeStarts.get(startKey);
			if (existing !== undefined) {
				const replay = await existing;
				if (supervisor.get(replay.id) !== undefined) return json(201, replay);
				recipeStarts.delete(startKey!);
			}
			const starting = (async (): Promise<SessionSummary> => {
				const created = await supervisor.create(request);
				try {
					if (recipe.thinkingLevel !== undefined && created.rootAgentId !== undefined) {
						await supervisor.setAgentThinking(created.id, created.rootAgentId, recipe.thinkingLevel);
					}
					await supervisor.sendPrompt(created.id, recipe.prompt);
					return created;
				} catch (error) {
					try {
						await supervisor.stop(created.id);
					} catch (stopError) {
						deps.log(`recipe start cleanup failed for ${created.id}: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
					}
					throw error;
				}
			})();
			if (startKey !== undefined) {
				recipeStarts.set(startKey, starting);
				const forget = (): void => {
					if (recipeStarts.get(startKey) === starting) recipeStarts.delete(startKey);
				};
				// A retry of the same tap within the window replays; after it, the key is free again.
				void starting.then(() => setTimeout(forget, RECIPE_START_REPLAY_MS).unref?.(), forget);
			}
			return json(201, await starting);
		}

		const recipeRoute = RECIPE_ROUTE.exec(pathname);
		if (recipeRoute) {
			allow(req, "PUT", "DELETE");
			if (recipeStore === undefined) throw new HttpError(503, "internal", "recipes are not configured on this daemon");
			const id = recordId(recipeRoute[1]!, "recipe id");
			if (req.method === "DELETE") {
				if (!(await recipeStore.remove(id))) throw new HttpError(404, "not-found", `recipe ${id} not found`);
				return new Response(null, { status: 204 });
			}
			const updated = await recipeStore.update(id, await validateRecipeInput(await readJson(req, MAX_RECIPE_BODY_BYTES)));
			if (!updated) throw new HttpError(404, "not-found", `recipe ${id} not found`);
			return json(200, updated);
		}

		if (pathname === "/api/new-session/suggestions") {
			allow(req, "GET");
			// Only sessions the user sees count as recent folders: no hidden internal or archived sessions.
			const internal = new Set(supervisor.list().flatMap(s => (s.hidden && s.sessionFile ? [sessionPathKey(s.sessionFile)] : [])));
			const recent = (await deps.listRecent()).filter(s =>
				!s.hidden &&
				!deps.archiveStore.isArchived(s.id) &&
				!(s.sessionFile && (internal.has(sessionPathKey(s.sessionFile)) || deps.isHiddenSessionFile?.(s.sessionFile))),
			);
			const workspaceRoots: WorkspaceRoots = { projectRoots: configuredCreateRoots };
			const roots = (configuredCreateRoots.length > 0 ? configuredCreateRoots : [os.homedir()])
				.map(root => ({ path: root, kind: "project" as const }));
			const body: NewSessionSuggestions = {
				recent: await workspaceSuggestions(recent, workspaceRoots, Date.now()),
				roots,
			};
			return json(200, body);
		}

		if (pathname === "/api/new-session/paths") {
			allow(req, "GET");
			const query = url.searchParams.get("q") ?? "";
			if (query.length > 200 || query.includes("\u0000")) {
				throw new HttpError(400, "bad-request", "q must be at most 200 non-NUL characters");
			}
			const body: PathSuggestions = await suggestPaths(query, { projectRoots: configuredCreateRoots });
			return json(200, body);
		}

		if (pathname === "/api/new-session/browse") {
			allow(req, "GET");
			const directory = url.searchParams.get("dir");
			if (directory !== null && (directory.length > 4096 || directory.includes("\u0000") || !path.isAbsolute(directory))) {
				throw new HttpError(400, "bad-request", "dir must be an absolute folder path of at most 4096 non-NUL characters");
			}
			const body: NewSessionBrowseResponse = await browseNewSessionDirectory(directory ?? undefined, {
				projectRoots: configuredCreateRoots,
			});
			return json(200, body);
		}

		if (pathname === "/api/search") {
			allow(req, "GET");
			const query = url.searchParams.get("q");
			if (query === null || query.trim() === "" || query.length > 512 || query.includes("\u0000")) {
				throw new HttpError(400, "bad-request", "q must be 1-512 non-NUL characters");
			}
			const live = supervisor.list();
			const hiddenFiles = new Set(live.filter(session => session.hidden && session.sessionFile).map(session => sessionPathKey(session.sessionFile!)));
			const sessions = [...live, ...(await deps.listRecent())].filter(session =>
				!session.hidden &&
				!(session.sessionFile && (hiddenFiles.has(sessionPathKey(session.sessionFile)) || deps.isHiddenSessionFile?.(session.sessionFile)))
			);
			const body: TranscriptSearchResponse = await searchTranscriptFiles(
				sessions,
				query.trim(),
				file => requireSessionFile(file, deps.sessionsDir),
				Date.now,
				req.signal,
			);
			return json(200, body);
		}

		const upload = UPLOADS_ROUTE.exec(pathname);
		if (upload) {
			allow(req, "POST");
			if (uploads === undefined) throw new HttpError(503, "internal", "session uploads are not configured on this daemon");
			return uploads.handle(req, url, sessionId(upload[1]!));
		}

		if (pathname === "/api/sessions") {
			allow(req, "GET", "POST");
			if (req.method === "GET") return listSessions(url);
			const requestBody = await readJson(req, deps.overnight ? MAX_CREATE_BODY_BYTES : MAX_BODY_BYTES);
			let request = await parseCreateRequest(
				requestBody,
				deps.sessionsDir,
				createRoots,
				deps.overnight?.parseStartRequest,
			);
			if (deps.overnight) request = await deps.overnight.prepareCreate(request);
			// In-place resume only for files this daemon hosted (or is hosting): any other saved session may still be
			// open in terminal omp, so it opens as a copy whatever the client asked for. A wrong copy is harmless; a wrong
			// in-place resume would have two processes writing one JSONL.
			const resumeFile = request.resumeSessionFile;
			if (
				resumeFile !== undefined &&
				deps.hostedSessions !== undefined &&
				!deps.hostedSessions.has(resumeFile) &&
				!supervisor.list().some(session => session.sessionFile !== undefined && canonicalSessionFile(session.sessionFile) === canonicalSessionFile(resumeFile))
			) {
				const { resumeSessionFile: _inPlace, ...rest } = request;
				request = { ...rest, forkFrom: { sessionFile: resumeFile } };
			}
			const sourceFile = request.resumeSessionFile ?? request.forkFrom?.sessionFile;
			const sourceFileKey = sourceFile === undefined ? undefined : sessionPathKey(sourceFile);
			if (sourceFileKey !== undefined && deletingFiles.has(sourceFileKey)) {
				throw new HttpError(409, "conflict", "this session is being deleted");
			}
			if (sourceFileKey !== undefined) startingFiles.set(sourceFileKey, (startingFiles.get(sourceFileKey) ?? 0) + 1);
			try {
				const archived = request.resumeSessionFile ? deps.archiveStore.findBySessionFile(request.resumeSessionFile) : undefined;
				if (archived) await deps.archiveStore.restore(archived.id);
				let created: CreateSessionResponse;
				try {
					created = await supervisor.create(request);
				} catch (error) {
					if (archived) await deps.archiveStore.archive(archived.id, archived.record);
					throw error;
				}
				if (request.overnight) await deps.overnight?.onCreated(created, request);
				// A transcript put back from the Trash and resumed is a session again, visible everywhere.
				deps.archiveStore.revive(created.id);
				return json(201, created);
			} finally {
				if (sourceFileKey !== undefined) {
					const holders = (startingFiles.get(sourceFileKey) ?? 1) - 1;
					if (holders > 0) startingFiles.set(sourceFileKey, holders);
					else startingFiles.delete(sourceFileKey);
				}
			}
		}
		if (pathname === "/api/health") {
			allow(req, "GET");
			const health: DaemonHealth = {
				version: OMP_CONSOLE_API_VERSION,
				startedAt: deps.startedAt,
				workers: await supervisor.health(),
				guests: deps.relay.guestCount,
				stalledAfterMs: supervisor.stalledAfterMs,
			};
			return json(200, health);
		}
		if (pathname === "/api/models") {
			allow(req, "GET");
			const body: ListModelsResponse = await deps.modelControl.listModels();
			return json(200, body);
		}

		if (pathname === "/api/profiles") {
			allow(req, "GET");
			const cwd = url.searchParams.has("cwd") ? (url.searchParams.get("cwd") ?? "") : undefined;
			const body: ListProfilesResponse = await deps.modelControl.listProfiles(cwd);
			return json(200, body);
		}

		const profileModel = PROFILE_MODEL_ROUTE.exec(pathname);
		if (profileModel) {
			allow(req, "PUT");
			const name = controlName(profileModel[1]!, "profile name");
			const selector = selectorRequest(await readJson(req), true);
			const cwd = url.searchParams.has("cwd") ? (url.searchParams.get("cwd") ?? "") : undefined;
			const request: SetProfileModelRequest = { selector };
			await deps.modelControl.setProfileModel(name, request.selector, cwd);
			return new Response(null, { status: 204 });
		}

		const modelRole = MODEL_ROLE_ROUTE.exec(pathname);
		if (modelRole) {
			allow(req, "PUT");
			const role = controlName(modelRole[1]!, "model role");
			const selector = selectorRequest(await readJson(req), false);
			const request: SetModelRoleRequest = { selector: selector! };
			await deps.modelControl.setModelRole(role, request.selector);
			return new Response(null, { status: 204 });
		}


		if (pathname === "/api/push/answer-options") return pushAnswerOptions(req);

		if (pathname === "/api/push/answer") return pushAnswer(req);

		if (pathname === "/api/push/public-key") {
			allow(req, "GET");
			const body: PushPublicKeyResponse = { publicKey: deps.sender.publicKey };
			return json(200, body);
		}

		if (pathname === "/api/push/subscribe") {
			allow(req, "POST", "DELETE");
			const body = await readJson(req);
			if (req.method === "DELETE") {
				if (!isObject(body) || typeof body.endpoint !== "string" || body.endpoint === "") {
					throw new HttpError(400, "bad-request", "body must be {\"endpoint\": string}");
				}
				await deps.push.remove(body.endpoint);
				return new Response(null, { status: 204 });
			}
			const parsed = parsePushSubscription(body);
			if (typeof parsed === "string") throw new HttpError(400, "bad-request", parsed);
			await deps.push.add(parsed);
			return new Response(null, { status: 204 });
		}

		if (pathname === "/api/push/test") {
			allow(req, "POST");
			const outcome = await deps.sender.test();
			if (outcome.attempted === 0) throw new HttpError(409, "conflict", "no push subscription is stored");
			if (outcome.delivered === 0) throw new HttpError(502, "internal", "no push service accepted the test notification");
			return new Response(null, { status: 204 });
		}
		const agentModel = AGENT_MODEL_ROUTE.exec(pathname);

		if (pathname === "/api/journal") {
			allow(req, "GET", "POST", "DELETE");
			if (req.method === "GET") {
				const limit = parseBoundedLimit(url, MAX_JOURNAL_LIMIT, DEFAULT_JOURNAL_LIMIT);
				return json(200, await deps.journal.read(limit));
			}
			if (req.method === "DELETE") {
				await deps.journal.clear();
				return new Response(null, { status: 204 });
			}
			await deps.journal.recordEvents(parseJournalEvents(await readJson(req, MAX_JOURNAL_BODY_BYTES)));
			return new Response(null, { status: 204 });
		}

		if (pathname === "/api/feedback") {
			allow(req, "POST");
			await deps.journal.recordFeedback(parseFeedbackEntry(await readJson(req)));
			return new Response(null, { status: 204 });
		}

		const restart = RESTART_SESSION_ROUTE.exec(pathname);
		if (restart) {
			allow(req, "POST");
			const body = await readJson(req);
			if (body !== undefined && (!isObject(body) || (body.restartAnyway !== undefined && typeof body.restartAnyway !== "boolean"))) {
				throw new HttpError(400, "bad-request", 'body must be {"restartAnyway"?: boolean}');
			}
			const request = (body ?? {}) as RestartSessionRequest;
			return json(200, await supervisor.restart(sessionId(restart[1]!), request.restartAnyway === true));
		}

		const abort = ABORT_SESSION_ROUTE.exec(pathname);
		if (abort) {
			allow(req, "POST");
			const id = sessionId(abort[1]!);
			// Stop means stop: an overnight run must not send the next continuation after the user's Stop, even
			// when the Stop arrives between turns (nothing to abort).
			const stoppedOvernight = (await deps.overnight?.stopIfActive(id)) ?? false;
			const aborted = await supervisor.abort(id);
			if (!aborted && !stoppedOvernight) throw new HttpError(409, "conflict", "session is idle");
			const response: AbortSessionResponse = { aborted: true };
			return json(202, response);
		}


		if (agentModel) {
			allow(req, "POST");
			const id = sessionId(agentModel[1]!);
			const agentId = sessionId(agentModel[2]!);
			const body = await readJson(req);
			if (!isObject(body) || typeof body.selector !== "string" || body.selector.trim() === "") {
				throw new HttpError(400, "bad-request", 'body must be {"selector": string}');
			}
			const request: SetAgentModelRequest = { selector: body.selector };
			return agentChangeResponse(await supervisor.setAgentModel(id, agentId, request.selector));
		}

		const agentThinking = AGENT_THINKING_ROUTE.exec(pathname);
		if (agentThinking) {
			allow(req, "POST");
			const id = sessionId(agentThinking[1]!);
			const agentId = sessionId(agentThinking[2]!);
			const body = await readJson(req);
			if (!isObject(body) || typeof body.level !== "string" || !THINKING_LEVELS.has(body.level)) {
				throw new HttpError(400, "bad-request", `level must be one of ${[...THINKING_LEVELS].join(", ")}`);
			}
			const request: SetAgentThinkingRequest = { level: body.level as SetAgentThinkingRequest["level"] };
			return agentChangeResponse(await supervisor.setAgentThinking(id, agentId, request.level));
		}

		const catalog = CATALOG_ROUTE.exec(pathname);
		if (catalog) {
			allow(req, "GET");
			const body: CatalogResponse = await supervisor.catalog(sessionId(catalog[1]!));
			return json(200, body);
		}

		const files = FILES_ROUTE.exec(pathname);
		if (files) {
			allow(req, "GET");
			const id = sessionId(files[1]!);
			const query = url.searchParams.get("q") ?? "";
			if (query.length > MAX_FILE_QUERY_LENGTH || query.includes("\0")) {
				throw new HttpError(400, "bad-request", `q must be at most ${MAX_FILE_QUERY_LENGTH} characters`);
			}
			const limit = parseBoundedLimit(url, MAX_FILE_LIMIT, DEFAULT_FILE_LIMIT);
			const session = supervisor.get(id);
			if (!session) throw new HttpError(404, "not-found", `no live session ${id}`);
			try {
				const body: FileSuggestionsResponse = { items: await suggestFiles(session.cwd, query, limit) };
				return json(200, body);
			} catch (error) {
				if (error instanceof FileSearchTimeoutError) throw new HttpError(504, "internal", error.message);
				throw error;
			}
		}

		const command = COMMAND_ROUTE.exec(pathname);
		if (command) {
			allow(req, "POST");
			const request = parseRunCommand(await readJson(req));
			await supervisor.runCommand(sessionId(command[1]!), request.text);
			const body: RunCommandResponse = { accepted: true };
			return json(202, body);
		}

		const agents = AGENTS_ROUTE.exec(pathname);
		if (agents) {
			allow(req, "POST");
			const request = parseSpawnRequest(await readJson(req));
			const body: SpawnAgentResponse = { agentId: await supervisor.spawnAgent(sessionId(agents[1]!), request) };
			return json(202, body);
		}

		const room = ROOM_ROUTE.exec(pathname);
		const sleep = SLEEP_SESSION_ROUTE.exec(pathname);
		if (sleep) {
			allow(req, "POST");
			const id = sessionId(sleep[1]!);
			const completed = await supervisor.sleep(id);
			if (!completed && supervisor.get(id)?.state !== "asleep") throw new HttpError(404, "not-found", `no live or sleeping session ${id}`);
			const response: SleepSessionResponse = { state: "asleep" };
			return json(200, response);
		}

		if (room) {
			allow(req, "POST");
			const id = sessionId(room[1]!);
			const body = await readJson(req);
			let permission: NonNullable<RoomLinkRequest["permission"]> = "view";
			if (body !== undefined) {
				if (!isObject(body)) throw new HttpError(400, "bad-request", "body must be a JSON object");
				const request: RoomLinkRequest = body;
				if (request.permission !== undefined) {
					if (request.permission !== "full" && request.permission !== "view") {
						throw new HttpError(400, "bad-request", 'permission must be "full" or "view"');
					}
					permission = request.permission;
				}
			}
			let secrets = supervisor.roomSecrets(id);
			if (!secrets && (supervisor.get(id)?.state === "asleep" || supervisor.isWaking(id))) {
				await supervisor.wake(id);
				secrets = supervisor.roomSecrets(id);
			}
			if (!secrets) throw new HttpError(404, "not-found", `no live session ${id}`);
			// A restart is in progress: the relay room does not exist until the new worker hosts it.
			if (supervisor.get(id)?.state === "starting") {
				throw new HttpError(409, "conflict", `session ${id} is starting; retry shortly`);
			}
			const link = formatRoomLink(originFromRequest(req.headers, deps.fallbackHost()), secrets, permission);
			const response: RoomLinkResponse = { roomId: secrets.roomId, link, permission };
			return json(200, response);
		}

		const trash = TRASH_SESSION_ROUTE.exec(pathname);
		if (trash) {
			allow(req, "POST");
			const id = sessionId(trash[1]!);
			// Delete is the second step after Archive: a session the user never archived, or one running again, is refused.
			const record = deps.archiveStore.get(id);
			if (!record) throw new HttpError(409, "conflict", "only archived sessions can be deleted; archive it first");
			const recordFileKey = record.sessionFile === undefined ? undefined : sessionPathKey(record.sessionFile);
			if (
				supervisor.list().some(
					session =>
						session.id === id ||
						(recordFileKey !== undefined &&
							session.sessionFile !== undefined &&
							sessionPathKey(session.sessionFile) === recordFileKey),
				)
			) {
				throw new HttpError(409, "conflict", "session is running; end it first");
			}
			if (!deps.trashSessionFile) throw new HttpError(501, "internal", "this daemon cannot delete sessions");
			let file: string | undefined;
			if (record.sessionFile !== undefined) {
				let info: Awaited<ReturnType<typeof fs.lstat>> | undefined;
				try {
					info = await fs.lstat(record.sessionFile);
				} catch {}
				// A link would move whatever it points at (another session's transcript): only real files are deleted.
				if (info?.isSymbolicLink()) throw new HttpError(400, "bad-request", "session file is a symbolic link; not deleted");
				if (info) file = await requireSessionFile(record.sessionFile, deps.sessionsDir);
			}
			const fileKey = file === undefined ? undefined : sessionPathKey(file);
			// Re-check after the waits above, then claim the file before the move: nothing awaits in between.
			if (
				deps.archiveStore.get(id) === undefined ||
				supervisor.list().some(session => session.id === id) ||
				(file !== undefined &&
					fileKey !== undefined &&
					(startingFiles.has(fileKey) || deletingFiles.has(fileKey) || supervisor.findBySessionFile(file)))
			) {
				throw new HttpError(409, "conflict", "session is starting, running or already being deleted");
			}
			let trashedTo: string | null = null;
			if (file !== undefined && fileKey !== undefined) {
				deletingFiles.add(fileKey);
				try {
					trashedTo = await deps.trashSessionFile(file);
				} finally {
					deletingFiles.delete(fileKey);
				}
			}
			await deps.archiveStore.forget(id);
			if (pinStore !== undefined) {
				try {
					await pinStore.set(id, false);
				} catch (error) {
					deps.log(`unpin after delete failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			deps.log(`deleted session ${id}${trashedTo ? ` -> ${trashedTo}` : " (transcript already gone)"}`);
			const body: TrashSessionResponse = { trashedTo };
			return json(200, body);
		}

		const archive = ARCHIVE_SESSION_ROUTE.exec(pathname);
		if (archive) {
			const id = sessionId(archive[1]!);
			if (req.method === "PUT") {
				allow(req, "PUT");
				const body = await readJson(req);
				let archiveRequest: ArchiveSessionRequest = {};
				if (body !== undefined) {
					if (!isObject(body)) throw new HttpError(400, "bad-request", "body must be a JSON object");
					if (body.stopIfLive !== undefined && typeof body.stopIfLive !== "boolean") {
						throw new HttpError(400, "bad-request", "stopIfLive must be a boolean");
					}
					archiveRequest = { ...(body.stopIfLive === undefined ? {} : { stopIfLive: body.stopIfLive }) };
				}

				const live = supervisor.list().find(session => session.id === id);
				if (live?.hidden) throw new HttpError(400, "bad-request", "hidden sessions cannot be archived");
				// Archiving is idempotent: a retry, or the same tap on a second device, gets the existing record.
				const existing = live ? undefined : deps.archiveStore.get(id);
				if (existing) return json(200, existing);
				const persisted = live ? undefined : (await deps.listRecent()).find(session => session.id === id);
				const session = live ?? persisted;
				if (session?.hidden || (session?.sessionFile && deps.isHiddenSessionFile?.(session.sessionFile))) {
					throw new HttpError(400, "bad-request", "hidden sessions cannot be archived");
				}
				if (session === undefined) throw new HttpError(404, "not-found", `no session ${id}`);
				if (
					live &&
					(live.state === "streaming" || live.state === "asking" || live.awaitingAnswer) &&
					!archiveRequest.stopIfLive
				) {
					throw new HttpError(409, "conflict", "session is working or waiting for an answer; confirm stop and archive");
				}

				const archivedAt = Date.now();
				const record: ArchiveRecord = {
					archivedAt,
					...(session.title === undefined ? {} : { title: session.title }),
					cwd: session.cwd,
					...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
					lastActivityAt: session.lastActivityAt,
				};
				const stored: ArchiveSessionRecord = await deps.archiveStore.archive(id, record);
				if (live) {
					try {
						// `false` means the session already stopped (a concurrent archive or stop got there first): the
						// archive stands. Only a failure to stop a still-running session undoes it.
						await supervisor.stop(id);
					} catch (error) {
						await deps.archiveStore.restore(id);
						throw error;
					}
				}
				return json(200, stored);
			}
			allow(req, "DELETE");
			if (!(await deps.archiveStore.restore(id))) throw new HttpError(404, "not-found", `session ${id} is not archived`);
			return new Response(null, { status: 204 });
		}

		const transcript = SESSION_TRANSCRIPT_ROUTE.exec(pathname);
		if (transcript) {
			allow(req, "GET");
			const id = sessionId(transcript[1]!);
			const saved = (await deps.listRecent()).find(item => item.id === id);
			if (
				saved === undefined ||
				saved.hidden ||
				saved.sessionFile === undefined ||
				deps.isHiddenSessionFile?.(saved.sessionFile)
			) {
				throw new HttpError(404, "not-found", `no saved session ${id}`);
			}
			const sessionFile = await requireSessionFile(saved.sessionFile, deps.sessionsDir);
			const body: SessionTranscriptResponse = await readSessionTranscript(sessionFile);
			return json(200, body);
		}

		const session = SESSION_ROUTE.exec(pathname);
		if (session) {
			allow(req, "DELETE");
			const id = sessionId(session[1]!);
			if (!(await supervisor.stop(id))) throw new HttpError(404, "not-found", `no live session ${id}`);
			return new Response(null, { status: 204 });
		}

		throw new HttpError(404, "not-found", "not found");
	}

	async function listSessions(url: URL): Promise<Response> {
		const limit = parseLimit(url);
		const pinnedIds = new Set(pinStore === undefined ? [] : await pinStore.list());
		const markPinned = (session: SessionSummary): SessionSummary => ({ ...session, pinned: pinnedIds.has(session.id) });
		const all = supervisor.list();
		const hiddenFiles = new Set(all.flatMap(s => (s.hidden && s.sessionFile ? [sessionPathKey(s.sessionFile)] : [])));
		const live = all.filter(s => !s.hidden && !deps.archiveStore.isArchived(s.id)).map(markPinned);
		const liveFiles = new Set(all.flatMap(s => (s.sessionFile ? [sessionPathKey(s.sessionFile)] : [])));
		const liveIds = new Set(all.map(s => s.id));
		await deps.hostedSessions?.remember(all.flatMap(s => (s.sessionFile ? [s.sessionFile] : [])));
		// A saved session this daemon hosted continues in place; anything else came from terminal omp and opens as a copy.
		const labelled = (session: SessionSummary): SessionSummary => {
			if (session.sessionFile === undefined || !deps.hostedSessions?.has(session.sessionFile)) return session;
			const { source: _terminal, ...rest } = session;
			return rest;
		};
		const persisted = (await deps.listRecent()).map(labelled);
		const persistedById = new Map(persisted.map(session => [session.id, session]));
		const recent: SessionSummary[] = persisted
			.filter(s => !deps.archiveStore.isArchived(s.id))
			.filter(s => !liveIds.has(s.id) && !(s.sessionFile && liveFiles.has(sessionPathKey(s.sessionFile))))
			.filter(s => !(s.sessionFile && (hiddenFiles.has(sessionPathKey(s.sessionFile)) || deps.isHiddenSessionFile?.(s.sessionFile))))
			.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
			.slice(0, limit)
			.map(markPinned);
		const archived: SessionSummary[] = deps.archiveStore
			.list()
			.sort((a, b) => b.record.archivedAt - a.record.archivedAt)
			.slice(0, 200)
			.flatMap<SessionSummary>(({ id, record }) => {
				const source = persistedById.get(id);
				if (
					source?.hidden ||
					(source?.sessionFile && (hiddenFiles.has(sessionPathKey(source.sessionFile)) || deps.isHiddenSessionFile?.(source.sessionFile))) ||
					(record.sessionFile && (hiddenFiles.has(sessionPathKey(record.sessionFile)) || deps.isHiddenSessionFile?.(record.sessionFile)))
				) {
					return [];
				}
				const title = source?.title ?? record.title;
				const sessionFile = source?.sessionFile ?? record.sessionFile;
				return [{
					id,
					...(title === undefined ? {} : { title }),
					cwd: source?.cwd ?? record.cwd ?? "",
					...(sessionFile === undefined ? {} : { sessionFile }),
					// Archived terminal sessions also open as copies, and a deleted folder opens read-only.
					...(source === undefined
						? sessionFile === undefined || deps.hostedSessions?.has(sessionFile) ? {} : { source: "terminal" as const }
						: { ...(source.source === undefined ? {} : { source: source.source }), ...(source.cwdExists === undefined ? {} : { cwdExists: source.cwdExists }) }),
					state: "stopped",
					createdAt: source?.createdAt ?? record.lastActivityAt ?? record.archivedAt,
					lastActivityAt: source?.lastActivityAt ?? record.lastActivityAt ?? record.archivedAt,
					agentCount: 0,
					goalActive: false,
					awaitingAnswer: false,
					archivedAt: record.archivedAt,
				}];
			});
		archived.forEach((session, index) => {
			archived[index] = markPinned(session);
		});
		const body: ListSessionsResponse = { live, recent, archived };
		return json(200, body);
	}

	return async req => {
		try {
			return await route(req);
		} catch (err) {
			if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, err.headers);
			if (err instanceof SupervisorError) return errorResponse(STATUS_BY_CODE[err.code], err.code, err.message, undefined, err.sleepCandidate);
			if (err instanceof JournalValidationError) return errorResponse(400, "bad-request", err.message);
			if (err instanceof ModelControlError) {
				const status = err.code === "not-found" ? 404 : 400;
				return errorResponse(status, err.code, err.message);
			}
			if (err instanceof NewSessionBrowseError) return errorResponse(err.status, err.code, err.message);
			if (err instanceof RecentSessionScanError || err instanceof PathSuggestionError) {
				deps.log(`api ${req.method} ${new URL(req.url).pathname} failed: ${err.message}`);
				return errorResponse(500, "internal", err.message);
			}
			deps.log(`api ${req.method} ${new URL(req.url).pathname} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
			return errorResponse(500, "internal", "internal error");
		}
	};
}
