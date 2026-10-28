import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { countLines, makeStreamTokens, makeTranscript } from "../bench/make-transcript";

describe("makeTranscript", () => {
	it("is byte-identical for the same seed and different for another", () => {
		const a = JSON.stringify(makeTranscript({ lines: 3_000, seed: 1 }));
		expect(JSON.stringify(makeTranscript({ lines: 3_000, seed: 1 }))).toBe(a);
		expect(JSON.stringify(makeTranscript({ lines: 3_000, seed: 2 }))).not.toBe(a);
	});

	it("reaches the requested line count without running far past it", () => {
		const entries = makeTranscript({ lines: 50_000 });
		const lines = countLines(entries);
		expect(lines).toBeGreaterThanOrEqual(50_000);
		expect(lines).toBeLessThan(50_400);
	});

	it("forms a valid session: unique ids, a parent chain, and every tool result right after its call", () => {
		const entries = makeTranscript({ lines: 8_000 });
		const ids = new Set(entries.map(e => e.id));
		expect(ids.size).toBe(entries.length);
		entries.forEach((entry, i) => {
			expect(entry.parentId).toBe(i === 0 ? null : entries[i - 1]!.id);
		});
		const callIds = new Map<string, number>();
		entries.forEach((entry, i) => {
			if (entry.type !== "message") return;
			if (entry.message.role === "assistant") {
				for (const block of entry.message.content) if (block.type === "toolCall") callIds.set(block.id, i);
			}
			if (entry.message.role === "toolResult") {
				const callIndex = callIds.get(entry.message.toolCallId);
				expect(callIndex).toBeDefined();
				expect(callIndex!).toBeLessThan(i);
			}
		});
	});

	it("mixes prose, code blocks, thinking and tool calls so row heights actually vary", () => {
		const entries = makeTranscript({ lines: 8_000 });
		const text = JSON.stringify(entries);
		expect(text).toContain("```ts");
		expect(text).toContain('"type":"thinking"');
		const tools = new Set<string>();
		for (const entry of entries as SessionEntry[]) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				for (const block of entry.message.content) if (block.type === "toolCall") tools.add(block.name);
			}
		}
		expect([...tools].sort()).toEqual(["bash", "grep", "read"]);
	});
});

describe("makeStreamTokens", () => {
	it("is deterministic and never leaves a code fence open at the end", () => {
		const tokens = makeStreamTokens(900);
		expect(makeStreamTokens(900)).toEqual(tokens);
		expect(tokens.length).toBeGreaterThanOrEqual(900);
		const fences = (tokens.join("").match(/```/g) ?? []).length;
		expect(fences % 2).toBe(0);
	});
});
