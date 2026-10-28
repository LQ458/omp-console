/**
 * Usage journal and in-place feedback (spec 0.5 / 0.6): validation, privacy (closed key set), file mode,
 * rotation, ordering under concurrent writers, wipe.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ApiError, FeedbackEntry, JournalEvent, JournalResponse } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { type TestDaemon, startTestDaemon, stopTestDaemons } from "./harness";

afterEach(async () => {
	await stopTestDaemons();
});

const event = (overrides: Partial<JournalEvent> = {}): JournalEvent => ({
	at: Date.now(),
	feature: "5.2.palette",
	action: "run",
	outcome: "ok",
	...overrides,
});

const journalFile = (t: TestDaemon) => path.join(t.stateDir, "journal.jsonl");
const feedbackFile = (t: TestDaemon) => path.join(t.stateDir, "feedback.jsonl");

async function readBack(t: TestDaemon, limit?: number): Promise<JournalResponse> {
	const response = await t.get(limit === undefined ? "/api/journal" : `/api/journal?limit=${limit}`);
	expect(response.status).toBe(200);
	return (await response.json()) as JournalResponse;
}

async function rejects(t: TestDaemon, events: unknown, message?: string): Promise<void> {
	const response = await t.post("/api/journal", events);
	expect(response.status).toBe(400);
	const body = (await response.json()) as ApiError;
	expect(body.code).toBe("bad-request");
	if (message) expect(body.error).toContain(message);
}

describe("POST /api/journal", () => {
	it("stores events in order, keeps only the known fields, and never writes a stray field to disk", async () => {
		const t = await startTestDaemon();
		const first = event({ at: 1000, via: "palette", latencyMs: 42, screen: "composer", detail: "compact", sessionId: "s-1" });
		const second = event({ at: 2000, feature: "2.5.spawn", action: "spawn", outcome: "error", via: "graph" });
		const leaky = { ...event({ at: 3000 }), prompt: "my secret prompt text", detail: "short", nested: { text: "file contents" } };
		const response = await t.post("/api/journal", { events: [first, second, leaky], extra: "ignored" });
		expect(response.status).toBe(204);

		const stored = await readBack(t);
		expect(stored.events).toEqual([first, second, { ...event({ at: 3000 }), detail: "short" }]);
		const raw = fs.readFileSync(journalFile(t), "utf8");
		expect(raw).not.toContain("my secret prompt text");
		expect(raw).not.toContain("file contents");
		expect(raw.trim().split("\n")).toHaveLength(3);
	});

	it("rejects an unknown outcome or via, over-long feature, action, detail, screen or sessionId, and malformed events", async () => {
		const t = await startTestDaemon();
		await rejects(t, { events: [event({ outcome: "maybe" as "ok" })] }, "outcome");
		await rejects(t, { events: [event({ via: "telepathy" as "direct" })] }, "via");
		await rejects(t, { events: [event({ feature: "f".repeat(65) })] }, "feature");
		await rejects(t, { events: [event({ action: "a".repeat(65) })] }, "action");
		await rejects(t, { events: [event({ detail: "d".repeat(121) })] }, "detail");
		await rejects(t, { events: [event({ screen: "s".repeat(65) })] }, "screen");
		await rejects(t, { events: [event({ sessionId: "i".repeat(129) })] }, "sessionId");
		await rejects(t, { events: [event({ feature: "" })] }, "feature");
		await rejects(t, { events: [event({ at: "yesterday" as unknown as number })] }, "at");
		await rejects(t, { events: [event({ latencyMs: -1 })] }, "latencyMs");
		await rejects(t, { events: [null] }, "must be an object");
		await rejects(t, { events: "nope" });
		await rejects(t, {});
		await rejects(t, [event()]);
		expect((await t.post("/api/journal", "{broken")).status).toBe(400);

		// Boundary values are accepted.
		const edge = event({ feature: "f".repeat(64), action: "a".repeat(64), detail: "d".repeat(120) });
		expect((await t.post("/api/journal", { events: [edge] })).status).toBe(204);
		expect((await readBack(t)).events).toEqual([edge]);
	});

	it("is atomic: one invalid event rejects the whole batch", async () => {
		const t = await startTestDaemon();
		await rejects(t, { events: [event({ at: 1 }), event({ at: 2, outcome: "bogus" as "ok" }), event({ at: 3 })] }, "events[1].outcome");
		expect((await readBack(t)).events).toEqual([]);
		expect(fs.existsSync(journalFile(t))).toBe(false);
	});

	it("accepts exactly 200 events per call and rejects 201", async () => {
		const t = await startTestDaemon();
		const full = Array.from({ length: 200 }, (_, index) =>
			event({ at: index + 1, feature: "f".repeat(64), action: "a".repeat(64), detail: "d".repeat(120), screen: "s".repeat(64), sessionId: "i".repeat(128) }),
		);
		expect((await t.post("/api/journal", { events: full })).status).toBe(204);
		expect((await readBack(t, 1000)).events).toHaveLength(200);
		await rejects(t, { events: [...full, event()] }, "200");
		expect((await readBack(t, 1000)).events).toHaveLength(200);
	});

	it("keeps every line whole under concurrent writers", async () => {
		const t = await startTestDaemon();
		const responses = await Promise.all(
			Array.from({ length: 25 }, (_, index) =>
				t.post("/api/journal", { events: [event({ at: index + 1, action: `w${index}` }), event({ at: index + 1, action: `w${index}b` })] }),
			),
		);
		expect(responses.every(response => response.status === 204)).toBe(true);
		const lines = fs.readFileSync(journalFile(t), "utf8").trim().split("\n");
		expect(lines).toHaveLength(50);
		for (const line of lines) expect(JSON.parse(line)).toHaveProperty("feature", "5.2.palette");
		// A batch is never interleaved with another batch's events.
		const actions = (await readBack(t, 100)).events.map(row => row.action);
		for (let index = 0; index < actions.length; index += 2) expect(actions[index + 1]).toBe(`${actions[index]}b`);
	});
});

describe("POST /api/feedback", () => {
	it("stores feedback linked to its screen and feature, and validates it", async () => {
		const t = await startTestDaemon();
		const entry: FeedbackEntry = { at: 5000, screen: "catalog", feature: "0.1.catalog", text: "wanted a filter by source" };
		expect((await t.post("/api/feedback", entry)).status).toBe(204);
		expect((await t.post("/api/feedback", { at: 6000, screen: "graph", text: "no feature id", junk: "dropped" })).status).toBe(204);
		const stored = await readBack(t);
		expect(stored.feedback).toEqual([entry, { at: 6000, screen: "graph", text: "no feature id" }]);
		expect(stored.events).toEqual([]);
		expect(fs.readFileSync(feedbackFile(t), "utf8")).not.toContain("junk");

		const bad = async (body: unknown, message?: string): Promise<void> => {
			const response = await t.post("/api/feedback", body);
			expect(response.status).toBe(400);
			if (message) expect(((await response.json()) as ApiError).error).toContain(message);
		};
		await bad({ ...entry, text: "x".repeat(2001) }, "text");
		await bad({ ...entry, text: "   " }, "text");
		await bad({ ...entry, screen: "" }, "screen");
		await bad({ ...entry, screen: "s".repeat(65) }, "screen");
		await bad({ ...entry, feature: "f".repeat(65) }, "feature");
		await bad({ at: 1, text: "no screen" }, "screen");
		await bad({ ...entry, at: "now" }, "at");
		await bad([entry]);
		expect((await t.post("/api/feedback", { ...entry, text: "x".repeat(2000) })).status).toBe(204);
		expect((await readBack(t)).feedback).toHaveLength(3);
	});
});

describe("GET and DELETE /api/journal", () => {
	it("returns the most recent `limit` rows oldest first and rejects bad limits", async () => {
		const t = await startTestDaemon();
		await t.post("/api/journal", { events: Array.from({ length: 10 }, (_, index) => event({ at: index + 1, action: `a${index}` })) });
		for (let index = 0; index < 4; index++) await t.post("/api/feedback", { at: index + 1, screen: "s", text: `f${index}` });

		const latest = await readBack(t, 3);
		expect(latest.events.map(row => row.action)).toEqual(["a7", "a8", "a9"]);
		expect(latest.feedback.map(row => row.text)).toEqual(["f1", "f2", "f3"]);
		expect((await readBack(t)).events).toHaveLength(10);
		for (const limit of ["0", "-1", "5001", "x", ""]) expect((await t.get(`/api/journal?limit=${limit}`)).status).toBe(400);
	});

	it("DELETE wipes the journal, the feedback and their rotated generations", async () => {
		const t = await startTestDaemon({ journalMaxFileBytes: 150 });
		for (let index = 0; index < 6; index++) await t.post("/api/journal", { events: [event({ at: index + 1, action: `a${index}` })] });
		await t.post("/api/feedback", { at: 1, screen: "s", text: "gone soon" });
		expect(fs.existsSync(`${journalFile(t)}.1`)).toBe(true);

		const wiped = await t.del("/api/journal");
		expect(wiped.status).toBe(204);
		expect(await readBack(t)).toEqual({ events: [], feedback: [] });
		for (const file of [journalFile(t), `${journalFile(t)}.1`, feedbackFile(t), `${feedbackFile(t)}.1`]) {
			expect(fs.existsSync(file)).toBe(false);
		}
		// New events start a clean journal.
		expect((await t.post("/api/journal", { events: [event({ action: "after-wipe" })] })).status).toBe(204);
		expect((await readBack(t)).events.map(row => row.action)).toEqual(["after-wipe"]);
		expect((await t.del("/api/journal")).status).toBe(204);
		expect((await t.del("/api/journal")).status).toBe(204);
	});

	it("only GET, POST and DELETE are allowed on /api/journal, and POST on /api/feedback", async () => {
		const t = await startTestDaemon();
		expect((await t.put("/api/journal", {})).status).toBe(405);
		expect((await t.get("/api/feedback")).status).toBe(405);
	});
});

describe("storage", () => {
	it("creates both files mode 0600, and tightens a pre-existing looser file", async () => {
		const t = await startTestDaemon();
		fs.writeFileSync(journalFile(t), "", { mode: 0o644 });
		fs.chmodSync(journalFile(t), 0o644);
		await t.post("/api/journal", { events: [event()] });
		await t.post("/api/feedback", { at: 1, screen: "s", text: "t" });
		for (const file of [journalFile(t), feedbackFile(t)]) {
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it("rotates at the size limit, keeps exactly one previous file, and reads across both in order", async () => {
		const t = await startTestDaemon({ journalMaxFileBytes: 700 });
		const all: string[] = [];
		for (let index = 0; index < 40; index++) {
			const action = `act-${String(index).padStart(2, "0")}`;
			all.push(action);
			expect((await t.post("/api/journal", { events: [event({ at: index + 1, action })] })).status).toBe(204);
		}
		const current = journalFile(t);
		expect(fs.existsSync(`${current}.1`)).toBe(true);
		expect(fs.existsSync(`${current}.2`)).toBe(false);
		expect(fs.statSync(current).size).toBeLessThanOrEqual(700);
		expect(fs.statSync(`${current}.1`).size).toBeLessThanOrEqual(700);
		expect(fs.statSync(`${current}.1`).mode & 0o777).toBe(0o600);

		const stored = (await readBack(t, 1000)).events.map(row => row.action);
		// Whatever survived is a contiguous, ordered tail of what was written; the oldest rows aged out.
		expect(stored.length).toBeGreaterThan(5);
		expect(stored.length).toBeLessThan(40);
		expect(stored).toEqual(all.slice(all.length - stored.length));
	});
});
