import type { SessionOpV3, VibeModeStatus } from "@omp-console/protocol";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { VibeSessionRegistry, type VibeOwnerScope, type VibeParentSession } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { RequestError } from "./request-error";

type VibeModeOp = Extract<SessionOpV3, { op: "vibe-mode" }>;
type PromptBehavior = "steer" | "followUp";

function persistedToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const names: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return undefined;
		names.push(entry);
	}
	return names;
}

export interface VibeModeControllerOptions {
	session: AgentSession;
	submitPrompt(text: string, behavior: PromptBehavior): Promise<void>;
	onChanged(): void;
}

/** Headless `/vibe` transitions over AgentSession's real restricted tools and VibeSessionRegistry. */
export class VibeModeController {
	readonly #session: AgentSession;
	readonly #submitPrompt: (text: string, behavior: PromptBehavior) => Promise<void>;
	readonly #onChanged: () => void;
	readonly #registry = VibeSessionRegistry.global();
	readonly #unsubscribeSessionChange: () => void;
	#active = false;
	#entering = false;
	#previousTools: string[] | undefined;
	#ownerScope: VibeOwnerScope | undefined;
	#closed = false;
	#tail: Promise<void> = Promise.resolve();

	constructor(options: VibeModeControllerOptions) {
		this.#session = options.session;
		this.#submitPrompt = options.submitPrompt;
		this.#onChanged = options.onChanged;
		this.#unsubscribeSessionChange = this.#session.registerSessionChangeCallback(() => {
			void this.#enqueue(() => this.#reconcile());
		});
	}

	status(): VibeModeStatus {
		return { active: this.#active, workers: this.#registry.listIdsByOwner(this.#session.getAgentId() ?? MAIN_AGENT_ID) };
	}
	blocksLoopReset(): boolean {
		return this.#active || this.#entering;
	}

	restore(): Promise<void> {
		return this.#enqueue(() => this.#reconcile());
	}

	run(op: VibeModeOp): Promise<VibeModeStatus> {
		const activeAtDispatch = this.#active || this.#session.getVibeModeState()?.enabled === true;
		return this.#enqueue(async () => {
			if (op.action === "status") return this.status();
			if (op.action === "disable") {
				if (this.#active) await this.#exit();
				return this.status();
			}
			if (op.action !== "toggle") return this.status();
			if (activeAtDispatch) {
				if (this.#active) await this.#exit();
				return this.status();
			}
			if (!this.#active) await this.#enter();
			const prompt = op.args?.trim();
			if (prompt) await this.#submitPrompt(prompt, this.#session.isStreaming ? "steer" : "followUp");
			return this.status();
		});
	}

	/** Prevent new transitions before the worker aborts its current turn. Vibe stays selected for rehydration. */
	stopForShutdown(): void {
		this.#closed = true;
		this.#unsubscribeSessionChange();
	}

	async close(): Promise<void> {
		this.stopForShutdown();
		await this.#tail;
		if (this.#ownerScope) {
			await this.#registry.suspendScope(this.#ownerScope, this.#session.asyncJobManager);
			this.#onChanged();
		}
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(() => undefined, () => undefined);
		return result;
	}

	async #reconcile(): Promise<void> {
		const context = this.#session.sessionManager.buildSessionContext();
		const parent = this.#parentSession();
		const targetScope = this.#registry.ownerScope(parent);
		const previousScope = this.#ownerScope;
		const hadVibe = this.#active || this.#session.getVibeModeState()?.enabled === true;
		const preserveVibe =
			hadVibe &&
			context.mode === "vibe" &&
			previousScope?.ownerId === targetScope.ownerId &&
			previousScope.parentSessionId === targetScope.parentSessionId &&
			previousScope.parentSessionFile === targetScope.parentSessionFile;
		const lostVibeToolset = hadVibe && !preserveVibe;

		if (lostVibeToolset) {
			await this.#session.removeVibeToolsPreservingActive();
			this.#session.setVibeModeState(undefined);
			this.#active = false;
			this.#previousTools = undefined;
			this.#ownerScope = undefined;
			if (previousScope) await this.#registry.suspendScope(previousScope, this.#session.asyncJobManager);
		}

		await this.#registry.rehydrate(parent);
		if (context.mode === "vibe" && !preserveVibe) {
			await this.#enter({
				persistModeChange: false,
				previousTools: lostVibeToolset ? persistedToolNames(context.modeData?.previousTools) : undefined,
			});
		}
		this.#onChanged();
	}

	async #enter(options?: { persistModeChange?: boolean; previousTools?: string[] }): Promise<void> {
		if (this.#active) return;
		this.#entering = true;
		try {
			const plan = this.#session.getPlanModeState();
			if (plan?.enabled) throw new RequestError("bad-request", "Exit plan mode first.");
			const goal = this.#session.getGoalModeState();
			if (goal?.enabled || goal?.goal?.status === "paused") throw new RequestError("bad-request", "Exit goal mode first.");

			const parent = this.#parentSession();
			const scope = this.#registry.ownerScope(parent);
			this.#registry.activateScope(scope);
			const previousTools = options?.previousTools ?? this.#session.getEnabledToolNames();
			const baseTools = ["read"];
			if (this.#session.hasBuiltInTool("todo")) baseTools.push("todo");
			await this.#session.activateVibeTools(baseTools);
			this.#previousTools = previousTools;
			this.#ownerScope = scope;
			this.#active = true;
			this.#session.setVibeModeState({ enabled: true });
			if (this.#session.isStreaming) await this.#session.sendVibeModeContext({ deliverAs: "steer" });
			if (options?.persistModeChange !== false) this.#session.sessionManager.appendModeChange("vibe", { previousTools });
			this.#onChanged();
		} finally {
			this.#entering = false;
		}
	}

	async #exit(): Promise<void> {
		if (!this.#active) return;
		const scope = this.#ownerScope;
		await this.#session.runModeExitTeardown(async () => {
			if (this.#session.isStreaming) await this.#session.abort();
			await this.#registry.killAll(this.#parentSession(), scope);
			await this.#session.deactivateVibeTools(this.#previousTools ?? []);
			this.#session.setVibeModeState(undefined);
		});
		this.#active = false;
		this.#previousTools = undefined;
		this.#ownerScope = undefined;
		this.#onChanged();
	}

	#parentSession(): VibeParentSession {
		return {
			getAgentId: () => this.#session.getAgentId() ?? null,
			getSessionId: () => this.#session.sessionManager.getSessionId(),
			getSessionFile: () => this.#session.sessionManager.getSessionFile() ?? null,
			sessionManager: this.#session.sessionManager,
			asyncJobManager: this.#session.asyncJobManager,
			settings: this.#session.settings,
			getActiveModelString: () => {
				const model = this.#session.model;
				return model ? `${model.provider}/${model.id}` : undefined;
			},
		};
	}
}
