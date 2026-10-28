/**
 * `{t:"usage-sample"}`: one line per finished model request of any agent in the session tree, for the daemon's quota
 * burn estimate. The main agent's requests come from its own session events; every subagent session (at any depth)
 * forwards its raw events on the task observability bus (`task:subagent:event`), so one subscription covers the tree.
 *
 * `tokens` excludes cache reads (they cost a fraction and would swamp the estimate); `provider` and `model` are the
 * ids omp stamped on the assistant message, so a fallback or routed model is reported as what actually served it.
 */
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TASK_SUBAGENT_EVENT_CHANNEL, type SubagentEventPayload } from "@oh-my-pi/pi-coding-agent/task/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { StatusSink } from "./status";

function isEventPayload(data: unknown): data is SubagentEventPayload {
	if (typeof data !== "object" || data === null) return false;
	const payload = data as { id?: unknown; event?: unknown };
	return typeof payload.id === "string" && typeof payload.event === "object" && payload.event !== null;
}

export interface UsageSampleReporterOptions {
	session: AgentSession;
	/** `subagentEventBus ?? eventBus` of the session, as the lifecycle reporter picks it. */
	bus: EventBus;
	sink: StatusSink;
	now?: () => number;
}

export class UsageSampleReporter {
	readonly #sink: StatusSink;
	readonly #now: () => number;
	readonly #unsubscribers: Array<() => void> = [];

	constructor(options: UsageSampleReporterOptions) {
		this.#sink = options.sink;
		this.#now = options.now ?? Date.now;
		this.#unsubscribers.push(
			options.session.subscribe(event => this.#observe(MAIN_AGENT_ID, event)),
			options.bus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				if (isEventPayload(data)) this.#observe(data.id, data.event);
			}),
		);
	}

	#observe(agentId: string, event: AgentSessionEvent): void {
		if (event.type !== "message_end") return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const { input, output, cacheRead, cacheWrite } = message.usage;
		if (!(input + output + cacheRead + cacheWrite > 0)) return;
		this.#sink.emit({
			t: "usage-sample",
			agentId,
			provider: message.provider,
			model: message.model,
			tokens: input + output + cacheWrite,
			cacheReadTokens: cacheRead,
			at: this.#now(),
		});
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
	}
}
