import { describe, expect, it } from "bun:test";
import { caretLines, HISTORY_LIMIT, HistoryCursor, MAX_HISTORY_ENTRY_CHARS, promptUseKey, PromptHistory } from "../src/lib/prompt-history";
import type { KeyValueStorage } from "../src/lib/storage";

class MemoryStorage implements KeyValueStorage {
	readonly map = new Map<string, string>();
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
}

class FullStorage implements KeyValueStorage {
	getItem(): string | null {
		return null;
	}
	setItem(): void {
		throw new Error("QuotaExceededError");
	}
	removeItem(): void {}
}

const NO_LINES = { onFirstLine: true, onLastLine: true };

describe("PromptHistory", () => {
	it("keeps each session's prompts apart and survives a new instance on the same storage", () => {
		const storage = new MemoryStorage();
		const history = new PromptHistory(storage);
		history.push("a", "first");
		history.push("a", "second");
		history.push("b", "other session");
		expect(history.entries("a")).toEqual(["first", "second"]);
		expect(new PromptHistory(storage).entries("a")).toEqual(["first", "second"]);
		expect(history.entries("b")).toEqual(["other session"]);
		expect(history.entries("none")).toEqual([]);
	});

	it("keeps only the last 100 prompts", () => {
		const history = new PromptHistory(new MemoryStorage());
		for (let i = 0; i < HISTORY_LIMIT + 5; i++) history.push("a", `prompt ${i}`);
		const entries = history.entries("a");
		expect(entries).toHaveLength(HISTORY_LIMIT);
		expect(entries[0]).toBe("prompt 5");
		expect(entries[entries.length - 1]).toBe(`prompt ${HISTORY_LIMIT + 4}`);
	});

	it("skips blank prompts, an immediate repeat and prompts too long to keep", () => {
		const history = new PromptHistory(new MemoryStorage());
		history.push("a", "   ");
		history.push("a", "hello ");
		history.push("a", "hello");
		history.push("a", "x".repeat(MAX_HISTORY_ENTRY_CHARS + 1));
		history.push("a", "hello");
		expect(history.entries("a")).toEqual(["hello"]);
		history.push("a", "bye");
		history.push("a", "hello");
		expect(history.entries("a")).toEqual(["hello", "bye", "hello"]);
	});

	it("counts consecutive sends without storing a second copy of the prompt and bounds tracked keys", () => {
		const storage = new MemoryStorage();
		const history = new PromptHistory(storage);
		const repeated = "Audit the retry path";
		for (let index = 0; index < 6; index++) history.push("a", repeated);
		expect(history.entries("a")).toEqual([repeated]);
		expect(history.promptUses("a")).toContainEqual({
			key: promptUseKey(repeated),
			count: 6,
			at: expect.any(Number),
		});
		expect(storage.map.get("omp-console-prompt-uses:a")).not.toContain(repeated);

		for (let index = 0; index < HISTORY_LIMIT + 5; index++) history.push("b", `unique prompt ${index}`);
		expect(history.promptUses("b")).toHaveLength(HISTORY_LIMIT);
	});

	it("restores a draft, and clears it when emptied", () => {
		const storage = new MemoryStorage();
		const history = new PromptHistory(storage);
		history.saveDraft("a", "half a thought");
		expect(new PromptHistory(storage).loadDraft("a")).toBe("half a thought");
		expect(history.loadDraft("b")).toBe("");
		history.saveDraft("a", "");
		expect(history.loadDraft("a")).toBe("");
		expect(storage.map.size).toBe(0);
	});

	it("falls back to memory when storage refuses writes, so drafts and history still work on the page", () => {
		const history = new PromptHistory(new FullStorage());
		history.push("a", "kept in memory");
		history.saveDraft("a", "draft");
		expect(history.entries("a")).toEqual(["kept in memory"]);
		expect(history.loadDraft("a")).toBe("draft");
		history.saveDraft("a", "");
		expect(history.loadDraft("a")).toBe("");
	});

	it("works without any storage", () => {
		const history = new PromptHistory(undefined);
		history.push("a", "one");
		expect(history.entries("a")).toEqual(["one"]);
	});

	it("ignores a corrupt stored history", () => {
		const storage = new MemoryStorage();
		storage.setItem("deck-prompts:a", "{not json");
		const history = new PromptHistory(storage);
		expect(history.entries("a")).toEqual([]);
		history.push("a", "fresh");
		expect(history.entries("a")).toEqual(["fresh"]);
	});
});

describe("HistoryCursor", () => {
	const entries = ["one", "two", "three"];

	it("walks back from an empty composer and forward to empty again", () => {
		const cursor = new HistoryCursor();
		expect(cursor.step("up", "", entries, NO_LINES)).toBe("three");
		expect(cursor.step("up", "three", entries, NO_LINES)).toBe("two");
		expect(cursor.step("up", "two", entries, NO_LINES)).toBe("one");
		expect(cursor.step("up", "one", entries, NO_LINES)).toBeNull(); // oldest: nothing further
		expect(cursor.step("down", "one", entries, NO_LINES)).toBe("two");
		expect(cursor.step("down", "two", entries, NO_LINES)).toBe("three");
		expect(cursor.step("down", "three", entries, NO_LINES)).toBe("");
		expect(cursor.browsing).toBe(false);
	});

	it("does not start from a non-empty composer, from Down, or with no history", () => {
		const cursor = new HistoryCursor();
		expect(cursor.step("up", "typing", entries, NO_LINES)).toBeNull();
		expect(cursor.step("down", "", entries, NO_LINES)).toBeNull();
		expect(cursor.step("up", "", [], NO_LINES)).toBeNull();
		expect(cursor.browsing).toBe(false);
	});

	it("stops browsing once the shown entry is edited, leaving the arrows to the caret", () => {
		const cursor = new HistoryCursor();
		expect(cursor.step("up", "", entries, NO_LINES)).toBe("three");
		expect(cursor.step("up", "three!", entries, NO_LINES)).toBeNull();
		expect(cursor.browsing).toBe(false);
		// The edited text is not empty, so Up does not restart the walk.
		expect(cursor.step("up", "three!", entries, NO_LINES)).toBeNull();
	});

	it("steps through a multi-line entry only from its first or last line", () => {
		const cursor = new HistoryCursor();
		const multi = ["old", "line1\nline2"];
		expect(cursor.step("up", "", multi, NO_LINES)).toBe("line1\nline2");
		const middle = caretLines("line1\nline2", 8); // caret on the second line
		expect(middle).toEqual({ onFirstLine: false, onLastLine: true });
		expect(cursor.step("up", "line1\nline2", multi, middle)).toBeNull();
		expect(cursor.step("up", "line1\nline2", multi, { onFirstLine: true, onLastLine: false })).toBe("old");
		expect(cursor.step("down", "old", multi, NO_LINES)).toBe("line1\nline2");
		expect(cursor.step("down", "line1\nline2", multi, { onFirstLine: true, onLastLine: false })).toBeNull();
	});

	it("reset forgets the position (a prompt was sent)", () => {
		const cursor = new HistoryCursor();
		cursor.step("up", "", entries, NO_LINES);
		cursor.reset();
		expect(cursor.browsing).toBe(false);
		expect(cursor.step("down", "three", entries, NO_LINES)).toBeNull();
	});
});
