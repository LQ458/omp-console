import type { DraftNode, DraftPlan, DraftRun, DraftRunNode } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { PlanAgentEvent, PlanPorts } from "./ports";

const MAX_PLAN_NODES = 50;
const MAX_RUNS_PER_SESSION = 50;
export const DEFAULT_PLAN_CONCURRENCY = 4;

export interface PlanRunnerOptions {
	maxConcurrent?: number;
}

export class PlanValidationError extends Error {}

interface ManagedRun {
	run: DraftRun;
	nodes: Map<string, DraftRunNode>;
}

interface AgentOwner {
	managed: ManagedRun;
	node: DraftRunNode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isDraftNode(value: unknown): value is DraftNode {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.instruction === "string" &&
		typeof value.profile === "string" &&
		(value.files === undefined || isStringArray(value.files)) &&
		(value.dependsOn === undefined || isStringArray(value.dependsOn)) &&
		(value.isolated === undefined || typeof value.isolated === "boolean")
	);
}

export function parseDraftPlan(value: unknown): DraftPlan | undefined {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.nodes) || !value.nodes.every(isDraftNode)) return undefined;
	return {
		name: value.name,
		nodes: value.nodes.map(node => ({
			...node,
			...(node.files === undefined ? {} : { files: [...node.files] }),
			...(node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] }),
		})),
	};
}

export function validateDraftPlanStructure(plan: DraftPlan): void {
	if (plan.nodes.length > MAX_PLAN_NODES) throw new PlanValidationError(`a plan may contain at most ${MAX_PLAN_NODES} nodes`);
	const byId = new Map<string, DraftNode>();
	for (const node of plan.nodes) {
		if (node.id.trim() === "") throw new PlanValidationError("node ids must not be empty");
		if (byId.has(node.id)) throw new PlanValidationError(`duplicate node id ${JSON.stringify(node.id)}`);
		if (node.profile.trim() === "") throw new PlanValidationError(`node ${JSON.stringify(node.id)} must have a profile`);
		if (node.instruction.trim() === "") throw new PlanValidationError(`node ${JSON.stringify(node.id)} must have non-empty instructions`);
		byId.set(node.id, node);
	}

	for (const node of plan.nodes) {
		for (const dependency of node.dependsOn ?? []) {
			if (!byId.has(dependency)) {
				throw new PlanValidationError(`node ${JSON.stringify(node.id)} depends on unknown node ${JSON.stringify(dependency)}`);
			}
		}
	}

	const visited = new Set<string>();
	const active = new Map<string, number>();
	const stack: string[] = [];
	const visit = (id: string): void => {
		if (visited.has(id)) return;
		const activeAt = active.get(id);
		if (activeAt !== undefined) {
			const cycle = [...stack.slice(activeAt), id];
			throw new PlanValidationError(`plan contains dependency cycle: ${cycle.join(" -> ")}`);
		}
		active.set(id, stack.length);
		stack.push(id);
		for (const dependency of byId.get(id)!.dependsOn ?? []) visit(dependency);
		stack.pop();
		active.delete(id);
		visited.add(id);
	};
	for (const node of plan.nodes) visit(node.id);
}

function clonePlan(plan: DraftPlan): DraftPlan {
	return {
		name: plan.name,
		nodes: plan.nodes.map(node => ({
			...node,
			...(node.files === undefined ? {} : { files: [...node.files] }),
			...(node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] }),
		})),
	};
}

function cloneRun(run: DraftRun): DraftRun {
	return { ...run, plan: clonePlan(run.plan), nodes: run.nodes.map(node => ({ ...node })) };
}

function agentKey(sessionId: string, agentId: string): string {
	return `${sessionId}\u0000${agentId}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function terminal(state: DraftRunNode["state"]): boolean {
	return state === "done" || state === "failed" || state === "skipped" || state === "cancelled";
}

export class PlanRunner {
	readonly #ports: PlanPorts;
	readonly #stateDir: string;
	readonly #maxConcurrent: number;
	readonly #runs = new Map<string, ManagedRun[]>();
	readonly #agentOwners = new Map<string, AgentOwner>();
	readonly #pendingSpawns = new Map<string, number>();
	readonly #unmatchedEvents = new Map<string, Map<string, PlanAgentEvent[]>>();
	#persistTail: Promise<void> = Promise.resolve();

	constructor(ports: PlanPorts, stateDir: string, options: PlanRunnerOptions = {}) {
		this.#ports = ports;
		this.#stateDir = stateDir;
		this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_PLAN_CONCURRENCY;
		if (!Number.isSafeInteger(this.#maxConcurrent) || this.#maxConcurrent < 1) {
			throw new RangeError("maxConcurrent must be a positive integer");
		}
		ports.onAgentEvent((sessionId, event) => this.#onAgentEvent(sessionId, event));
	}

	async start(sessionId: string, input: DraftPlan): Promise<DraftRun> {
		const plan = parseDraftPlan(input);
		if (!plan) throw new PlanValidationError("body must be a draft plan");
		validateDraftPlanStructure(plan);
		const profiles = new Set(await this.#ports.knownProfiles(sessionId));
		for (const node of plan.nodes) {
			if (!profiles.has(node.profile)) {
				throw new PlanValidationError(`node ${JSON.stringify(node.id)} uses unknown profile ${JSON.stringify(node.profile)}`);
			}
		}

		const run: DraftRun = {
			runId: crypto.randomUUID(),
			sessionId,
			plan,
			nodes: plan.nodes.map(node => ({ id: node.id, state: "waiting" })),
			state: "running",
			startedAt: this.#ports.now(),
		};
		const managed: ManagedRun = { run, nodes: new Map(run.nodes.map(node => [node.id, node])) };
		const history = this.#runs.get(sessionId) ?? [];
		history.push(managed);
		this.#runs.set(sessionId, history);
		if (history.length > MAX_RUNS_PER_SESSION) {
			const evicted = history.shift()!;
			if (evicted.run.state === "running") {
				void this.#cancelManaged(evicted).catch(error => {
					logger.error("failed to cancel an evicted plan run", { runId: evicted.run.runId, error: errorText(error) });
				});
			}
		}
		this.#record(managed);
		await this.flush();
		this.#schedule(managed);
		return cloneRun(run);
	}

	list(sessionId: string): DraftRun[] {
		return (this.#runs.get(sessionId) ?? []).map(managed => cloneRun(managed.run));
	}

	get(sessionId: string, runId: string): DraftRun | undefined {
		const managed = (this.#runs.get(sessionId) ?? []).find(candidate => candidate.run.runId === runId);
		return managed ? cloneRun(managed.run) : undefined;
	}

	async cancel(sessionId: string, runId: string): Promise<DraftRun | undefined> {
		const managed = (this.#runs.get(sessionId) ?? []).find(candidate => candidate.run.runId === runId);
		if (!managed) return undefined;
		await this.#cancelManaged(managed);
		return cloneRun(managed.run);
	}

	async flush(): Promise<void> {
		await this.#persistTail;
	}

	async #cancelManaged(managed: ManagedRun): Promise<void> {
		const { run } = managed;
		if (run.state !== "running") return;
		run.state = "cancelled";
		this.#record(managed);
		const agentIds: string[] = [];
		for (const node of run.nodes) {
			if (node.state === "waiting") {
				node.state = "skipped";
				node.endedAt = this.#ports.now();
				this.#record(managed);
			} else if (node.state === "running") {
				node.state = "cancelled";
				node.endedAt = this.#ports.now();
				this.#record(managed);
				if (node.agentId !== undefined) {
					this.#agentOwners.delete(agentKey(run.sessionId, node.agentId));
					agentIds.push(node.agentId);
				}
			}
		}
		const results = await Promise.allSettled(agentIds.map(agentId => this.#ports.cancelAgent(run.sessionId, agentId)));
		const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failure) throw failure.reason;
	}

	#schedule(managed: ManagedRun): void {
		const { run } = managed;
		if (run.state !== "running") return;
		let running = run.nodes.filter(node => node.state === "running").length;
		for (const draftNode of run.plan.nodes) {
			if (running >= this.#maxConcurrent) break;
			const node = managed.nodes.get(draftNode.id)!;
			if (node.state !== "waiting") continue;
			const dependencies = draftNode.dependsOn ?? [];
			const dependencyStates = dependencies.map(id => managed.nodes.get(id)!.state);
			if (dependencyStates.some(state => state === "failed" || state === "skipped" || state === "cancelled")) {
				node.state = "skipped";
				node.endedAt = this.#ports.now();
				this.#record(managed);
				continue;
			}
			if (!dependencyStates.every(state => state === "done")) continue;

			node.state = "running";
			node.startedAt = this.#ports.now();
			running++;
			this.#record(managed);
			this.#pendingSpawns.set(run.sessionId, (this.#pendingSpawns.get(run.sessionId) ?? 0) + 1);
			void this.#launch(managed, node, draftNode);
		}
		this.#settle(managed);
	}

	async #launch(managed: ManagedRun, node: DraftRunNode, draftNode: DraftNode): Promise<void> {
		const { run } = managed;
		try {
			const response = await this.#ports.spawn(run.sessionId, {
				profile: draftNode.profile,
				task: this.#taskText(managed, draftNode),
				name: draftNode.title,
				...(draftNode.isolated === undefined ? {} : { isolated: draftNode.isolated }),
			});
			if (response.agentId.trim() === "") throw new Error("spawn returned an empty agent id");
			node.agentId = response.agentId;
			this.#record(managed);
			if (run.state !== "running" || node.state !== "running") {
				await this.#ports.cancelAgent(run.sessionId, response.agentId);
				return;
			}
			const key = agentKey(run.sessionId, response.agentId);
			this.#agentOwners.set(key, { managed, node });
			const events = this.#unmatchedEvents.get(run.sessionId)?.get(response.agentId) ?? [];
			this.#unmatchedEvents.get(run.sessionId)?.delete(response.agentId);
			for (const event of events) this.#applyAgentEvent(run.sessionId, event);
		} catch (error) {
			if (run.state === "running" && node.state === "running") {
				node.state = "failed";
				node.summary = errorText(error);
				node.endedAt = this.#ports.now();
				this.#record(managed);
				this.#skipDependents(managed, node.id);
				this.#settle(managed);
			} else {
				logger.warn("failed to cancel a plan agent after run cancellation", {
					runId: run.runId,
					nodeId: node.id,
					error: errorText(error),
				});
			}
		} finally {
			const pending = (this.#pendingSpawns.get(run.sessionId) ?? 1) - 1;
			if (pending === 0) {
				this.#pendingSpawns.delete(run.sessionId);
				this.#unmatchedEvents.delete(run.sessionId);
			} else {
				this.#pendingSpawns.set(run.sessionId, pending);
			}
			this.#schedule(managed);
		}
	}

	#taskText(managed: ManagedRun, node: DraftNode): string {
		const context: string[] = [];
		const dependencies = (node.dependsOn ?? []).map(id => managed.nodes.get(id)!);
		if (dependencies.length > 0) {
			context.push(
				"Finished dependencies:",
				...dependencies.map(dependency => {
					const title = managed.run.plan.nodes.find(item => item.id === dependency.id)!.title;
					return `- ${title}: ${dependency.summary ?? "(no summary reported)"}`;
				}),
			);
		}
		if (node.files && node.files.length > 0) context.push("Files:", ...node.files.map(file => `@${file}`));
		return context.length === 0 ? node.instruction : `${node.instruction}\n\nContext:\n${context.join("\n")}`;
	}

	#skipDependents(managed: ManagedRun, failedId: string): void {
		const failed = new Set([failedId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const draftNode of managed.run.plan.nodes) {
				const node = managed.nodes.get(draftNode.id)!;
				if (node.state !== "waiting" || !(draftNode.dependsOn ?? []).some(id => failed.has(id))) continue;
				node.state = "skipped";
				node.endedAt = this.#ports.now();
				failed.add(node.id);
				changed = true;
				this.#record(managed);
			}
		}
	}

	#settle(managed: ManagedRun): void {
		const { run } = managed;
		if (run.state !== "running") return;
		if (run.nodes.every(node => node.state === "done")) {
			run.state = "done";
			this.#record(managed);
			return;
		}
		if (run.nodes.every(node => terminal(node.state)) && run.nodes.some(node => node.state === "failed")) {
			run.state = "failed";
			this.#record(managed);
		}
	}

	#onAgentEvent(sessionId: string, event: PlanAgentEvent): void {
		const key = agentKey(sessionId, event.agentId);
		const owner = this.#agentOwners.get(key);
		if (owner) {
			this.#applyAgentEvent(sessionId, event);
			return;
		}
		if (event.status === "started" || (this.#pendingSpawns.get(sessionId) ?? 0) === 0) return;
		let sessionEvents = this.#unmatchedEvents.get(sessionId);
		if (!sessionEvents) {
			sessionEvents = new Map();
			this.#unmatchedEvents.set(sessionId, sessionEvents);
		}
		const events = sessionEvents.get(event.agentId) ?? [];
		events.push(event);
		sessionEvents.set(event.agentId, events);
	}

	#applyAgentEvent(sessionId: string, event: PlanAgentEvent): void {
		const key = agentKey(sessionId, event.agentId);
		const owner = this.#agentOwners.get(key);
		if (!owner || event.status === "started") return;
		this.#agentOwners.delete(key);
		const { managed, node } = owner;
		if (managed.run.state !== "running" || node.state !== "running") return;

		node.state = event.status === "completed" ? "done" : "failed";
		node.summary = event.summary ?? (event.status === "completed" ? undefined : `Agent ${event.status}`);
		node.endedAt = this.#ports.now();
		this.#record(managed);
		if (node.state === "failed") this.#skipDependents(managed, node.id);
		this.#schedule(managed);
	}

	#record(managed: ManagedRun): void {
		const { run } = managed;
		const record = JSON.stringify({
			at: this.#ports.now(),
			sessionId: run.sessionId,
			runId: run.runId,
			state: run.state,
			nodes: run.nodes.map(node => ({
				id: node.id,
				state: node.state,
				...(node.agentId === undefined ? {} : { agentId: node.agentId }),
				...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
				...(node.endedAt === undefined ? {} : { endedAt: node.endedAt }),
				...(node.summary === undefined ? {} : { summary: node.summary }),
			})),
		});
		const file = path.join(this.#stateDir, "plan-runs.jsonl");
		this.#persistTail = this.#persistTail
			.then(async () => {
				await fs.mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
				await fs.appendFile(file, `${record}\n`, { encoding: "utf8", mode: 0o600 });
				await fs.chmod(file, 0o600);
			})
			.catch(error => {
				logger.error("failed to append plan run state", { runId: run.runId, error: errorText(error) });
			});
	}
}
