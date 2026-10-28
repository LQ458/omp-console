/**
 * Subagent lifecycle for the daemon: every `started` / `completed` / `failed` / `aborted` transition on omp's task
 * lifecycle bus (`task:subagent:lifecycle`, published on the session tree's observability bus at any spawn depth)
 * becomes one `{t:"agent"}` status line. The daemon's draft-plan runner follows plans from these lines without a
 * guest connection.
 *
 * `parentId` comes from the agent registry. `summary` (terminal states only) is the first lines of the agent's
 * result or error; the lifecycle payload itself carries no result, so it is read from the background job that ran
 * the spawn, after that job settled. Lines of one agent keep their order: a terminal line waits for its summary.
 */
import type { WorkerStatus } from "@omp-console/protocol";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentLifecyclePayload } from "@oh-my-pi/pi-coding-agent/task/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { StatusSink } from "./status";
import { firstLines, unwrapTaskResult } from "./summary";

export type AgentStatusLine = Extract<WorkerStatus, { t: "agent" }>;

/** Longest a terminal line waits for the job result that supplies its summary. */
const SUMMARY_WAIT_MS = 2000;
const SUMMARY_LINES = 3;
const SUMMARY_CHARS = 400;

function isLifecyclePayload(data: unknown): data is SubagentLifecyclePayload {
	if (typeof data !== "object" || data === null) return false;
	const payload = data as { id?: unknown; agent?: unknown; status?: unknown };
	return (
		typeof payload.id === "string" &&
		typeof payload.agent === "string" &&
		(payload.status === "started" ||
			payload.status === "completed" ||
			payload.status === "failed" ||
			payload.status === "aborted")
	);
}

export interface AgentLifecycleReporterOptions {
	/** `subagentEventBus ?? eventBus` of the session, as the collab host picks it. */
	bus: EventBus;
	registry: AgentRegistry;
	session: AgentSession;
	sink: StatusSink;
}

export class AgentLifecycleReporter {
	readonly #registry: AgentRegistry;
	readonly #session: AgentSession;
	readonly #sink: StatusSink;
	readonly #unsubscribe: () => void;
	readonly #chains = new Map<string, Promise<void>>();
	#disposed = false;

	constructor(options: AgentLifecycleReporterOptions) {
		this.#registry = options.registry;
		this.#session = options.session;
		this.#sink = options.sink;
		this.#unsubscribe = options.bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			if (isLifecyclePayload(data)) this.#enqueue(data);
		});
	}

	#enqueue(payload: SubagentLifecyclePayload): void {
		const previous = this.#chains.get(payload.id) ?? Promise.resolve();
		const next = previous
			.then(() => this.#emit(payload))
			.catch(error => logger.warn("agent lifecycle line failed", { agent: payload.id, error: String(error) }))
			.finally(() => {
				if (this.#chains.get(payload.id) === next) this.#chains.delete(payload.id);
			});
		this.#chains.set(payload.id, next);
	}

	async #emit(payload: SubagentLifecyclePayload): Promise<void> {
		const terminal = payload.status !== "started";
		const summary = terminal ? await this.#summary(payload.id) : undefined;
		if (this.#disposed) return;
		const parentId = this.#registry.get(payload.id)?.parentId;
		const line: AgentStatusLine = {
			t: "agent",
			agentId: payload.id,
			profile: payload.agent,
			status: payload.status,
		};
		if (parentId !== undefined) line.parentId = parentId;
		if (summary !== undefined) line.summary = summary;
		this.#sink.emit(line);
	}

	async #summary(agentId: string): Promise<string | undefined> {
		const manager = this.#session.asyncJobManager;
		const job = manager?.getJob(agentId) ?? manager?.getAllJobs().find(candidate => candidate.agentId === agentId);
		if (!job) return undefined;
		const timer = Promise.withResolvers<void>();
		const handle = setTimeout(timer.resolve, SUMMARY_WAIT_MS);
		try {
			await Promise.race([job.promise.catch(() => {}), timer.promise]);
		} finally {
			clearTimeout(handle);
		}
		const text = job.status === "completed" ? job.resultText : (job.errorText ?? job.resultText);
		return firstLines(unwrapTaskResult(text), SUMMARY_LINES, SUMMARY_CHARS);
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
	}
}
