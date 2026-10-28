import type { LoopModeStatus, SessionOpV3 } from "@omp-console/protocol";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgLoopConditionTimeoutMs, cfgLoopMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	isLoopLimitExhausted,
	parseLoopArgs,
	type LoopLimitConfig,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import { describeLoopCondition, evaluateLoopCondition } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { LoopLimitRuntime, LoopConditionConfig } from "@oh-my-pi/pi-tui/status-line/loop";
import { isUserRequestEntry, userTurnDraft } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { RequestError } from "./request-error";

const AUTO_SUBMIT_DELAY_MS = 800;

type LoopModeOp = Extract<SessionOpV3, { op: "loop-mode" }>;
type LoopEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
			const block = part as Record<string, unknown>;
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join(" ")
		.trim();
}

function latestUserPrompt(session: AgentSession): { entryId: string; text: string } | undefined {
	const branch = session.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if ((entry.type !== "message" && entry.type !== "custom_message") || !isUserRequestEntry(entry)) continue;
		const text = userTurnDraft(entry)?.trim();
		if (text) return { entryId: entry.id, text };
	}
	return undefined;
}

function failedTurn(event: LoopEndEvent): boolean {
	return event.messages.some(
		message => message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error"),
	);
}

export interface LoopModeControllerOptions {
	session: AgentSession;
	submitPrompt(text: string): Promise<void>;
	onChanged(): void;
	vibeActive(): boolean;
}

/** Headless `/loop` controller. Loop progress is process-local and deliberately clears on worker restart. */
export class LoopModeController {
	readonly #session: AgentSession;
	readonly #submitPrompt: (text: string) => Promise<void>;
	readonly #onChanged: () => void;
	readonly #vibeActive: () => boolean;
	readonly #unsubscribe: () => void;
	#active = false;
	#iteration = 0;
	#prompt: string | undefined;
	#lastUserEntryId: string | undefined;
	#limit: LoopLimitRuntime | undefined;
	#limitConfig: LoopLimitConfig | undefined;
	#condition: LoopConditionConfig | undefined;
	#conditionAbort: AbortController | undefined;
	#timer: Timer | undefined;
	#processing = false;
	#generation = 0;
	#closed = false;
	#message: string | undefined;

	constructor(options: LoopModeControllerOptions) {
		this.#session = options.session;
		this.#submitPrompt = options.submitPrompt;
		this.#onChanged = options.onChanged;
		this.#vibeActive = options.vibeActive;
		this.#unsubscribe = this.#session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "user") this.#onUserMessage(event.message.content);
			if (event.type === "agent_end" && event.isTerminal !== false) this.#scheduleAfterTurn(event);
		});
	}

	status(): LoopModeStatus {
		return {
			active: this.#active,
			iteration: this.#iteration,
			limit: this.#limitConfig ? describeLoopLimit(this.#limitConfig) : undefined,
			condition: this.#condition ? describeLoopCondition(this.#condition) : undefined,
			waitingForPrompt: this.#active && this.#prompt === undefined,
			message: this.#message,
		};
	}

	async run(op: LoopModeOp): Promise<LoopModeStatus> {
		if (op.action === "status") return this.status();
		if (op.action === "disable") {
			this.#disable("Loop mode disabled.");
			return this.status();
		}
		if (this.#active) {
			this.#disable("Loop mode disabled.");
			return this.status();
		}
		if (op.action !== "toggle") return this.status();

		const parsed = parseLoopArgs(op.args ?? "");
		if (typeof parsed === "string") throw new RequestError("bad-request", parsed);
		this.#lastUserEntryId = latestUserPrompt(this.#session)?.entryId;
		this.#active = true;
		this.#iteration = 0;
		this.#prompt = undefined;
		this.#limitConfig = parsed.limit;
		this.#limit = createLoopLimitRuntime(parsed.limit);
		this.#condition = parsed.condition;
		this.#message = undefined;
		this.#generation++;
		this.#onChanged();

		if (parsed.prompt) {
			this.#prompt = parsed.prompt;
			try {
				await this.#submitPrompt(parsed.prompt);
			} catch (error) {
				this.#disable(errorMessage(error));
				throw error;
			}
		}
		return this.status();
	}

	stopForShutdown(): void {
		this.#closed = true;
		this.#disable("Loop mode cleared when the worker stopped.");
		this.#unsubscribe();
	}

	/** Stop pressed between rounds: cancel the pending resubmit and any running condition check, and leave loop mode. */
	interrupt(): void {
		if (this.#active) this.#disable("Loop stopped.");
	}

	async close(): Promise<void> {
		this.stopForShutdown();
	}

	#onUserMessage(content: unknown): void {
		if (!this.#active || this.#closed) return;
		const prompt = textOf(content);
		if (prompt === "") return;
		this.#lastUserEntryId = latestUserPrompt(this.#session)?.entryId ?? this.#lastUserEntryId;
		this.#prompt = prompt;
		this.#generation++;
		this.#cancelTimer();
		this.#abortCondition();
		this.#onChanged();
	}

	#scheduleAfterTurn(event: LoopEndEvent): void {
		if (!this.#active || this.#closed) return;
		const generation = this.#generation;
		this.#cancelTimer();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#afterTurn(generation, event);
		}, AUTO_SUBMIT_DELAY_MS);
	}

	async #afterTurn(generation: number, event: LoopEndEvent): Promise<void> {
		if (!this.#isCurrent(generation) || this.#processing) return;
		if (failedTurn(event)) {
			this.#disable("Loop stopped because the turn was aborted or failed.");
			return;
		}
		const latest = latestUserPrompt(this.#session);
		if (latest && latest.entryId !== this.#lastUserEntryId) {
			this.#lastUserEntryId = latest.entryId;
			this.#prompt = latest.text;
		}
		const prompt = this.#prompt;
		if (!prompt) return;
		if (this.#isBusy()) {
			this.#scheduleAfterTurn(event);
			return;
		}

		this.#processing = true;
		try {
			if (isLoopLimitExhausted(this.#limit)) {
				this.#disable("Loop limit reached.");
				return;
			}
			const action = cfgLoopMode.get(this.#session.settings);
			if (action === "reset" && this.#vibeActive()) {
				this.#disable("Exit Vibe mode before using reset loops.");
				return;
			}

			if (this.#condition) {
				const controller = new AbortController();
				this.#abortCondition();
				this.#conditionAbort = controller;
				const verdict = await evaluateLoopCondition(this.#condition, {
					cwd: this.#session.sessionManager.getCwd(),
					timeoutMs: cfgLoopConditionTimeoutMs.get(this.#session.settings),
					signal: controller.signal,
					sessionId: this.#session.sessionManager.getSessionId(),
				});
				if (this.#conditionAbort === controller) this.#conditionAbort = undefined;
				if (!this.#isCurrent(generation) || this.#prompt !== prompt) return;
				if (verdict.kind === "aborted") return;
				if (verdict.kind !== "continue") {
					this.#disable(verdict.message);
					return;
				}
			}
			if (action === "reset" && this.#vibeActive()) {
				this.#disable("Exit vibe mode before using reset loops. Loop mode disabled.");
				return;
			}

			if (!this.#isCurrent(generation) || this.#prompt !== prompt) return;
			if (this.#isBusy()) {
				this.#scheduleAfterTurn(event);
				return;
			}
			if (!consumeLoopLimitIteration(this.#limit)) {
				this.#disable("Loop limit reached.");
				return;
			}
			this.#iteration++;
			this.#onChanged();

			if (action === "compact") await this.#session.compact();
			if (action === "reset") {
				const reset = await this.#session.newSession();
				if (!reset) {
					this.#disable("Loop stopped because the session reset was cancelled.");
					return;
				}
			}
			if (action === "reset" && this.#vibeActive()) {
				this.#disable("Exit vibe mode before using reset loops. Loop mode disabled.");
				return;
			}
			if (!this.#isCurrent(generation) || this.#prompt !== prompt) return;
			await this.#submitPrompt(prompt);
		} catch (error) {
			this.#disable(`Loop stopped: ${errorMessage(error)}`);
		} finally {
			this.#processing = false;
		}
	}

	#isCurrent(generation: number): boolean {
		return this.#active && !this.#closed && this.#generation === generation;
	}

	#isBusy(): boolean {
		return this.#session.isStreaming || this.#session.isCompacting || this.#session.hasPostPromptWork;
	}

	#disable(message: string): void {
		const wasActive = this.#active;
		this.#active = false;
		this.#prompt = undefined;
		this.#limitConfig = undefined;
		this.#limit = undefined;
		this.#condition = undefined;
		this.#message = wasActive ? message : this.#message;
		this.#generation++;
		this.#cancelTimer();
		this.#abortCondition();
		if (wasActive) this.#onChanged();
	}

	#cancelTimer(): void {
		if (!this.#timer) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#abortCondition(): void {
		this.#conditionAbort?.abort();
		this.#conditionAbort = undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
