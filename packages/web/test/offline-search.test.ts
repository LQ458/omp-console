import { describe, expect, it } from "bun:test";
import type { OfflineCachedTranscript } from "../src/lib/offline-cache/types";
import { searchOfflineTranscripts } from "../src/lib/offline-search";

const transcript: OfflineCachedTranscript = {
	metadata: {
		key: "session-1",
		title: "Nightly triage",
		cwd: "/work/triage",
		replicaToken: null,
		entryCount: 3,
		tailEntryId: "assistant-hit",
		leafId: "assistant-hit",
		lastViewedAt: 10,
		lastEntryAt: 10,
		bytes: 0,
		partial: false,
		archivedAt: null,
		live: false,
		waitingOnYou: false,
		unfinished: false,
	},
	entries: [
		{
			type: "message",
			id: "user-hit",
			parentId: null,
			timestamp: "2026-10-26T10:00:00.000Z",
			message: { role: "user", content: "Please check the nightly reminders phrase.", timestamp: Date.parse("2026-10-26T10:00:00.000Z") },
		},
		{
			type: "message",
			id: "tool-result",
			parentId: "user-hit",
			timestamp: "2026-10-26T10:00:01.000Z",
			message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "nightly reminders" }], isError: false, timestamp: Date.parse("2026-10-26T10:00:01.000Z") },
		},
		{
			type: "message",
			id: "assistant-hit",
			parentId: "tool-result",
			timestamp: "2026-10-26T10:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I found the nightly reminders." }],
				model: "test/model",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: Date.parse("2026-10-26T10:00:02.000Z"),
			},
		},
	],
};

describe("offline transcript search", () => {
	it("finds newest user and assistant text, highlights matches, and excludes tool output", async () => {
		const loaded: string[] = [];
		const results = await searchOfflineTranscripts(
			"nightly reminders",
			[{ sessionId: "session-1", title: "Old title", lastActivityAt: 10 }],
			async key => {
				loaded.push(key);
				return transcript;
			},
		);

		expect(loaded).toEqual(["session-1"]);
		expect(results.map(result => result.entryId)).toEqual(["assistant-hit", "user-hit"]);
		expect(results[0]).toMatchObject({
			title: "Nightly triage",
			snippet: "I found the nightly reminders.",
			matchStart: 12,
			matchEnd: 29,
		});
	});
	it("keeps original-string match offsets when case folding changes earlier text length", async () => {
		const text = "İİİİİİ foo bar";
		const cached: OfflineCachedTranscript = {
			...transcript,
			metadata: { ...transcript.metadata, entryCount: 1, tailEntryId: "unicode-hit", leafId: "unicode-hit" },
			entries: [{
				type: "message",
				id: "unicode-hit",
				parentId: null,
				timestamp: "2026-10-26T10:00:03.000Z",
				message: { role: "user", content: text, timestamp: Date.parse("2026-10-26T10:00:03.000Z") },
			}],
		};
		const results = await searchOfflineTranscripts(
			"FOO",
			[{ sessionId: "session-1", title: "Nightly triage", lastActivityAt: 10 }],
			async () => cached,
		);

		expect(results[0]).toMatchObject({
			entryId: "unicode-hit",
			matchStart: text.indexOf("foo"),
			matchEnd: text.indexOf("foo") + 3,
		});
		expect(results[0]?.snippet.slice(results[0].matchStart, results[0].matchEnd)).toBe("foo");
	});
});
