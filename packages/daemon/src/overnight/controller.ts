import type {
	OvernightAutoAnswer,
	OvernightEvent,
	OvernightLastTurn,
	OvernightPhase,
	OvernightPolicy,
	OvernightState,
	OvernightSummary,
	OvernightTemplate,
	WorkerStatus,
} from "@omp-console/protocol";
import { OVERNIGHT_COMPLETE_MARKER } from "@omp-console/protocol";
import { OVERNIGHT_WRAP_UP_PROMPT, renderOvernightContinuationPrompt } from "./prompts";
import type { CrashEvent, Supervisor } from "../supervisor";
import { renderOvernightReport } from "./report";
import { OvernightStore } from "./store";

const TERMINAL: readonly OvernightPhase[] = ["complete", "deadline", "blocked", "stopped"];
const RETRY_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const CONTINUATION_DELAY_MS = 15_000;
const STALL_TIMEOUT_MS = 20 * 60_000;
/** After an accepted stall abort, how long the stream may keep "streaming" before the worker is restarted. */
const STALL_ESCALATE_MS = 2 * 60_000;
/** How long a stall-abort flag waits for the aborted turn's end once the session is no longer streaming. */
const STALL_FLAG_TTL_MS = 60_000;
const RESTART_WINDOW_MS = 60 * 60_000;
const MAX_RESTARTS_PER_HOUR = 5;
const TIMER_MAX_MS = 60_000;
const ACTION_RECHECK_MS = 1000;

type SupervisorPort = Pick<
	Supervisor,
	"get" | "list" | "sendPrompt" | "abort" | "restart" | "setOvernightSummary" | "setOvernightOptions" | "wake"
>;
interface CaffeinateChild {
	kill(signal?: number | NodeJS.Signals): void;
	exited: Promise<number>;
}

export interface OvernightControllerOptions {
	supervisor: SupervisorPort;
	store: OvernightStore;
	notify?: (sessionId: string, phase: "complete" | "deadline" | "blocked", title?: string) => void | Promise<void>;
	now?: () => number;
	log?: (message: string) => void;
	platform?: string;
	spawnCaffeinate?: (args: readonly string[]) => CaffeinateChild;
}

function active(state: OvernightState): boolean {
	return !TERMINAL.includes(state.phase);
}

function keepAwakeCommand(platform: string): readonly string[] | undefined {
	if (platform === "darwin") return ["/usr/bin/caffeinate", "-i", "-s", "-w", String(process.pid)];
	// `tail --pid` ends with the daemon even after SIGKILL, so the inhibitor never outlives it (like caffeinate's -w).
	if (platform === "linux") {
		return ["systemd-inhibit", "--what=idle:sleep", "--who=omp-console", "--why=Overnight run", "--mode=block", "tail", `--pid=${process.pid}`, "-f", "/dev/null"];
	}
	return undefined;
}

function retryableError(text: string): boolean {
	return /stream stalled|overloaded|network|\b5\d\d\b|timed? ?out|ECONN|socket hang up|temporar(?:y|ily)|fetch failed|connection (?:error|reset|closed)|terminated/i.test(text);
}

function usageError(text: string): boolean {
	return /\b429\b|rate[ -]?limit|usage limit|quota|resets? in|resets? at/i.test(text);
}

/** Errors a retry cannot fix: the same prompt will be refused again. */
function fatalError(text: string): boolean {
	return /usage polic|violat|flagged|invalid api key|unauthori[sz]ed|\b401\b|\b403\b|not logged in|no credentials/i.test(text);
}

/**
 * Unclassified error turns in a row (no successful turn between them) before the run is marked blocked. Known
 * transient errors (network, overload, 5xx, rate limits) keep backing off until the deadline instead.
 */
const MAX_UNCLASSIFIED_ERRORS = 3;
const UNCLASSIFIED_RETRY = "Unclassified error; retrying";

function unclassifiedErrors(state: OvernightState): number {
	let errors = 0;
	for (let index = state.events.length - 1; index >= 0; index--) {
		const event = state.events[index]!;
		if (event.kind === "continue" && event.detail.startsWith("Turn ended")) break;
		if (event.kind === "retry-wait" && event.detail.startsWith(UNCLASSIFIED_RETRY)) errors++;
	}
	return errors;
}

function withDeadline(now: number, delayMs: number, deadline: number): number {
	return Math.min(now + Math.max(0, delayMs), deadline);
}

function workerOptions(policy: OvernightPolicy): { askTimeoutSec: number; quiet: OvernightPolicy["quiet"] } {
	return { askTimeoutSec: policy.askTimeoutSec, quiet: policy.quiet };
}
function retryAttempts(state: OvernightState): number {
	let attempts = 0;
	for (let index = state.events.length - 1; index >= 0; index--) {
		const event = state.events[index]!;
		if (event.kind === "continue" && event.detail.startsWith("Turn ended")) break;
		if (event.kind === "retry-wait") attempts++;
	}
	return attempts;
}


/** One persisted state machine per session; all incoming worker events and timer actions are serialized per id. */
export class OvernightController {
	readonly #supervisor: SupervisorPort;
	readonly #store: OvernightStore;
	readonly #notify: NonNullable<OvernightControllerOptions["notify"]>;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	readonly #states = new Map<string, OvernightState>();
	readonly #queues = new Map<string, Promise<void>>();
	readonly #timers = new Map<string, Timer>();
	/** Session id -> when the controller aborted its stalled turn (that turn's end must not read as the user's Stop). */
	readonly #stallAborts = new Map<string, number>();
	/** Active runs loaded from disk that wait for `resume` (their sessions are not restored yet). */
	readonly #awaitingResume = new Set<string>();
	#caffeinate: CaffeinateChild | undefined;
	#keepAwakeUnavailable = false;
	/** Set by `close()`. An action still awaiting persistence when the daemon shuts down must not schedule or prompt. */
	#closed = false;
	readonly #platform: string;
	readonly #spawnCaffeinate: (args: readonly string[]) => CaffeinateChild;

	constructor(options: OvernightControllerOptions) {
		this.#supervisor = options.supervisor;
		this.#store = options.store;
		this.#notify = options.notify ?? (() => {});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => {});
		this.#platform = options.platform ?? process.platform;
		this.#spawnCaffeinate = options.spawnCaffeinate ?? (args =>
			Bun.spawn([...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
		);
	}

	async load(): Promise<void> {
		for (const state of await this.#store.loadStates()) {
			this.#states.set(state.sessionId, state);
			this.#setSummary(state);
			// Sessions are restored after this; acting now would prompt a worker that has no overnight options and
			// that `resume` then restarts, so active runs wait for `reconcile` -> `resume`.
			if (active(state)) this.#awaitingResume.add(state.sessionId);
		}
		await this.#syncKeepAwake();
	}

	get(sessionId: string): OvernightState | undefined {
		const state = this.#states.get(sessionId);
		return state === undefined ? undefined : structuredClone(state);
	}

	states(): OvernightState[] {
		return [...this.#states.values()].map(state => structuredClone(state));
	}

	isActive(sessionId: string): boolean {
		const state = this.#states.get(sessionId);
		return state !== undefined && active(state);
	}

	async start(sessionId: string, policy: OvernightPolicy): Promise<OvernightState> {
		const existing = this.#states.get(sessionId);
		if (existing && active(existing)) throw new Error(`session ${sessionId} already has active overnight state`);
		if (existing) this.#clearTimer(sessionId);
		const state: OvernightState = {
			sessionId,
			startedAt: this.#now(),
			policy: { ...policy },
			phase: "running",
			continuations: 0,
			idleContinuations: 0,
			events: [],
		};
		this.#states.set(sessionId, state);
		await this.#change(state, "start", `Overnight run started; deadline ${policy.deadline}.`);
		return structuredClone(state);
	}

	/** Resume a persisted active controller after its worker has reported ready. */
	async resume(sessionId: string): Promise<void> {
		await this.#enqueue(sessionId, async () => {
			this.#awaitingResume.delete(sessionId);
			const state = this.#states.get(sessionId);
			if (!state || !active(state)) return;
			if (!this.#supervisor.get(sessionId)) {
				await this.#finish(state, "blocked", "An Overnight run could not be restored after the daemon restarted.", "");
				return;
			}
			const previousPhase = state.phase;
			const previousActionAt = state.nextActionAt;
			state.phase = "recovering";
			state.nextActionAt = previousActionAt ?? this.#now();
			this.#event(state, "daemon-resume", "The daemon resumed this Overnight run.");
			await this.#persist(state);
			try {
				await this.#supervisor.restart(sessionId, true, workerOptions(state.policy));
			} catch (error) {
				await this.#finish(state, "blocked", `Worker could not be restored after daemon restart: ${String(error)}`, "");
				return;
			}
			if (
				(previousPhase === "waiting-usage" || previousPhase === "waiting-retry") &&
				previousActionAt !== undefined &&
				previousActionAt > this.#now()
			) {
				state.phase = previousPhase;
				state.nextActionAt = previousActionAt;
				await this.#persist(state);
				this.#schedule(sessionId);
				return;
			}
			await this.#actIfReady(sessionId, state);
		});
	}

	async stop(sessionId: string): Promise<OvernightState | undefined> {
		return this.#enqueue(sessionId, async () => {
			const state = this.#states.get(sessionId);
			if (!state) return undefined;
			if (!active(state)) return structuredClone(state);
			await this.#finish(state, "stopped", "The user stopped the Overnight run.", "");
			return structuredClone(state);
		});
	}

	/** Worker callbacks enqueue synchronously; the supervisor stdout pump never waits on work that needs its replies. */
	onWorkerStatus(sessionId: string, status: WorkerStatus): void {
		if (!this.#states.has(sessionId)) return;
		void this.#enqueue(sessionId, async () => {
			const state = this.#states.get(sessionId);
			if (!state || !active(state)) return;
			switch (status.t) {
				case "auto-answer":
					await this.#autoAnswer(state, status);
					break;
				case "turn-end":
					await this.#turnEnded(sessionId, state, status.lastTurn);
					break;
				case "state":
					await this.#actIfReady(sessionId, state);
					break;
				default:
					break;
			}
			this.#schedule(sessionId);
		}).catch(error => this.#log(`overnight worker event failed for ${sessionId}: ${String(error)}`));
	}

	/** Block an overnight run when its initial task prompt was not admitted to the worker. */
	onInitialPromptFailure(sessionId: string, message: string): void {
		if (!this.#states.has(sessionId)) return;
		void this.#enqueue(sessionId, async () => {
			const state = this.#states.get(sessionId);
			if (!state || !active(state)) return;
			const detail = fatalError(message)
				? `Worker error a retry cannot fix: ${message}`
				: `Initial overnight prompt could not be delivered; no work has started: ${message}`;
			await this.#finish(state, "blocked", detail, "");
		}).catch(error => this.#log(`overnight initial prompt failure handling failed for ${sessionId}: ${String(error)}`));
	}

	/** Called for supervisor crash notifications, including retries performed by the normal worker restart budget. */
	onWorkerCrash(event: CrashEvent): void {
		void this.#enqueue(event.sessionId, async () => {
			const state = this.#states.get(event.sessionId);
			if (!state || !active(state)) return;
			this.#event(state, "error", `Worker crashed: ${event.title ?? event.sessionId}.`);
			const restartCount = this.#restartCount(state);
			if (restartCount >= MAX_RESTARTS_PER_HOUR) {
				await this.#finish(state, "blocked", `Worker restart limit reached (${MAX_RESTARTS_PER_HOUR} in one hour).`, "");
				return;
			}
			if (event.willRestart) {
				this.#event(state, "worker-restart", "Supervisor scheduled a worker restart.");
				state.phase = "recovering";
				state.nextActionAt = this.#now();
				await this.#persist(state);
				return;
			}
			await this.#restartFromSessionFile(event.sessionId, state, "Overnight controller restarting the worker from its session file.");
		}).catch(error => this.#log(`overnight crash recovery failed for ${event.sessionId}: ${String(error)}`));
	}

	async #restartFromSessionFile(sessionId: string, state: OvernightState, detail: string): Promise<void> {
		const attempts = this.#restartCount(state);
		if (attempts >= MAX_RESTARTS_PER_HOUR) {
			await this.#finish(state, "blocked", `Worker restart limit reached (${MAX_RESTARTS_PER_HOUR} in one hour).`, "");
			return;
		}
		this.#event(state, "worker-restart", detail);
		state.phase = "recovering";
		state.nextActionAt = this.#now();
		await this.#persist(state);
		try {
			await this.#supervisor.restart(sessionId, true, workerOptions(state.policy));
		} catch (error) {
			const failures = this.#restartCount(state);
			if (failures >= MAX_RESTARTS_PER_HOUR) {
				await this.#finish(state, "blocked", `Worker restart failed and the restart limit was reached: ${String(error)}`, "");
				return;
			}
			state.phase = "waiting-retry";
			state.nextActionAt = withDeadline(this.#now(), RETRY_BACKOFF_MS[Math.min(failures - 1, RETRY_BACKOFF_MS.length - 1)]!, Date.parse(state.policy.deadline));
			this.#event(state, "retry-wait", `Worker restart failed: ${String(error)}`);
			await this.#persist(state);
		}
		this.#schedule(sessionId);
	}

	#restartCount(state: OvernightState): number {
		return state.events.filter(item => item.kind === "worker-restart" && this.#now() - item.at < RESTART_WINDOW_MS).length;
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
		const child = this.#caffeinate;
		this.#caffeinate = undefined;
		if (child) {
			try {
				child.kill("SIGTERM");
				await child.exited;
			} catch {
				// The child already exited during daemon shutdown.
			}
		}
	}
	async reconcile(): Promise<void> {
		for (const state of this.#states.values()) {
			// `load()` ran before the sessions existed, so their summaries (including finished runs) are applied now.
			this.#setSummary(state);
		}
		for (const state of this.states()) {
			if (!active(state)) continue;
			let summary = this.#supervisor.get(state.sessionId);
			if (summary?.state === "asleep") {
				try {
					await this.#supervisor.wake(state.sessionId);
					summary = this.#supervisor.get(state.sessionId);
				} catch (error) {
					await this.#enqueue(state.sessionId, async () => {
						const current = this.#states.get(state.sessionId);
						if (current && active(current)) {
							await this.#finish(current, "blocked", `Asleep session could not be resumed: ${String(error)}`, "");
						}
					});
					continue;
				}
			}
			if (!summary) {
				await this.#enqueue(state.sessionId, async () => {
					const current = this.#states.get(state.sessionId);
					if (current && active(current)) {
						await this.#finish(current, "blocked", "The session file was not restored after daemon restart.", "");
					}
				});
				continue;
			}
			await this.resume(state.sessionId);
		}
	}


	async #autoAnswer(state: OvernightState, answer: OvernightAutoAnswer): Promise<void> {
		const detail = `${answer.question || "Dialog"} → ${answer.answer}`;
		this.#event(state, "auto-answer", detail, answer.at);
		await this.#persist(state);
	}

	async #turnEnded(sessionId: string, state: OvernightState, turn: OvernightLastTurn): Promise<void> {
		// True when this turn ended because the controller itself aborted a stalled stream.
		const stallAbort = this.#stallAborts.delete(sessionId);
		// The wrap-up turn (prompt already sent) always ends the run as "deadline", even though the wrap-up prompt also
		// asks for the marker. A turn that was already running when the deadline passed can still finish the work.
		const wrapUpTurn = state.phase === "wrapping-up" && state.nextActionAt === undefined;
		if (wrapUpTurn) {
			await this.#finish(state, "deadline", "Overnight deadline passed; wrap-up turn ended.", turn.textTail);
			return;
		}
		if (turn.textTail.includes(OVERNIGHT_COMPLETE_MARKER)) {
			await this.#finish(state, "complete", "Agent reported OVERNIGHT-COMPLETE.", turn.textTail);
			return;
		}
		if (state.phase === "wrapping-up") {
			await this.#actIfReady(sessionId, state);
			return;
		}
		if (this.#now() >= Date.parse(state.policy.deadline)) {
			await this.#beginWrapUp(state);
			return;
		}
		if (turn.stopReason === "aborted" && !stallAbort) {
			// The user pressed Stop (or /abort): honour it instead of continuing behind their back.
			await this.#finish(state, "stopped", "Stopped by the user during an overnight turn.", turn.textTail);
			return;
		}
		if (turn.stopReason === "error") {
			const detail = turn.errorMessage ?? "Worker turn ended with an error.";
			this.#event(state, "error", detail, turn.endedAt);
			if (fatalError(detail)) {
				await this.#finish(state, "blocked", `Worker error a retry cannot fix: ${detail}`, turn.textTail);
				return;
			}
			const known = retryableError(detail) || usageError(detail);
			if (!known && unclassifiedErrors(state) + 1 >= MAX_UNCLASSIFIED_ERRORS) {
				await this.#finish(state, "blocked", `Blocked after ${MAX_UNCLASSIFIED_ERRORS} consecutive unclassified errors; last: ${detail}`, turn.textTail);
				return;
			}
			if (usageError(detail) && turn.retryAfterMs !== undefined) {
				state.phase = "waiting-usage";
				state.nextActionAt = withDeadline(this.#now(), turn.retryAfterMs, Date.parse(state.policy.deadline));
				this.#event(state, "usage-wait", `Usage reset wait: ${Math.max(0, turn.retryAfterMs)} ms.`, turn.endedAt);
			} else {
				const attempt = retryAttempts(state);
				const delay = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!;
				state.phase = "waiting-retry";
				state.nextActionAt = withDeadline(this.#now(), delay, Date.parse(state.policy.deadline));
				this.#event(state, "retry-wait", `${known ? "Retrying" : UNCLASSIFIED_RETRY} after ${Math.ceil(delay / 60_000)} minute(s).`, turn.endedAt);
			}
			await this.#persist(state);
			return;
		}
		if (state.continuations > 0) {
			state.idleContinuations = turn.toolCalls === 0 ? state.idleContinuations + 1 : 0;
			if (state.idleContinuations >= state.policy.maxIdleContinuations) {
				await this.#finish(state, "blocked", `Blocked after ${state.idleContinuations} consecutive continuations with no tool calls.`, turn.textTail);
				return;
			}
		}
		state.phase = "continuing";
		state.nextActionAt = withDeadline(this.#now(), CONTINUATION_DELAY_MS, Date.parse(state.policy.deadline));
		this.#event(state, "continue", `Turn ended with ${turn.toolCalls} tool calls; continuation queued.`, turn.endedAt);
		await this.#persist(state);
	}

	async #beginWrapUp(state: OvernightState): Promise<void> {
		if (!active(state) || state.phase === "wrapping-up") return;
		state.phase = "wrapping-up";
		state.nextActionAt = this.#now();
		this.#event(state, "wrap-up", "Deadline passed; one wrap-up prompt is queued.");
		await this.#persist(state);
		await this.#actIfReady(state.sessionId, state);
	}

	async #actIfReady(sessionId: string, state: OvernightState): Promise<void> {
		if (this.#closed || !active(state) || this.#awaitingResume.has(sessionId)) return;
		const now = this.#now();
		const deadline = Date.parse(state.policy.deadline);
		if (state.phase !== "wrapping-up" && now >= deadline) {
			await this.#beginWrapUp(state);
			return;
		}
		const summary = this.#supervisor.get(sessionId);
		const stallAbortAt = this.#stallAborts.get(sessionId);
		if (summary?.state !== "streaming" && stallAbortAt !== undefined && now - stallAbortAt >= STALL_FLAG_TTL_MS) {
			// The aborted turn's end was never reported; forget the flag so a later user Stop is not misread.
			this.#stallAborts.delete(sessionId);
		}
		if (summary?.state === "streaming" && !summary.paused && now - summary.lastActivityAt >= STALL_TIMEOUT_MS) {
			if (stallAbortAt === undefined) {
				this.#stallAborts.set(sessionId, now);
				this.#event(state, "stall-abort", "No worker event arrived for 20 minutes; abort requested.");
				await this.#persist(state);
				let aborted = false;
				try {
					aborted = await this.#supervisor.abort(sessionId);
				} catch (error) {
					this.#event(state, "error", `Stall abort failed: ${String(error)}`);
				}
				if (!aborted) {
					this.#stallAborts.delete(sessionId);
					await this.#restartFromSessionFile(sessionId, state, "Stall abort failed; restarting the worker from its session file.");
				} else {
					await this.#persist(state);
				}
				return;
			}
			if (now - stallAbortAt >= STALL_ESCALATE_MS) {
				this.#stallAborts.delete(sessionId);
				await this.#restartFromSessionFile(sessionId, state, "Stall abort did not end the turn; restarting the worker from its session file.");
			}
			return;
		}
		if (state.nextActionAt === undefined || state.nextActionAt > now) return;
		if (summary?.state === "crashed") {
			await this.#restartFromSessionFile(sessionId, state, "Retrying worker restart from its session file.");
			return;
		}
		if (summary?.state !== "idle" || summary.awaitingAnswer || summary.paused || summary.frozen) return;
		const wrapUp = state.phase === "wrapping-up";
		const prompt = wrapUp
			? OVERNIGHT_WRAP_UP_PROMPT
			: renderOvernightContinuationPrompt(new Date(deadline).toLocaleString());
		state.nextActionAt = undefined;
		if (!wrapUp) state.phase = "continuing";
		await this.#persist(state);
		try {
			await this.#supervisor.sendPrompt(sessionId, prompt);
			if (!wrapUp) {
				state.continuations++;
				state.phase = "running";
			}
			await this.#persist(state);
		} catch (error) {
			if (wrapUp) {
				await this.#finish(state, "deadline", `Deadline passed; wrap-up prompt failed: ${String(error)}`, "");
				return;
			}
			state.phase = "waiting-retry";
			state.nextActionAt = withDeadline(this.#now(), RETRY_BACKOFF_MS[0]!, deadline);
			this.#event(state, "retry-wait", `Continuation prompt failed: ${String(error)}`);
			await this.#persist(state);
		}
	}

	async #finish(
		state: OvernightState,
		phase: Extract<OvernightPhase, "complete" | "deadline" | "blocked" | "stopped">,
		detail: string,
		finalTextTail: string,
	): Promise<void> {
		state.phase = phase;
		state.nextActionAt = undefined;
		this.#event(state, phase, detail);
		state.report = renderOvernightReport(state, this.#now(), finalTextTail);
		await this.#persist(state);
		this.#clearTimer(state.sessionId);
		try {
			await this.#supervisor.setOvernightOptions(state.sessionId, null);
		} catch (error) {
			this.#log(`could not restore normal ask timeout for ${state.sessionId}: ${String(error)}`);
		}
		if (phase !== "stopped") {
			try {
				await this.#notify(state.sessionId, phase, this.#supervisor.get(state.sessionId)?.title);
			} catch (error) {
				this.#log(`overnight notification failed for ${state.sessionId}: ${String(error)}`);
			}
		}
	}

	async #change(state: OvernightState, kind: OvernightEvent["kind"], detail: string): Promise<void> {
		this.#event(state, kind, detail);
		await this.#persist(state);
		this.#schedule(state.sessionId);
	}

	#event(state: OvernightState, kind: OvernightEvent["kind"], detail: string, at = this.#now()): void {
		state.events.push({ at, kind, detail });
		if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
		this.#setSummary(state);
	}

	async #persist(state: OvernightState): Promise<void> {
		this.#setSummary(state);
		await this.#store.saveState(state);
		await this.#syncKeepAwake();
	}

	#setSummary(state: OvernightState): void {
		const summary: OvernightSummary = {
			phase: state.phase,
			deadline: state.policy.deadline,
			continuations: state.continuations,
		};
		this.#supervisor.setOvernightSummary(state.sessionId, summary);
	}

	#schedule(sessionId: string): void {
		const state = this.#states.get(sessionId);
		this.#clearTimer(sessionId);
		if (this.#closed || !state || !active(state)) return;
		const summary = this.#supervisor.get(sessionId);
		const now = this.#now();
		const deadline = Date.parse(state.policy.deadline);
		let target = Number.POSITIVE_INFINITY;
		if (state.nextActionAt !== undefined) {
			if (state.nextActionAt > now) target = state.nextActionAt;
			else {
				const ready = summary?.state === "idle" && !summary.awaitingAnswer && !summary.paused && !summary.frozen;
				target = ready ? now : now + ACTION_RECHECK_MS;
			}
		}
		if (state.phase !== "wrapping-up") {
			target = now >= deadline ? now : Math.min(target, deadline);
		}
		if (summary?.state === "streaming" && !summary.paused) {
			const stallAbortAt = this.#stallAborts.get(sessionId);
			target = Math.min(target, stallAbortAt === undefined ? summary.lastActivityAt + STALL_TIMEOUT_MS : stallAbortAt + STALL_ESCALATE_MS);
		}
		if (!Number.isFinite(target)) return;
		const delay = Math.max(0, Math.min(TIMER_MAX_MS, target - now));
		const timer = setTimeout(() => {
			this.#timers.delete(sessionId);
			void this.#enqueue(sessionId, async () => {
				const current = this.#states.get(sessionId);
				if (!current || !active(current)) return;
				await this.#actIfReady(sessionId, current);
				this.#schedule(sessionId);
			}).catch(error => this.#log(`overnight timer failed for ${sessionId}: ${String(error)}`));
		}, delay);
		timer.unref();
		this.#timers.set(sessionId, timer);
	}

	#clearTimer(sessionId: string): void {
		const timer = this.#timers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.#timers.delete(sessionId);
	}

	#enqueue<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(sessionId) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(action);
		const tracked = current.then(() => {}, () => {});
		this.#queues.set(sessionId, tracked);
		return current.finally(() => {
			if (this.#queues.get(sessionId) === tracked) this.#queues.delete(sessionId);
		});
	}

	async #syncKeepAwake(): Promise<void> {
		const command = keepAwakeCommand(this.#platform);
		const needed = command !== undefined && [...this.#states.values()].some(state => active(state) && state.policy.keepAwake);
		if (!needed && this.#caffeinate) {
			const child = this.#caffeinate;
			this.#caffeinate = undefined;
			try {
				child.kill("SIGTERM");
				await child.exited;
			} catch {
				// Already exited.
			}
			return;
		}
		if (needed && command !== undefined && !this.#caffeinate && !this.#keepAwakeUnavailable) {
			try {
				const child = this.#spawnCaffeinate(command);
				const startedAt = Date.now();
				this.#caffeinate = child;
				void child.exited.then(code => {
					if (this.#caffeinate !== child) return;
					this.#caffeinate = undefined;
					// An inhibitor that dies at once (e.g. polkit "Access denied" without a login session) would fail the
					// same way on every retry; stop trying for this daemon run.
					if (Date.now() - startedAt < 10_000) this.#keepAwakeUnavailable = true;
					this.#log(`keep-awake inhibitor exited with code ${code}; overnight runs continue without keep-awake protection`);
				}, () => {});
			} catch (error) {
				this.#log(`could not start keep-awake inhibitor: ${String(error)}`);
			}
		}
	}
}

export function overnightWorkerOptions(policy: OvernightPolicy): { askTimeoutSec: number; quiet: OvernightPolicy["quiet"] } {
	return workerOptions(policy);
}

export function overnightSummary(state: OvernightState): OvernightSummary {
	return { phase: state.phase, deadline: state.policy.deadline, continuations: state.continuations };
}

export function isTerminalOvernightState(state: OvernightState): boolean {
	return TERMINAL.includes(state.phase);
}

export function overnightTemplatePolicy(template: OvernightTemplate): Omit<OvernightPolicy, "deadline"> & { deadlineLocalTime: string } {
	return { ...template.policy };
}
