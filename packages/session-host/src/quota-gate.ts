/**
 * `quota-policy`: the daemon's flow-control decision, enforced inside the worker through omp's own extension events.
 *
 *  - `before_subagent_spawn` fires in the spawning session before a child resolves its model. When the spawning agent
 *    is the MAIN agent and the provider the child would run on is not admitted, the handler does not return until a
 *    later policy admits that provider, so the `task` call simply stays pending ("held by flow control"). Children of
 *    running subagents are different agents (`ctx.agent.kind === "sub"`) and never wait here: holding them would
 *    deadlock a subtree whose root already holds a slot.
 *  - `before_agent_start` fires before a prompt reaches the provider. With `holdPrompts` for the main agent's
 *    provider, the handler posts a visible session notice and waits the same way.
 *
 * omp caps every extension handler at 30 s (`EXTENSION_HANDLER_TIMEOUT_MS`) and treats a timed-out handler as if it
 * had returned nothing, which would let a held spawn through. While any provider is restricted, the cap is therefore
 * raised for the worker process (the only exported seam is `testSetExtensionHandlerTimeoutMs`) and restored once the
 * policy admits everything and nothing waits. A handler armed under the raised cap keeps it.
 */
import type { WorkerCommand } from "@omp-console/protocol";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

export type QuotaProviderPolicy = Extract<WorkerCommand, { t: "quota-policy" }>["providers"][number];

/** Longest a held spawn or prompt waits; far beyond any usage window the daemon pauses for. */
export const HOLD_HANDLER_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type HoldKind = "spawn" | "prompt";

interface Waiter {
	provider: string;
	kind: HoldKind;
	settle(outcome: "admitted" | "cancelled"): void;
}

export class QuotaGate {
	#policy = new Map<string, QuotaProviderPolicy>();
	readonly #waiters = new Set<Waiter>();
	#cancelled = false;
	#frozen = false;

	/** A frozen session (a move in progress) holds every prompt and spawn regardless of provider. */
	get frozen(): boolean {
		return this.#frozen;
	}

	setFrozen(frozen: boolean): void {
		this.#frozen = frozen;
		for (const waiter of [...this.#waiters]) {
			if (!this.#blocked(waiter.provider, waiter.kind)) waiter.settle("admitted");
		}
		this.#syncHandlerTimeout();
	}

	/** Replace the whole policy (providers it does not list are admitted) and release every waiter it now admits. */
	update(providers: readonly QuotaProviderPolicy[]): void {
		this.#policy = new Map(providers.map(entry => [entry.provider, entry]));
		for (const waiter of [...this.#waiters]) {
			if (!this.#blocked(waiter.provider, waiter.kind)) waiter.settle("admitted");
		}
		this.#syncHandlerTimeout();
	}

	#blocked(provider: string, kind: HoldKind): boolean {
		if (this.#frozen) return true;
		const entry = this.#policy.get(provider);
		if (!entry) return false;
		return kind === "spawn" ? !entry.admitSpawns : entry.holdPrompts;
	}

	/** Whether new top-level spawns on `provider` are held now. */
	holdsSpawns(provider: string | undefined): boolean {
		return this.#frozen || (provider !== undefined && this.#blocked(provider, "spawn"));
	}

	/** Whether new prompts for `provider` are held now. */
	holdsPrompts(provider: string | undefined): boolean {
		return this.#frozen || (provider !== undefined && this.#blocked(provider, "prompt"));
	}

	reason(provider: string | undefined): string | undefined {
		if (this.#frozen) return "the session is frozen while it is moved";
		return provider === undefined ? undefined : this.#policy.get(provider)?.reason;
	}

	/** Waiters currently parked (spawns and prompts). */
	get waiting(): number {
		return this.#waiters.size;
	}

	/**
	 * Resolves when `provider` is admitted for `kind`, immediately when it already is, or with `cancelled` when the
	 * gate is cancelled (worker stop, abort). A policy that flips back to blocking between the wake-up and the caller
	 * resuming parks the caller again.
	 */
	async wait(provider: string, kind: HoldKind): Promise<"admitted" | "cancelled"> {
		while (this.#blocked(provider, kind)) {
			if (this.#cancelled) return "cancelled";
			const settled = Promise.withResolvers<"admitted" | "cancelled">();
			const waiter: Waiter = { provider, kind, settle: outcome => settled.resolve(outcome) };
			this.#waiters.add(waiter);
			this.#syncHandlerTimeout();
			let outcome: "admitted" | "cancelled";
			try {
				outcome = await settled.promise;
			} finally {
				this.#waiters.delete(waiter);
				this.#syncHandlerTimeout();
			}
			if (outcome === "cancelled") return "cancelled";
		}
		return "admitted";
	}

	/** Release every waiter without admitting it (an abort of the turn, or the worker stopping). */
	cancelWaiters(): void {
		for (const waiter of [...this.#waiters]) waiter.settle("cancelled");
	}

	/** Worker stop: release waiters and refuse to park new ones. */
	close(): void {
		this.#cancelled = true;
		this.cancelWaiters();
		this.#policy.clear();
		this.#syncHandlerTimeout();
	}

	#restricted(): boolean {
		if (this.#frozen) return true;
		for (const entry of this.#policy.values()) if (!entry.admitSpawns || entry.holdPrompts) return true;
		return this.#waiters.size > 0;
	}

	#syncHandlerTimeout(): void {
		testSetExtensionHandlerTimeoutMs(this.#restricted() ? HOLD_HANDLER_TIMEOUT_MS : EXTENSION_HANDLER_TIMEOUT_MS);
	}
}

export interface QuotaExtensionOptions {
	gate: QuotaGate;
	settings: Settings;
	/** Posts the visible notice a held prompt shows. */
	notice(message: string): void;
}

/** The in-process extension that registers both handlers; pass it to `createAgentSession({ extensions })`. */
export function createQuotaExtension(options: QuotaExtensionOptions): ExtensionFactory {
	const { gate, settings, notice } = options;
	return pi => {
		pi.on("before_subagent_spawn", async (event, ctx) => {
			if (ctx.agent.kind !== "main") return undefined;
			// The first pattern core would spawn with decides the provider; an agent without a model override runs on the
			// parent's model.
			const resolved = resolveModelOverride(event.patterns, ctx.modelRegistry, settings).model;
			const provider = (resolved ?? ctx.model)?.provider;
			if (!gate.holdsSpawns(provider)) return undefined;
			// A cancelled hold (the turn was aborted, the worker is stopping) must not let the spawn through.
			if ((await gate.wait(provider ?? "*", "spawn")) === "cancelled") {
				return { block: true, reason: `Spawn on ${provider ?? "this session"} was held and cancelled.` };
			}
			return undefined;
		});
		pi.on("before_agent_start", async (_event, ctx) => {
			if (ctx.agent.kind !== "main") return undefined;
			const provider = ctx.model?.provider;
			if (!gate.holdsPrompts(provider)) return undefined;
			const reason = gate.reason(provider);
			notice(
				gate.frozen
					? `Prompt held: ${reason}. It starts when the session is unfrozen.`
					: `Prompt held by flow control (${provider})${reason ? `: ${reason}` : ""}. It starts when the policy admits ${provider}.`,
			);
			await gate.wait(provider ?? "*", "prompt");
		});
	};
}
