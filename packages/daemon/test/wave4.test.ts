import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ListPinnedSessionsResponse,
	ListSessionRecipesResponse,
	ListSessionsResponse,
	SessionRecipe,
	SessionRecipeInput,
	SessionRecipeSource,
	SessionSummary,
	TranscriptSearchResponse,
} from "@omp-console/protocol";
import { PinStore } from "../src/pins/store";
import { searchTranscriptFiles } from "../src/history/transcript-search";
import { RecipeStore } from "../src/recipes/store";
import { readJsonLines, makeTmp } from "./helpers";
import { startTestDaemon, stopTestDaemons } from "./harness";

afterEach(stopTestDaemons);

function recentRow(id: string, sessionFile: string, lastActivityAt: number, cwd: string, title?: string): SessionSummary {
	return {
		id,
		...(title === undefined ? {} : { title }),
		cwd,
		sessionFile,
		state: "stopped",
		createdAt: lastActivityAt - 10,
		lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	};
}

function writeTranscript(file: string, entries: readonly Record<string, unknown>[]): void {
	fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("persistent pins", () => {
	it("survive store recreation and mark session summaries without changing other session metadata", async () => {
		const row = recentRow("saved-1", "/unused/session.jsonl", 100, "/work", "Saved work");
		const daemon = await startTestDaemon({ recent: [row] });

		const pin = await daemon.put("/api/pins/saved-1", { pinned: true });
		expect(pin.status).toBe(200);
		expect(await pin.json()).toEqual({ pinned: true });
		expect(await (await daemon.get("/api/pins")).json()).toEqual({ sessionIds: ["saved-1"] } satisfies ListPinnedSessionsResponse);
		const sessions = (await (await daemon.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(sessions.recent[0]).toMatchObject({ id: "saved-1", title: "Saved work", pinned: true });

		const reopened = new PinStore(daemon.stateDir);
		expect(await reopened.list()).toEqual(["saved-1"]);
		expect(fs.statSync(path.join(daemon.stateDir, "pinned-sessions.json")).mode & 0o777).toBe(0o600);

		const unpin = await daemon.put("/api/pins/saved-1", { pinned: false });
		expect(unpin.status).toBe(200);
		expect((await (await daemon.get("/api/sessions")).json() as ListSessionsResponse).recent[0]).toMatchObject({ pinned: false });
		expect(await new PinStore(daemon.stateDir).list()).toEqual([]);
	});
	it("keeps a pinned live session awake and lets it sleep once unpinned", async () => {
		const daemon = await startTestDaemon();
		const created = (await (await daemon.post("/api/sessions", { cwd: daemon.sessionsDir, title: "Pinned" })).json()) as SessionSummary;
		fs.writeFileSync(created.sessionFile!, '{"type":"message","text":"saved"}\n');
		expect((await daemon.put(`/api/pins/${created.id}`, { pinned: true })).status).toBe(200);

		expect((await daemon.post(`/api/sessions/${created.id}/sleep`)).status).toBe(409);
		expect((await daemon.put(`/api/pins/${created.id}`, { pinned: false })).status).toBe(200);
		expect((await daemon.post(`/api/sessions/${created.id}/sleep`)).status).toBe(200);
	});
	it("rejects pinning sessions that do not exist", async () => {
		const daemon = await startTestDaemon();
		const response = await daemon.put("/api/pins/missing-session", { pinned: true });

		expect(response.status).toBe(404);
		expect(await (await daemon.get("/api/pins")).json()).toEqual({ sessionIds: [] });
	});

	it("prunes a persisted pin after its archived session is trashed", async () => {
		const daemon = await startTestDaemon();
		const file = path.join(daemon.sessionsDir, "pruned.jsonl");
		writeTranscript(file, [{ type: "message", id: "first", message: { role: "user", content: "Keep this record" } }]);
		daemon.recent.push(recentRow("pruned", file, 100, daemon.dir, "Pruned"));
		expect((await daemon.put("/api/pins/pruned", { pinned: true })).status).toBe(200);
		expect((await daemon.put("/api/sessions/pruned/archive")).status).toBe(200);

		expect((await daemon.post("/api/sessions/pruned/trash")).status).toBe(200);
		expect(await (await daemon.get("/api/pins")).json()).toEqual({ sessionIds: [] });
	});

	it("keeps pin and recipe memory unchanged when atomic persistence fails", async () => {
		const stateDir = makeTmp("deck-store-write-failure-");
		const recipeInput: SessionRecipeInput = {
			name: "Nightly",
			cwd: "/work",
			machineId: "local",
			prompt: "Review reminders",
		};
		const recipe: SessionRecipe = { id: "recipe-1", ...recipeInput, createdAt: 1, updatedAt: 1 };
		fs.writeFileSync(path.join(stateDir, "pinned-sessions.json"), JSON.stringify({ version: 1, sessionIds: ["pinned-1"] }));
		fs.writeFileSync(path.join(stateDir, "recipes.json"), JSON.stringify({ version: 1, recipes: [recipe] }));
		const pins = new PinStore(stateDir);
		const recipes = new RecipeStore(stateDir);
		expect(await pins.list()).toEqual(["pinned-1"]);
		expect(await recipes.list()).toEqual([recipe]);

		fs.rmSync(stateDir, { recursive: true, force: true });
		fs.writeFileSync(stateDir, "directory replaced");
		await expect(pins.set("pinned-1", false)).rejects.toThrow();
		await expect(recipes.update(recipe.id, { ...recipeInput, name: "Changed" })).rejects.toThrow();
		await expect(recipes.remove(recipe.id)).rejects.toThrow();
		await expect(recipes.create({ ...recipeInput, name: "New" })).rejects.toThrow();

		expect(await pins.list()).toEqual(["pinned-1"]);
		expect(await recipes.list()).toEqual([recipe]);
	});
	it("quarantines corrupt pin and recipe state without breaking session or recipe routes", async () => {
		const stateDir = makeTmp("deck-corrupt-state-");
		fs.writeFileSync(path.join(stateDir, "pinned-sessions.json"), "{not json");
		fs.writeFileSync(path.join(stateDir, "recipes.json"), "{not json");
		const logs: string[] = [];
		const daemon = await startTestDaemon({ stateDir, log: message => logs.push(message) });

		expect((await daemon.get("/api/sessions")).status).toBe(200);
		expect((await daemon.get("/api/pins").then(response => response.json()))).toEqual({ sessionIds: [] });
		expect((await daemon.get("/api/recipes").then(response => response.json()))).toEqual({ recipes: [] });
		const files = fs.readdirSync(stateDir);
		expect(files.some(file => file.startsWith("pinned-sessions.json.corrupt-"))).toBe(true);
		expect(files.some(file => file.startsWith("recipes.json.corrupt-"))).toBe(true);
		expect(logs.some(message => message.includes("pin state is invalid"))).toBe(true);
		expect(logs.some(message => message.includes("recipe state is invalid"))).toBe(true);
	});
});

describe("saved recipes", () => {
	it("loads a source prompt, persists CRUD, and starts a session with the saved prompt and thinking level", async () => {
		const dump = path.join(makeTmp(), "worker-requests.jsonl");
		const daemon = await startTestDaemon({ workerFlags: ["--dump-requests", dump] });
		const sourceFile = path.join(daemon.sessionsDir, "source.jsonl");
		writeTranscript(sourceFile, [
			{ type: "message", id: "first-entry", timestamp: "2026-10-25T10:00:00.000Z", message: { role: "user", content: "Triage the reminders" } },
		]);
		daemon.recent.push(recentRow("source-session", sourceFile, 1_000, daemon.dir, "Reminder triage"));

		const source = await daemon.get("/api/recipes/source/source-session");
		expect(source.status).toBe(200);
		expect(await source.json()).toEqual({ name: "Reminder triage", cwd: daemon.dir, prompt: "Triage the reminders" } satisfies SessionRecipeSource);

		const input = {
			name: "Nightly triage",
			cwd: daemon.dir,
			machineId: "local",
			prompt: "Review today's Apple Reminders",
			model: "openai-codex/gpt-6-luna",
			thinkingLevel: "high",
		};
		const created = await daemon.post("/api/recipes", input);
		expect(created.status).toBe(201);
		const recipe = (await created.json()) as SessionRecipe;
		expect(recipe).toMatchObject(input);
		expect((await (await daemon.get("/api/recipes")).json() as ListSessionRecipesResponse).recipes).toEqual([recipe]);
		const recipeFile = path.join(daemon.stateDir, "recipes.json");
		expect(fs.existsSync(recipeFile)).toBe(true);
		expect((JSON.parse(fs.readFileSync(recipeFile, "utf8")) as { recipes: SessionRecipe[] }).recipes).toEqual([recipe]);
		const reopenedStore = new RecipeStore(daemon.stateDir);
		expect(await reopenedStore.list()).toEqual([recipe]);

		const startPath = `/api/recipes/${recipe.id}/start`;
		const startRequests = await Promise.all([
			daemon.post(startPath, { idempotencyKey: "nightly-start-1" }),
			daemon.post(startPath, { idempotencyKey: "nightly-start-1" }),
		]);
		expect(startRequests.map(response => response.status)).toEqual([201, 201]);
		const session = (await startRequests[0]!.json()) as SessionSummary;
		const replayed = (await startRequests[1]!.json()) as SessionSummary;
		expect(replayed.id).toBe(session.id);
		const workerDeadline = Date.now() + 2_000;
		let commands = readJsonLines(dump);
		while (!commands.some(command => command.t === "send-prompt" && command.text === input.prompt) && Date.now() < workerDeadline) {
			await Bun.sleep(10);
			commands = readJsonLines(dump);
		}
		expect(commands.filter(command => command.t === "send-prompt" && command.text === input.prompt)).toHaveLength(1);
		expect(commands.some(command => command.t === "set-agent-thinking" && command.level === "high")).toBe(true);
		const live = (await (await daemon.get("/api/sessions")).json() as ListSessionsResponse).live;
		expect(live.filter(row => row.id === session.id)).toHaveLength(1);
		const other = (await (await daemon.post("/api/recipes", { ...input, name: "Other recipe" })).json()) as SessionRecipe;
		const otherStart = await daemon.post(`/api/recipes/${other.id}/start`, { idempotencyKey: "nightly-start-1" });
		expect(otherStart.status).toBe(201);
		expect(((await otherStart.json()) as SessionSummary).id).not.toBe(session.id);
		expect((await daemon.del(`/api/recipes/${other.id}`)).status).toBe(204);

		const updated = await daemon.put(`/api/recipes/${recipe.id}`, { ...input, name: "Updated triage", prompt: "Review the newest reminders" });
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({ id: recipe.id, name: "Updated triage", prompt: "Review the newest reminders" });
		expect((await daemon.del(`/api/recipes/${recipe.id}`)).status).toBe(204);
		expect((await (await daemon.get("/api/recipes")).json() as ListSessionRecipesResponse).recipes).toEqual([]);
		expect((await (await daemon.get("/api/sessions")).json() as ListSessionsResponse).live.some(row => row.id === session.id)).toBe(true);
	});
	it("stops the created session when a recipe's first prompt cannot be delivered", async () => {
		const daemon = await startTestDaemon({ workerFlags: ["--fail-send-prompt"] });
		const created = await daemon.post("/api/recipes", {
			name: "Broken recipe",
			cwd: daemon.dir,
			machineId: "local",
			prompt: "Start this work",
		});
		expect(created.status).toBe(201);
		const recipe = (await created.json()) as SessionRecipe;

		const started = await daemon.post(`/api/recipes/${recipe.id}/start`, { idempotencyKey: "broken-start" });
		expect(started.status).toBe(500);
		expect(await started.json()).toMatchObject({ code: "internal" });
		const sessions = (await (await daemon.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(sessions.live.some(session => session.title === "Broken recipe")).toBe(false);
	});
});

describe("transcript search", () => {
	it("returns user and assistant text newest-first with entry ids, snippets, and no tool output", async () => {
		const daemon = await startTestDaemon();
		const olderFile = path.join(daemon.sessionsDir, "older.jsonl");
		const newerFile = path.join(daemon.sessionsDir, "newer.jsonl");
		writeTranscript(olderFile, [
			{ type: "message", id: "older-user", timestamp: "2026-10-25T09:00:00Z", message: { role: "user", content: "Find the cobalt comet report" } },
			{ type: "message", id: "tool-only", message: { role: "tool", content: "cobalt comet from a tool" } },
		]);
		writeTranscript(newerFile, [
			{ type: "message", id: "newer-user", timestamp: "2026-10-25T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "Track the cobalt comet" }] } },
			{ type: "message", id: "newer-assistant", timestamp: "2026-10-25T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "The cobalt comet is visible tonight." }, { type: "tool_result", text: "cobalt comet hidden tool output" }] } },
		]);
		daemon.recent.push(
			recentRow("older", olderFile, 100, daemon.dir, "Older report"),
			recentRow("newer", newerFile, 200, daemon.dir, "Tonight's sky"),
		);

		const response = await daemon.get("/api/search?q=cobalt%20comet");
		expect(response.status).toBe(200);
		const result = (await response.json()) as TranscriptSearchResponse;
		expect(result.results.map(hit => [hit.sessionId, hit.entryId])).toEqual([
			["newer", "newer-assistant"],
			["newer", "newer-user"],
			["older", "older-user"],
		]);
		const highlighted = result.results[0]!;
		expect(highlighted.title).toBe("Tonight's sky");
		expect(highlighted.snippet.slice(highlighted.matchStart, highlighted.matchEnd).toLowerCase()).toBe("cobalt comet");
		expect(result.results.some(hit => hit.entryId === "tool-only" || hit.snippet.includes("hidden tool output"))).toBe(false);
		expect(result.scannedSessions).toBe(2);
	});
	it("keeps source offsets when case folding changes earlier transcript text length", async () => {
		const daemon = await startTestDaemon();
		const file = path.join(daemon.sessionsDir, "unicode.jsonl");
		const text = "İİİİİİ foo bar";
		writeTranscript(file, [{ type: "message", id: "unicode-match", message: { role: "user", content: text } }]);
		daemon.recent.push(recentRow("unicode", file, 100, daemon.dir));

		const result = (await (await daemon.get("/api/search?q=FOO")).json()) as TranscriptSearchResponse;
		expect(result.results[0]).toMatchObject({
			entryId: "unicode-match",
			matchStart: text.indexOf("foo"),
			matchEnd: text.indexOf("foo") + 3,
		});
		expect(result.results[0]?.snippet.slice(result.results[0].matchStart, result.results[0].matchEnd)).toBe("foo");
	});

	it("finds an early match behind many non-matching messages", async () => {
		const daemon = await startTestDaemon();
		const file = path.join(daemon.sessionsDir, "mixed.jsonl");
		writeTranscript(file, [
			{ type: "message", id: "the-match", message: { role: "user", content: "needle first" } },
			...Array.from({ length: 60 }, (_, index) => ({
				type: "message",
				id: `other-${index}`,
				message: { role: "assistant", content: `other ${index}` },
			})),
		]);
		daemon.recent.push(recentRow("mixed", file, 100, daemon.dir));

		const result = (await (await daemon.get("/api/search?q=needle")).json()) as TranscriptSearchResponse;
		expect(result.results.map(hit => hit?.entryId)).toEqual(["the-match"]);
		expect(result.truncated).toBe(false);
	});

	it("stops a transcript scan between chunks when the request signal aborts", async () => {
		const file = path.join(makeTmp("deck-search-abort-"), "large.jsonl");
		fs.writeFileSync(file, `${JSON.stringify({
			type: "message",
			id: "large-entry",
			message: { role: "user", content: `needle ${"x".repeat(128 * 1024)}` },
		})}\n`);
		const controller = new AbortController();
		let clockCalls = 0;
		const result = await searchTranscriptFiles(
			[recentRow("large", file, 100, "/work")],
			"needle",
			async path => path,
			() => {
				clockCalls++;
				if (clockCalls === 4) controller.abort();
				return 1_000;
			},
			controller.signal,
		);

		expect(result).toEqual({ results: [], truncated: true, scannedSessions: 0 });
		expect(clockCalls).toBeGreaterThanOrEqual(4);
	});

	it("caps hits across multiple newest-first transcripts", async () => {
		const daemon = await startTestDaemon();
		const olderFile = path.join(daemon.sessionsDir, "cap-older.jsonl");
		const newerFile = path.join(daemon.sessionsDir, "cap-newer.jsonl");
		writeTranscript(olderFile, Array.from({ length: 30 }, (_, index) => ({
			type: "message",
			id: `older-${index}`,
			message: { role: "user", content: `needle older ${index}` },
		})));
		writeTranscript(newerFile, Array.from({ length: 30 }, (_, index) => ({
			type: "message",
			id: `newer-${index}`,
			message: { role: "user", content: `needle newer ${index}` },
		})));
		daemon.recent.push(
			recentRow("older-cap", olderFile, 100, daemon.dir),
			recentRow("newer-cap", newerFile, 200, daemon.dir),
		);

		const result = (await (await daemon.get("/api/search?q=needle")).json()) as TranscriptSearchResponse;
		expect(result.results).toHaveLength(50);
		expect(result.results[0]).toMatchObject({ sessionId: "newer-cap", entryId: "newer-29" });
		expect(result.results[29]).toMatchObject({ sessionId: "newer-cap", entryId: "newer-0" });
		expect(result.results[30]).toMatchObject({ sessionId: "older-cap", entryId: "older-29" });
		expect(result.results[49]).toMatchObject({ sessionId: "older-cap", entryId: "older-10" });
		expect(result.truncated).toBe(true);
	});

	it("caps the result page at 50 and reads no more than the newest 20 MiB of a transcript", async () => {
		const daemon = await startTestDaemon();
		const cappedFile = path.join(daemon.sessionsDir, "capped.jsonl");
		writeTranscript(cappedFile, Array.from({ length: 51 }, (_, index) => ({
			type: "message",
			id: `needle-${index}`,
			message: { role: "user", content: `needle ${index}` },
		})));
		daemon.recent.push(recentRow("capped", cappedFile, 100, daemon.dir));
		const capped = (await (await daemon.get("/api/search?q=needle")).json()) as TranscriptSearchResponse;
		expect(capped.results).toHaveLength(50);
		expect(capped.results[0]?.entryId).toBe("needle-50");
		expect(capped.truncated).toBe(true);

		const oversizedFile = path.join(daemon.sessionsDir, "oversized.jsonl");
		const descriptor = fs.openSync(oversizedFile, "w");
		try {
			const oldMatch = `${JSON.stringify({ type: "message", id: "old-match", message: { role: "user", content: "needle outside scan window" } })}\n`;
			fs.writeSync(descriptor, oldMatch, 0, "utf8");
			fs.ftruncateSync(descriptor, 21 * 1024 * 1024);
		} finally {
			fs.closeSync(descriptor);
		}
		daemon.recent.splice(0, daemon.recent.length, recentRow("oversized", oversizedFile, 200, daemon.dir));
		const bounded = (await (await daemon.get("/api/search?q=needle%20outside%20scan%20window")).json()) as TranscriptSearchResponse;
		expect(bounded.results).toEqual([]);
	});
});
