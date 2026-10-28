/**
 * `spawn-agent` (spec 2.5): spawn a subagent of a chosen profile with a task, from the GUI, without asking the main
 * model. The worker runs omp's own `task` tool (`TaskTool.execute`), so spawn policy, `task.disabledAgents`, the
 * isolation setting, model resolution, the registry entry and the lifecycle events are exactly what a model-issued
 * `task` call produces.
 *
 * Two things differ from a model-issued call, both on purpose:
 *  - the reply is sent as soon as the agent has an id (and is in the registry), not when it finishes;
 *  - the finished result does not wake the main agent. With `async.enabled` the task tool hands the result to the
 *    owning session as an `async-result` follow-up, which starts a main turn; the job's delivery is acknowledged
 *    instead, and the worker appends a visible custom message with the agent name, profile and the first lines of
 *    its result. That message is delivered with `triggerTurn: false`: it joins the transcript (and the main agent's
 *    context) without starting a turn. With async execution off the tool call itself returns the result.
 */
import type { SpawnAgentRequest } from "@omp-console/protocol";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { discoverSessionAgents } from "./catalog";
import { RequestError } from "./request-error";
import { firstLines, unwrapTaskResult } from "./summary";

/** `customType` of the transcript message that reports a deck-spawned agent's outcome. */
export const SPAWN_RESULT_MESSAGE_TYPE = "deck-agent-result";
const MAX_NAME_LENGTH = 64;
const MAX_FILES = 64;
const REGISTERED_WAIT_MS = 10_000;
const RESULT_LINES = 12;
const RESULT_CHARS = 1500;

type TerminalStatus = "completed" | "failed" | "aborted";

/** The part of a task-tool result this module reads. */
interface TaskCallResult {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

/** `@path` as omp's mention parser reads it: bare, or quoted when the path contains whitespace. */
export function formatMention(file: string): string {
	if (file.trim() === "" || file.includes("\n")) throw new RequestError("bad-request", "files must be non-empty single-line paths");
	if (!/\s/.test(file)) return `@${file}`;
	if (!file.includes('"')) return `@"${file}"`;
	if (!file.includes("'")) return `@'${file}'`;
	throw new RequestError("bad-request", `cannot mention a path that contains whitespace and both quote kinds: ${file}`);
}

export function composeAssignment(task: string, files: readonly string[] | undefined): string {
	const mentions = (files ?? []).map(formatMention);
	return mentions.length === 0 ? task : `${mentions.join("\n")}\n\n${task}`;
}

function waitRegistered(registry: AgentRegistry, agentId: string): Promise<void> {
	if (registry.get(agentId)) return Promise.resolve();
	const registered = Promise.withResolvers<void>();
	const unsubscribe = registry.onChange(event => {
		if (event.type === "registered" && event.ref.id === agentId) registered.resolve();
	});
	const timer = setTimeout(registered.resolve, REGISTERED_WAIT_MS);
	return registered.promise.finally(() => {
		clearTimeout(timer);
		unsubscribe();
	});
}

export class AgentSpawner {
	readonly #session: AgentSession;
	readonly #registry: AgentRegistry;
	readonly #abort = new AbortController();

	constructor(session: AgentSession, registry: AgentRegistry = AgentRegistry.global()) {
		this.#session = session;
		this.#registry = registry;
	}

	/** Cancel spawns still running synchronously (async jobs are cancelled by the session's own disposal). */
	stop(reason: string): void {
		this.#abort.abort(reason);
	}

	async spawn(request: SpawnAgentRequest): Promise<string> {
		const session = this.#session;
		const profile = request.profile?.trim();
		const task = request.task?.trim();
		if (!profile) throw new RequestError("bad-request", "profile is required");
		if (!task) throw new RequestError("bad-request", "task must be a non-empty string");
		if (request.name !== undefined && (request.name.trim() === "" || request.name.length > MAX_NAME_LENGTH)) {
			throw new RequestError("bad-request", `name must be 1 to ${MAX_NAME_LENGTH} characters`);
		}
		if (request.files !== undefined && (!Array.isArray(request.files) || request.files.length > MAX_FILES)) {
			throw new RequestError("bad-request", `files must be an array of at most ${MAX_FILES} paths`);
		}
		const known = await discoverSessionAgents(session);
		if (!known.some(agent => agent.name === profile)) {
			throw new RequestError("bad-request", `unknown profile ${profile}; available: ${known.map(agent => agent.name).join(", ")}`);
		}
		const tool = session.getToolByName("task");
		if (!tool) throw new RequestError("conflict", "the task tool is not available in this session");

		const params: Record<string, unknown> = { agent: profile, task: composeAssignment(task, request.files) };
		if (request.name !== undefined) params.name = request.name.trim();
		if (request.isolated !== undefined) params.isolated = request.isolated;

		const started = Promise.withResolvers<string>();
		let knownId: string | undefined;
		const execution = tool
			.execute(`deck-spawn-${crypto.randomUUID()}`, params, this.#abort.signal, update => {
				const id = (update.details as TaskToolDetails | undefined)?.progress?.[0]?.id;
				if (!id) return;
				knownId = id;
				started.resolve(id);
			})
			.then(
				result => this.#afterExecute(result, profile, started),
				async error => {
					const message = error instanceof Error ? error.message : String(error);
					started.reject(new RequestError("conflict", message));
					// A synchronous run that threw after its agent was announced still owes its outcome to the transcript.
					if (knownId !== undefined) await this.#reportOutcome(knownId, profile, "failed", message);
				},
			);
		void execution.catch(error => logger.warn("spawn-agent bookkeeping failed", { error: String(error) }));

		const agentId = await started.promise;
		await waitRegistered(this.#registry, agentId);
		return agentId;
	}

	/** Runs when the task call returned: right away for an async spawn, after the agent finished otherwise. */
	async #afterExecute(
		result: TaskCallResult,
		profile: string,
		started: PromiseWithResolvers<string>,
	): Promise<void> {
		const details = result.details as TaskToolDetails | undefined;
		const jobId = details?.async?.jobId;
		const agentId = details?.progress?.[0]?.id ?? details?.results?.[0]?.id;
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		if (!agentId || (result.isError === true && !jobId)) {
			// Preflight refusals (unknown or disabled agent, spawn policy, isolation unavailable) come back as an error result.
			started.reject(new RequestError("conflict", text || "the task tool refused the spawn"));
			return;
		}
		started.resolve(agentId);

		const manager = this.#session.asyncJobManager;
		const job: AsyncJob | undefined = jobId ? manager?.getJob(jobId) : undefined;
		if (jobId && manager && job) {
			// Before the job can settle: its delivery would start a main-agent turn.
			manager.acknowledgeDeliveries([jobId]);
			await job.promise.catch(() => {});
			const status: TerminalStatus = job.status === "completed" ? "completed" : job.status === "cancelled" ? "aborted" : "failed";
			await this.#reportOutcome(agentId, profile, status, job.status === "completed" ? job.resultText : (job.errorText ?? job.resultText));
			return;
		}
		const single = details?.results?.[0];
		const status: TerminalStatus = single?.aborted ? "aborted" : result.isError === true || (single && single.exitCode !== 0) ? "failed" : "completed";
		await this.#reportOutcome(agentId, profile, status, text);
	}

	async #reportOutcome(agentId: string, profile: string, status: TerminalStatus, resultText: string | undefined): Promise<void> {
		const head = `Agent ${agentId} (${profile}) ${status}.`;
		const body = firstLines(unwrapTaskResult(resultText), RESULT_LINES, RESULT_CHARS);
		try {
			// No `triggerTurn`: the message joins the transcript without starting a main-agent turn.
			await this.#session.sendCustomMessage(
				{
					customType: SPAWN_RESULT_MESSAGE_TYPE,
					content: body ? `${head}\n\n${body}` : head,
					display: true,
					details: { agentId, profile, status },
				},
				{ triggerTurn: false },
			);
		} catch (error) {
			logger.warn("could not post a spawned agent's result", { agentId, error: String(error) });
		}
	}
}
