import type { ContextBreakdownView, SessionOp, SessionOpResult, SessionStatsView, SessionSummary, SessionTreeNode } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { DeckApi } from "./api";
import { recordUsage } from "./journal";

export type TodoTaskStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface EditableTodoTask {
	content: string;
	status: TodoTaskStatus;
}

export interface EditableTodoPhase {
	name: string;
	tasks: EditableTodoTask[];
}

export interface TodoSnapshot {
	entryId: string;
	phases: EditableTodoPhase[];
}

export interface GoalProgress {
	objective: string;
	status: string;
	active: boolean;
	tokensUsed: number | null;
	tokenBudget: number | null;
}

export interface PlanDocument {
	entryId: string;
	path: string;
	content: string;
}

export interface SessionOpJournal {
	feature: string;
	action: string;
	screen: string;
	via?: "suggestion" | "direct";
}

export type SessionOpApi = Pick<DeckApi, "sessionOp">;

export async function runSessionOp(
	api: SessionOpApi,
	sessionId: string,
	op: SessionOp,
	journal: SessionOpJournal,
): Promise<SessionOpResult> {
	const started = performance.now();
	try {
		const result = await api.sessionOp(sessionId, op);
		recordUsage({
			feature: journal.feature,
			action: journal.action,
			outcome: "ok",
			latencyMs: Math.round(performance.now() - started),
			via: journal.via ?? "direct",
			screen: journal.screen,
			sessionId,
		});
		return result;
	} catch (error) {
		recordUsage({
			feature: journal.feature,
			action: journal.action,
			outcome: "error",
			latencyMs: Math.round(performance.now() - started),
			via: journal.via ?? "direct",
			screen: journal.screen,
			sessionId,
		});
		throw error;
	}
}

export function sessionOpError(error: unknown): string {
	return error instanceof Error ? error.message : "The session operation failed.";
}

export function readTodoSnapshot(entries: readonly SessionEntry[]): TodoSnapshot | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo" || entry.message.isError) {
			continue;
		}
		const details = asRecord(entry.message.details);
		if (!details || !Array.isArray(details.phases)) continue;
		return { entryId: entry.id, phases: parseTodoPhases(details.phases) };
	}
	return null;
}

export function parseTodoPhases(raw: unknown): EditableTodoPhase[] {
	if (!Array.isArray(raw)) return [];
	const phases: EditableTodoPhase[] = [];
	for (const value of raw) {
		const phase = asRecord(value);
		if (!phase) continue;
		const tasks: EditableTodoTask[] = [];
		if (Array.isArray(phase.tasks)) {
			for (const item of phase.tasks) {
				const task = asRecord(item);
				if (!task || typeof task.content !== "string") continue;
				tasks.push({ content: task.content, status: todoStatus(task.status) });
			}
		}
		phases.push({ name: typeof phase.name === "string" ? phase.name : "", tasks });
	}
	return phases;
}

export type TodoEditorAction =
	| { type: "phase:add" }
	| { type: "phase:rename"; phase: number; name: string }
	| { type: "phase:move"; phase: number; direction: -1 | 1 }
	| { type: "task:add"; phase: number }
	| { type: "task:edit"; phase: number; task: number; content: string }
	| { type: "task:status"; phase: number; task: number; status: TodoTaskStatus }
	| { type: "task:move"; phase: number; task: number; direction: -1 | 1 };

export function reduceTodoPhases(phases: readonly EditableTodoPhase[], action: TodoEditorAction): EditableTodoPhase[] {
	const next = phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(task => ({ ...task })) }));
	switch (action.type) {
		case "phase:add":
			next.push({ name: `Phase ${next.length + 1}`, tasks: [] });
			return next;
		case "phase:rename": {
			const phase = next[action.phase];
			if (phase) phase.name = action.name;
			return next;
		}
		case "phase:move":
			move(next, action.phase, action.direction);
			return next;
		case "task:add": {
			const phase = next[action.phase];
			phase?.tasks.push({ content: "", status: "pending" });
			return next;
		}
		case "task:edit": {
			const task = next[action.phase]?.tasks[action.task];
			if (task) task.content = action.content;
			return next;
		}
		case "task:status": {
			const task = next[action.phase]?.tasks[action.task];
			if (task) task.status = action.status;
			return next;
		}
		case "task:move": {
			const tasks = next[action.phase]?.tasks;
			if (tasks) move(tasks, action.task, action.direction);
			return next;
		}
	}
}

export function todoOperation(phases: readonly EditableTodoPhase[]): Extract<SessionOp, { op: "todos" }> {
	return {
		op: "todos",
		phases: phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.content.trim() !== "").map(task => ({ ...task, content: task.content.trim() })),
		})),
	};
}

export function readGoalProgress(entries: readonly SessionEntry[], summary?: SessionSummary): GoalProgress | null {
	let goal: GoalProgress | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "goal" || entry.message.isError) {
			continue;
		}
		const details = asRecord(entry.message.details);
		if (!details || !("goal" in details)) continue;
		const record = asRecord(details.goal);
		if (!record) {
			goal = { objective: "", status: "dropped", active: false, tokensUsed: null, tokenBudget: null };
		} else {
			const status = typeof record.status === "string" ? record.status : "";
			goal = {
				objective: typeof record.objective === "string" ? record.objective : "",
				status,
				active: status === "active" || status === "budget-limited",
				tokensUsed: finiteNumber(record.tokensUsed),
				tokenBudget: finiteNumber(record.tokenBudget),
			};
		}
		break;
	}
	if (!goal && !summary?.goalActive && !summary?.goalObjective) return null;
	return {
		objective: summary?.goalObjective ?? goal?.objective ?? "",
		status: goal?.status || (summary?.goalActive ? "active" : "inactive"),
		active: summary?.goalActive ?? goal?.active ?? false,
		tokensUsed: goal?.tokensUsed ?? null,
		tokenBudget: goal?.tokenBudget ?? null,
	};
}

export function readLatestPlan(entries: readonly SessionEntry[]): PlanDocument | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && message.toolName === "read") {
			const details = asRecord(message.details);
			const filePath = stringField(details, "path", "file", "filename");
			const content = contentText(message.content);
			if (filePath && isPlanPath(filePath) && content) return { entryId: entry.id, path: filePath, content };
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const call = asRecord(message.content[j]);
			if (!call || call.type !== "toolCall") continue;
			const name = typeof call.name === "string" ? call.name : call.toolName;
			if (name !== "write") continue;
			const args = asRecord(call.arguments) ?? asRecord(call.input);
			const filePath = stringField(args, "path", "file", "filename");
			const content = stringField(args, "content", "text");
			if (filePath && isPlanPath(filePath) && content) return { entryId: entry.id, path: filePath, content };
		}
	}
	return null;
}

/**
 * Plans the host approved in these entries. Approval (automatic in deck, see session-host plan-mode.ts) answers the
 * agent's `xd://propose` write with "Plan approved at …" and leaves plan mode; guests see only that tool result.
 */
export function countPlanApprovals(entries: readonly SessionEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (contentText(entry.message.content).startsWith("Plan approved at ")) count++;
	}
	return count;
}

export function contextFromResult(result: SessionOpResult): ContextBreakdownView | null {
	return "context" in result ? result.context : null;
}

export function statsFromResult(result: SessionOpResult): SessionStatsView | null {
	return "stats" in result ? result.stats : null;
}

export function treeFromResult(result: SessionOpResult): SessionTreeNode[] | null {
	return "tree" in result ? result.tree : null;
}

function move<T>(items: T[], index: number, direction: -1 | 1): void {
	const target = index + direction;
	if (index < 0 || index >= items.length || target < 0 || target >= items.length) return;
	const [item] = items.splice(index, 1);
	if (item !== undefined) items.splice(target, 0, item);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(value: Record<string, unknown> | null, ...keys: string[]): string | null {
	for (const key of keys) if (typeof value?.[key] === "string") return value[key] as string;
	return null;
}

function contentText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map(block => {
			const record = asRecord(block);
			return record?.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function isPlanPath(value: string): boolean {
	const normalized = value.toLowerCase();
	return normalized === "xd://propose" || /(^|[\/-])plan(?:-[^/\\]+)?\.md$/.test(normalized) || normalized.endsWith("/plan.md");
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function todoStatus(value: unknown): TodoTaskStatus {
	return value === "in_progress" || value === "completed" || value === "abandoned" || value === "blocked" ? value : "pending";
}
