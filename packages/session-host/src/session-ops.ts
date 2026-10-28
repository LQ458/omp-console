/**
 * `session-op`: one session operation through omp's own session API. Nothing here synthesises prompt text; every
 * operation is the call omp's RPC mode, TUI or ACP agent makes for the same control:
 *
 *  - plan-mode      `PlanModeController` (headless plan mode, see plan-mode.ts)
 *  - goal           `RpcGoalController.handle` (set/pause/resume/drop) and `goalRuntime.onBudgetMutated` (budget,
 *                   the `/goal budget` path)
 *  - todos          `setTodoPhases` plus the `user_todo_edit` entry (RPC `set_todos`)
 *  - compact        `session.compact(undefined, { mode })` (`/compact [soft|remote|snapcompact]`)
 *  - approval-mode  `tools.approvalMode` runtime override on the session's settings (`--approval-mode`; not persisted)
 *  - dequeue        `popLastQueuedMessage` / `takeQueuedMessage` (Alt+Up and `remove_queued_message`)
 *  - stats, tree, context   `getSessionStats`, `sessionManager` entries, `computeSessionContextBreakdown`
 *  - rewind, shell, btw   `navigateTree`, the session's bash/Python executors, and the RPC side-question controller
 */
import type {
	CollabSessionStatus,
	ContextBreakdownView,
	DebugSessionOp,
	LoopModeStatus,
	LiveModeStatus,
	PendingUiRequest,
	RewindPoint,
	SessionOp,
	SessionOpResult,
	SessionOpV3,
	SessionOpV3Result,
	SessionStatsView,
	SessionTreeNode,
	VibeModeStatus,
} from "@omp-console/protocol";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getBtwLatestTurn } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { computeSessionContextBreakdown } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isTranscriptEntry } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { RpcBtwController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-btw";
import { RpcGoalController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import { isUserRequestEntry, userTurnDraft } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { splitQueuedMessages } from "@oh-my-pi/pi-tui/prompt/queue-input";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { DebugModeService } from "./debug-mode";
import { DebugDiagnosticsService } from "./debug-diagnostics";
import { LoopModeController } from "./loop-mode";
import type { PlanModeController } from "./plan-mode";
import { generateQuickReplies } from "./quick-replies";
import { RequestError } from "./request-error";
import { TanWorkerService } from "./tan";
import { OmfgWorkerService } from "./omfg";
import { CleanseWorkerService } from "./cleanse";
import type { SkillsService } from "./skills";
import type { GitService } from "./git";
import { LiveModeControllerService } from "./live-mode";
import { VibeModeController } from "./vibe-mode";

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "abandoned", "blocked"]);
const PREVIEW_LIMIT = 120;
/** Matches `bashPtyViewport`'s default 80x24 terminal after its execution-frame margins. */
const HEADLESS_BASH_PTY = { cols: 78, rows: 20, onChunk: (_chunk: string): void => {} };
const MAX_TODO_TEXT = 4000;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `RpcGoalController` throws plain `Error`s for refusals (disabled, wrong state, bad budget); those are the caller's. */
function goalError(error: unknown): RequestError {
	return error instanceof RequestError ? error : new RequestError("bad-request", error instanceof Error ? error.message : String(error));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join(" ");
}

/** Generated quick replies kept per session (only the latest agent answer is asked for). */
const QUICK_REPLY_CACHE_LIMIT = 8;
/** Closed question ids remembered to tell "already answered" from "never existed". */
const SEEN_UI_REQUEST_LIMIT = 256;

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT - 1)}…` : flat;
}

/** An agent answer with prose: a rewind point that keeps the answer (and nothing after it). */
function agentAnswerText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
	const text = textOf(entry.message.content).trim();
	return text === "" ? undefined : text;
}

/**
 * Where a rewind to the agent answer at `branch[index]` puts the leaf: the answer itself, extended through the tool
 * results that answer its tool calls, so the session never ends on calls whose results exist (the same rule omp's
 * entry fork applies). Bookkeeping entries between results are stepped over only when a later result follows.
 */
function agentRewindLeaf(branch: readonly SessionEntry[], index: number): string {
	const answer = branch[index]!;
	if (answer.type !== "message" || answer.message.role !== "assistant") return answer.id;
	const pending = new Set<string>();
	for (const block of answer.message.content) if (block.type === "toolCall") pending.add(block.id);
	let leaf = answer.id;
	for (let cursor = index + 1; cursor < branch.length && pending.size > 0; cursor++) {
		const entry = branch[cursor]!;
		if (entry.type === "message") {
			if (entry.message.role !== "toolResult" || !pending.has(entry.message.toolCallId)) break;
			pending.delete(entry.message.toolCallId);
			leaf = entry.id;
		} else if (isTranscriptEntry(entry)) break;
	}
	return leaf;
}

function entryView(entry: SessionEntry, current: ReadonlySet<string>): SessionTreeNode {
	let role: SessionTreeNode["role"] = "other";
	let text = "";
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "user" || message.role === "assistant") role = message.role;
		text = textOf("content" in message ? message.content : undefined);
		if (text === "" && message.role === "assistant") text = "(tool call)";
		if (text === "" && message.role === "toolResult") text = `tool result: ${message.toolName}`;
	} else if (entry.type === "custom_message") {
		// A prompt a collab guest typed is the user speaking; other custom messages are the harness's.
		if (entry.attribution === "user") role = "user";
		text = textOf(entry.content) || entry.customType;
	} else if (entry.type === "custom") {
		text = entry.customType;
	} else {
		text = entry.type;
	}
	const at = Date.parse(entry.timestamp);
	return {
		entryId: entry.id,
		parentId: entry.parentId,
		role,
		preview: preview(text),
		at: Number.isFinite(at) ? at : 0,
		onCurrentBranch: current.has(entry.id),
	};
}

export interface SessionOpsOptions {
	session: AgentSession;
	roomId: string;
	goals: RpcGoalController;
	plan: PlanModeController;
	skills: SkillsService;
	git: GitService;
	registry?: AgentRegistry;
	host?: () => CollabHost | undefined;
	/** Re-broadcasts collab and worker status after a change no session event announces. */
	onStateChanged?: () => void;
	onLiveAudio?(audio: string): void;
	onLiveLevels?(input: number, output: number): void;
	tan?: TanWorkerService;
	omfg?: OmfgWorkerService;
	cleanse?: CleanseWorkerService;
	submitPrompt(text: string, behavior: "steer" | "followUp"): Promise<void>;
}

interface BtwPending {
	resolve(answer: string): void;
	reject(reason: unknown): void;
}

export class SessionOps {
	readonly #session: AgentSession;
	readonly #roomId: string;
	readonly #goals: RpcGoalController;
	readonly #onStateChanged: () => void;
	readonly #plan: PlanModeController;
	readonly #skills: SkillsService;
	readonly #git: GitService;
	readonly #registry: AgentRegistry;
	readonly #btw: RpcBtwController;
	readonly #tan: TanWorkerService | undefined;
	readonly #omfg: OmfgWorkerService | undefined;
	readonly #cleanse: CleanseWorkerService | undefined;
	readonly #getHost: () => CollabHost | undefined;
	readonly #loop: LoopModeController;
	readonly #vibe: VibeModeController;
	readonly #live: LiveModeControllerService;
	readonly #debug: DebugModeService;
	readonly #debugDiagnostics: DebugDiagnosticsService;
	readonly #uiRequestsSeen = new Set<string>();
	readonly #quickReplyCache = new Map<string, Promise<string[]>>();
	#btwPending: BtwPending | undefined;

	constructor(options: SessionOpsOptions) {
		this.#session = options.session;
		this.#roomId = options.roomId;
		this.#goals = options.goals;
		this.#getHost = options.host ?? (() => undefined);
		this.#onStateChanged = options.onStateChanged ?? (() => {});
		this.#plan = options.plan;
		this.#tan = options.tan;
		this.#omfg = options.omfg;
		this.#cleanse = options.cleanse;
		this.#skills = options.skills;
		this.#git = options.git;
		this.#registry = options.registry ?? AgentRegistry.global();
		this.#vibe = new VibeModeController({
			session: options.session,
			submitPrompt: options.submitPrompt,
			onChanged: this.#onStateChanged,
		});
		this.#loop = new LoopModeController({
			session: options.session,
			submitPrompt: text => options.submitPrompt(text, "followUp"),
			onChanged: this.#onStateChanged,
			vibeActive: () => this.#vibe.blocksLoopReset(),
		});
		this.#live = new LiveModeControllerService({
			session: options.session,
			onChanged: this.#onStateChanged,
			...(options.onLiveAudio === undefined ? {} : { onAudio: options.onLiveAudio }),
			...(options.onLiveLevels === undefined ? {} : { onLevels: options.onLiveLevels }),
		});
		this.#debug = new DebugModeService(options.session);
		this.#debugDiagnostics = new DebugDiagnosticsService(options.session);
		this.#btw = new RpcBtwController(options.session, frame => {
			if (frame.type !== "btw_record") return;
			const latest = getBtwLatestTurn(frame.record);
			if (latest.status === "running") return;
			const pending = this.#btwPending;
			if (!pending) return;
			if (latest.status === "complete") pending.resolve(latest.answer);
			else pending.reject(new RequestError("internal", latest.error ?? "The /btw question did not complete."));
		});
	}

	loopMode(): LoopModeStatus {
		return this.#loop.status();
	}

	vibeMode(): VibeModeStatus {
		return this.#vibe.status();
	}

	modeStatus(): { loopMode: LoopModeStatus; vibeMode: VibeModeStatus; liveMode: LiveModeStatus } {
		return { loopMode: this.loopMode(), vibeMode: this.vibeMode(), liveMode: this.liveMode() };
	}

	liveMode(): LiveModeStatus {
		return this.#live.status();
	}

	pushLiveAudio(data: string): void {
		this.#live.pushAudio(data);
	}

	restoreModes(): Promise<void> {
		return this.#vibe.restore();
	}

	/** Stop pressed: an active loop must not submit its next round (omp's TUI Esc pauses the loop the same way). */
	interruptLoop(): void {
		this.#loop.interrupt();
	}

	/** Starts a turn with `text` and resolves once omp admitted it, not when the turn ends. */
	async #startPrompt(text: string, images: Extract<SessionOpV3, { op: "queue" }>["images"]): Promise<void> {
		const admitted = Promise.withResolvers<void>();
		this.#session
			.prompt(text, {
				...(images ? { images } : {}),
				expandPromptTemplates: false,
				runCommands: false,
				userInitiated: true,
				streamingBehavior: "followUp",
				onPromptAdmitted: () => admitted.resolve(),
			})
			.then(
				() => admitted.resolve(),
				error => admitted.reject(new RequestError("internal", error instanceof Error ? error.message : String(error))),
			);
		await admitted.promise;
	}

	prepareForShutdown(): void {
		this.#loop.stopForShutdown();
		this.#vibe.stopForShutdown();
	}

	async run(op: SessionOp | SessionOpV3, signal?: AbortSignal): Promise<SessionOpResult | SessionOpV3Result> {
		switch (op.op) {
			case "pause": {
				if (op.action === "pause") agentPauseGate.pause();
				else if (op.action === "resume") agentPauseGate.resume();
				else if (agentPauseGate.paused) agentPauseGate.resume();
				else agentPauseGate.pause();
				this.#onStateChanged();
				const pausedAt = agentPauseGate.pausedAt;
				return { ok: true, paused: agentPauseGate.paused, ...(pausedAt === undefined ? {} : { pausedAt }) };
			}
			case "queue": {
				const split = splitQueuedMessages(op.text);
				if (split.length === 0 && (op.images?.length ?? 0) === 0) {
					throw new RequestError("bad-request", "queue needs a message or at least one image");
				}
				const messages = split.length > 0 ? split : [""];
				let next = 0;
				// Nothing running and nothing queued: the first message starts a turn now, as omp's TUI /queue does;
				// the rest wait behind it.
				if (!this.#session.isStreaming && !this.#session.isCompacting && this.#session.queuedMessageCount === 0) {
					await this.#startPrompt(messages[0] ?? "", op.images);
					next = 1;
				}
				for (let index = next; index < messages.length; index++) {
					await this.#session.followUp(messages[index] ?? "", index === 0 ? op.images : undefined);
				}
				return { ok: true, queued: messages.length };
			}
			case "collab-status": {
				const host = this.#getHost();
				if (!host) throw new RequestError("conflict", "the omp console room is not ready");
				const participants = host.participants.map(participant => ({
					name: participant.name,
					role: participant.role,
					...(participant.readOnly === undefined ? {} : { readOnly: participant.readOnly }),
				}));
				const status: CollabSessionStatus = { roomId: this.#roomId, participants };
				return { ok: true, ...status };
			}
			case "loop-mode":
				return { ok: true, loopMode: await this.#loop.run(op) };
			case "vibe-mode":
				return { ok: true, vibeMode: await this.#vibe.run(op) };
			case "rewind-points":
				return this.#rewindPoints();
			case "rewind": {
				const result = await this.#rewind(op.entryId);
				this.#onStateChanged();
				return result;
			}
			case "shell":
				return this.#shell(op);
			case "btw":
				return this.#askBtw(op.question, op.recordId);
			case "handoff":
				return this.#handoff(op.focus);
			case "plan-mode":
				await this.#plan.set(op.enabled);
				this.#onStateChanged();
				return { ok: true };
			case "goal":
				await this.#goal(op);
				return { ok: true };
			case "todos":
				this.#todos(op.phases);
				return { ok: true };
			case "compact":
				await this.#compact(op.mode);
				return { ok: true };
			case "approval-mode":
				cfgToolsApprovalMode.override(this.#session.settings, op.mode);
				this.#onStateChanged();
				return { ok: true };
			case "dequeue":
				this.#dequeue(op.index);
				return { ok: true };
			case "stats":
				return { ok: true, stats: this.stats() };
			case "tree":
				return { ok: true, tree: this.tree() };
			case "context":
				return { ok: true, context: this.context() };
			case "ui-requests":
				return this.#uiRequests();
			case "ui-answer":
				return this.#uiAnswer(op.reqId, op.value);
			case "quick-replies":
				return this.#quickReplies(op.entryId);
			case "tan-start":
				if (!this.#tan) throw new RequestError("internal", "Tan service is unavailable");
				return this.#tan.start(op.work);
			case "omfg-generate":
				if (!this.#omfg) throw new RequestError("internal", "OMFG service is unavailable");
				return this.#omfg.generate(op.requestId, op.complaint);
			case "omfg-save":
				if (!this.#omfg) throw new RequestError("internal", "OMFG service is unavailable");
				return this.#omfg.save(op);
			case "omfg-cancel":
				if (!this.#omfg) throw new RequestError("internal", "OMFG service is unavailable");
				return this.#omfg.cancel(op.requestId);
			case "cleanse-discover":
				if (!this.#cleanse) throw new RequestError("internal", "Cleanse service is unavailable");
				return this.#cleanse.discover(op.includeTests);
			case "cleanse-start":
				if (!this.#cleanse) throw new RequestError("internal", "Cleanse service is unavailable");
				return this.#cleanse.start(op);
			case "cleanse-cancel":
				if (!this.#cleanse) throw new RequestError("internal", "Cleanse service is unavailable");
				return this.#cleanse.cancel(op.runId);
			case "cleanse-state":
				if (!this.#cleanse) throw new RequestError("internal", "Cleanse service is unavailable");
				return this.#cleanse.state();
			case "skills-search":
				return { ok: true, skillSearch: await this.#skills.search(op.query) };
			case "skills-installed":
				return { ok: true, installedSkills: await this.#skills.installed() };
			case "skills-install": {
				const result = await this.#skills.install(op.specs, op.global, {
					...(op.approvalId === undefined ? {} : { approvalId: op.approvalId }),
					...(signal === undefined ? {} : { signal }),
				});
				return {
					ok: true,
					skillChanges: result.changes,
					warnings: result.warnings,
					installedSkills: result.installed,
				};
			}
			case "skills-update": {
				const result = await this.#skills.update(op.names, op.global, {
					...(op.approvalId === undefined ? {} : { approvalId: op.approvalId }),
					...(signal === undefined ? {} : { signal }),
				});
				return {
					ok: true,
					skillChanges: result.changes,
					warnings: result.warnings,
					installedSkills: result.installed,
				};
			}
			case "git-view":
				return { ok: true, git: await this.#git.view(op.revision) };
			case "git-diff":
				return { ok: true, gitDiff: await this.#git.diff(op.path, op.area, op.revision) };
			case "git-stage":
				return { ok: true, git: await this.#git.stage(op.action, op.paths) };
			case "git-hunk":
				return {
					ok: true,
					git: await this.#git.applyHunk(op.action, op.path, op.area, op.hunkIndex, op.patchHash),
				};
			case "git-commit":
				return { ok: true, git: await this.#git.commit(op.message) };
			case "live-mode": {
				const liveMode = await this.#live.run(op.action, op.action === "start" ? op.offer : undefined, signal);
				const browserAnswer = op.action === "start" ? this.#live.browserAnswer() : undefined;
				return { ok: true, liveMode, ...(browserAnswer === undefined ? {} : { browserAnswer }) };
			}
			case "debug":
				return this.#debug.run(op, signal);
			case "debug-diagnostics":
				return { ok: true, debugDiagnostic: await this.#debugDiagnostics.run(op.action, op.confirmed, signal) };
			default: {
				const unreachable: never = op;
				throw new RequestError("bad-request", `unknown session operation ${JSON.stringify(unreachable)}`);
			}
		}
	}

	async close(): Promise<void> {
		await Promise.all([
			this.#btw.close(),
			this.#loop.close(),
			this.#vibe.close(),
			this.#live.stop(),
			this.#debug.close(),
			this.#debugDiagnostics.close(),
			Promise.resolve(this.#omfg?.close()),
			this.#cleanse?.close() ?? Promise.resolve(),
		]);
	}

	/** User requests (rewinding re-opens the prompt) and agent answers with prose (rewinding keeps the answer and drops what came after), newest first. */
	#uiRequests(): SessionOpV3Result {
		const pending = this.#getHost()?.pendingGuestUi() ?? [];
		const uiRequests: PendingUiRequest[] = pending.map(request => {
			const { reqId, request: value, at } = request;
			this.#uiRequestsSeen.add(String(reqId));
			const common = { reqId: String(reqId), kind: value.kind, title: value.title, at };
			if (value.kind === "editor") {
				return { ...common, kind: "editor", ...(value.prefill === undefined ? {} : { prefill: value.prefill }) };
			}
			return {
				...common,
				kind: "select",
				options: value.options.map(option =>
					typeof option === "string"
						? { label: option }
						: { label: option.label, ...(option.description === undefined ? {} : { description: option.description }) },
				),
				...(value.initialIndex === undefined ? {} : { initialIndex: value.initialIndex }),
				...(value.checkedIndices === undefined ? {} : { checkedIndices: [...value.checkedIndices] }),
				...(value.markableCount === undefined ? {} : { markableCount: value.markableCount }),
				...(value.helpText === undefined ? {} : { helpText: value.helpText }),
			};
		});
		return { ok: true, uiRequests };
	}

	#uiAnswer(reqId: string, value: string | null): SessionOpV3Result {
		const host = this.#getHost();
		const pending = host?.pendingGuestUi().find(request => String(request.reqId) === reqId);
		if (!pending) {
			if (this.#uiRequestsSeen.has(reqId)) throw new RequestError("conflict", "that question has already been answered or closed");
			throw new RequestError("not-found", "no pending question has that id");
		}
		this.#uiRequestsSeen.add(reqId);
		if (this.#uiRequestsSeen.size > SEEN_UI_REQUEST_LIMIT) {
			const oldest = this.#uiRequestsSeen.values().next().value;
			if (oldest !== undefined) this.#uiRequestsSeen.delete(oldest);
		}
		if (
			value !== null &&
			pending.request.kind === "select" &&
			!pending.request.options.some(option => (typeof option === "string" ? option : option.label) === value)
		) {
			throw new RequestError("bad-request", "select answers must match one of the offered option labels");
		}
		if (!host?.answerGuestUi(pending.reqId, value ?? undefined)) {
			throw new RequestError("conflict", "that question has already been answered or closed");
		}
		return { ok: true };
	}

	async #quickReplies(entryId: string): Promise<SessionOpV3Result> {
		const session = this.#session;
		if (session.isStreaming || session.isCompacting || this.#getHost()?.inputRequired) return { ok: true, replies: [] };
		const branch = session.sessionManager.getBranch();
		const index = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant");
		const entry = branch[index];
		if (index < 0 || !entry || entry.id !== entryId) return { ok: true, replies: [] };
		const answer = agentAnswerText(entry);
		if (!answer) return { ok: true, replies: [] };
		const userRequest = branch
			.slice(0, index)
			.findLast(candidate => candidate.type === "message" && candidate.message.role === "user");
		let generated = this.#quickReplyCache.get(entryId);
		if (!generated) {
			generated = generateQuickReplies(
				session,
				userRequest?.type === "message" ? textOf("content" in userRequest.message ? userRequest.message.content : undefined) : "",
				answer,
			);
			// Only the latest answer is ever asked for: keep a handful, newest last.
			this.#quickReplyCache.set(entryId, generated);
			while (this.#quickReplyCache.size > QUICK_REPLY_CACHE_LIMIT) {
				const oldest = this.#quickReplyCache.keys().next().value;
				if (oldest === undefined) break;
				this.#quickReplyCache.delete(oldest);
			}
			// A failed generation (timeout, no smol model) is not remembered: the next request tries again.
			generated.catch(() => {
				if (this.#quickReplyCache.get(entryId) === generated) this.#quickReplyCache.delete(entryId);
			});
		}
		return { ok: true, replies: [...(await generated.catch(() => []))] };
	}
	#rewindPoints(): SessionOpV3Result {
		const branch = this.#session.sessionManager.getBranch();
		// Bookkeeping (session_exit, model changes) after the last message does not count: the branch "ends" on its last transcript entry.
		const lastId = branch.findLast(entry => isTranscriptEntry(entry))?.id;
		const points: RewindPoint[] = [];
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (!isTranscriptEntry(entry)) continue;
			const at = Date.parse(entry.timestamp);
			const time = Number.isFinite(at) ? at : 0;
			if (isUserRequestEntry(entry)) {
				points.push({ entryId: entry.id, kind: "user", preview: preview(userTurnDraft(entry) ?? ""), at: time });
				continue;
			}
			const answer = agentAnswerText(entry);
			// Rewinding to the answer the session already ends on changes nothing.
			if (answer === undefined || agentRewindLeaf(branch, index) === lastId) continue;
			points.push({ entryId: entry.id, kind: "agent", preview: preview(answer), at: time });
		}
		return { ok: true, points };
	}

	async #rewind(entryId: string): Promise<SessionOpV3Result> {
		const branch = this.#session.sessionManager.getBranch();
		const index = branch.findIndex(candidate => candidate.id === entryId);
		const entry = branch[index];
		if (!entry || !isTranscriptEntry(entry)) throw new RequestError("not-found", "no message at that point on the current branch");
		if (!isUserRequestEntry(entry)) {
			if (agentAnswerText(entry) === undefined) throw new RequestError("not-found", "only user messages and agent answers can be rewound to");
			const leaf = agentRewindLeaf(branch, index);
			await this.#btw.close();
			const result = await this.#session.navigateTree(leaf, { summarize: false });
			if (result.cancelled) throw new RequestError("conflict", "rewind was cancelled");
			return { ok: true, text: "", keptThrough: leaf };
		}
		const draft = userTurnDraft(entry);
		if (draft === undefined) throw new RequestError("not-found", "the selected user message cannot be restored");
		await this.#btw.close();
		const result = await this.#session.navigateTree(entryId, { summarize: false });
		if (result.cancelled) throw new RequestError("conflict", "rewind was cancelled");
		return { ok: true, text: result.editorText ?? draft };
	}

	async #shell(op: Extract<SessionOpV3, { op: "shell" }>): Promise<SessionOpV3Result> {
		if (op.kind === "bash") {
			if (this.#session.isBashRunning) throw new RequestError("conflict", "a bash command is already running");
			const result = await this.#session.executeBash(op.code, undefined, {
				excludeFromContext: op.excludeFromContext,
				useUserShell: true,
				pty: HEADLESS_BASH_PTY,
			});
			return { ok: true, output: result.output, exitCode: result.exitCode };
		}
		if (this.#session.isEvalRunning) throw new RequestError("conflict", "a Python execution is already running");
		const result = await this.#session.executePython(op.code, undefined, { excludeFromContext: op.excludeFromContext });
		return { ok: true, output: result.output, exitCode: result.exitCode };
	}

	/** One side question, or a follow-up in topic `recordId`; returns the topic id so the next follow-up continues it. */
	async #askBtw(question: string, recordId?: string): Promise<SessionOpV3Result> {
		if (this.#btwPending) throw new RequestError("conflict", "a /btw question is still running");
		const pending = Promise.withResolvers<string>();
		this.#btwPending = { resolve: pending.resolve, reject: pending.reject };
		try {
			let record: { id: string };
			try {
				record = await this.#btw.ask(question, recordId);
			} catch (error) {
				if (recordId !== undefined && error instanceof Error && error.message.startsWith("Unknown /btw topic")) {
					throw new RequestError("not-found", "that side-question topic no longer exists; ask a new question");
				}
				throw error;
			}
			return { ok: true, answer: await pending.promise, recordId: record.id };
		} finally {
			this.#btwPending = undefined;
			await this.#btw.close();
		}
	}



	async #goal(op: Extract<SessionOp, { op: "goal" }>): Promise<void> {
		const session = this.#session;
		try {
			switch (op.action) {
				case "set":
					await this.#goals.handle({ op: "create", objective: op.objective, token_budget: op.tokenBudget });
					return;
				case "pause": {
					await this.#goals.settled();
					if (!session.getGoalModeState()?.enabled) throw new RequestError("bad-request", "no active goal to pause");
					await this.#goals.handle({ op: "pause" });
					return;
				}
				case "drop": {
					await this.#goals.settled();
					const state = session.getGoalModeState();
					if (!state || state.goal.status === "complete" || state.goal.status === "dropped") {
						throw new RequestError("bad-request", "no goal to drop");
					}
					await this.#goals.handle({ op: "drop" });
					return;
				}
				case "resume":
					await this.#goals.handle({ op: "resume" });
					return;
				case "budget": {
					await this.#goals.settled();
					const state = session.getGoalModeState();
					if (!state || state.goal.status === "complete" || state.goal.status === "dropped") {
						throw new RequestError("bad-request", "no goal to change the budget of");
					}
					await session.goalRuntime.onBudgetMutated(op.tokenBudget);
					return;
				}
			}
		} catch (error) {
			throw goalError(error);
		}
	}

	#todos(phases: Extract<SessionOp, { op: "todos" }>["phases"]): void {
		if (!Array.isArray(phases)) throw new RequestError("bad-request", "phases must be an array");
		for (const phase of phases) {
			if (!isObject(phase) || typeof phase.name !== "string" || phase.name.trim() === "" || !Array.isArray(phase.tasks)) {
				throw new RequestError("bad-request", "each phase needs a name and a tasks array");
			}
			for (const task of phase.tasks) {
				if (!isObject(task) || typeof task.content !== "string" || task.content.trim() === "" || typeof task.status !== "string") {
					throw new RequestError("bad-request", `phase ${phase.name}: each task needs content and a status`);
				}
				if (!TODO_STATUSES.has(task.status)) throw new RequestError("bad-request", `phase ${phase.name}: unknown task status ${task.status}`);
				if (task.content.length > MAX_TODO_TEXT) throw new RequestError("bad-request", `phase ${phase.name}: task content is too long`);
			}
		}
		const session = this.#session;
		session.setTodoPhases(phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })) })));
		session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: session.getTodoPhases() });
	}

	/**
	 * omp's `/handoff`: the handoff document becomes this session's compaction (so the session that hands off is
	 * compacted, not left at full context) and the same text seeds the session that continues the work.
	 */
	async #handoff(focus: string): Promise<SessionOpV3Result> {
		const session = this.#session;
		if (session.isStreaming || session.isCompacting) {
			throw new RequestError("conflict", "session is busy; a handoff needs an idle session");
		}
		let result: Awaited<ReturnType<AgentSession["handoff"]>>;
		try {
			result = await session.handoff(focus.trim() === "" ? undefined : focus);
		} catch (error) {
			throw new RequestError("conflict", error instanceof Error ? error.message : String(error));
		}
		const document = result?.document.trim() ?? "";
		if (document === "") throw new RequestError("conflict", "the handoff produced no document");
		return { ok: true, document };
	}

	async #compact(mode: Extract<SessionOp, { op: "compact" }>["mode"]): Promise<void> {
		const session = this.#session;
		if (session.isStreaming || session.isCompacting) {
			throw new RequestError("conflict", "session is busy; compaction needs an idle session");
		}
		const options = mode === undefined ? undefined : { mode: mode === "snap" ? ("snapcompact" as const) : mode };
		try {
			await session.compact(undefined, options);
		} catch (error) {
			// Compaction preconditions (nothing to compact, no model) and provider failures are the caller's to read.
			throw new RequestError("conflict", error instanceof Error ? error.message : String(error));
		}
	}

	#dequeue(index: number | undefined): void {
		const session = this.#session;
		if (index === undefined) {
			if (!session.popLastQueuedMessage()) throw new RequestError("not-found", "no queued messages");
			return;
		}
		const queued = session.getQueuedMessages();
		const all = [
			...queued.steering.map(text => ({ text, queue: "steering" as const })),
			...queued.followUp.map(text => ({ text, queue: "followUp" as const })),
		];
		if (!Number.isInteger(index) || index < 0 || index >= all.length) {
			throw new RequestError("not-found", `no queued message at index ${index}`);
		}
		const target = all[index]!;
		if (!session.takeQueuedMessage(target.text, target.queue)) {
			throw new RequestError("conflict", "the queued message was already delivered");
		}
	}

	/** Totals are the main agent's own session; `byAgent` lists every agent of the tree (main included). */
	stats(): SessionStatsView {
		const session = this.#session;
		const stats = session.getSessionStats();
		const usage = session.getContextUsage();
		const byAgent: SessionStatsView["byAgent"] = [];
		for (const ref of this.#registry.list()) {
			if (ref.kind === "advisor") continue;
			if (ref.session) {
				const own = ref.session === session ? stats : ref.session.getSessionStats();
				byAgent.push({ agentId: ref.id, tokens: own.tokens.total, cost: own.cost });
			} else if (ref.history?.metrics) {
				byAgent.push({ agentId: ref.id, tokens: ref.history.metrics.tokens, cost: ref.history.metrics.cost });
			}
		}
		if (!byAgent.some(entry => entry.agentId === MAIN_AGENT_ID)) {
			byAgent.unshift({ agentId: MAIN_AGENT_ID, tokens: stats.tokens.total, cost: stats.cost });
		}
		return {
			tokens: {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				reasoning: stats.tokens.reasoning,
			},
			cost: stats.cost,
			contextTokens: usage?.tokens ?? 0,
			contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
			byAgent,
		};
	}

	tree(): SessionTreeNode[] {
		const manager = this.#session.sessionManager;
		const current = new Set(manager.getBranch().map(entry => entry.id));
		const entries = manager.getEntries();
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		// omp forks only at transcript messages (`AgentSession.fork`); anything else forks at the nearest earlier one.
		const forkPoint = (entry: SessionEntry): string | undefined => {
			if (entry.type === "message") return entry.id;
			let parent = entry.parentId ? byId.get(entry.parentId) : undefined;
			for (let hops = 0; parent && hops < entries.length; hops++) {
				if (parent.type === "message") return parent.id;
				parent = parent.parentId ? byId.get(parent.parentId) : undefined;
			}
			return undefined;
		};
		return entries.map(entry => {
			const view = entryView(entry, current);
			const fork = forkPoint(entry);
			return fork === undefined ? view : { ...view, forkEntryId: fork };
		});
	}

	context(): ContextBreakdownView {
		const breakdown = computeSessionContextBreakdown(this.#session);
		const parts = breakdown.categories.map(category => ({ label: category.label, tokens: category.tokens }));
		return {
			total: parts.reduce((sum, part) => sum + part.tokens, 0),
			window: breakdown.contextWindow,
			parts,
		};
	}
}
