/**
 * Todo board as far as collab frames expose it: the `details.phases` of the latest successful
 * `todo` tool result. Every `todo` op returns the whole board, so the latest result is the state.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoTask {
	content: string;
	status: TodoStatus;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface TodoBoard {
	phases: TodoPhase[];
	total: number;
	completed: number;
	inProgress: number;
	/** Content of the first in-progress task, for a one-line summary. */
	current: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusOf(raw: unknown): TodoStatus {
	return raw === "completed" || raw === "in_progress" || raw === "abandoned" ? raw : "pending";
}

function phasesOf(raw: unknown[]): TodoPhase[] {
	const phases: TodoPhase[] = [];
	for (const phase of raw) {
		if (!isRecord(phase)) continue;
		const tasks: TodoTask[] = [];
		if (Array.isArray(phase.tasks)) {
			for (const task of phase.tasks as unknown[]) {
				if (!isRecord(task) || typeof task.content !== "string") continue;
				tasks.push({ content: task.content, status: statusOf(task.status) });
			}
		}
		phases.push({ name: typeof phase.name === "string" ? phase.name : "", tasks });
	}
	return phases;
}

/** Null when no `todo` result exists or the latest board is empty. */
export function deriveTodos(entries: readonly SessionEntry[]): TodoBoard | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo")
			continue;
		if (entry.message.isError) continue;
		const details = entry.message.details;
		if (!isRecord(details) || !Array.isArray(details.phases)) continue;
		const phases = phasesOf(details.phases as unknown[]);
		let total = 0;
		let completed = 0;
		let inProgress = 0;
		let current: string | null = null;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				total++;
				if (task.status === "completed") completed++;
				if (task.status === "in_progress") {
					inProgress++;
					current ??= task.content;
				}
			}
		}
		return total === 0 ? null : { phases, total, completed, inProgress, current };
	}
	return null;
}
