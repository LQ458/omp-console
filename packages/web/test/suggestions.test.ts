import { describe, expect, it } from "bun:test";
import type { SessionSummary } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { IDLE_LIVE_SESSION_MS, LONG_TURN_MS, hasRepeatedSimilarPrompts, sessionSuggestions, type SuggestionInput } from "../src/lib/suggestions";

const NOW = Date.parse("2026-06-12T12:00:00.000Z");

function summary(lastActivityAt = NOW): SessionSummary {
	return { id: "session-1", cwd: "/work", state: "idle", createdAt: NOW - 3_600_000, lastActivityAt, agentCount: 0, goalActive: false, awaitingAnswer: false };
}

function userEntry(id: string, text: string, at: number, synthetic = false): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at, ...(synthetic ? { synthetic: true } : {}) },
	};
}

function todoEntry(id: string, status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(NOW).toISOString(),
		message: { role: "toolResult", toolCallId: id, toolName: "todo", content: [{ type: "text", text: "updated" }], details: { phases: [{ name: "Work", tasks: [{ content: "finish", status }] }] }, isError: false, timestamp: NOW },
	};
}

function input(patch: Partial<SuggestionInput> = {}): SuggestionInput {
	return { sessionId: "session-1", summary: summary(), contextPercent: null, subagentCount: 0, working: false, entries: [], now: NOW, ...patch };
}

function ids(value: SuggestionInput): string[] {
	return sessionSuggestions(value).map(suggestion => suggestion.id);
}

describe("session suggestion rules", () => {
	it("suggests context controls only above the 70 percent threshold", () => {
		expect(ids(input({ contextPercent: 70 }))).not.toContain("context-high");
		expect(ids(input({ contextPercent: 70.01 }))).toContain("context-high");
		expect(ids(input({ contextPercent: null }))).not.toContain("context-high");
	});

	it("opens the agent graph at three active subagents, not two", () => {
		expect(ids(input({ subagentCount: 2 }))).not.toContain("agent-graph");
		expect(ids(input({ subagentCount: 3 }))).toContain("agent-graph");
	});

	it("suggests plan mode after a long active turn only when no open todo exists", () => {
		const oldPrompt = userEntry("u1", "Implement the new session workflow", NOW - LONG_TURN_MS);
		expect(ids(input({ entries: [oldPrompt], working: true }))).toContain("plan-for-long-turn");
		expect(ids(input({ entries: [userEntry("u2", "Implement the new session workflow", NOW - LONG_TURN_MS + 1)], working: true }))).not.toContain("plan-for-long-turn");
		expect(ids(input({ entries: [oldPrompt], working: false }))).not.toContain("plan-for-long-turn");
		expect(ids(input({ entries: [oldPrompt, todoEntry("todo-1", "in_progress")], working: true }))).not.toContain("plan-for-long-turn");
	});

	it("detects similar recurring prompts but ignores unique, short and synthetic prompts", () => {
		const similar = [
			userEntry("u1", "Explain recurring build failure in relay service", NOW - 2),
			userEntry("u2", "Explain the recurring build failure in relay service", NOW - 1),
		];
		expect(hasRepeatedSimilarPrompts(similar)).toBe(true);
		expect(ids(input({ entries: similar }))).toContain("repeated-prompts");
		expect(hasRepeatedSimilarPrompts([userEntry("u1", "Explain recurring build failure in relay service", NOW - 2), userEntry("u2", "Summarize a different topic for the documentation", NOW - 1)])).toBe(false);
		expect(hasRepeatedSimilarPrompts([userEntry("u1", "Help me", NOW - 2), userEntry("u2", "Help me", NOW - 1)])).toBe(false);
		expect(hasRepeatedSimilarPrompts([userEntry("u1", "Explain recurring build failure in relay service", NOW - 2, true), userEntry("u2", "Explain recurring build failure in relay service", NOW - 1)])).toBe(false);
	});

	it("offers to stop a live session after 24 idle hours and not before", () => {
		expect(ids(input({ summary: summary(NOW - IDLE_LIVE_SESSION_MS) }))).toContain("idle-live-session");
		expect(ids(input({ summary: summary(NOW - IDLE_LIVE_SESSION_MS + 1) }))).not.toContain("idle-live-session");
		expect(ids(input({ summary: undefined }))).not.toContain("idle-live-session");
	});

	it("does not suggest actions when there is no daemon session to control", () => {
		expect(ids(input({ sessionId: null, contextPercent: 90, subagentCount: 5, summary: summary(NOW - IDLE_LIVE_SESSION_MS) }))).toEqual([]);
	});
});
