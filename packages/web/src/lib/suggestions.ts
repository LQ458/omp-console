import type { SessionSummary } from "@omp-console/protocol";
import type { SessionEntry, UserMessage } from "@oh-my-pi/pi-wire";
import { readTodoSnapshot } from "./session-ops";

export const LONG_TURN_MS = 10 * 60 * 1_000;
export const IDLE_LIVE_SESSION_MS = 24 * 60 * 60 * 1_000;

export type SuggestionId = "context-high" | "agent-graph" | "plan-for-long-turn" | "repeated-prompts" | "idle-live-session";

export interface SessionSuggestion {
	id: SuggestionId;
	title: string;
	description: string;
	actionLabel: string;
	ompEquivalent: string | null;
}

export interface SuggestionInput {
	sessionId: string | null;
	summary?: SessionSummary;
	contextPercent: number | null;
	subagentCount: number;
	working: boolean;
	entries: readonly SessionEntry[];
	now: number;
}

export function sessionSuggestions(input: SuggestionInput): SessionSuggestion[] {
	if (!input.sessionId) return [];
	const suggestions: SessionSuggestion[] = [];
	if (input.contextPercent !== null && input.contextPercent > 70) {
		suggestions.push({
			id: "context-high",
			title: "Context is above 70%",
			description: "Review compact and handoff options before the next long turn.",
			actionLabel: "Review context options",
			ompEquivalent: "/compact soft · /compact remote",
		});
	}
	if (input.subagentCount >= 3) {
		suggestions.push({
			id: "agent-graph",
			title: `${input.subagentCount} subagents are active`,
			description: "Open the agent graph to inspect their branches and progress.",
			actionLabel: "Open agent graph",
			ompEquivalent: null,
		});
	}
	const lastUserAt = latestUserTimestamp(input.entries);
	const todoSnapshot = readTodoSnapshot(input.entries);
	const hasOpenTodo = todoSnapshot?.phases.some(phase => phase.tasks.some(task => task.status === "pending" || task.status === "in_progress" || task.status === "blocked")) ?? false;
	if (input.working && !hasOpenTodo && lastUserAt !== null && input.now - lastUserAt >= LONG_TURN_MS) {
		suggestions.push({
			id: "plan-for-long-turn",
			title: "This turn has run for a while without todos",
			description: "Switch to plan mode to structure the remaining work.",
			actionLabel: "Enable plan mode",
			ompEquivalent: "app.plan.toggle",
		});
	}
	if (hasRepeatedSimilarPrompts(input.entries)) {
		suggestions.push({
			id: "repeated-prompts",
			title: "Similar prompts are recurring",
			description: "Use /goal to give the agent a lasting objective, or /loop to repeat a prompt.",
			actionLabel: "Set a goal",
			ompEquivalent: "/goal · /loop <prompt>",
		});
	}
	if (input.summary && input.summary.lastActivityAt > 0 && input.now - input.summary.lastActivityAt >= IDLE_LIVE_SESSION_MS) {
		suggestions.push({
			id: "idle-live-session",
			title: "This live session has been idle for over a day",
			description: "Stop the idle worker to release its resources.",
			actionLabel: "Stop idle session",
			ompEquivalent: null,
		});
	}
	return suggestions;
}

export function hasRepeatedSimilarPrompts(entries: readonly SessionEntry[]): boolean {
	const prompts = entries.flatMap(entry => {
		if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) return [];
		const text = userText(entry.message);
		const normalized = normalizePrompt(text);
		return normalized === null ? [] : [normalized];
	}).slice(-8);
	if (prompts.length < 2) return false;
	const current = prompts[prompts.length - 1]!;
	return prompts.slice(0, -1).some(previous => similarity(current, previous) >= 0.8);
}

function latestUserTimestamp(entries: readonly SessionEntry[]): number | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) continue;
		const timestamp = Date.parse(entry.timestamp);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	return null;
}

function userText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(block => block.type === "text" ? [block.text] : []).join(" ");
}

function normalizePrompt(text: string): string | null {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
	if (words.length < 4) return null;
	return words.join(" ");
}

function similarity(left: string, right: string): number {
	const leftWords = new Set(left.split(" "));
	const rightWords = new Set(right.split(" "));
	let intersection = 0;
	for (const word of leftWords) if (rightWords.has(word)) intersection++;
	const union = leftWords.size + rightWords.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
