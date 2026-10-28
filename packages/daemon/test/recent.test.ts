import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmp } from "./helpers";
import { firstPromptFromHead, listPersistedSessions, RecentSessionScanError, titleFromFirstMessage } from "../src/recent";

describe("titleFromFirstMessage", () => {
	it("uses the first user message as one trimmed line", () => {
		expect(titleFromFirstMessage("  fix the relay\n\nbackoff bug  ")).toBe("fix the relay backoff bug");
	});

	it("drops harness context blocks that precede the typed prompt", () => {
		const message = "<system-reminder>Today is 2026-10-23</system-reminder>\nreview the daemon diff";
		expect(titleFromFirstMessage(message)).toBe("review the daemon diff");
	});

	it("returns undefined when only context blocks or nothing is left", () => {
		expect(titleFromFirstMessage("<system-notice>x</system-notice>")).toBeUndefined();
		expect(titleFromFirstMessage("")).toBeUndefined();
		expect(titleFromFirstMessage(undefined)).toBeUndefined();
	});

	it("caps long messages at 80 characters with an ellipsis", () => {
		const title = titleFromFirstMessage("word ".repeat(60));
		expect(title?.length).toBe(80);
		expect(title?.endsWith("…")).toBe(true);
	});
});

describe("firstPromptFromHead", () => {
	const line = (entry: unknown) => JSON.stringify(entry);

	it("takes a deck-typed prompt (collab-prompt custom message) ahead of later tool output", () => {
		const head = [
			line({ type: "session" }),
			line({ type: "custom_message", customType: "collab-prompt", content: "Read note.txt and reply" }),
			line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "[note.txt#F3B8] 1:hello" }] } }),
		].join("\n");
		expect(firstPromptFromHead(head)).toBe("Read note.txt and reply");
	});

	it("takes the first user message of a terminal session, including content blocks", () => {
		const head = [
			line({ type: "model_change" }),
			line({ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the relay" }, { type: "image" }] } }),
		].join("\n");
		expect(firstPromptFromHead(head)).toBe("fix the relay");
	});

	it("ignores a truncated last line and returns undefined when no prompt is present", () => {
		expect(firstPromptFromHead(`${line({ type: "session" })}\n{"type":"custom_message","customType":"collab-pr`)).toBeUndefined();
		expect(firstPromptFromHead("")).toBeUndefined();
	});
});

describe("persisted session listing", () => {
	it("reflects new sessions, file growth, replacement, and deletion on the next list", async () => {
		const sessionsDir = makeTmp("deck-recent-list-");
		const bucket = path.join(sessionsDir, "bucket");
		const file = path.join(bucket, "session.jsonl");
		const replacement = path.join(bucket, "replacement.jsonl");
		const originalSessionsDir = process.env.OMP_CONSOLE_SESSIONS_DIR;
		const header = (id: string, title: string): string =>
			`${JSON.stringify({ type: "session", id, cwd: sessionsDir, timestamp: new Date(0).toISOString(), title })}\n`;
		await fs.mkdir(bucket, { recursive: true });
		process.env.OMP_CONSOLE_SESSIONS_DIR = sessionsDir;
		try {
			await Bun.write(file, header("original", "Initial title"));
			const initial = await listPersistedSessions();
			expect(initial.map(session => session.id)).toEqual(["original"]);
			expect(initial[0]).toMatchObject({ source: "terminal", cwdExists: true });
			const oldActivity = initial[0]!.lastActivityAt;
			const freshFile = path.join(bucket, "fresh.jsonl");
			await Bun.write(freshFile, header("fresh", "Fresh session"));
			const fresh = await listPersistedSessions();
			expect(fresh.map(session => session.id).sort()).toEqual(["fresh", "original"]);

			await fs.appendFile(file, `${JSON.stringify({ type: "message", message: { role: "user", content: "Continue work" } })}\n`);
			const grownAt = new Date(Date.now() + 2_000);
			await fs.utimes(file, grownAt, grownAt);
			const grown = await listPersistedSessions();
			const grownOriginal = grown.find(session => session.id === "original");
			expect(grownOriginal?.lastActivityAt).toBeGreaterThan(oldActivity);

			await Bun.write(replacement, header("replacement", "Replacement title"));
			const replacedAt = new Date(Date.now() + 3_000);
			await fs.utimes(replacement, replacedAt, replacedAt);
			await fs.rename(replacement, file);
			const replaced = await listPersistedSessions();
			expect(replaced.map(session => session.id).sort()).toEqual(["fresh", "replacement"]);
			const replacementSession = replaced.find(session => session.id === "replacement");
			expect(replacementSession?.title).toBe("Replacement title");

			await fs.unlink(file);
			const afterDelete = await listPersistedSessions();
			expect(afterDelete.map(session => session.id)).toEqual(["fresh"]);
			await fs.unlink(freshFile);
			expect(await listPersistedSessions()).toEqual([]);
		} finally {
			await fs.rm(sessionsDir, { recursive: true, force: true });
			if (originalSessionsDir === undefined) delete process.env.OMP_CONSOLE_SESSIONS_DIR;
			else process.env.OMP_CONSOLE_SESSIONS_DIR = originalSessionsDir;
		}
	});
	it("surfaces the path when the persisted session directory cannot be scanned", async () => {
		const directory = makeTmp("deck-recent-not-directory-");
		const invalidStore = path.join(directory, "sessions-file");
		const previous = process.env.OMP_CONSOLE_SESSIONS_DIR;
		await fs.writeFile(invalidStore, "not a directory");
		process.env.OMP_CONSOLE_SESSIONS_DIR = invalidStore;
		try {
			let failure: unknown;
			try {
				await listPersistedSessions();
			} catch (error) {
				failure = error;
			}
			if (!(failure instanceof RecentSessionScanError)) {
				throw new Error("expected the persisted-session scan to fail with RecentSessionScanError");
			}
			expect(failure.message).toContain(invalidStore);
		} finally {
			if (previous === undefined) delete process.env.OMP_CONSOLE_SESSIONS_DIR;
			else process.env.OMP_CONSOLE_SESSIONS_DIR = previous;
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
