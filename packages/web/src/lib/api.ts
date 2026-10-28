/**
 * Typed client for the omp-console daemon control API (`/api`, contract in `@omp-console/protocol`).
 *
 * The web app is served by the daemon on the same origin, so every URL is relative. Failures are
 * mapped to a small closed set of kinds the UI can act on: `auth` (show the sign-in/tailnet
 * state, retrying will not help), `network` (daemon unreachable, retry), `conflict` (worker not
 * ready yet), `not-found`, `bad-request`, `server`.
 */
import type {
	AbortSessionResponse,
	ArchiveSessionRecord,
	ArchiveSessionRequest,
	TrashSessionResponse,
	ClaudeImportJobResponse,
	ClaudeImportSessionsResponse,
	ClaudeImportSettingsResponse,
	ClaudeImportSource,
	ClaudeImportSummary,
	StartClaudeImportRequest,
	UpdateClaudeImportSettingsRequest,
	ApiError,
	CacheWarmingRequest,
	CatalogResponse,
	DaemonCapabilities,
	DaemonBusySession,
	DaemonConfigFile,
	DaemonConfigResponse,
	DriftSuggestion,
	EquivalenceTable,
	ExtensionUiState,
	GateStatusResponse,
	HistoryResponse,
	ImprovementReport,
	ListPluginsResponse,
	ListProcessesResponse,
	DaemonRestartConflict,
	ListWorkspacesResponse,
	MoveConfirmRequest,
	MovePrepareRequest,
	MovePreview,
	MoveRecord,
	ProcessPoliciesRequest,
	QuickAskRequest,
	QuickAskResponse,
	QuotaResponse,
	RuleFileResponse,
	RuleFileWrite,
	SessionOp,
	SessionOpResult,
	SpawnEstimate,
	StartWorkspaceSessionRequest,
	WorkspaceColorRequest,
	CreateSessionRequest,
	DaemonHealth,
	DraftPlan,
	DraftRun,
	FeedbackEntry,
	FileSuggestionsResponse,
	JournalEvent,
	JournalResponse,
	ListDraftRunsResponse,
	ListModelsResponse,
	ListPlanTemplatesResponse,
	ListProfilesResponse,
	ListPinnedSessionsResponse,
	ListSessionRecipesResponse,
	ListSessionsResponse,
	PinSessionResponse,
	RestartSessionRequest,
	RoomPermission,
	RoomLinkResponse,
	RunCommandRequest,
	SessionRecipe,
	SessionRecipeInput,
	SessionRecipeSource,
	SleepCandidate,
	SleepSettingsRequest,
	SleepSettingsResponse,
	SleepSessionResponse,
	SessionSummary,
	OvernightState,
	OvernightTemplate,
	PreflightCheck,
	StartOvernightRequest,
	SetAgentModelRequest,
	SetAgentModelResponse,
	SetAgentThinkingRequest,
	SetModelRoleRequest,
	SetProfileModelRequest,
	SpawnAgentRequest,
	SpawnAgentResponse,
	TranscriptSearchResponse,
	SetupResponse,
	SessionTranscriptResponse,
} from "@omp-console/protocol";
import type {
	AgendaAskRequest,
	AgendaAskResponse,
	AgendaItem,
	AgendaToday,
	CardsResponse,
	CompleteAgendaTodoRequest,
	CompleteAgendaTodoResponse,
	CreateAgendaTodoRequest,
	KeybindingsResponse,
	LinkAgendaTodoRequest,
	NewSessionSuggestions,
	PathSuggestions,
	PeersResponse,
	RefreshCardsRequest,
	ReturnBrief,
	SessionCard,
	SessionOpV3,
	SessionOpV3Result,
} from "@omp-console/protocol";
import { API_CACHE_DISABLED_HEADER, API_CACHE_NAME, API_CACHE_STORED_AT_HEADER, API_CACHE_TTL_MS } from "./offline-cache/api-cache";
import { offlineCacheEnabled } from "./offline-cache/preference";

/** Latest daemon restart summary, persisted until the next restart. */
export interface RestartNotice {
	at: number;
	resumed: number;
	interruptedTitles: string[];
}

export type ApiErrorKind = "auth" | "network" | "conflict" | "not-found" | "bad-request" | "server";
export interface SessionUploadResponse {
	path: string;
	name: string;
	size: number;
}


export class DeckApiError extends Error {
	readonly kind: ApiErrorKind;
	/** HTTP status; 0 when no response arrived. */
	readonly status: number;
	readonly sleepCandidate: SleepCandidate | undefined;
	readonly busySessions: readonly DaemonBusySession[] | undefined;

	constructor(kind: ApiErrorKind, status: number, message: string, sleepCandidate?: SleepCandidate, busySessions?: readonly DaemonBusySession[]) {
		super(message);
		this.name = "DeckApiError";
		this.kind = kind;
		this.status = status;
		this.sleepCandidate = sleepCandidate;
		this.busySessions = busySessions;
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface UploadOptions {
	signal?: AbortSignal;
	onProgress?: (loaded: number, total: number) => void;
}

export type UploadLike = (input: string, file: File, options: UploadOptions) => Promise<Response>;


export interface DeckApiOptions {
	/** Defaults to `globalThis.fetch`; injected by tests. */
	fetch?: FetchLike;
	/** Upload transport; defaults to XMLHttpRequest so the composer can report browser upload progress. */
	upload?: UploadLike;
	/** Prefix for every path; defaults to same-origin `/api`. */
	base?: string;
	/** Called when the local daemon returns 401, allowing the app to show the pairing screen. */
	onUnauthorized?: () => void;
}
export interface PairedDevice {
	id: string;
	label: string;
	createdAt: number;
	lastSeenAt: number;
}

export interface DeviceListResponse {
	devices: PairedDevice[];
	currentDeviceId: string;
}

export interface PairingCodeResponse {
	code: string;
	expiresAt: number;
}

export interface RevokeDeviceResponse {
	revoked: string;
	loggedOut: boolean;
}

function isApiError(value: unknown): value is ApiError {
	return typeof value === "object" && value !== null && typeof (value as ApiError).error === "string";
}

function isDaemonBusySession(value: unknown): value is DaemonBusySession {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const session = value as Record<string, unknown>;
	return typeof session.id === "string" &&
		typeof session.cwd === "string" &&
		(session.title === undefined || typeof session.title === "string");
}

function isDaemonRestartConflict(value: unknown): value is DaemonRestartConflict {
	if (!isApiError(value) || value.code !== "conflict" || typeof value !== "object" || value === null) return false;
	const busySessions: unknown = "busySessions" in value ? value.busySessions : undefined;
	return Array.isArray(busySessions) && (busySessions as unknown[]).every(isDaemonBusySession);
}

function kindFor(status: number, code: ApiError["code"] | undefined): ApiErrorKind {
	if (status === 401 || status === 403 || code === "unauthorized") return "auth";
	if (status === 404 || code === "not-found") return "not-found";
	if (status === 409 || code === "conflict") return "conflict";
	if (status === 400 || status === 422 || code === "bad-request") return "bad-request";
	return "server";
}
async function parseResponse<T>(response: Response): Promise<T> {
	const text = await response.text().catch(() => "");
	let parsed: unknown;
	if (text.length > 0) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
	}
	if (!response.ok) {
		const apiError = isApiError(parsed) ? parsed : undefined;
		const kind = kindFor(response.status, apiError?.code);
		const message = apiError?.error ?? (kind === "auth" ? "not authorized" : `request failed (${response.status})`);
		const busySessions = isDaemonRestartConflict(parsed) ? parsed.busySessions : undefined;
		throw new DeckApiError(kind, response.status, message, apiError?.sleepCandidate, busySessions);
	}
	if (parsed === undefined && text.length > 0) {
		throw new DeckApiError("server", response.status, "daemon returned a non-JSON response");
	}
	return parsed as T;
}

function uploadWithXhr(input: string, file: File, options: UploadOptions): Promise<Response> {
	if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	if (typeof XMLHttpRequest === "undefined") {
		return Promise.reject(new DeckApiError("server", 0, "file uploads require a browser"));
	}
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const xhr = new XMLHttpRequest();
	const abort = (): void => xhr.abort();
	const cleanup = (): void => options.signal?.removeEventListener("abort", abort);
	xhr.upload.addEventListener("progress", event => {
		if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
	});
	xhr.addEventListener("load", () => {
		cleanup();
		if (xhr.status === 0) {
			reject(new DeckApiError("network", 0, "daemon unreachable"));
			return;
		}
		const headers = new Headers();
		const contentType = xhr.getResponseHeader("content-type");
		if (contentType !== null) headers.set("content-type", contentType);
		resolve(new Response(xhr.responseText, { status: xhr.status, headers }));
	});
	xhr.addEventListener("error", () => {
		cleanup();
		reject(new DeckApiError("network", 0, "daemon unreachable"));
	});
	xhr.addEventListener("abort", () => {
		cleanup();
		reject(options.signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
	});
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		xhr.open("POST", input);
		xhr.setRequestHeader("accept", "application/json");
		xhr.send(file);
	} catch (error) {
		cleanup();
		reject(error);
	}
	return promise;
}


export class DeckApi {
	readonly #fetch: FetchLike;
	readonly #upload: UploadLike;
	readonly #base: string;
	readonly #onUnauthorized: (() => void) | undefined;

	constructor(options: DeckApiOptions = {}) {
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.#upload = options.upload ?? uploadWithXhr;
		this.#base = options.base ?? "/api";
		this.#onUnauthorized = options.onUnauthorized;
	}
	get isLocalMachine(): boolean {
		return !this.#base.startsWith("/api/peers/");
	}

	capabilities(signal?: AbortSignal): Promise<DaemonCapabilities> {
		return this.#request<DaemonCapabilities>("GET", "/capabilities", undefined, signal);
	}

	// p1-onboard: first-run setup and optional Claude Code history checks.
	setup(signal?: AbortSignal): Promise<SetupResponse> {
		return this.#request<SetupResponse>("GET", "/setup", undefined, signal);
	}

	getDaemonConfig(signal?: AbortSignal): Promise<DaemonConfigResponse> {
		return this.#request<DaemonConfigResponse>("GET", "/config", undefined, signal);
	}

	setDaemonConfig(config: DaemonConfigFile): Promise<{ restartRequired: true }> {
		return this.#request<{ restartRequired: true }>("PUT", "/config", config);
	}

	restartDaemon(force = false): Promise<{ restarting: true }> {
		return this.#request<{ restarting: true }>("POST", "/daemon/restart", { force });
	}

	listSessions(signal?: AbortSignal): Promise<ListSessionsResponse> {
		return this.#request<ListSessionsResponse>("GET", "/sessions", undefined, signal);
	}

	listPinnedSessions(signal?: AbortSignal): Promise<ListPinnedSessionsResponse> {
		return this.#request<ListPinnedSessionsResponse>("GET", "/pins", undefined, signal);
	}

	setPinned(sessionId: string, pinned: boolean): Promise<PinSessionResponse> {
		return this.#request<PinSessionResponse>("PUT", `/pins/${encodeURIComponent(sessionId)}`, { pinned });
	}

	listRecipes(signal?: AbortSignal): Promise<ListSessionRecipesResponse> {
		return this.#request<ListSessionRecipesResponse>("GET", "/recipes", undefined, signal);
	}

	createRecipe(input: SessionRecipeInput): Promise<SessionRecipe> {
		return this.#request<SessionRecipe>("POST", "/recipes", input);
	}

	updateRecipe(id: string, input: SessionRecipeInput): Promise<SessionRecipe> {
		return this.#request<SessionRecipe>("PUT", `/recipes/${encodeURIComponent(id)}`, input);
	}

	async deleteRecipe(id: string): Promise<void> {
		await this.#request<unknown>("DELETE", `/recipes/${encodeURIComponent(id)}`);
	}

	startRecipe(id: string, idempotencyKey?: string): Promise<SessionSummary> {
		const body = idempotencyKey === undefined ? undefined : { idempotencyKey };
		return this.#request<SessionSummary>("POST", `/recipes/${encodeURIComponent(id)}/start`, body);
	}

	recipeSource(sessionId: string): Promise<SessionRecipeSource> {
		return this.#request<SessionRecipeSource>("GET", `/recipes/source/${encodeURIComponent(sessionId)}`);
	}

	searchTranscripts(query: string, signal?: AbortSignal): Promise<TranscriptSearchResponse> {
		return this.#request<TranscriptSearchResponse>("GET", `/search?${new URLSearchParams({ q: query })}`, undefined, signal);
	}

	/** Reads a fresh-enough same-origin GET response saved by the service worker. */
	async cachedGet<T>(path: string): Promise<T | null> {
		try {
			if (!offlineCacheEnabled() || typeof caches === "undefined") return null;
			const cache = await caches.open(API_CACHE_NAME);
			const request = new Request(new URL(`${this.#base}${path}`, globalThis.location.href), {
				method: "GET",
				credentials: "same-origin",
				headers: { accept: "application/json" },
			});
			const response = await cache.match(request);
			if (!response) return null;
			const storedAt = Number(response.headers.get(API_CACHE_STORED_AT_HEADER));
			if (response.status !== 200 || !Number.isFinite(storedAt) || Date.now() - storedAt > API_CACHE_TTL_MS) {
				await cache.delete(request);
				return null;
			}
			return await parseResponse<T>(response);
		} catch {
			return null;
		}
	}

	/** New, resume (`resumeSessionFile`) or fork (`forkFrom`); resolves with the started session. */
	createSession(request: CreateSessionRequest): Promise<SessionSummary> {
		return this.#request<SessionSummary>("POST", "/sessions", request);
	}
	// Claude Code and Codex migration
	getClaudeImportSummary(source: ClaudeImportSource, signal?: AbortSignal): Promise<ClaudeImportSummary> {
		const query = new URLSearchParams({ source });
		return this.#request<ClaudeImportSummary>("GET", `/claude-import/summary?${query}`, undefined, signal);
	}

	listClaudeImportSessions(source: ClaudeImportSource, signal?: AbortSignal): Promise<ClaudeImportSessionsResponse> {
		const query = new URLSearchParams({ source });
		return this.#request<ClaudeImportSessionsResponse>("GET", `/claude-import/sessions?${query}`, undefined, signal);
	}

	startClaudeImport(source: ClaudeImportSource, request: StartClaudeImportRequest): Promise<ClaudeImportJobResponse> {
		const query = new URLSearchParams({ source });
		return this.#request<ClaudeImportJobResponse>("POST", `/claude-import?${query}`, request);
	}

	getClaudeImportJob(jobId: string): Promise<ClaudeImportJobResponse> {
		return this.#request<ClaudeImportJobResponse>("GET", `/claude-import/jobs/${encodeURIComponent(jobId)}`);
	}

	getClaudeImportSettings(signal?: AbortSignal): Promise<ClaudeImportSettingsResponse> {
		return this.#request<ClaudeImportSettingsResponse>("GET", "/claude-import/settings", undefined, signal);
	}

	setClaudeImportSettings(request: UpdateClaudeImportSettingsRequest): Promise<ClaudeImportSettingsResponse> {
		return this.#request<ClaudeImportSettingsResponse>("PUT", "/claude-import/settings", request);
	}

	getOvernightTemplate(signal?: AbortSignal): Promise<OvernightTemplate> {
		return this.#request<OvernightTemplate>("GET", "/overnight/template", undefined, signal);
	}

	setOvernightTemplate(template: OvernightTemplate): Promise<OvernightTemplate> {
		return this.#request<OvernightTemplate>("PUT", "/overnight/template", template);
	}

	getOvernightPreflight(cwd: string, signal?: AbortSignal): Promise<{ checks: PreflightCheck[] }> {
		const query = new URLSearchParams({ cwd });
		return this.#request<{ checks: PreflightCheck[] }>("GET", `/overnight/preflight?${query}`, undefined, signal);
	}

	getOvernightState(sessionId: string, signal?: AbortSignal): Promise<OvernightState> {
		return this.#request<OvernightState>("GET", `/sessions/${encodeURIComponent(sessionId)}/overnight`, undefined, signal);
	}

	startOvernight(sessionId: string, request: StartOvernightRequest): Promise<OvernightState> {
		return this.#request<OvernightState>("POST", `/sessions/${encodeURIComponent(sessionId)}/overnight`, request);
	}

	stopOvernight(sessionId: string): Promise<OvernightState> {
		return this.#request<OvernightState>("DELETE", `/sessions/${encodeURIComponent(sessionId)}/overnight`);
	}

	roomLink(sessionId: string, permission?: RoomPermission): Promise<RoomLinkResponse> {
		return this.#request<RoomLinkResponse>("POST", `/sessions/${encodeURIComponent(sessionId)}/room`, permission ? { permission } : undefined);
	}

	restartSession(sessionId: string, request: RestartSessionRequest = {}): Promise<SessionSummary> {
		return this.#request<SessionSummary>("POST", `/sessions/${encodeURIComponent(sessionId)}/restart`, request);
	}
	async sleepSession(sessionId: string): Promise<SleepSessionResponse> {
		return this.#request<SleepSessionResponse>("POST", `/sessions/${encodeURIComponent(sessionId)}/sleep`);
	}

	getSleepSettings(signal?: AbortSignal): Promise<SleepSettingsResponse> {
		return this.#request<SleepSettingsResponse>("GET", "/settings/sleep", undefined, signal);
	}

	setSleepSettings(minutes: number): Promise<SleepSettingsResponse> {
		const request: SleepSettingsRequest = { minutes };
		return this.#request<SleepSettingsResponse>("PUT", "/settings/sleep", request);
	}


	async stopSession(sessionId: string): Promise<void> {
		await this.#request<unknown>("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
	}


	abortSession(sessionId: string): Promise<AbortSessionResponse> {
		return this.#request<AbortSessionResponse>("POST", `/sessions/${encodeURIComponent(sessionId)}/abort`);
	}
	archiveSession(sessionId: string, request: ArchiveSessionRequest = {}): Promise<ArchiveSessionRecord> {
		return this.#request<ArchiveSessionRecord>("PUT", `/sessions/${encodeURIComponent(sessionId)}/archive`, request);
	}

	/** Deletes an archived, stopped session: its transcript goes to the Trash (or the daemon's trash folder). */
	trashSession(sessionId: string): Promise<TrashSessionResponse> {
		return this.#request<TrashSessionResponse>("POST", `/sessions/${encodeURIComponent(sessionId)}/trash`);
	}

	async restoreSession(sessionId: string): Promise<void> {
		await this.#request<unknown>("DELETE", `/sessions/${encodeURIComponent(sessionId)}/archive`);
	}

	listModels(signal?: AbortSignal): Promise<ListModelsResponse> {
		return this.#request<ListModelsResponse>("GET", "/models", undefined, signal);
	}

	/** Session-only override on the root agent or a running subagent of a live session. */
	setAgentModel(sessionId: string, agentId: string, selector: string): Promise<SetAgentModelResponse> {
		const body: SetAgentModelRequest = { selector };
		return this.#request<SetAgentModelResponse>(
			"POST",
			`/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/model`,
			body,
		);
	}

	listProfiles(signal?: AbortSignal): Promise<ListProfilesResponse> {
		return this.#request<ListProfilesResponse>("GET", "/profiles", undefined, signal);
	}

	/** Writes omp config (`task.agentModelOverrides`); `null` clears the override. */
	async setProfileModel(name: string, selector: string | null): Promise<void> {
		const body: SetProfileModelRequest = { selector };
		await this.#request<unknown>("PUT", `/profiles/${encodeURIComponent(name)}/model`, body);
	}

	/** Writes omp config (`modelRoles`). */
	async setModelRole(role: string, selector: string): Promise<void> {
		const body: SetModelRoleRequest = { selector };
		await this.#request<unknown>("PUT", `/model-roles/${encodeURIComponent(role)}`, body);
	}

	health(signal?: AbortSignal): Promise<DaemonHealth> {
		return this.#request<DaemonHealth>("GET", "/health", undefined, signal);
	}

	restartNotice(signal?: AbortSignal): Promise<RestartNotice | null> {
		return this.#request<RestartNotice | null>("GET", "/restart-notice", undefined, signal);
	}

	catalog(sessionId: string, signal?: AbortSignal): Promise<CatalogResponse> {
		return this.#request<CatalogResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/catalog`, undefined, signal);
	}

	fileSuggestions(sessionId: string, query: string, limit = 50, signal?: AbortSignal): Promise<FileSuggestionsResponse> {
		const params = new URLSearchParams({ q: query, limit: String(limit) });
		return this.#request<FileSuggestionsResponse>(
			"GET",
			`/sessions/${encodeURIComponent(sessionId)}/files?${params}`,
			undefined,
			signal,
		);
	}
	uploadFile(sessionId: string, file: File, options: UploadOptions = {}): Promise<SessionUploadResponse> {
		const query = new URLSearchParams({ name: file.name });
		const url = `${this.#base}/sessions/${encodeURIComponent(sessionId)}/uploads?${query}`;
		return this.#upload(url, file, options).then(response => parseResponse<SessionUploadResponse>(response)).catch(error => {
			if (options.signal?.aborted || error instanceof DeckApiError) throw error;
			throw new DeckApiError("network", 0, "daemon unreachable");
		});
	}


	async runCommand(sessionId: string, text: string): Promise<void> {
		const body: RunCommandRequest = { text };
		await this.#request<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/command`, body);
	}

	async setAgentThinking(sessionId: string, agentId: string, level: SetAgentThinkingRequest["level"]): Promise<void> {
		const body: SetAgentThinkingRequest = { level };
		await this.#request<unknown>(
			"POST",
			`/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/thinking`,
			body,
		);
	}

	spawnAgent(sessionId: string, request: SpawnAgentRequest): Promise<SpawnAgentResponse> {
		return this.#request<SpawnAgentResponse>("POST", `/sessions/${encodeURIComponent(sessionId)}/agents`, request);
	}

	startDraftRun(sessionId: string, plan: DraftPlan): Promise<DraftRun> {
		return this.#request<DraftRun>("POST", `/sessions/${encodeURIComponent(sessionId)}/plans`, plan);
	}

	listDraftRuns(sessionId: string, signal?: AbortSignal): Promise<ListDraftRunsResponse> {
		return this.#request<ListDraftRunsResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/plans`, undefined, signal);
	}

	async cancelDraftRun(sessionId: string, runId: string): Promise<void> {
		await this.#request<unknown>("DELETE", `/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(runId)}`);
	}

	listPlanTemplates(signal?: AbortSignal): Promise<ListPlanTemplatesResponse> {
		return this.#request<ListPlanTemplatesResponse>("GET", "/plan-templates", undefined, signal);
	}

	async savePlanTemplate(plan: DraftPlan): Promise<void> {
		await this.#request<unknown>("PUT", `/plan-templates/${encodeURIComponent(plan.name)}`, plan);
	}

	async recordJournal(events: JournalEvent[]): Promise<void> {
		await this.#request<unknown>("POST", "/journal", { events });
	}

	async recordFeedback(entry: FeedbackEntry): Promise<void> {
		await this.#request<unknown>("POST", "/feedback", entry);
	}

	readJournal(limit = 500, signal?: AbortSignal): Promise<JournalResponse> {
		return this.#request<JournalResponse>("GET", `/journal?limit=${limit}`, undefined, signal);
	}

	async clearJournal(): Promise<void> {
		await this.#request<unknown>("DELETE", "/journal");
	}

	// ---- wave 2 (packages/protocol/src/wave2.ts) ----

	listWorkspaces(signal?: AbortSignal): Promise<ListWorkspacesResponse> {
		return this.#request<ListWorkspacesResponse>("GET", "/workspaces", undefined, signal);
	}

	startWorkspaceSession(workspaceId: string, request: StartWorkspaceSessionRequest): Promise<SessionSummary> {
		return this.#request<SessionSummary>("POST", `/workspaces/${encodeURIComponent(workspaceId)}/sessions`, request);
	}

	readRuleFile(workspaceId: string, path: string, signal?: AbortSignal): Promise<RuleFileResponse> {
		return this.#request<RuleFileResponse>("GET", `/workspaces/${encodeURIComponent(workspaceId)}/rules/${encodeURIComponent(path)}`, undefined, signal);
	}

	async writeRuleFile(workspaceId: string, path: string, write: RuleFileWrite): Promise<void> {
		await this.#request<unknown>("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/rules/${encodeURIComponent(path)}`, write);
	}

	async setWorkspaceColor(workspaceId: string, hue: number | null): Promise<void> {
		const body: WorkspaceColorRequest = { hue };
		await this.#request<unknown>("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/color`, body);
	}

	quickAsk(request: QuickAskRequest): Promise<QuickAskResponse> {
		return this.#request<QuickAskResponse>("POST", "/quick-ask", request);
	}

	quota(signal?: AbortSignal): Promise<QuotaResponse> {
		return this.#request<QuotaResponse>("GET", "/quota", undefined, signal);
	}

	async setEquivalence(table: EquivalenceTable): Promise<void> {
		await this.#request<unknown>("PUT", "/quota/equivalence", table);
	}

	async setCacheWarming(mode: CacheWarmingRequest["mode"]): Promise<void> {
		const body: CacheWarmingRequest = { mode };
		await this.#request<unknown>("PUT", "/quota/cache-warming", body);
	}

	/** Ask omp's title generator for a new title; the result arrives on the session summary. */
	async refineTitle(sessionId: string): Promise<void> {
		await this.#request<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/title`);
	}

	spawnEstimate(profile: string, model?: string, signal?: AbortSignal): Promise<SpawnEstimate> {
		const params = new URLSearchParams({ profile });
		if (model) params.set("model", model);
		return this.#request<SpawnEstimate>("GET", `/quota/estimate?${params}`, undefined, signal);
	}

	gate(signal?: AbortSignal): Promise<GateStatusResponse> {
		return this.#request<GateStatusResponse>("GET", "/gate", undefined, signal);
	}

	drift(sessionId: string, signal?: AbortSignal): Promise<DriftSuggestion | null> {
		return this.#request<DriftSuggestion | null>("GET", `/sessions/${encodeURIComponent(sessionId)}/drift`, undefined, signal);
	}

	async dismissDrift(sessionId: string, suggestionId: string): Promise<void> {
		await this.#request<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/drift/${encodeURIComponent(suggestionId)}/dismiss`);
	}

	prepareMove(request: MovePrepareRequest): Promise<MovePreview> {
		return this.#request<MovePreview>("POST", "/moves", request);
	}

	confirmMove(moveId: string, confirm: MoveConfirmRequest): Promise<MoveRecord> {
		return this.#request<MoveRecord>("POST", `/moves/${encodeURIComponent(moveId)}/confirm`, confirm);
	}

	async undoMove(moveId: string): Promise<void> {
		await this.#request<unknown>("POST", `/moves/${encodeURIComponent(moveId)}/undo`);
	}

	listMoves(signal?: AbortSignal): Promise<{ moves: MoveRecord[] }> {
		return this.#request<{ moves: MoveRecord[] }>("GET", "/moves", undefined, signal);
	}

	plugins(sessionId: string, signal?: AbortSignal): Promise<ListPluginsResponse> {
		return this.#request<ListPluginsResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/plugins`, undefined, signal);
	}

	async togglePlugin(sessionId: string, pluginId: string, enabled: boolean): Promise<void> {
		const action = enabled ? "enable" : "disable";
		await this.#request<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/plugins/${encodeURIComponent(pluginId)}/${action}`);
	}

	extensionUi(sessionId: string, signal?: AbortSignal): Promise<ExtensionUiState> {
		return this.#request<ExtensionUiState>("GET", `/sessions/${encodeURIComponent(sessionId)}/ext-ui`, undefined, signal);
	}

	history(params: { workspace?: string; q?: string; limit?: number } = {}, signal?: AbortSignal): Promise<HistoryResponse> {
		const query = new URLSearchParams();
		if (params.workspace) query.set("workspace", params.workspace);
		if (params.q) query.set("q", params.q);
		if (params.limit) query.set("limit", String(params.limit));
		return this.#request<HistoryResponse>("GET", `/history?${query}`, undefined, signal);
	}

	async regenerateKeyPoints(sessionId: string): Promise<void> {
		await this.#request<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/key-points`);
	}

	processes(signal?: AbortSignal): Promise<ListProcessesResponse> {
		return this.#request<ListProcessesResponse>("GET", "/processes", undefined, signal);
	}

	async stopProcess(pid: number): Promise<void> {
		await this.#request<unknown>("POST", `/processes/${pid}/stop`, { confirm: true });
	}

	async setProcessPolicies(policies: ProcessPoliciesRequest): Promise<void> {
		await this.#request<unknown>("PUT", "/processes/policies", policies);
	}

	sessionOp(sessionId: string, op: SessionOp): Promise<SessionOpResult> {
		return this.#request<SessionOpResult>("POST", `/sessions/${encodeURIComponent(sessionId)}/ops`, op);
	}

	/** Wave-3 session operations on the same route. `signal` cancels a cancellable operation when its caller leaves. */
	sessionOpV3(sessionId: string, op: SessionOpV3, signal?: AbortSignal): Promise<SessionOpV3Result> {
		return this.#request<SessionOpV3Result>("POST", `/sessions/${encodeURIComponent(sessionId)}/ops`, op, signal);
	}

	cards(
		options: { limit?: number; workspace?: string; includeScheduled?: boolean } = {},
		signal?: AbortSignal,
	): Promise<CardsResponse> {
		const params = new URLSearchParams();
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.workspace !== undefined) params.set("workspace", options.workspace);
		if (options.includeScheduled !== undefined) params.set("includeScheduled", String(options.includeScheduled));
		const query = params.size > 0 ? `?${params}` : "";
		return this.#request<CardsResponse>("GET", `/cards${query}`, undefined, signal);
	}

	setCardTitle(sessionId: string, title: string): Promise<SessionCard> {
		return this.#request<SessionCard>("POST", `/cards/${encodeURIComponent(sessionId)}/title`, { title });
	}

	undoCardTitle(sessionId: string): Promise<SessionCard> {
		return this.#request<SessionCard>("POST", `/cards/${encodeURIComponent(sessionId)}/title/undo`);
	}

	async refreshCards(request: RefreshCardsRequest = {}): Promise<void> {
		await this.#request<unknown>("POST", "/cards/refresh", request);
	}

	brief(signal?: AbortSignal, since?: number): Promise<ReturnBrief> {
		const query = since === undefined ? "" : `?${new URLSearchParams({ since: String(since) })}`;
		return this.#request<ReturnBrief>("GET", `/brief${query}`, undefined, signal);
	}

	newSessionSuggestions(signal?: AbortSignal): Promise<NewSessionSuggestions> {
		return this.#request<NewSessionSuggestions>("GET", "/new-session/suggestions", undefined, signal);
	}

	pathSuggestions(query: string, signal?: AbortSignal): Promise<PathSuggestions> {
		const params = new URLSearchParams({ q: query });
		return this.#request<PathSuggestions>("GET", `/new-session/paths?${params}`, undefined, signal);
	}
	// p1-sessions API methods
	sessionTranscript(sessionId: string, signal?: AbortSignal): Promise<SessionTranscriptResponse> {
		return this.#request<SessionTranscriptResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/transcript`, undefined, signal);
	}

	claudeImportSummary(signal?: AbortSignal): Promise<{ dir: string; found: boolean; sessionCount: number; projectCount: number }> {
		return this.#request("GET", "/claude-import/summary", undefined, signal);
	}


	agendaToday(signal?: AbortSignal): Promise<AgendaToday> {
		return this.#request<AgendaToday>("GET", "/agenda/today", undefined, signal);
	}

	createAgendaTodo(request: CreateAgendaTodoRequest): Promise<AgendaItem> {
		return this.#request<AgendaItem>("POST", "/agenda/todos", request);
	}

	agendaAsk(request: AgendaAskRequest): Promise<AgendaAskResponse> {
		return this.#request<AgendaAskResponse>("POST", "/agenda/ask", request);
	}

	linkAgendaTodo(uid: string, request: LinkAgendaTodoRequest): Promise<AgendaItem> {
		return this.#request<AgendaItem>("POST", `/agenda/todos/${encodeURIComponent(uid)}/link`, request);
	}

	completeAgendaTodo(request: CompleteAgendaTodoRequest): Promise<CompleteAgendaTodoResponse> {
		return this.#request<CompleteAgendaTodoResponse>("POST", "/agenda/todos/complete", request);
	}

	keybindings(signal?: AbortSignal): Promise<KeybindingsResponse> {
		return this.#request<KeybindingsResponse>("GET", "/keybindings", undefined, signal);
	}

	/** This daemon's machine id and its peer daemons; a peer's API is `new DeckApi({ base: "/api/peers/<id>" })`. */
	peers(signal?: AbortSignal): Promise<PeersResponse> {
		return this.#request<PeersResponse>("GET", "/peers", undefined, signal);
	}

	pairStatus(signal?: AbortSignal): Promise<{ paired: boolean }> {
		return this.#request<{ paired: boolean }>("GET", "/pair/status", undefined, signal);
	}

	pair(code: string, label: string, signal?: AbortSignal): Promise<{ deviceId: string }> {
		return this.#request<{ deviceId: string }>("POST", "/pair", { code, label }, signal);
	}

	devices(signal?: AbortSignal): Promise<DeviceListResponse> {
		return this.#request<DeviceListResponse>("GET", "/devices", undefined, signal);
	}

	async revokeDevice(id: string, signal?: AbortSignal): Promise<RevokeDeviceResponse> {
		const result = await this.#request<RevokeDeviceResponse>("DELETE", `/devices/${encodeURIComponent(id)}`, undefined, signal);
		if (result.loggedOut && this.#base === "/api") this.#onUnauthorized?.();
		return result;
	}

	issuePairingCode(signal?: AbortSignal): Promise<PairingCodeResponse> {
		return this.#request<PairingCodeResponse>("POST", "/pair/code", {}, signal);
	}

	async requestReport(): Promise<void> {
		await this.#request<unknown>("POST", "/report");
	}

	report(signal?: AbortSignal): Promise<ImprovementReport | null> {
		return this.#request<ImprovementReport | null>("GET", "/report", undefined, signal);
	}

	async #request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		const headers: Record<string, string> = { accept: "application/json" };
		const noStore = path === "/pair" || path === "/pair/status" || path === "/pair/code" || path === "/devices" || path.startsWith("/devices/");
		if (method === "GET" && (!offlineCacheEnabled() || noStore)) headers[API_CACHE_DISABLED_HEADER] = "true";
		if (noStore) headers[API_CACHE_DISABLED_HEADER] = "true";
		const init: RequestInit = { method, signal, credentials: "same-origin", headers, ...(noStore ? { cache: "no-store" } : {}) };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			headers["content-type"] = "application/json";
		}
		let response: Response;
		try {
			response = await this.#fetch(`${this.#base}${path}`, init);
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new DeckApiError("network", 0, "daemon unreachable");
		}
		if (response.status === 401 && this.#base === "/api") this.#onUnauthorized?.();
		return parseResponse<T>(response);
	}
}
