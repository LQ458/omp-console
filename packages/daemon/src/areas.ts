/**
 * Wave-2 control areas (packages/protocol/src/wave2.ts) assembled over the real supervisor: session operations, plugins,
 * history, quota, workspaces, processes, safety and the improvement report. Each area keeps its own `ports.ts`
 * interface; this file is the only place that adapts them to the supervisor, the model settings and each other.
 */
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionPathKey } from "./session-key";
import type { AgendaAskResponse, CreateSessionRequest, HistoryEdge, KeyPoints, QuickAskSource, SessionSummary, WorkspaceKind } from "@omp-console/protocol";
import type { FeatureSettings } from "./config";
import { type AgendaHubConfig, AgendaAskError, type AgendaRouteOptions } from "./agenda/ports";
import { AskCompletionLimit } from "./agenda/ask-limit";
import { askAnswerWithReceipt, createAgendaRoutes, readAgendaToday } from "./agenda/routes";
import { listPersisted } from "./history/persisted";
import { createHistoryRoutes, type HistoryRoutes } from "./history/routes";
import { createKeybindingsPorts } from "./keybindings/ports";
import { createKeybindingsRoutes } from "./keybindings/routes";
import { createLibrarianRoutes, type LibrarianRoutes } from "./librarian/routes";
import { readSessionConversation } from "./librarian/transcript";
import type { ModelControl } from "./model-control";
import type { DecisionModel, TextModel } from "./models/types";
import { createPluginRoutes } from "./plugins/routes";
import { createProcessRoutes, type ProcessRouteHandler } from "./processes/routes";
import type { QuotaAgentEvent, QuotaQueueEvent, QuotaRateLimitEvent, QuotaUsageSample } from "./quota/ports";
import { createQuotaRoutes, type QuotaRouteHandler } from "./quota/routes";
import { createReportRoutes } from "./report/routes";
import { createSafetyRoutes, type SafetyRouteHandler } from "./safety/routes";
import { createSessionOpsRoutes } from "./session-ops/routes";
import { errorResponse } from "./api";
import { type AgentEvent, type NotifyEvent, type Supervisor, SupervisorError, type UsageSampleEvent } from "./supervisor";
import { createWorkspaceRoutes } from "./workspaces/routes";

type Handler = (req: Request, url: URL) => Promise<Response | undefined>;

export interface AreaOptions {
	stateDir: string;
	/** omp agent dir whose keybindings deck serves (default: omp's own resolution). */
	agentDir?: string;
	/** Optional knowledge root; features that require it stay unavailable when it is absent. */
	knowledgeRoot?: string;
	/** Explicit project roots; there are no home-directory defaults. */
	projectRoots?: readonly string[];
	features?: FeatureSettings;
	quickAskSources?: readonly QuickAskSource[];
	/** Usage poll period while sessions are live, for quota pacing (default 2 min; 0 disables). */
	quotaPollMs?: number;
	/** Disable background timers (history idle summaries, process idle-stop checks) in tests. */
	timers?: boolean;
	/** Background models for the librarian (session cards, brief); without them its routes are not mounted. */
	backgroundModels?: (modelControl: ModelControl) => Promise<{ text: TextModel; decision: DecisionModel }>;
	/** Optional local scheduler TOML; absent means no local schedule data. */
	scheduleConfig?: string;
	/** tasks-hub checkout for the agenda routes; absent means the agenda reports itself unavailable. */
	agendaHub?: AgendaHubConfig;
	/** Longest wait for a hidden agenda-ask session to answer. */
	agendaAskTimeoutMs?: number;
	log: (message: string) => void;
}

export interface Areas {
	handle(req: Request, url: URL): Promise<Response | undefined>;
	/** Supervisor hooks, bound late because the areas need the supervisor. */
	beforeStop(sessionId: string): Promise<void>;
	beforeSleep(sessionId: string): Promise<void>;
	onCreated(summary: SessionSummary, request: CreateSessionRequest): Promise<void>;
	onUsageSample(sessionId: string, sample: UsageSampleEvent): void;
	onAgentEvent(sessionId: string, event: AgentEvent): void;
	/** Worker `notify` lines (turn finished, needs answer); hidden agenda asks wait on them. */
	onNotify(event: NotifyEvent): void;
	isHiddenSessionFile(sessionFile: string): boolean;
	/** The title the session list shows (the librarian card), for notifications. */
	sessionTitle(sessionId: string): string | undefined;
	/** Resolved configured workspace roots. */
	readonly roots: readonly string[];
	close(): Promise<void>;
}

/** Persisted session files of internal sessions (quick-ask, report) so the recent list keeps hiding them. */
class HiddenFiles {
	readonly #file: string;
	readonly #files = new Set<string>();

	constructor(stateDir: string) {
		this.#file = path.join(stateDir, "hidden-sessions.json");
	}

	async load(): Promise<void> {
		try {
			const value = JSON.parse(await fs.readFile(this.#file, "utf8")) as unknown;
			if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string") this.#files.add(sessionPathKey(entry));
		} catch {}
	}

	has(file: string): boolean {
		return this.#files.has(sessionPathKey(file));
	}

	async add(file: string): Promise<void> {
		const key = sessionPathKey(file);
		if (this.#files.has(key)) return;
		this.#files.add(key);
		await fs.writeFile(this.#file, JSON.stringify([...this.#files]), { mode: 0o600 });
	}
}

/**
 * Real path of a configured root or session cwd. The safety area refuses symlink components (a workspace must not
 * be redirected through one); the roots themselves are trusted, so system links above them (`/tmp`, `/var` on
 * macOS) are resolved here once.
 */
function canonical(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function providerOf(selector: string | undefined): string | undefined {
	if (!selector) return undefined;
	const slash = selector.indexOf("/");
	return slash > 0 ? selector.slice(0, slash) : undefined;
}

async function gitInit(cwd: string): Promise<void> {
	const child = Bun.spawn(["git", "init", "--quiet"], { cwd, stdout: "ignore", stderr: "pipe" });
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(`git init failed: ${stderr.trim().slice(0, 200)}`);
}

/**
 * The whole board Ask, from the request's arrival (queue, session start, the turn, and waiting for a task write under
 * way): the reminders-board's 60 s proxy timeout and its WebKit view drop a silent request at
 * about 60 s, so the answer, a receipt included, must be back before then.
 */
const AGENDA_ASK_BUDGET_MS = 52_000;
/** Kept back from the turn for reporting: waiting for a write under way, then reading the reply. */
const AGENDA_ASK_SETTLE_MS = 10_000;

export async function createAreas(supervisor: Supervisor, modelControl: ModelControl, options: AreaOptions): Promise<Areas> {
	const knowledgeRoot = options.knowledgeRoot === undefined ? undefined : canonical(options.knowledgeRoot);
	const projectRoots = (options.projectRoots ?? []).map(canonical);
	const quickAskSources = options.quickAskSources ?? [];
	const agendaEnabled = options.features?.agenda === true && options.agendaHub !== undefined;
	const quickAskEnabled = options.features?.quickAsk === true && knowledgeRoot !== undefined && quickAskSources.length > 0;
	const librarianEnabled =
		options.features?.librarian === true &&
		knowledgeRoot !== undefined &&
		projectRoots.length > 0 &&
		options.backgroundModels !== undefined;
	const timers = options.timers ?? true;
	const hidden = new HiddenFiles(options.stateDir);
	await hidden.load();

	const usageListeners = new Set<(sessionId: string, sample: QuotaUsageSample) => void>();
	const agentListeners = new Set<(sessionId: string, event: QuotaAgentEvent) => void>();
	// No worker line reports 429/529 or held-spawn counts yet; the quota area treats these sources as silent.
	const rateLimitListeners = new Set<(event: QuotaRateLimitEvent) => void>();
	const queueListeners = new Set<(event: QuotaQueueEvent) => void>();
	const subscribe = <T>(set: Set<T>, listener: T): (() => void) => {
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	};

	const kindOf = (cwd: string): WorkspaceKind => {
		const real = canonical(cwd);
		return knowledgeRoot !== undefined && within(knowledgeRoot, real)
			? "knowledge"
			: projectRoots.some(root => within(root, real))
				? "project"
				: "scratch";
	};
	const sessionCwd = (id: string): string | undefined => {
		const cwd = supervisor.get(id)?.cwd;
		return cwd === undefined ? undefined : canonical(cwd);
	};

	const create = async (request: CreateSessionRequest): Promise<SessionSummary> => {
		const summary = await supervisor.create(request);
		if (request.hidden && summary.sessionFile) await hidden.add(summary.sessionFile);
		return summary;
	};

	const history: HistoryRoutes = createHistoryRoutes(
		{ list: () => supervisor.list(), summarize: sessionId => supervisor.summarize(sessionId) },
		options.stateDir,
		{
			workspaceOf: cwd => {
				const kind = kindOf(cwd);
				if (kind === "knowledge") return "knowledge";
				if (kind === "project") {
					const real = canonical(cwd);
					const root = projectRoots.find(candidate => within(candidate, real));
					if (!root) return undefined;
					if (existsSync(path.join(root, ".git"))) return `project:${path.basename(root)}`;
					const [first] = path.relative(root, real).split(path.sep);
					return first ? `project:${first}` : `project:${path.basename(root)}`;
				}
				return undefined;
			},
			pollMs: timers ? undefined : 0,
			log: options.log,
		},
	);
	const recordEdge = (edge: HistoryEdge): Promise<void> => history.recordEdge(edge);
	/**
	 * Key points for a handoff (workspace start, move). A session with nothing said yet has nothing to summarise; the
	 * handoff then carries its title and nothing else rather than blocking the move or the new session.
	 */
	const keyPoints = async (sessionId: string): Promise<KeyPoints> => {
		try {
			return await supervisor.summarize(sessionId);
		} catch (error) {
			if (!(error instanceof SupervisorError) || error.code !== "conflict") throw error;
			const summary = supervisor.get(sessionId);
			return { sessionId, title: summary?.title ?? path.basename(summary?.cwd ?? sessionId), decisions: [], files: [], openQuestions: [], generatedAt: Date.now() };
		}
	};

	/** omp's handoff on the session (see SafetyPorts.handoffDocument); it also compacts that session. */
	const handoffDocument = async (sessionId: string, focus: string): Promise<string> => {
		const result = await supervisor.sessionOp(sessionId, { op: "handoff", focus });
		if (!("document" in result)) throw new SupervisorError("internal", "handoff returned no document");
		return result.document;
	};

	const quota: QuotaRouteHandler = createQuotaRoutes(
		{
			fetchUsage: async () => {
				const live = supervisor.list().find(session => session.state === "idle" || session.state === "streaming" || session.state === "asking");
				return live ? supervisor.usage(live.id) : null;
			},
			onUsageSample: listener => subscribe(usageListeners, listener),
			onAgentEvent: listener => subscribe(agentListeners, listener),
			onRateLimit: listener => subscribe(rateLimitListeners, listener),
			onQueueChange: listener => subscribe(queueListeners, listener),
			pushPolicy: policy => supervisor.pushQuotaPolicy(policy),
			listLiveSessions: async () =>
				supervisor.list().flatMap(session => {
					if (session.state === "asleep") return [];
					const provider = providerOf(session.model);
					return session.model && provider
						? [{ sessionId: session.id, rootAgentId: session.rootAgentId, model: session.model, provider, role: "default" }]
						: [];
				}),
			setMainModel: async (sessionId, selector) => {
				const session = supervisor.get(sessionId);
				if (!session?.rootAgentId) throw new Error(`no live session ${sessionId}`);
				const result = await supervisor.setAgentModel(sessionId, session.rootAgentId, selector);
				if (result.t === "model-error") throw new Error(result.message);
			},
			readCacheWarming: () => modelControl.cacheWarming(),
			writeCacheWarming: mode => modelControl.setCacheWarming(mode),
			getProviderFamily: providerOf,
			getModelRoles: () => modelControl.modelRoles(),
			now: () => performance.now(),
			wallNow: () => Date.now(),
		},
		options.stateDir,
	);

	const workspaces = createWorkspaceRoutes(
		{
			createSession: create,
			createQuickAskSession: request =>
				create({ cwd: request.cwd, resumeSessionFile: request.resumeSessionFile, title: request.title, hidden: true }),
			sendPrompt: (sessionId, text) => supervisor.sendPrompt(sessionId, text),
			keyPoints: async sessionId => (supervisor.get(sessionId) ? keyPoints(sessionId) : undefined),
			handoffDocument,
			liveSessions: () => supervisor.list(),
			recordEdge,
		},
		options.stateDir,
		{ discovery: { knowledgeRoot, projectRoots }, quickAsk: { enabled: quickAskEnabled, sources: quickAskSources } },
	);

	const processes: ProcessRouteHandler = createProcessRoutes(
		{
			liveSessions: () => supervisor.list(),
			workerHealth: () => supervisor.health(),
			stopSession: sessionId => supervisor.stop(sessionId),
		},
		options.stateDir,
		timers ? {} : { policyCheckIntervalMs: 2 ** 31 - 1 },
	);

	const safety: SafetyRouteHandler = createSafetyRoutes(
		{
			sessionCwd,
			sessionModel: id => supervisor.get(id)?.model,
			sessionWorkspaceKind: id => {
				const cwd = sessionCwd(id);
				return cwd === undefined ? undefined : kindOf(cwd);
			},
			abortSession: async id => {
				await supervisor.abort(id);
			},
			// Unfreezing a session that is no longer live has nothing to release; freezing one must still fail.
			freezeSession: async (id, frozen) => {
				if (!frozen && !supervisor.get(id)) return;
				await supervisor.freeze(id, frozen);
			},
			createSession: request => create(request),
			sendPrompt: (id, text) => supervisor.sendPrompt(id, text),
			keyPoints,
			handoffDocument,
			recordEdge,
			initializeGit: gitInit,
			stopSession: async id => {
				await supervisor.stop(id);
			},
		},
		options.stateDir,
		{ move: projectRoots[0] === undefined ? undefined : { projectsRoot: projectRoots[0] }, log: options.log },
	);

	// Hidden agenda asks (reminders-board's Ask box, spec A12): ONE hidden session in the knowledge root answers them
	// in turn with the agenda tools, so asks never pile up workers and "Open in omp console" lands in a live session. The answer
	// is its last assistant message once the worker reports `turn-finished` (a `needs-answer` dialog is not an answer).
	const turnWaiters = new Map<string, () => void>();
	const askLimit = new AskCompletionLimit();
	// A hidden session retired after a failed ask; the next ask waits for it to stop before starting a fresh one.
	let retiring: Promise<unknown> = Promise.resolve();
	let agendaSessionId: string | undefined;
	let agendaStarting: Promise<SessionSummary> | undefined;
	let askTail: Promise<unknown> = Promise.resolve();
	const askOnce = async (text: string, systemAddendum: string, deadline: number): Promise<AgendaAskResponse> => {
		const left = (): number => deadline - Date.now();
		const busy = (): AgendaAskError => new AgendaAskError("omp console is busy with an earlier ask; ask again in a moment");
		// Every wait before the turn is bounded by this ask's budget, so the board always gets an answer in time.
		const beforeTurn = async <T>(work: Promise<T>): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(busy()), Math.max(0, left() - AGENDA_ASK_SETTLE_MS - 5_000));
			});
			try {
				return await Promise.race([work, late]);
			} finally {
				clearTimeout(timer);
			}
		};
		await beforeTurn(retiring);
		if (left() < AGENDA_ASK_SETTLE_MS + 5_000) throw busy();
		const known = agendaSessionId === undefined ? undefined : supervisor.get(agendaSessionId);
		// Task titles come from shared lists and other sessions: the session that reads them can only read, add and
		// complete agenda items (no shell, no files, no web), so a hostile title cannot make it do anything else. A
		// completion hides the task from the board, so each ask may complete one task and its answer names it, written
		// by the daemon (the model cannot leave it out).
		let summary = known;
		if (!summary) {
			// One start at a time: an ask that gives up on a slow start leaves it running, and the next ask waits on
			// the same start instead of launching another hidden worker. The finished start becomes the Ask session.
			agendaStarting ??= create({
				cwd: knowledgeRoot ?? process.cwd(),
				hidden: true,
				title: "Agenda",
				toolAllowlist: ["agenda_today", "agenda_add", "agenda_complete"],
			})
				.then(created => {
					agendaSessionId = created.id;
					return created;
				})
				.finally(() => {
					agendaStarting = undefined;
				});
			try {
				summary = await beforeTurn(agendaStarting);
			} catch (error) {
				throw error instanceof AgendaAskError ? new AgendaAskError("omp console is still starting its agenda helper; ask again in a moment") : error;
			}
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const turnMs = options.agendaAskTimeoutMs ?? Math.max(1_000, left() - AGENDA_ASK_SETTLE_MS);
		const timer = setTimeout(() => reject(new AgendaAskError("omp console did not answer in time")), turnMs);
		turnWaiters.set(summary.id, resolve);
		askLimit.begin(summary.id);
		// The timeout can fire while the prompt is still being sent; the rejection is observed by the await below.
		promise.catch(() => undefined);
		try {
			// The turn timer also bounds a slow prompt send.
			await Promise.race([supervisor.sendPrompt(summary.id, `${systemAddendum}\n\n${text}`), promise]);
			await promise;
		} catch (error) {
			// A turn still running after the timeout is stopped; the ask is closed, so it cannot tick anything more.
			// The turn may still be running: retire this hidden session (stop it; the next ask starts a fresh one), so its
			// late end can never answer the next ask.
			if (agendaSessionId === summary.id) agendaSessionId = undefined;
			// Stopped in the background so the board gets its answer first; the next ask waits for it.
			// Forgotten only once it has stopped: until then its completions stay refused.
			const retired = summary.id;
			retiring = supervisor.stop(retired).catch(() => false).finally(() => askLimit.forget(retired));
			const done = await askLimit.end(summary.id, Math.max(0, left() - 1_000));
			if (done.length === 0) throw error;
			// What it ticked is still reported, as an answer the board shows.
			return { answer: askAnswerWithReceipt("omp console did not finish this ask.", done), sessionId: summary.id };
		} finally {
			clearTimeout(timer);
			turnWaiters.delete(summary.id);
		}
		const file = supervisor.get(summary.id)?.sessionFile ?? summary.sessionFile;
		const messages = file ? await readSessionConversation(file) : [];
		const reply = messages.findLast(message => message.role === "assistant")?.text;
		const completed = await askLimit.end(summary.id, Math.max(0, left() - 1_000));
		if (!reply && completed.length === 0) throw new Error("the agenda session gave no answer");
		return { answer: askAnswerWithReceipt(reply, completed), sessionId: summary.id };
	};
	const askHidden = (text: string, systemAddendum: string): Promise<AgendaAskResponse> => {
		// The budget starts now: time queued behind an earlier ask counts.
		const deadline = Date.now() + (options.agendaAskTimeoutMs === undefined ? AGENDA_ASK_BUDGET_MS : options.agendaAskTimeoutMs + AGENDA_ASK_SETTLE_MS + 5_000);
		const run = askTail.then(() => askOnce(text, systemAddendum, deadline));
		askTail = run.catch(() => undefined);
		return run;
	};
	const agendaOptions: AgendaRouteOptions = {
		hub: options.agendaHub,
		claimCompletion: sessionId => askLimit.claim(sessionId),
	};
	const agenda = agendaEnabled ? createAgendaRoutes({ askHidden }, options.stateDir, agendaOptions) : undefined;
	const warmAgenda = (): void => {
		void readAgendaToday(agendaOptions).catch(error => options.log(`agenda cache warm failed: ${error instanceof Error ? error.message : String(error)}`));
	};

	const models = librarianEnabled && options.backgroundModels ? await options.backgroundModels(modelControl) : undefined;
	const librarian: LibrarianRoutes | undefined = models
		? createLibrarianRoutes(
				{
					list: () => supervisor.list().filter(session => !session.hidden),
					listPersisted: async () => (await listPersisted()).filter(session => !hidden.has(session.file)),
					// A live session's omp file is current (omp appends each entry), so the librarian reads it like any other.
					readLiveConversation: async sessionId => {
						const file = supervisor.get(sessionId)?.sessionFile;
						const messages = file ? await readSessionConversation(file) : [];
						const first = messages.find(message => message.role === "user")?.text;
						return first === undefined ? { messages } : { messages, firstUserPrompt: first };
					},
					textModel: models.text,
					decisionModel: models.decision,
					...(agendaEnabled ? { agendaToday: async () => (await readAgendaToday(agendaOptions)).items } : {}),
				},
				options.stateDir,
				{
					...(knowledgeRoot === undefined ? {} : { knowledgeRoot }),
					projectRoots,
					scheduleConfig: options.scheduleConfig,
					...(timers ? {} : { intervalMs: 0 }),
					log: options.log,
				},
			)
		: undefined;

	const TITLE_ROUTE = /^\/api\/sessions\/([^/]+)\/title$/;
	const titleRoute: Handler = async (req, url) => {
		const match = TITLE_ROUTE.exec(url.pathname);
		if (!match) return undefined;
		if (req.method !== "POST") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "POST" });
		const sessionId = decodeURIComponent(match[1]!);
		if (!supervisor.get(sessionId)) return errorResponse(404, "not-found", `no live session ${sessionId}`);
		await supervisor.refineTitle(sessionId);
		return new Response(null, { status: 202 });
	};

	const handlers: Handler[] = [
		titleRoute,
		createSessionOpsRoutes({ sessionOp: (id, op) => supervisor.sessionOp(id, op) }),
		createPluginRoutes({
			plugins: id => supervisor.plugins(id),
			togglePlugin: (id, pluginId, enabled) => supervisor.togglePlugin(id, pluginId, enabled),
			extensionUi: id => supervisor.extensionUi(id),
		}),
		history,
		quota,
		workspaces,
		processes,
		safety,
		createReportRoutes({ createSession: create }, options.stateDir),
		...(agenda ? [agenda] : []),
		createKeybindingsRoutes(createKeybindingsPorts(options.agentDir)),
		...(librarian ? [librarian] : []),
	];

	const pollMs = options.quotaPollMs ?? 120_000;
	const quotaTimer =
		pollMs > 0
			? setInterval(() => {
					if (!supervisor.list().some(session => session.state !== "asleep")) return;
					quota.refresh().catch(error => options.log(`quota poll failed: ${error instanceof Error ? error.message : String(error)}`));
				}, pollMs)
			: undefined;
	quotaTimer?.unref?.();

	// The agenda read costs ~1.4 s (tasks-hub's Python plus a CalDAV round trip); keep its cache warm so the home
	// screen and the return brief never wait for it.
	if (agendaEnabled && timers) warmAgenda();
	const agendaTimer = agendaEnabled && timers ? setInterval(warmAgenda, 4 * 60_000) : undefined;
	agendaTimer?.unref?.();

	return {
		async handle(req, url) {
			for (const handler of handlers) {
				const response = await handler(req, url);
				if (response) return response;
			}
			return undefined;
		},
		beforeSleep: sessionId => history.beforeSleep(sessionId),
		beforeStop: sessionId => history.beforeStop(sessionId),
		async onCreated(summary, request) {
			// Drift baselines describe the tree before the agent ran; a resumed or forked session keeps its old one.
			if (!request.resumeSessionFile && !request.forkFrom) await safety.captureSessionBaseline(summary.id, canonical(summary.cwd));
		},
		onUsageSample(sessionId, sample) {
			for (const listener of [...usageListeners]) listener(sessionId, sample);
		},
		onAgentEvent(sessionId, event) {
			for (const listener of [...agentListeners]) listener(sessionId, event);
		},
		onNotify(event) {
			if (event.reason === "turn-finished") turnWaiters.get(event.sessionId)?.();
		},
		isHiddenSessionFile: file => hidden.has(file),
		sessionTitle: sessionId => librarian?.cardTitle(sessionId),
		roots: [...(knowledgeRoot === undefined ? [] : [knowledgeRoot]), ...projectRoots],
		async close() {
			clearInterval(quotaTimer);
			clearInterval(agendaTimer);
			librarian?.dispose();
			history.dispose();
			processes.dispose();
			await quota.close();
		},
	};
}
