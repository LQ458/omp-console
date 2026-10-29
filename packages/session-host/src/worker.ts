/**
 * Session-host worker: one omp `AgentSession` hosted as a collab room, no TUI.
 *
 * Composition (nothing here reimplements collab or the agent):
 *  - the session comes from the SDK with isolated `Settings`, one shared `AuthStorage` under the
 *    `ModelRegistry`, explicit `cwd` (no `process.chdir`) and default discovery, so `~/.omp/agent`
 *    extensions, agents, commands and config apply exactly as in a terminal session;
 *  - the room is the real `CollabController`/`CollabHost` against a structural headless
 *    `InteractiveModeContext` double (see headless-context.ts), on the daemon's relay, with the daemon's
 *    room id, key and write token pinned (`CollabStartOptions.identity`);
 *  - questions (`ask`, approvals, extension dialogs) go to writable guests through `requestGuestUi` (see
 *    guest-ui.ts); there is no local dialog to race;
 *  - the daemon sees `ready` / `state` / `notify` / `fatal` / `agent` lines (see status.ts, agent-events.ts) and
 *    asks for the capability catalog, slash commands and subagent spawns through request commands (see main.ts).
 */
import * as path from "node:path";
import type { CatalogResponse, KeyPoints, PluginInfo, SessionOp, SessionOpResult, SessionOpV3, SessionOpV3Result, SpawnAgentRequest, WorkerOvernightOptions } from "@omp-console/protocol";
import { getAgentDir, getModelDbPath } from "@oh-my-pi/pi-utils/dirs";
import { logger } from "@oh-my-pi/pi-utils";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { RpcGoalController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import { parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgComputerEnabled, cfgTodoEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { DEFAULT_SKILLS_URL } from "@oh-my-pi/pi-wire/skillshare";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { cfgSkillsRegistryUrl } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { cfgAskTimeout } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { asInteractiveContext, createHeadlessContext } from "./headless-context";
import { createGuestUiContext } from "./guest-ui";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { WorkerLaunch } from "./launch";
import { killDescendants } from "./process-tree";
import { StateReporter, type StatusSink } from "./status";
import { AgentLifecycleReporter } from "./agent-events";
import { CatalogProvider } from "./catalog";
import { RequestError } from "./request-error";
import { CommandRunner } from "./run-command";
import { AgentSpawner } from "./spawn-agent";
import { ExtUiReporter } from "./ext-ui";
import { summarizeSession } from "./key-points";
import { PlanModeController } from "./plan-mode";
import { PluginControl } from "./plugins";
import { createAgendaTools } from "./agenda-tool";
import { createQuotaExtension, QuotaGate, type QuotaProviderPolicy } from "./quota-gate";
import { SessionOps } from "./session-ops";
import { TanWorkerService } from "./tan";
import { OmfgWorkerService } from "./omfg";
import { CleanseWorkerService } from "./cleanse";
import { SkillsService } from "./skills";
import { GitService } from "./git";
import { TitleReporter } from "./title";
import { UsageSampleReporter } from "./usage-samples";
import { sanitizeUsageReports } from "./usage-report";
import { installWorkerWebSocketAuth } from "./worker-auth";
import deckDisplayPrompt from "./prompts/console-display.md" with { type: "text" };
import deckWorkPrompt from "./prompts/console-work.md" with { type: "text" };

/** Longest a single teardown step may hold the stop sequence; the whole stop stays well under 5 s. */
const STEP_TIMEOUT_MS = 1000;
/** How often a room that vanished without us stopping it is noticed. */
const ROOM_WATCH_MS = 1000;

export interface WorkerHooks {
	/** The worker can no longer do its job (room lost, relay unusable). The caller reports `fatal` and exits. */
	onFatal(message: string): void;
}

/** What `start` builds before the worker object exists and hands to it. */
interface WorkerServices {
	authStorage: AgentSession["modelRegistry"]["authStorage"];
	mcpManager: MCPManager | undefined;
	/** `subagentEventBus ?? eventBus` of the session. */
	lifecycleBus: EventBus;
	ui: ExtensionUIContext;
	extUi: ExtUiReporter;
	gate: QuotaGate;
	goals: RpcGoalController;
}

async function bounded(label: string, step: () => Promise<unknown>, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
	const timer = Promise.withResolvers<"timeout">();
	const handle = setTimeout(() => timer.resolve("timeout"), timeoutMs);
	try {
		const outcome = await Promise.race([step().then(() => "done" as const), timer.promise]);
		if (outcome === "timeout") logger.warn("shutdown step timed out", { step: label, timeoutMs });
	} catch (error) {
		logger.warn("shutdown step failed", { step: label, error: String(error) });
	} finally {
		clearTimeout(handle);
	}
}

export class SessionHostWorker {
	readonly #launch: WorkerLaunch;
	readonly #sink: StatusSink;
	readonly #hooks: WorkerHooks;
	readonly #session: AgentSession;
	readonly #authStorage: AgentSession["modelRegistry"]["authStorage"];
	readonly #controller: CollabController;
	readonly #reporter: StateReporter;
	readonly #catalog: CatalogProvider;
	readonly #commands: CommandRunner;
	readonly #spawner: AgentSpawner;
	readonly #lifecycle: AgentLifecycleReporter;
	readonly #gate: QuotaGate;
	readonly #extUi: ExtUiReporter;
	readonly #goals: RpcGoalController;
	readonly #ops: SessionOps;
	readonly #title: TitleReporter;
	readonly #usageSamples: UsageSampleReporter;
	readonly #plugins: PluginControl;
	readonly #unsubscribeGoalEvents: () => void;
	readonly #background = new AbortController();
	readonly #unsubscribeSessionChange: () => void;
	#unsubscribePendingUi: (() => void) | undefined;
	#roomWatch: Timer | undefined;
	#rehosting: Promise<void> | undefined;
	#abortInProgress: Promise<boolean> | undefined;
	#stopping: Promise<void> | undefined;

	private constructor(
		launch: WorkerLaunch,
		sink: StatusSink,
		hooks: WorkerHooks,
		session: AgentSession,
		controller: CollabController,
		reporter: StateReporter,
		services: WorkerServices,
	) {
		const { authStorage, mcpManager, lifecycleBus, ui, extUi, gate, goals } = services;
		this.#launch = launch;
		this.#sink = sink;
		this.#hooks = hooks;
		this.#session = session;
		this.#authStorage = authStorage;
		this.#controller = controller;
		this.#reporter = reporter;
		this.#gate = gate;
		this.#extUi = extUi;
		this.#goals = goals;
		this.#catalog = new CatalogProvider(session, mcpManager);
		this.#commands = new CommandRunner({ session, mcpManager });
		this.#spawner = new AgentSpawner(session);
		this.#lifecycle = new AgentLifecycleReporter({ bus: lifecycleBus, registry: AgentRegistry.global(), session, sink });
		const plan = new PlanModeController(session, goals);
		const skills = new SkillsService({
			cwd: launch.cwd,
			registryUrl: cfgSkillsRegistryUrl.get(session.settings) || DEFAULT_SKILLS_URL,
			session,
			ui,
			onCatalogChanged: () => this.#catalog.invalidate(),
		});
		const git = new GitService(launch.cwd);
		this.#ops = new SessionOps({
			session,
			roomId: this.#launch.roomId,
			goals,
			plan,
			tan: new TanWorkerService({ session, settings: session.settings, mcpManager }),
			omfg: new OmfgWorkerService({
				session,
				settings: session.settings,
				getCwd: () => session.sessionManager.getCwd(),
			}),
			cleanse: new CleanseWorkerService({
				session,
				getCwd: () => session.sessionManager.getCwd(),
				onStateChanged: status => reporter.setCleanseStatus(status),
			}),
			skills,
			git,
			host: () => this.host,
			submitPrompt: (text, behavior) => this.sendPrompt(text, behavior),
			onStateChanged: () => {
				this.host?.refreshState();
				this.#reporter.schedule();
			},
			onLiveAudio: audio => this.#sink.emit({ t: "live-audio", audio }),
			onLiveLevels: (input, output) => this.#sink.emit({ t: "live-levels", input, output }),
		});
		this.#reporter.setModeStatusProvider(() => this.#ops.modeStatus());
		this.#title = new TitleReporter(session, sink, () => reporter.schedule());
		this.#usageSamples = new UsageSampleReporter({ session, bus: lifecycleBus, sink });
		this.#plugins = new PluginControl({
			session,
			mcpManager,
			eventBus: lifecycleBus,
			onReloaded: () => this.#catalog.invalidate(),
		});
		// Goal continuation is driven from agent lifecycle events, ahead of every other observer of the same event.
		this.#unsubscribeGoalEvents = session.subscribe(event => goals.observe(event));
		this.#unsubscribeSessionChange = session.registerSessionChangeCallback(() => this.#onSessionChanged());
	}

	get session(): AgentSession {
		return this.#session;
	}

	get registry(): AgentRegistry {
		return AgentRegistry.global();
	}

	get host(): CollabHost | undefined {
		return this.#controller.host;
	}

	/** The capability catalog (cached for 10 s; see catalog.ts). */
	catalog(): Promise<CatalogResponse> {
		return this.#catalog.get();
	}

	/** Run one remote-invokable slash command; resolves once omp admitted it (see run-command.ts). */
	runCommand(text: string): Promise<void> {
		return this.#commands.run(text);
	}

	/** Spawn a subagent of a profile through omp's task tool; resolves with its registry id (see spawn-agent.ts). */
	spawnAgent(request: SpawnAgentRequest): Promise<string> {
		return this.#spawner.spawn(request);
	}

	/**
	 * Stop one subagent of this session the way the collab `kill` agent command does: abort its live turn, then release
	 * it as an aborted tombstone so the owning `task` call settles. The main agent cannot be cancelled this way.
	 */
	async cancelAgent(agentId: string): Promise<void> {
		if (agentId === MAIN_AGENT_ID) throw new RequestError("bad-request", "the main agent is stopped with abort, not cancel");
		const ref = AgentRegistry.global().get(agentId);
		if (!ref || ref.kind !== "sub") throw new RequestError("not-found", `no subagent ${agentId}`);
		if (ref.status === "running" && ref.session) await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
	}

	/** Re-evaluate the `state` line now; model and thinking changes land as entries, not session events. */
	refreshState(): void {
		this.#reporter.schedule();
	}

	/** One session operation through omp's session API, including rewind, shell and BTW. */
	sessionOp(op: SessionOp | SessionOpV3, signal?: AbortSignal): Promise<SessionOpResult | SessionOpV3Result> {
		return this.#ops.run(op, signal);
	}
	pushLiveAudio(data: string): void {
		this.#ops.pushLiveAudio(data);
	}

	/** `fetchUsageReports()` of the session's auth storage with everything credential-shaped removed. */
	async usage(): Promise<unknown[]> {
		return sanitizeUsageReports(await this.#session.fetchUsageReports(this.#background.signal));
	}

	/** Key points of the current branch from the `smol` role (see key-points.ts). */
	summarize(): Promise<KeyPoints> {
		return summarizeSession(this.#session, { signal: this.#background.signal });
	}

	/** Start omp's title generator; the result arrives as a `title` line (see title.ts). */
	refineTitle(): void {
		this.#title.refine();
	}

	plugins(): Promise<PluginInfo[]> {
		return this.#plugins.list();
	}

	togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
		return this.#plugins.toggle(pluginId, enabled);
	}

	/** The daemon's latest flow-control policy (see quota-gate.ts). */
	setQuotaPolicy(providers: readonly QuotaProviderPolicy[]): void {
		this.#gate.update(providers);
	}

	/** Update the session-scoped ask timeout without persisting it to omp settings. */
	setOvernightOptions(options: WorkerOvernightOptions | null): void {
		this.#launch.overnight = options === null ? undefined : { ...options };
		if (options === null) cfgAskTimeout.clearOverride(this.#session.settings);
		else cfgAskTimeout.override(this.#session.settings, options.askTimeoutSec);
	}

	/**
	 * Prompt the main agent as the host user (workspace handoff, quick-ask). Templates and slash commands are not
	 * expanded; a running turn gets it as a follow-up. Resolves once omp admitted it, not when the turn ends.
	 */
	sendPrompt(text: string, behavior: "steer" | "followUp" = "followUp"): Promise<void> {
		if (this.#stopping) return Promise.reject(new RequestError("conflict", "worker is stopping"));
		if (this.#gate.frozen) return Promise.reject(new RequestError("conflict", "session is frozen"));
		const admitted = Promise.withResolvers<void>();
		this.#session
			.prompt(text, {
				expandPromptTemplates: false,
				runCommands: false,
				userInitiated: true,
				streamingBehavior: behavior,
				onPromptAdmitted: () => admitted.resolve(),
			})
			.then(
				() => admitted.resolve(),
				error => admitted.reject(new RequestError("internal", error instanceof Error ? error.message : String(error))),
			);
		return admitted.promise;
	}

	/** Freeze holds every new prompt and spawn (and aborts the running turn); unfreeze releases them. */
	async freeze(frozen: boolean): Promise<void> {
		this.#gate.setFrozen(frozen);
		if (frozen) await this.abort();
	}

	/** Build the session, host the room, announce `ready`. Throws on any startup failure (caller reports `fatal`). */
	static async start(
		launch: WorkerLaunch,
		sink: StatusSink,
		hooks: WorkerHooks,
	): Promise<SessionHostWorker> {
		installWorkerWebSocketAuth(launch.relay, launch.deviceToken);
		const agentDir = getAgentDir();
		const settings = await Settings.loadIsolated({ cwd: launch.cwd, agentDir });
		if (launch.overnight) cfgAskTimeout.override(settings, launch.overnight.askTimeoutSec);
		// Computer use is opt-in on every platform; an explicit environment override is also supported.
		cfgComputerEnabled.override(settings, launch.computerUse || process.env.OMP_CONSOLE_COMPUTER_USE === "1");
		// Tools format their results through the process-global theme even with no terminal (ask, read, ...);
		// without this they throw `theme.status`. No watcher: there is no TTY to follow.
		await initTheme(false);
		// One AuthStorage for everything this process runs; the registry is built on that very object so
		// refresh failures and credential events route through a single instance.
		const authStorage = await discoverAuthStorage(agentDir, { settings, cwd: launch.cwd });
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), {
			settings,
			cacheDbPath: getModelDbPath(agentDir),
		});
		const sessionManager = launch.resumeFile
			? await SessionManager.open(launch.resumeFile)
			: launch.fork
				? await SessionManager.open(launch.fork.sessionFile)
				: SessionManager.create(
						launch.cwd,
						// The daemon's OMP_CONSOLE_SESSIONS_DIR (a separate store, used by the scenario sandbox) applies to new sessions too.
						process.env.OMP_CONSOLE_SESSIONS_DIR ? computeDefaultSessionDir(launch.cwd, new FileSessionStorage(), process.env.OMP_CONSOLE_SESSIONS_DIR) : undefined,
					);

		let host: () => CollabHost | undefined = () => undefined;
		let reporter: StateReporter | undefined;
		const extUi = new ExtUiReporter(sink);
		const ui = createGuestUiContext({
			host: () => host(),
			opened: (kind, summary) => (reporter ? reporter.dialogOpened(kind, summary) : 0),
			closed: id => reporter?.dialogClosed(id),
			askTimeoutSec: () => launch.overnight?.askTimeoutSec,
			autoAnswer: answer => {
				if (launch.overnight) sink.emit({ t: "auto-answer", ...answer });
			},
			extUi,
		});
		const gate = new QuotaGate();
		let noticeTarget: AgentSession | undefined;

		const toolAllowlist = launch.toolAllowlist;
		const created = await createAgentSession({
			cwd: launch.cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			// `hasUI` enables the `ask` tool; its dialogs are answered by guests through `ui`.
			hasUI: true,
			modelPattern: launch.model,
			bindProcessState: false,
			// omp's own operator-message titles (the TUI's behaviour): a fork of the first reply names the session.
			autoTitle: true,
			customTools: launch.agendaTools
				? createAgendaTools({
					relayUrl: launch.relay,
					sessionId: sessionManager.getSessionId(),
					deviceToken: launch.deviceToken,
				})
				: [],
			...(toolAllowlist === undefined
				? // What deck draws (diagrams, charts, widgets), plus how the agent tracks its own work when it has `todo` and `goal`;
					// restricted sessions (the agenda) only answer in text.
					{
						appendSystemPrompt:
							cfgTodoEnabled.get(settings) && cfgGoalEnabled.get(settings)
								? `${deckDisplayPrompt}\n\n${deckWorkPrompt}`
								: deckDisplayPrompt,
					}
				: {
						toolNames: toolAllowlist,
						restrictToolNames: true,
						allowRestrictedCustomTools: true,
					}),
			extensions: [
				createQuotaExtension({
					gate,
					settings,
					notice: message => noticeTarget?.emitNotice("warning", message, "deck-quota"),
				}),
			],
		});
		const { session } = created;
		noticeTarget = session;
		const goals = new RpcGoalController(session);
		try {
			created.setToolUIContext(ui, true);
			await initializeExtensions(session, {
				mode: "rpc",
				uiContext: ui,
				// Extension-initiated session changes get the goal quiesce/reattach RPC mode gives them.
				wrapSessionChange: async <T extends { cancelled: boolean }>(
					change: () => Promise<T>,
					{ detachesRun }: { detachesRun: boolean },
				): Promise<T> => {
					await goals.beginSessionChange();
					let result: T | undefined;
					try {
						result = await change();
						return result;
					} finally {
						await goals.endSessionChange({ detachedRun: detachesRun && result?.cancelled !== true });
					}
				},
				reportSendError: (action, error) => logger.warn("extension send failed", { action, error: error.message }),
				reportRuntimeError: error =>
					logger.warn("extension error", { error: String(error.error), event: error.event }),
			});
			if (launch.fork) {
				const forked = await session.fork(launch.fork.entryId);
				if (!forked) throw new Error("fork was cancelled by an extension");
			}
			// A fresh session has no file until its first assistant message; the daemon needs the path to resume.
			await session.sessionManager.ensureOnDisk();
			// `goal` is the agent's own bookkeeping, like `todo`: keep it in the tool set from the start instead of only
			// after a user sets a goal. Enabled before the goal reattaches, so RpcGoalController's restore after a goal
			// ends keeps it too.
			if (toolAllowlist === undefined && cfgGoalEnabled.get(settings)) {
				const enabled = session.getEnabledToolNames();
				if (!enabled.includes("goal")) await session.setActiveToolsByName([...enabled, "goal"]);
			}
			// Reattach a goal journaled in a resumed session (an active one comes back paused, as in RPC mode).
			await goals.reconcile();
			await goals.settled();

			const context = createHeadlessContext({
				session,
				settings,
				eventBus: created.eventBus,
				subagentEventBus: created.subagentEventBus,
			});
			const controller = new CollabController(asInteractiveContext(context));
			host = () => controller.host;
			const registry = AgentRegistry.global();
			reporter = new StateReporter({
				session,
				registry,
				rootAgentId: MAIN_AGENT_ID,
				sink,
				isOvernight: () => launch.overnight !== undefined,
			});
			const worker = new SessionHostWorker(launch, sink, hooks, session, controller, reporter, {
				mcpManager: created.mcpManager,
				authStorage,
				lifecycleBus: created.subagentEventBus ?? created.eventBus,
				ui,
				extUi,
				gate,
				goals,
			});
			await worker.#ops.restoreModes();
			context.collabHost = undefined;
			await worker.#hostRoom();
			// Guests may drive the session only once startup (extensions, fork) is complete.
			controller.startupComplete();
			worker.#announceReady();
			worker.#roomWatch = setInterval(() => worker.#checkRoom(), ROOM_WATCH_MS);
			worker.#roomWatch.unref();
			return worker;
		} catch (error) {
			reporter?.dispose();
			extUi.dispose();
			gate.close();
			await bounded("dispose after failed start", () => session.dispose());
			await bounded("auth storage close after failed start", async () => authStorage.close());
			await killDescendants(process.pid);
			throw error;
		}
	}

	/** Abort the active turn using the same reason and session API as a writable guest. */
	abort(): Promise<boolean> {
		if (this.#stopping) return Promise.resolve(false);
		// Stop between loop rounds would otherwise do nothing and the loop would submit its next round.
		this.#ops.interruptLoop();
		if (this.#abortInProgress) return this.#abortInProgress;
		if (!this.#session.isStreaming) return Promise.resolve(false);
		// A spawn or prompt parked by flow control would otherwise keep the turn from unwinding.
		this.#gate.cancelWaiters();
		const operation = this.#session.abort({ reason: USER_INTERRUPT_LABEL }).then(() => true);
		const tracked = operation.finally(() => {
			if (this.#abortInProgress === tracked) this.#abortInProgress = undefined;
		});
		this.#abortInProgress = tracked;
		return tracked;
	}

	/** Start the room with the daemon's identity and verify the published link carries exactly that identity. */
	async #hostRoom(): Promise<CollabHost> {
		const { roomId, roomKey, writeToken } = this.#launch;
		const host = await this.#controller.start({
			access: "control",
			relay: this.#launch.relay,
			identity: { roomId, roomKey, writeToken },
		});
		const parsed = parseCollabLink(host.link);
		const matches =
			!("error" in parsed) &&
			parsed.roomId === roomId &&
			Buffer.from(parsed.key).equals(Buffer.from(roomKey)) &&
			parsed.writeToken !== undefined &&
			Buffer.from(parsed.writeToken).equals(Buffer.from(writeToken));
		if (!matches) {
			await host.stop("room identity mismatch");
			throw new Error("collab host did not adopt the room identity supplied by the daemon");
		}
		this.#unsubscribePendingUi?.();
		this.#unsubscribePendingUi = host.onPendingUiChange(requests => this.#reporter.pendingGuestUiChanged(requests));
		return host;
	}

	#announceReady(): void {
		const manager = this.#session.sessionManager;
		this.#sink.emit({
			t: "ready",
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			rootAgentId: MAIN_AGENT_ID,
			roomId: this.#launch.roomId,
		});
		this.#reporter.flush();
	}

	/**
	 * `/new`, resume, fork or branch inside the session replaced its identity: the controller already
	 * stopped the old room (it only mirrors the session it started with). Re-host under the same daemon
	 * identity so the link the daemon handed out keeps working, and announce the new session.
	 */
	#onSessionChanged(): void {
		if (this.#stopping) return;
		this.#title.rebind();
		const rehost = async (): Promise<void> => {
			try {
				await this.#controller.idle();
				await this.#hostRoom();
				this.#announceReady();
			} catch (error) {
				if (!this.#stopping)
					this.#hooks.onFatal(`collab room could not follow the session change: ${String(error)}`);
			}
		};
		this.#rehosting = (this.#rehosting ?? Promise.resolve()).then(rehost).finally(() => {
			this.#rehosting = undefined;
		});
	}

	/** The relay ended the room underneath us and nothing is replacing it. */
	#checkRoom(): void {
		if (this.#stopping || this.#rehosting) return;
		if (this.#controller.host) return;
		this.#hooks.onFatal("collab room ended");
	}

	/**
	 * Graceful shutdown: abort the running turn, close the room (pending dialogs settle as unavailable and
	 * unblock their tools), dispose the session and everything it spawned, then sweep stragglers. Idempotent,
	 * never throws, bounded: each step is capped so the whole sequence fits the 5 s exit contract.
	 */
	stop(reason: string): Promise<void> {
		this.#stopping ??= this.#runStop(reason);
		return this.#stopping;
	}

	async #runStop(reason: string): Promise<void> {
		clearInterval(this.#roomWatch);
		this.#ops.prepareForShutdown();
		this.#gate.close();
		this.#background.abort(reason);
		this.#unsubscribeSessionChange();
		this.#unsubscribeGoalEvents();
		this.#spawner.stop(reason);
		this.#commands.abortBackground(reason);
		await bounded("abort", () => this.#abortInProgress ?? this.#session.abort({ reason }));
		await bounded("side question shutdown", () => this.#ops.close());
		this.#reporter.flush();
		this.#unsubscribePendingUi?.();
		this.#unsubscribePendingUi = undefined;
		this.#lifecycle.dispose();
		this.#usageSamples.dispose();
		this.#title.dispose();
		this.#extUi.dispose();
		this.#reporter.dispose();
		await bounded("collab shutdown", () => this.#controller.shutdown(reason));
		await bounded("session dispose", () => this.#session.dispose());
		await bounded("auth storage close", async () => this.#authStorage.close());
		await bounded("descendant sweep", () => killDescendants(process.pid));
	}
}
