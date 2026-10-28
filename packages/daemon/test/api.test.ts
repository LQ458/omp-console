import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_MAX_WORKERS } from "../src/supervisor";
import type {
	ArchiveSessionRecord,
	ApiError,
	DaemonHealth,
	ListModelsResponse,
	ListProfilesResponse,
	ListSessionsResponse,
	RoomLinkResponse,
	SleepSettingsResponse,
	SetAgentModelResponse,
	SessionSummary,
	SessionTranscriptResponse,
	NewSessionSuggestions,
	QuotaResponse,
} from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { parseCollabLink } from "../../session-host/test/collab-web/link";
import { type TestDaemon, startTestDaemon, stopTestDaemons } from "./harness";
import { isAlive, makeTmp, readJsonLines } from "./helpers";
import { listPersistedSessions, RecentSessionScanError } from "../src/recent";
import { socket, until, waitOpen, waitText, closeAllSockets } from "./ws-helpers";

afterEach(async () => {
	closeAllSockets();
	await stopTestDaemons();
});

async function createSession(t: TestDaemon, body: Record<string, unknown> = {}): Promise<SessionSummary> {
	const res = await t.post("/api/sessions", { cwd: t.dir, ...body });
	expect(res.status).toBe(201);
	return (await res.json()) as SessionSummary;
}

async function waitForLiveSession(
	t: TestDaemon,
	id: string,
	predicate: (session: SessionSummary) => boolean,
	timeoutMs = 5_000,
): Promise<SessionSummary> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const response = await t.get("/api/sessions");
		const body = (await response.json()) as ListSessionsResponse;
		const session = body.live.find(row => row.id === id);
		if (session && predicate(session)) return session;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for session ${id} state`);
		await Bun.sleep(20);
	}
}

function recentRow(id: string, file: string, lastActivityAt: number): SessionSummary {
	return {
		id,
		cwd: "/work",
		sessionFile: file,
		state: "stopped",
		createdAt: 1,
		lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	};
}
function configureModelControl(t: Pick<TestDaemon, "agentDir">, reviewerOverride = "deck-open/available"): void {
	fs.mkdirSync(path.join(t.agentDir, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(t.agentDir, "models.yml"),
		[
			"providers:",
			"  deck-open:",
			"    baseUrl: https://control.example.test/v1",
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: available",
			"        name: Available fixture",
			"        contextWindow: 8192",
			"        maxTokens: 1024",
			"  deck-closed:",
			"    baseUrl: https://control.example.test/v1",
			"    auth: oauth",
			"    api: openai-completions",
			"    models:",
			"      - id: locked",
			"        name: Unavailable fixture",
			"        contextWindow: 8192",
			"        maxTokens: 1024",
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(t.agentDir, "config.yml"),
		[
			"modelRoles:",
			"  default: deck-open/available",
			"  task: deck-open/available",
			"  smol: deck-open/available",
			"  plan: deck-closed/locked",
			"task:",
			"  agentModelOverrides:",
			`    reviewer: ${reviewerOverride}`,
			"    untouched: deck-open/available",
			"",
		].join("\n"),
	);
	writeAgent(t.agentDir, "reviewer", "@task");
	writeAgent(t.agentDir, "custom-user");
}
async function startModelTestDaemon(reviewerOverride = "deck-open/available"): Promise<TestDaemon> {
	const agentDir = makeTmp("deck-agent-");
	configureModelControl({ agentDir }, reviewerOverride);
	return startTestDaemon({ agentDir });
}


function writeAgent(root: string, name: string, model?: string): void {
	const modelLine = model === undefined ? "" : `model: ${JSON.stringify(model)}\n`;
	fs.writeFileSync(
		path.join(root, "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: ${name} fixture\n${modelLine}---\nFixture agent.\n`,
	);
}

function readConfig(t: TestDaemon): Record<string, unknown> {
	const parsed = YAML.parse(fs.readFileSync(path.join(t.agentDir, "config.yml"), "utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config.yml is not a YAML mapping");
	return parsed as Record<string, unknown>;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} is not a YAML mapping`);
	return value as Record<string, unknown>;
}

describe("model and profile control API", () => {
	it("lists all catalog models with auth availability booleans and effective roles only", async () => {
		const t = await startModelTestDaemon();
		const response = await t.get("/api/models");
		expect(response.status).toBe(200);
		const body = (await response.json()) as ListModelsResponse;
		expect(body.models.find(model => model.selector === "deck-open/available")).toMatchObject({
			provider: "deck-open",
			label: "Available fixture",
			available: true,
		});
		expect(body.models.find(model => model.selector === "deck-closed/locked")).toMatchObject({
			available: false,
		});
		expect(body.roles).toMatchObject({ default: "deck-open/available", plan: "deck-closed/locked" });
		expect(body.models.every(model => Object.keys(model).sort().join(",") === "available,label,provider,selector")).toBe(true);
		expect(JSON.stringify(body)).not.toContain("apiKey");
		expect(JSON.stringify(body)).not.toContain("authStorage");
	});

	it("discovers bundled, user, and cwd-scoped project profiles with omp model resolution", async () => {
		const t = await startModelTestDaemon();
		const projectAgents = path.join(t.dir, ".omp", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		writeAgent(path.join(t.dir, ".omp"), "reviewer", "deck-open/available");
		writeAgent(path.join(t.dir, ".omp"), "project-only", "deck-open/available");

		const unscoped = (await (await t.get("/api/profiles")).json()) as ListProfilesResponse;
		const reviewer = unscoped.profiles.find(profile => profile.name === "reviewer");
		expect(reviewer).toMatchObject({
			source: "user",
			definitionModels: ["@task"],
			override: "deck-open/available",
			effectiveModel: "deck-open/available",
		});
		expect(unscoped.profiles.find(profile => profile.name === "custom-user")).toMatchObject({
			source: "user",
			definitionModels: [],
		});
		expect(unscoped.profiles.find(profile => profile.name === "scout")?.source).toBe("bundled");
		expect(unscoped.profiles.some(profile => profile.name === "project-only")).toBe(false);

		const scoped = (await (await t.get(`/api/profiles?cwd=${encodeURIComponent(t.dir)}`)).json()) as ListProfilesResponse;
		expect(scoped.profiles.find(profile => profile.name === "reviewer")).toMatchObject({
			source: "project",
			definitionModels: ["deck-open/available"],
			override: "deck-open/available",
			effectiveModel: "deck-open/available",
		});
		expect(scoped.profiles.find(profile => profile.name === "project-only")?.source).toBe("project");
		expect((await t.get("/api/profiles?cwd=relative")).status).toBe(400);
	});

	it("writes and clears one settings entry atomically, rejects unusable selectors and unknown names", async () => {
		const t = await startModelTestDaemon("deck-closed/locked");

		const beforeProfile = readConfig(t);
		const profileResponse = await t.put("/api/profiles/reviewer/model", { selector: "deck-open/available" });
		expect(profileResponse.status).toBe(204);
		expect(await profileResponse.text()).toBe("");
		const profileBeforeTask = nestedRecord(beforeProfile, "task");
		const profileBeforeOverrides = nestedRecord(profileBeforeTask, "agentModelOverrides");
		expect(readConfig(t)).toEqual({
			...beforeProfile,
			task: {
				...profileBeforeTask,
				agentModelOverrides: { ...profileBeforeOverrides, reviewer: "deck-open/available" },
			},
		});

		const beforeClear = readConfig(t);
		const clearResponse = await t.put("/api/profiles/reviewer/model", { selector: null });
		expect(clearResponse.status).toBe(204);
		const clearTask = nestedRecord(beforeClear, "task");
		const clearOverrides = nestedRecord(clearTask, "agentModelOverrides");
		const expectedOverrides = { ...clearOverrides };
		delete expectedOverrides.reviewer;
		expect(readConfig(t)).toEqual({
			...beforeClear,
			task: { ...clearTask, agentModelOverrides: expectedOverrides },
		});

		const beforeRole = readConfig(t);
		const roleResponse = await t.put("/api/model-roles/plan", { selector: "deck-open/available" });
		expect(roleResponse.status).toBe(204);
		const beforeRoles = nestedRecord(beforeRole, "modelRoles");
		expect(readConfig(t)).toEqual({
			...beforeRole,
			modelRoles: { ...beforeRoles, plan: "deck-open/available" },
		});

		expect((await t.put("/api/model-roles/plan", { selector: "deck-closed/locked" })).status).toBe(400);
		expect((await t.put("/api/model-roles/ghost", { selector: "deck-open/available" })).status).toBe(404);
		expect((await t.put("/api/profiles/ghost/model", { selector: "deck-open/available" })).status).toBe(404);
		expect((await t.put("/api/profiles/reviewer/model", { selector: "no-such-model" })).status).toBe(400);
	});
	it("rejects model-role aliases without altering settings but still allows profile aliases", async () => {
		const t = await startModelTestDaemon();
		const configPath = path.join(t.agentDir, "config.yml");
		const before = fs.readFileSync(configPath, "utf8");

		for (const selector of ["@default", "@task", "pi/task", "*"]) {
			const response = await t.put("/api/model-roles/default", { selector });
			expect(response.status).toBe(400);
			expect(fs.readFileSync(configPath, "utf8")).toBe(before);
		}

		expect((await t.put("/api/profiles/reviewer/model", { selector: "@smol" })).status).toBe(204);
	});

	it("only accepts exact provider/id selectors (a fuzzy match must not pick a different model)", async () => {
		const t = await startModelTestDaemon();
		const configPath = path.join(t.agentDir, "config.yml");
		const before = fs.readFileSync(configPath, "utf8");
		for (const selector of ["a: b", "available", "deck-open", "DECK-OPEN/available", "deck-open/avail", "@no-such-role", "deck-open/available:bogus"]) {
			expect((await t.put("/api/profiles/reviewer/model", { selector })).status).toBe(400);
			expect(fs.readFileSync(configPath, "utf8")).toBe(before);
		}
		expect((await t.put("/api/profiles/reviewer/model", { selector: "deck-open/available:high" })).status).toBe(204);
	});

	it("lists prototype-key project profiles and rejects prototype-key profile and role writes", async () => {
		const t = await startModelTestDaemon();
		const projectAgents = path.join(t.dir, ".omp", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		for (const name of ["__proto__", "constructor", "prototype"]) writeAgent(path.join(t.dir, ".omp"), name);

		const listed = await t.get(`/api/profiles?cwd=${encodeURIComponent(t.dir)}`);
		expect(listed.status).toBe(200);
		const profiles = (await listed.json()) as ListProfilesResponse;
		expect(profiles.profiles.map(profile => profile.name)).toEqual(expect.arrayContaining(["__proto__", "constructor", "prototype"]));

		const configPath = path.join(t.agentDir, "config.yml");
		const before = fs.readFileSync(configPath, "utf8");
		for (const name of ["__proto__", "constructor", "prototype"]) {
			expect((await t.put(`/api/profiles/${name}/model`, { selector: "deck-open/available" })).status).toBe(400);
			expect(fs.readFileSync(configPath, "utf8")).toBe(before);
			expect((await t.put(`/api/model-roles/${name}`, { selector: "deck-open/available" })).status).toBe(400);
			expect(fs.readFileSync(configPath, "utf8")).toBe(before);
		}
	});

	it("clears an override for a profile that has been removed", async () => {
		const t = await startModelTestDaemon();
		writeAgent(t.agentDir, "removed-profile");
		expect((await t.put("/api/profiles/removed-profile/model", { selector: "deck-open/available" })).status).toBe(204);
		fs.rmSync(path.join(t.agentDir, "agents", "removed-profile.md"));

		const configPath = path.join(t.agentDir, "config.yml");
		expect((await t.put("/api/profiles/removed-profile/model", { selector: null })).status).toBe(204);
		const cleared = fs.readFileSync(configPath, "utf8");
		expect(cleared).not.toContain("removed-profile:");
		expect((await t.put("/api/profiles/removed-profile/model", { selector: null })).status).toBe(404);
		expect(fs.readFileSync(configPath, "utf8")).toBe(cleared);
	});

});

describe("POST /api/sessions/:id/abort", () => {
	it("aborts a running fake-worker turn, then reports idle and unknown sessions distinctly", async () => {
		const t = await startTestDaemon({ workerFlags: ["--streaming-forever"] });
		const session = await createSession(t);

		const response = await t.post(`/api/sessions/${session.id}/abort`);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ aborted: true });
		expect((await t.post(`/api/sessions/${session.id}/abort`)).status).toBe(409);
		expect((await t.post("/api/sessions/missing/abort")).status).toBe(404);
	});

	it("copies pending question and kind from state and clears them after resolution", async () => {
		const t = await startTestDaemon({ workerFlags: ["--asking-approval", "--clear-pending-after", "500"] });
		const session = await createSession(t);
		const asking = await waitForLiveSession(t, session.id, row => row.pendingQuestion !== undefined);
		expect(asking).toMatchObject({
			state: "asking",
			awaitingAnswer: true,
			pendingQuestion: "Approve this action?",
			pendingKind: "approval",
		});
		const idle = await waitForLiveSession(t, session.id, row => row.state === "idle" && row.pendingQuestion === undefined);
		expect(idle.pendingKind).toBeUndefined();
		expect(idle.awaitingAnswer).toBe(false);
	});
});

describe("zero-configuration new-session API", () => {
	it("uses persisted terminal sessions for recent project folders without configured roots", async () => {
		const t = await startTestDaemon({ withoutConfiguredRoots: true, listRecent: listPersistedSessions });
		const previousSessionsDir = process.env.OMP_CONSOLE_SESSIONS_DIR;
		const projectA = path.join(t.dir, "project-a");
		const projectB = path.join(t.dir, "project-b");
		await fs.promises.mkdir(projectA);
		await fs.promises.mkdir(projectB);
		const now = Date.now();
		const bucket = path.join(t.sessionsDir, "fixture-bucket");
		fs.mkdirSync(bucket, { recursive: true });
		const seed = (id: string, cwd: string, lastActivityAt: number, prompt?: string): string => {
			const file = path.join(bucket, `${id}.jsonl`);
			const header = JSON.stringify({
				type: "session",
				id,
				cwd,
				timestamp: new Date(lastActivityAt).toISOString(),
				title: id,
			});
			const entries = [
				header,
				...(prompt === undefined
					? []
					: [
							JSON.stringify({ type: "message", message: { role: "user", content: prompt } }),
							JSON.stringify({ type: "message", message: { role: "assistant", content: "fixture response" } }),
						]),
			];
			fs.writeFileSync(file, `${entries.join("\n")}\n`);
			fs.utimesSync(file, new Date(lastActivityAt), new Date(lastActivityAt));
			return file;
		};
		seed("alpha-old", projectA, now - 4_000);
		seed("alpha-new", projectA, now - 1_000);
		seed("beta", projectB, now - 500);
		const deletedFile = seed("deleted", path.join(t.dir, "deleted-project"), now - 100, "read-only fixture prompt");
		const originalDeletedBytes = fs.readFileSync(deletedFile);
		process.env.OMP_CONSOLE_SESSIONS_DIR = t.sessionsDir;
		try {
			const response = await t.get("/api/new-session/suggestions");
			expect(response.status).toBe(200);
			const suggestions = (await response.json()) as NewSessionSuggestions;
			expect(suggestions.recent).toEqual([
				{ cwd: projectB, name: "project-b", workspaceId: `project:${projectB}`, sessions30d: 1, lastUsedAt: now - 500 },
				{ cwd: projectA, name: "project-a", workspaceId: `project:${projectA}`, sessions30d: 2, lastUsedAt: now - 1_000 },
			]);

			const sessions = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
			expect(sessions.recent).toHaveLength(4);
			expect(sessions.recent.find(session => session.id === "deleted")).toMatchObject({ source: "terminal", cwdExists: false });
			expect(sessions.recent.find(session => session.id === "alpha-new")).toMatchObject({ source: "terminal", cwdExists: true });
			const transcriptResponse = await t.get("/api/sessions/deleted/transcript");
			expect(transcriptResponse.status).toBe(200);
			expect((await transcriptResponse.json() as SessionTranscriptResponse)).toEqual({
				messages: [
					{ role: "user", text: "read-only fixture prompt" },
					{ role: "assistant", text: "fixture response" },
				],
				truncated: false,
			});
			expect(fs.readFileSync(deletedFile)).toEqual(originalDeletedBytes);

			const started = await t.post("/api/sessions", { cwd: projectA });
			expect(started.status).toBe(201);
			expect(((await started.json()) as SessionSummary).cwd).toBe(projectA);
		} finally {
			if (previousSessionsDir === undefined) delete process.env.OMP_CONSOLE_SESSIONS_DIR;
			else process.env.OMP_CONSOLE_SESSIONS_DIR = previousSessionsDir;
		}
	});

	it("returns the persisted-session scan error and directory instead of an empty list", async () => {
		const directory = makeTmp("deck-api-scan-error-");
		const t = await startTestDaemon({
			listRecent: async () => {
				throw new RecentSessionScanError(directory, new Error("permission denied"));
			},
		});
		const response = await t.get("/api/sessions");
		expect(response.status).toBe(500);
		expect((await response.json() as ApiError).error).toContain(`Could not scan omp sessions in ${directory}: permission denied`);
	});
});

describe("GET /api/sessions", () => {
	it("returns live sessions plus recent persisted ones, newest first, without a hosted session in both lists", async () => {
		const t = await startTestDaemon({
			recent: [recentRow("old-1", "/s/old-1.jsonl", 100), recentRow("old-2", "/s/old-2.jsonl", 300), recentRow("old-3", "/s/old-3.jsonl", 200)],
			hostedSessionNames: ["old-2.jsonl"],
		});
		const empty = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(empty.live).toEqual([]);
		expect(empty.recent.map(s => s.id)).toEqual(["old-2", "old-3", "old-1"]);

		// Resuming a persisted session moves it from `recent` to `live`.
		const live = await createSession(t, { resumeSessionFile: writeFile(t, "old-2.jsonl") });
		expect(live.state).toBe("idle");
		const body = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(body.live.map(s => s.id)).toEqual(["old-2"]);
		expect(body.live[0]!.roomId).toBeTruthy();
		expect(body.recent.map(s => s.id)).toEqual(["old-3", "old-1"]);

		const limited = (await (await t.get("/api/sessions?limit=1")).json()) as ListSessionsResponse;
		expect(limited.recent.map(s => s.id)).toEqual(["old-3"]);
		const bad = await t.get("/api/sessions?limit=abc");
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as ApiError).code).toBe("bad-request");
		const emptyLimit = await t.get("/api/sessions?limit=");
		expect(emptyLimit.status).toBe(400);
	});

	it("hides a recent row whose session file is hosted even when its id differs", async () => {
		const t = await startTestDaemon({ hostedSessionNames: ["hosted.jsonl"] });
		const file = writeFile(t, "hosted.jsonl");
		t.recent.push(recentRow("different-id", file, 5));
		const live = await createSession(t, { resumeSessionFile: file });
		expect(live.sessionFile).toBe(file);
		const body = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(body.live).toHaveLength(1);
		expect(body.recent).toEqual([]);
	});

	it("keeps hidden sessions out of both lists and returns the same session for a repeated idempotency key", async () => {
		const t = await startTestDaemon({ hostedSessionNames: ["hidden.jsonl"] });
		const file = writeFile(t, "hidden.jsonl");
		const hidden = await createSession(t, { resumeSessionFile: file, hidden: true, title: "quick-ask" });
		expect(hidden.hidden).toBe(true);
		expect(hidden.title).toBe("quick-ask");
		t.recent.push(recentRow("hidden-row", file, 5));
		const body = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(body.live).toEqual([]);
		expect(body.recent).toEqual([]);

		const first = await createSession(t, { idempotencyKey: "move-1" });
		const again = await createSession(t, { idempotencyKey: "move-1" });
		expect(again.id).toBe(first.id);
		expect((await t.post("/api/sessions", { cwd: t.sessionsDir, hidden: "yes" })).status).toBe(400);
	});
});
describe("session archive API", () => {
	it("hides a persisted row, lists its saved metadata, and restores it without changing the session file", async () => {
		const t = await startTestDaemon({});
		const file = writeFile(t, "archive-roundtrip.jsonl");
		const originalBytes = fs.readFileSync(file);
		const row = { ...recentRow("saved", file, 100), title: "Saved work" };
		t.recent.push(row);

		const archiveResponse = await t.put("/api/sessions/saved/archive");
		expect(archiveResponse.status).toBe(200);
		const record = (await archiveResponse.json()) as ArchiveSessionRecord;
		expect(record).toMatchObject({ title: "Saved work", cwd: "/work", sessionFile: file, lastActivityAt: 100 });
		const hidden = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(hidden.recent.map(session => session.id)).toEqual([]);
		expect(hidden.archived?.map(session => session.id)).toEqual(["saved"]);
		expect(fs.readFileSync(file)).toEqual(originalBytes);
		// A retry (or the same tap on another device) is answered with the record already stored.
		const retry = await t.put("/api/sessions/saved/archive");
		expect(retry.status).toBe(200);
		expect(((await retry.json()) as ArchiveSessionRecord).archivedAt).toBe(record.archivedAt);

		t.recent.splice(0);
		const fallback = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(fallback.archived?.[0]).toMatchObject({
			id: "saved",
			title: "Saved work",
			cwd: "/work",
			sessionFile: file,
			lastActivityAt: 100,
		});

		t.recent.push(row);
		expect((await t.del("/api/sessions/saved/archive")).status).toBe(204);
		const restored = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(restored.recent.map(session => session.id)).toEqual(["saved"]);
		expect(restored.archived).toEqual([]);
		expect(fs.readFileSync(file)).toEqual(originalBytes);
	});

	it("stops an idle live session before listing it as archived", async () => {
		const t = await startTestDaemon({});
		const session = await createSession(t);

		// Two devices archive the same live session at once: both succeed and it stays archived.
		const [first, second] = await Promise.all([
			t.put(`/api/sessions/${session.id}/archive`),
			t.put(`/api/sessions/${session.id}/archive`),
		]);
		expect([first.status, second.status]).toEqual([200, 200]);
		expect(t.daemon.supervisor.list().some(item => item.id === session.id)).toBe(false);
		const list = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(list.live).toEqual([]);
		expect(list.archived?.map(item => item.id)).toEqual([session.id]);
	});

	it("requires confirmation before stopping a working live session and rejects hidden or unknown ids", async () => {
		const t = await startTestDaemon({ workerFlags: ["--streaming-forever"] });
		const working = await createSession(t);
		await waitForLiveSession(t, working.id, row => row.state === "streaming");

		const conflict = await t.put(`/api/sessions/${working.id}/archive`);
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as ApiError).code).toBe("conflict");
		expect((await t.daemon.supervisor.list()).some(item => item.id === working.id)).toBe(true);

		const stopped = await t.put(`/api/sessions/${working.id}/archive`, { stopIfLive: true });
		expect(stopped.status).toBe(200);
		expect(t.daemon.supervisor.list().some(item => item.id === working.id)).toBe(false);

		const hidden = await createSession(t, { hidden: true, title: "quick-ask" });
		const hiddenResponse = await t.put(`/api/sessions/${hidden.id}/archive`);
		expect(hiddenResponse.status).toBe(400);
		expect(((await hiddenResponse.json()) as ApiError).code).toBe("bad-request");
		expect((await t.put("/api/sessions/missing/archive")).status).toBe(404);
	});

	it("restores an archived session when its file is resumed", async () => {
		const t = await startTestDaemon({ hostedSessionNames: ["resume-archived.jsonl"] });
		const file = writeFile(t, "resume-archived.jsonl");
		t.recent.push(recentRow("archived-id", file, 200));
		expect((await t.put("/api/sessions/archived-id/archive")).status).toBe(200);

		const resumed = await createSession(t, { resumeSessionFile: file });
		expect(resumed.sessionFile).toBe(file);
		const list = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(list.archived).toEqual([]);
		expect(list.live.some(item => item.sessionFile === file)).toBe(true);
	});
});


describe("session delete (trash) API", () => {
	it("deletes only archived sessions, moving the transcript and its subagent folder out of the store", async () => {
		const t = await startTestDaemon({});
		const file = writeFile(t, "to-delete.jsonl");
		const folder = file.slice(0, -".jsonl".length);
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, "Sub.jsonl"), "{}\n");
		t.recent.push(recentRow("doomed", file, 100));

		const notArchived = await t.post("/api/sessions/doomed/trash");
		expect(notArchived.status).toBe(409);
		expect(fs.existsSync(file)).toBe(true);

		expect((await t.put("/api/sessions/doomed/archive")).status).toBe(200);
		const response = await t.post("/api/sessions/doomed/trash");
		expect(response.status).toBe(200);
		const { trashedTo } = (await response.json()) as { trashedTo: string | null };
		expect(trashedTo?.startsWith(path.join(t.stateDir, "trash"))).toBe(true);
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(folder)).toBe(false);
		expect(fs.readFileSync(path.join(trashedTo!, "to-delete.jsonl"), "utf8")).toBe("{}\n");
		expect(fs.existsSync(path.join(trashedTo!, "to-delete", "Sub.jsonl"))).toBe(true);

		t.recent.splice(0);
		const list = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(list.archived).toEqual([]);
		// Already gone: a second tap is refused, nothing else moves.
		expect((await t.post("/api/sessions/doomed/trash")).status).toBe(409);
	});

	it("never lets a delete and a resume of the same transcript both succeed", async () => {
		const t = await startTestDaemon({});
		for (let round = 0; round < 4; round++) {
			const file = writeFile(t, `race-${round}.jsonl`);
			t.recent.splice(0, t.recent.length, recentRow(`race-${round}`, file, 100));
			expect((await t.put(`/api/sessions/race-${round}/archive`)).status).toBe(200);
			const [trashed, resumed] = await Promise.all([
				t.post(`/api/sessions/race-${round}/trash`),
				t.post("/api/sessions", { cwd: t.dir, resumeSessionFile: file }),
			]);
			// Exactly one wins. A resume that parses after the move finds no file (400) rather than the lock (409).
			if (trashed.status === 200) expect([400, 409]).toContain(resumed.status);
			else expect([trashed.status, resumed.status]).toEqual([409, 201]);
			expect(fs.existsSync(file)).toBe(resumed.status === 201);
			if (resumed.status === 201) await t.del(`/api/sessions/${((await resumed.json()) as { id: string }).id}`);
		}
	});

	it("refuses a delete while any of two forks of the transcript is still starting", async () => {
		const t = await startTestDaemon({ workerFlags: ["--ready-delay-ms", "1000"] });
		const file = writeFile(t, "forked.jsonl");
		t.recent.push(recentRow("forked", file, 100));
		expect((await t.put("/api/sessions/forked/archive")).status).toBe(200);
		const first = t.post("/api/sessions", { cwd: t.dir, forkFrom: { sessionFile: file } });
		await Bun.sleep(400);
		const second = t.post("/api/sessions", { cwd: t.dir, forkFrom: { sessionFile: file } });
		expect((await first).status).toBe(201);
		// The first fork is done, the second still starting: the transcript stays.
		expect((await t.post("/api/sessions/forked/trash")).status).toBe(409);
		expect(fs.existsSync(file)).toBe(true);
		expect((await second).status).toBe(201);
	});

	it("shows a deleted session again when its transcript is put back and resumed", async () => {
		const t = await startTestDaemon({ hostedSessionNames: ["back.jsonl"] });
		const file = writeFile(t, "back.jsonl");
		t.recent.push(recentRow("back", file, 100));
		expect((await t.put("/api/sessions/back/archive")).status).toBe(200);
		const { trashedTo } = (await (await t.post("/api/sessions/back/trash")).json()) as { trashedTo: string };
		fs.renameSync(path.join(trashedTo, "back.jsonl"), file);

		const resumed = await t.post("/api/sessions", { cwd: t.dir, resumeSessionFile: file });
		expect(resumed.status).toBe(201);
		const list = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(list.live.map(session => session.id)).toContain("back");
	});

	it("refuses a transcript that is a symbolic link, moving nothing", async () => {
		const t = await startTestDaemon({});
		const victim = writeFile(t, "victim.jsonl");
		const link = path.join(t.sessionsDir, "linky.jsonl");
		fs.symlinkSync(victim, link);
		t.recent.push(recentRow("linky", link, 100));
		expect((await t.put("/api/sessions/linky/archive")).status).toBe(200);

		expect((await t.post("/api/sessions/linky/trash")).status).toBe(400);
		expect(fs.existsSync(victim)).toBe(true);
	});

	it("never moves a file outside the session store", async () => {
		const t = await startTestDaemon({});
		const outside = path.join(makeTmp("deck-outside-"), "elsewhere.jsonl");
		fs.writeFileSync(outside, "{}\n");
		t.recent.push(recentRow("outside", fs.realpathSync(outside), 100));
		expect((await t.put("/api/sessions/outside/archive")).status).toBe(200);

		expect((await t.post("/api/sessions/outside/trash")).status).toBe(400);
		expect(fs.existsSync(outside)).toBe(true);
	});

	it("drops the archive entry when the transcript is already gone", async () => {
		const t = await startTestDaemon({});
		const file = writeFile(t, "vanished.jsonl");
		t.recent.push(recentRow("vanished", file, 100));
		expect((await t.put("/api/sessions/vanished/archive")).status).toBe(200);
		fs.rmSync(file);
		t.recent.splice(0);

		const response = await t.post("/api/sessions/vanished/trash");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ trashedTo: null });
	});
});

function writeFile(t: TestDaemon, name: string): string {
	const file = path.join(t.sessionsDir, name);
	fs.writeFileSync(file, "{}\n");
	return fs.realpathSync(file);
}

describe("POST /api/sessions", () => {
	it("creates a new session and returns its summary", async () => {
		const t = await startTestDaemon({});
		const summary = await createSession(t, { model: "x/y" });
		expect(summary).toMatchObject({ cwd: t.dir, model: "x/y", state: "idle", awaitingAnswer: false, goalActive: false });
		expect(summary.id).toMatch(/^sess-/);
		expect(t.daemon.supervisor.list()).toHaveLength(1);
	});

	it("passes resume and fork targets to the worker without modifying the fork source", async () => {
		const dump = path.join(makeTmp(), "launch.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump", dump], hostedSessionNames: ["r.jsonl"] });
		const resumeFile = writeFile(t, "r.jsonl");
		const forkFile = writeFile(t, "f.jsonl");
		fs.writeFileSync(forkFile, [
			JSON.stringify({ type: "session", id: "terminal", cwd: t.dir, timestamp: new Date().toISOString() }),
			JSON.stringify({ type: "message", message: { role: "user", content: "the original prompt" } }),
			"",
		].join("\n"));
		const originalForkBytes = fs.readFileSync(forkFile);
		await createSession(t, { resumeSessionFile: resumeFile });
		await createSession(t, { forkFrom: { sessionFile: forkFile, entryId: "e1" } });
		const [resume, fork] = readJsonLines(dump).map(l => l.argv as string[]);
		expect(resume!.slice(resume!.indexOf("--resume"))).toEqual(["--resume", resumeFile]);
		expect(fork!.slice(fork!.indexOf("--fork"))).toEqual(["--fork", `${forkFile}:e1`]);
		expect(fs.readFileSync(forkFile)).toEqual(originalForkBytes);
	});

	it("rejects resume and fork files outside the active sessions directory without revealing paths", async () => {
		const t = await startTestDaemon({});
		const existingOutside = path.join(t.dir, "outside.jsonl");
		const missingOutside = path.join(t.dir, "missing.jsonl");
		fs.writeFileSync(existingOutside, "{}\n");
		const responses = await Promise.all([
			t.post("/api/sessions", { cwd: t.dir, resumeSessionFile: existingOutside }),
			t.post("/api/sessions", { cwd: t.dir, resumeSessionFile: missingOutside }),
			t.post("/api/sessions", { cwd: t.dir, forkFrom: { sessionFile: existingOutside, entryId: "e1" } }),
			t.post("/api/sessions", { cwd: t.dir, forkFrom: { sessionFile: missingOutside } }),
		]);
		const results = await Promise.all(
			responses.map(async response => ({ status: response.status, body: (await response.json()) as ApiError })),
		);

		expect(results.map(({ status, body }) => [status, body.code])).toEqual(
			Array.from({ length: 4 }, () => [400, "bad-request"]),
		);
		expect(new Set(results.map(({ body }) => body.error)).size).toBe(1);
		expect(JSON.stringify(results)).not.toContain(t.dir);
	});

	it("rejects a session-directory symlink that resolves outside the active sessions directory", async () => {
		const t = await startTestDaemon({});
		const outside = path.join(t.dir, "outside.jsonl");
		const symlink = path.join(t.sessionsDir, "escape.jsonl");
		fs.writeFileSync(outside, "{}\n");
		fs.symlinkSync(outside, symlink);

		const response = await t.post("/api/sessions", { cwd: t.dir, resumeSessionFile: symlink });
		const body = (await response.json()) as ApiError;
		expect(response.status).toBe(400);
		expect(body.code).toBe("bad-request");
		expect(body.error).not.toContain(outside);
	});

	it("returns a generic 404 without echoing the requested path", async () => {
		const t = await startTestDaemon({});
		const pathFragment = "secret-session-path.jsonl";
		const response = await t.get(`/api/no-such-route/${pathFragment}`);
		const body = (await response.json()) as ApiError;

		expect(response.status).toBe(404);
		expect(body.code).toBe("not-found");
		expect(body.error).not.toContain(pathFragment);
	});

	it("sets the required security headers on static and API responses", async () => {
		const webDir = makeTmp("deck-web-");
		fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>deck</title>");
		const t = await startTestDaemon({ webDir });
		const responses = await Promise.all([t.get("/index.html"), t.get("/api/health"), t.get("/api/no-such-route")]);
		const policy =
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

		for (const response of responses) {
			expect(response.headers.get("Content-Security-Policy")).toBe(policy);
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		}
	});

	it("returns an eligible sleep candidate at the worker limit and sleeping it frees the slot", async () => {
		const t = await startTestDaemon({ maxWorkers: 1 });
		const first = await createSession(t);
		fs.writeFileSync(first.sessionFile!, "resumable transcript\n");

		const capped = await t.post("/api/sessions", { cwd: t.dir });
		expect(capped.status).toBe(409);
		expect((await capped.json()) as ApiError).toMatchObject({
			code: "conflict",
			sleepCandidate: { id: first.id, title: first.title, idleMinutes: 0 },
		});

		const slept = await t.post(`/api/sessions/${first.id}/sleep`);
		expect(slept.status).toBe(200);
		expect(await slept.json()).toEqual({ state: "asleep" });
		const list = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(list.live.find(session => session.id === first.id)?.state).toBe("asleep");
		expect((await createSession(t)).state).toBe("idle");
	});

	it("writes transcript-derived history before sleeping without a worker model request", async () => {
		const requests = path.join(makeTmp("deck-sleep-history-"), "requests.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump-requests", requests] });
		const session = await createSession(t, { title: "History checkpoint" });
		fs.writeFileSync(
			session.sessionFile!,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "Implement transcript checkpointing" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "Sleeping preserves this transcript" } }),
			].join("\n") + "\n",
		);

		expect((await t.post(`/api/sessions/${session.id}/sleep`)).status).toBe(200);
		const history = (await (await t.get("/api/history")).json()) as {
			nodes: Array<{ sessionId: string; keyPoints?: { goal?: string; outcome?: string } }>;
		};
		expect(history.nodes.find(node => node.sessionId === session.id)?.keyPoints).toMatchObject({
			goal: "Implement transcript checkpointing",
			outcome: "Sleeping preserves this transcript",
		});
		expect(readJsonLines(requests).some(command => command.t === "summarize")).toBe(false);
	});
	it("does not include an asleep session's model in live quota providers", async () => {
		const t = await startTestDaemon({});
		const asleep = await createSession(t, { model: "sleep-only-provider/test-model" });
		expect(t.daemon.supervisor.get(asleep.id)?.model).toBe("sleep-only-provider/test-model");
		fs.writeFileSync(asleep.sessionFile!, "transcript\n");
		expect((await t.post(`/api/sessions/${asleep.id}/sleep`)).status).toBe(200);

		const response = await t.get("/api/quota");
		expect(response.status).toBe(200);
		const quota = (await response.json()) as QuotaResponse;
		expect(quota.providers.some(provider => provider.provider === "sleep-only-provider")).toBe(false);
	});

	it("wakes the same session through concurrent room links without duplicate workers", async () => {
		const dump = path.join(makeTmp("deck-wake-launches-"), "launches.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump", dump, "--ready-delay-ms", "250"] });
		const session = await createSession(t);
		const transcript = '{"type":"message","text":"resume me"}\n';
		fs.writeFileSync(session.sessionFile!, transcript);
		expect((await t.post(`/api/sessions/${session.id}/sleep`)).status).toBe(200);

		const roomPath = `/api/sessions/${session.id}/room`;
		const leftPending = t.post(roomPath);
		await until(() => t.daemon.supervisor.list().some(row => row.id === session.id && row.state === "waking"), "wake is visible in the live list");
		const wakingList = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(wakingList.live.find(row => row.id === session.id)).toMatchObject({ state: "waking", sessionFile: session.sessionFile });
		const rightPending = t.post(roomPath);
		const [left, right] = await Promise.all([leftPending, rightPending]);
		expect(left.status).toBe(200);
		expect(right.status).toBe(200);
		const leftRoom = (await left.json()) as RoomLinkResponse;
		const rightRoom = (await right.json()) as RoomLinkResponse;
		expect(rightRoom.roomId).toBe(leftRoom.roomId);
		expect(t.daemon.supervisor.get(session.id)).toMatchObject({ id: session.id, state: "idle" });
		expect(fs.readFileSync(session.sessionFile!, "utf8")).toBe(transcript);
		expect(readJsonLines(dump)).toHaveLength(2);
	});

	it("archives and trashes a session only after its in-flight wake has stopped", async () => {
		const t = await startTestDaemon({ workerFlags: ["--ready-delay-ms", "250"] });
		const session = await createSession(t, { cwd: t.sessionsDir });
		fs.writeFileSync(session.sessionFile!, '{"type":"message","message":{"role":"user","content":"Keep this work"}}\n');
		expect((await t.post(`/api/sessions/${session.id}/sleep`)).status).toBe(200);

		const roomPending = t.post(`/api/sessions/${session.id}/room`);
		await until(() => t.daemon.supervisor.list().some(row => row.id === session.id && row.state === "waking"), "archive test wake is in progress");
		const archived = await t.put(`/api/sessions/${session.id}/archive`);
		expect(archived.status).toBe(200);
		await roomPending;
		expect(t.daemon.supervisor.get(session.id)).toBeUndefined();
		expect(await t.daemon.supervisor.health()).toEqual([]);

		const trashed = await t.post(`/api/sessions/${session.id}/trash`);
		expect(trashed.status).toBe(200);
		expect(fs.existsSync(session.sessionFile!)).toBe(false);
	});

	it("DELETE waits for an in-flight wake before forgetting its worker", async () => {
		const t = await startTestDaemon({ workerFlags: ["--ready-delay-ms", "250"] });
		const session = await createSession(t, { cwd: t.sessionsDir });
		fs.writeFileSync(session.sessionFile!, '{"type":"message","message":{"role":"user","content":"Keep this work"}}\n');
		expect((await t.post(`/api/sessions/${session.id}/sleep`)).status).toBe(200);

		const roomPending = t.post(`/api/sessions/${session.id}/room`);
		await until(() => t.daemon.supervisor.list().some(row => row.id === session.id && row.state === "waking"), "delete test wake is in progress");
		const deleted = await t.del(`/api/sessions/${session.id}`);
		expect(deleted.status).toBe(204);
		await roomPending;
		expect(t.daemon.supervisor.get(session.id)).toBeUndefined();
		expect(await t.daemon.supervisor.health()).toEqual([]);
	});

	it("reads and changes the runtime automatic sleep delay", async () => {
		const t = await startTestDaemon({});
		const initial = await t.get("/api/settings/sleep");
		expect(initial.status).toBe(200);
		expect((await initial.json()) as SleepSettingsResponse).toEqual({ minutes: 120 });

		const updated = await t.put("/api/settings/sleep", { minutes: 0 });
		expect(updated.status).toBe(200);
		expect((await updated.json()) as SleepSettingsResponse).toEqual({ minutes: 0 });
		const reread = await t.get("/api/settings/sleep");
		expect((await reread.json()) as SleepSettingsResponse).toEqual({ minutes: 0 });
		expect((await t.put("/api/settings/sleep", { minutes: 1.5 })).status).toBe(400);
	});

	it("does not auto-sleep a session with a connected relay guest", async () => {
		const t = await startTestDaemon({ sleepAfterMinutes: 0.01, sleepPollMs: 10 });
		const session = await createSession(t);
		fs.writeFileSync(session.sessionFile!, "");
		const wsBase = t.url.replace("http://", "ws://");
		const host = socket(wsBase, `/r/${session.roomId}?role=host`, { Cookie: t.cookie });
		await waitOpen(host);
		const guest = socket(wsBase, `/r/${session.roomId}?role=guest`, { Cookie: t.cookie });
		await waitOpen(guest);
		await until(() => t.daemon.relay.hasGuests(session.roomId!), "relay guest is registered");

		await Bun.sleep(750);
		expect(t.daemon.supervisor.get(session.id)?.state).toBe("idle");
		guest.close(1000);
		await until(() => !t.daemon.relay.hasGuests(session.roomId!), "relay guest leaves");
		await until(() => t.daemon.supervisor.get(session.id)?.state === "asleep", "idle session sleeps after its guest leaves");
		host.close(1000);
	});

	it("defaults to the machine's memory-scaled live worker slots", async () => {
		const t = await startTestDaemon({});
		for (let i = 0; i < DEFAULT_MAX_WORKERS; i++) await createSession(t);

		const response = await t.post("/api/sessions", { cwd: t.dir });
		expect(response.status).toBe(409);
		expect(((await response.json()) as ApiError).code).toBe("conflict");
	});

	it("requires JSON content type for POST, PUT, and DELETE bodies", async () => {
		const t = await startTestDaemon({});
		const responses = await Promise.all([
			fetch(`${t.url}/api/push/test`, {
				method: "POST",
				headers: { Cookie: t.cookie, "Content-Type": "text/plain" },
				body: "{}",
			}),
			fetch(`${t.url}/api/sessions/missing`, {
				method: "DELETE",
				headers: { Cookie: t.cookie, "Content-Type": "text/plain" },
				body: "{}",
			}),
			fetch(`${t.url}/api/profiles/reviewer/model`, {
				method: "PUT",
				headers: { Cookie: t.cookie, "Content-Type": "text/plain" },
				body: JSON.stringify({ selector: "deck-open/available" }),
			}),
		]);
		const results = await Promise.all(
			responses.map(async response => ({ status: response.status, body: (await response.json()) as ApiError })),
		);
		expect(results.map(({ status, body }) => [status, body.code])).toEqual([
			[415, "bad-request"],
			[415, "bad-request"],
			[415, "bad-request"],
		]);
	});

	it("caps declared bodies at one mebibyte before endpoint handling", async () => {
		const t = await startTestDaemon({});
		const body = "x".repeat(1024 * 1024 + 1);
		const response = await fetch(`${t.url}/api/push/test`, {
			method: "POST",
			headers: { Cookie: t.cookie, "Content-Type": "application/json" },
			body,
		});

		expect(response.status).toBe(413);
	});

	it("lets a raw upload over one mebibyte reach the upload route, and nothing else", async () => {
		const t = await startTestDaemon({});
		const body = new Uint8Array(1024 * 1024 + 1);
		const upload = await fetch(`${t.url}/api/sessions/no-such-session/uploads?name=big.bin`, {
			method: "POST",
			headers: { Cookie: t.cookie, "Content-Type": "application/octet-stream" },
			body,
		});
		// Past the size and content-type gates: the route itself answers (no live session here).
		expect([404, 409, 503]).toContain(upload.status);
		const other = await fetch(`${t.url}/api/sessions/no-such-session/command`, {
			method: "POST",
			headers: { Cookie: t.cookie, "Content-Type": "application/octet-stream" },
			body,
		});
		expect(other.status).toBe(413);
	});

	it("caps a chunked JSON body at one mebibyte and still serves a small chunked one", async () => {
		const t = await startTestDaemon({});
		const stream = (bytes: number): ReadableStream<Uint8Array> => {
			let left = bytes;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					if (left === 0) return controller.close();
					const size = Math.min(64 * 1024, left);
					controller.enqueue(new Uint8Array(size).fill(0x20));
					left -= size;
				},
			});
		};
		const big = await fetch(`${t.url}/api/sessions`, {
			method: "POST",
			headers: { Cookie: t.cookie, "Content-Type": "application/json" },
			body: stream(10 * 1024 * 1024),
			duplex: "half",
		} as RequestInit);
		expect(big.status).toBe(413);
		const small = await fetch(`${t.url}/api/sessions`, {
			method: "POST",
			headers: { Cookie: t.cookie, "Content-Type": "application/json" },
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("[]"));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		expect(small.status).toBe(400);
	});

	it("rejects malformed and unsafe requests with ApiError JSON", async () => {
		const t = await startTestDaemon({});
		const file = writeFile(t, "x.jsonl");
		const cases: Array<[unknown, number, ApiError["code"]]> = [
			["{not json", 400, "bad-request"],
			[[], 400, "bad-request"],
			[{}, 400, "bad-request"],
			[{ cwd: "relative/dir" }, 400, "bad-request"],
			[{ cwd: path.join(t.dir, "missing") }, 400, "bad-request"],
			[{ cwd: file }, 400, "bad-request"], // a file, not a directory
			[{ cwd: t.dir, model: 5 }, 400, "bad-request"],
			[{ cwd: t.dir, resumeSessionFile: path.join(t.dir, "missing.jsonl") }, 400, "bad-request"],
			[{ cwd: t.dir, resumeSessionFile: "rel.jsonl" }, 400, "bad-request"],
			[{ cwd: t.dir, resumeSessionFile: file, forkFrom: { sessionFile: file } }, 400, "bad-request"],
			[{ cwd: t.dir, forkFrom: { sessionFile: path.join(t.dir, "nope.jsonl") } }, 400, "bad-request"],
			[{ cwd: t.dir, forkFrom: "x" }, 400, "bad-request"],
		];
		for (const [body, status, code] of cases) {
			const res = await t.post("/api/sessions", body);
			expect({ body, status: res.status }).toEqual({ body, status });
			const error = (await res.json()) as ApiError;
			expect(error.code).toBe(code);
			expect(error.error.length).toBeGreaterThan(0);
		}
		expect(t.daemon.supervisor.list()).toHaveLength(0);
	});

	it("answers 409 when the session file is already hosted and 500 with the worker's message when it fails to start", async () => {
		const t = await startTestDaemon({ hostedSessionNames: ["dup.jsonl"] });
		const file = writeFile(t, "dup.jsonl");
		await createSession(t, { resumeSessionFile: file });
		const dup = await t.post("/api/sessions", { cwd: t.dir, resumeSessionFile: file });
		expect(dup.status).toBe(409);
		expect(((await dup.json()) as ApiError).code).toBe("conflict");

		const failing = await startTestDaemon({ workerFlags: ["--fatal", "model not found: nope"] });
		const res = await failing.post("/api/sessions", { cwd: failing.dir });
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "model not found: nope", code: "internal" });
	});
});

describe("POST /api/sessions/:id/restart", () => {
	it("refuses a busy session by default and resumes the same session after explicit confirmation", async () => {
		const dump = path.join(makeTmp(), "launches.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--streaming-forever", "--dump", dump] });
		const session = await createSession(t);
		fs.writeFileSync(session.sessionFile!, "persisted transcript\n");
		await waitForLiveSession(t, session.id, current => current.state === "streaming");

		const invalid = await t.post(`/api/sessions/${session.id}/restart`, { restartAnyway: "yes" });
		expect(invalid.status).toBe(400);
		expect(((await invalid.json()) as ApiError).code).toBe("bad-request");
		const refused = await t.post(`/api/sessions/${session.id}/restart`, {});
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as ApiError).error).toContain("confirm restartAnyway");
		expect(readJsonLines(dump)).toHaveLength(1);

		const restartedResponse = await t.post(`/api/sessions/${session.id}/restart`, { restartAnyway: true });
		expect(restartedResponse.status).toBe(200);
		const restarted = (await restartedResponse.json()) as SessionSummary;
		expect(restarted).toMatchObject({
			id: session.id,
			sessionFile: session.sessionFile,
			roomId: session.roomId,
		});
		const launches = readJsonLines(dump);
		expect(launches).toHaveLength(2);
		expect((launches[1]!.argv as string[]).slice(-2)).toEqual(["--resume", session.sessionFile!]);
	});
});

describe("POST /api/sessions/:id/room", () => {
	it("returns a view-only link by default with the worker's key", async () => {
		const dump = path.join(makeTmp(), "launch.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump", dump] });
		const session = await createSession(t);
		const res = await t.post(`/api/sessions/${session.id}/room`);
		expect(res.status).toBe(200);
		const room = (await res.json()) as RoomLinkResponse;
		expect(room.permission).toBe("view");
		expect(room.roomId).toBe(session.roomId!);

		const parsed = parseCollabLink(room.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const [launch] = readJsonLines(dump);
		expect(parsed.roomId).toBe(room.roomId);
		expect(Buffer.from(parsed.key).toString("base64url")).toBe(launch!.key as string);
		expect(parsed.writeToken).toBeUndefined();
		expect(parsed.wsUrl).toBe(`ws://127.0.0.1:${t.daemon.port}/r/${room.roomId}`);
	});

	it("includes a write token only when full permission is requested", async () => {
		const dump = path.join(makeTmp(), "launch.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump", dump] });
		const session = await createSession(t);
		const res = await t.post(`/api/sessions/${session.id}/room`, { permission: "full" });
		const room = (await res.json()) as RoomLinkResponse;
		expect(room.permission).toBe("full");
		const parsed = parseCollabLink(room.link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(Buffer.from(parsed.writeToken!).toString("base64url")).toBe(readJsonLines(dump)[0]!.token as string);
	});

	it("builds a wss link on the public host when reached through tailscale serve", async () => {
		const t = await startTestDaemon({ owner: "alice@example.com", allowHosts: ["host.tailnet-example.ts.net"] });
		const session = await createSession(t);
		const res = await t.post(`/api/sessions/${session.id}/room`, undefined, {
			"Tailscale-User-Login": "alice@example.com",
			"X-Forwarded-Proto": "https",
			"X-Forwarded-Host": "host.tailnet-example.ts.net",
			"X-Forwarded-For": "100.64.0.7",
		});
		expect(res.status).toBe(200);
		const room = (await res.json()) as RoomLinkResponse;
		const parsed = parseCollabLink(room.link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://host.tailnet-example.ts.net/r/${room.roomId}`);
		expect(room.link.startsWith("https://host.tailnet-example.ts.net/#")).toBe(true);
	});

	it("rejects unknown sessions and bad permissions", async () => {
		const t = await startTestDaemon({});
		const session = await createSession(t);
		expect((await t.post("/api/sessions/nope/room")).status).toBe(404);
		const bad = await t.post(`/api/sessions/${session.id}/room`, { permission: "admin" });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as ApiError).code).toBe("bad-request");
		expect((await t.get(`/api/sessions/${session.id}/room`)).status).toBe(405);
	});

	it("answers 409 conflict while the worker is restarting", async () => {
		const marker = path.join(makeTmp(), "launched");
		// The first launch exits after 100 ms; the restart never reports ready, so the session stays `starting`.
		const t = await startTestDaemon({ workerFlags: ["--stall-restart", marker] });
		const session = await createSession(t);
		await until(async () => ((await (await t.get("/api/sessions")).json()) as ListSessionsResponse).live[0]?.state === "starting", "restart in progress");
		const res = await t.post(`/api/sessions/${session.id}/room`);
		expect(res.status).toBe(409);
		expect(((await res.json()) as ApiError).code).toBe("conflict");
		// Unknown ids keep answering 404, not 409.
		expect((await t.post("/api/sessions/nope/room")).status).toBe(404);
	});
});

describe("POST /api/sessions/:id/agents/:agentId/model", () => {
	it("returns the active model from the matching worker reply", async () => {
		const t = await startTestDaemon({ workerFlags: ["--unknown-output", "--model-unmatched-first"] });
		const session = await createSession(t);
		const res = await t.post(`/api/sessions/${session.id}/agents/Main/model`, { selector: "role-coder" });

		expect(res.status).toBe(200);
		const result = (await res.json()) as SetAgentModelResponse;
		expect(result).toEqual({ agentId: "Main", model: "google/gemini-2.5-pro", thinkingLevel: "high" });
	});

	it("maps unknown sessions and agents, inactive agents, and invalid selectors to the documented statuses", async () => {
		const t = await startTestDaemon({ workerFlags: ["--model-unmatched-first"] });
		const session = await createSession(t);
		const missingSession = await t.post("/api/sessions/nope/agents/Main/model", { selector: "role-coder" });
		expect(missingSession.status).toBe(404);
		expect(((await missingSession.json()) as ApiError).code).toBe("not-found");

		const missingAgent = await t.post(`/api/sessions/${session.id}/agents/missing/model`, { selector: "role-coder" });
		expect(missingAgent.status).toBe(404);
		expect(((await missingAgent.json()) as ApiError).code).toBe("not-found");

		const inactiveAgent = await t.post(`/api/sessions/${session.id}/agents/inactive/model`, { selector: "role-coder" });
		expect(inactiveAgent.status).toBe(409);
		expect(((await inactiveAgent.json()) as ApiError).code).toBe("conflict");

		const invalidSelector = await t.post(`/api/sessions/${session.id}/agents/Main/model`, { selector: "bad-model" });
		expect(invalidSelector.status).toBe(400);
		expect(((await invalidSelector.json()) as ApiError).code).toBe("bad-request");

		const invalidBody = await t.post(`/api/sessions/${session.id}/agents/Main/model`, { selector: " " });
		expect(invalidBody.status).toBe(400);
		expect((await t.get(`/api/sessions/${session.id}/agents/Main/model`)).status).toBe(405);
	});
});

describe("DELETE /api/sessions/:id", () => {
	it("stops the worker, forgets the session and 404s on repeat", async () => {
		const t = await startTestDaemon({});
		const session = await createSession(t);
		const { workers } = (await (await t.get("/api/health")).json()) as DaemonHealth;
		const pid = workers[0]!.pid;
		expect(isAlive(pid)).toBe(true);
		const res = await t.del(`/api/sessions/${session.id}`);
		expect(res.status).toBe(204);
		expect(isAlive(pid)).toBe(false);
		expect(((await (await t.get("/api/sessions")).json()) as ListSessionsResponse).live).toEqual([]);
		const again = await t.del(`/api/sessions/${session.id}`);
		expect(again.status).toBe(404);
		expect(((await again.json()) as ApiError).code).toBe("not-found");
	});
});

describe("GET /api/health", () => {
	it("reports workers, connected guests and the stall threshold", async () => {
		const t = await startTestDaemon({ stalledAfterMs: 4321 });
		const empty = (await (await t.get("/api/health")).json()) as DaemonHealth;
		expect(empty).toMatchObject({ version: 1, workers: [], guests: 0, stalledAfterMs: 4321 });
		expect(empty.startedAt).toBeLessThanOrEqual(Date.now());

		const session = await createSession(t);
		// The fake worker does not host the room, so play the host to let a guest in.
		const wsBase = `ws://127.0.0.1:${t.daemon.port}`;
		const host = socket(wsBase, `/r/${session.roomId}?role=host`, { Cookie: t.cookie });
		await waitOpen(host);
		const guest = socket(wsBase, `/r/${session.roomId}?role=guest`, { Cookie: t.cookie });
		await waitOpen(guest);
		await waitText(host, "peer-joined");
		const health = (await (await t.get("/api/health")).json()) as DaemonHealth;
		expect(health.guests).toBe(1);
		expect(health.workers).toHaveLength(1);
		expect(health.workers[0]).toMatchObject({ sessionId: session.id, state: "idle", restarts: 0, stalled: false });
		expect(health.workers[0]!.rssBytes).toBeGreaterThan(0);
		guest.close(1000);
		await until(async () => ((await (await t.get("/api/health")).json()) as DaemonHealth).guests === 0, "guest gone");
	});
});

describe("POST /api/push/subscribe", () => {
	const valid = { endpoint: "https://web.push.apple.com/abc123", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" }, label: "iPhone" };

	it("validates, persists with owner-only permissions, and replaces by endpoint", async () => {
		const t = await startTestDaemon({});
		expect((await t.post("/api/push/subscribe", valid)).status).toBe(204);
		expect((await t.post("/api/push/subscribe", { ...valid, label: "iPhone 2" })).status).toBe(204);
		expect((await t.post("/api/push/subscribe", { ...valid, endpoint: "https://web.push.apple.com/other" })).status).toBe(204);
		const file = path.join(t.stateDir, "push-subscriptions.json");
		const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ endpoint: string; label?: string; keys: unknown }>;
		// The second post replaced the first by endpoint; the third is a different device.
		expect(stored.map(s => [s.endpoint, s.label])).toEqual([
			["https://web.push.apple.com/abc123", "iPhone 2"],
			["https://web.push.apple.com/other", "iPhone"],
		]);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it("rejects invalid subscriptions without persisting anything", async () => {
		const t = await startTestDaemon({});
		const bad: unknown[] = [
			"{nope",
			[],
			{},
			{ ...valid, endpoint: "http://insecure.example/x" },
			{ ...valid, endpoint: "not a url" },
			{ ...valid, keys: undefined },
			{ ...valid, keys: { p256dh: valid.keys.p256dh } },
			{ ...valid, keys: { p256dh: "has space", auth: "x" } },
			{ ...valid, label: "x".repeat(65) },
		];
		for (const body of bad) {
			const res = await t.post("/api/push/subscribe", body);
			expect({ body, status: res.status }).toEqual({ body, status: 400 });
			expect(((await res.json()) as ApiError).code).toBe("bad-request");
		}
		expect(fs.existsSync(path.join(t.stateDir, "push-subscriptions.json"))).toBe(false);
	});
});

describe("routing errors", () => {
	it("answers unknown endpoints with 404 and wrong methods with 405 ApiError JSON", async () => {
		const t = await startTestDaemon({});
		const unknown = await t.get("/api/nope");
		expect(unknown.status).toBe(404);
		expect(((await unknown.json()) as ApiError).code).toBe("not-found");
		const wrong = await t.del("/api/health");
		expect(wrong.status).toBe(405);
		expect(wrong.headers.get("allow")).toBe("GET");
		expect(((await wrong.json()) as ApiError).code).toBe("bad-request");
		expect((await t.get("/api/sessions/some-id")).status).toBe(405);
	});
});

describe("POST /api/sessions createDirectory", () => {
	it("creates a missing directory only under the knowledge or projects root, and only for new sessions", async () => {
		const knowledgeRoot = makeTmp("deck-knowledge-");
		const outside = makeTmp("deck-outside-");
		const t = await startTestDaemon({ knowledgeRoot });

		const inside = path.join(knowledgeRoot, "03-projects", "new-thing");
		const created = await createSession(t, { cwd: inside, createDirectory: true });
		expect(created.cwd).toBe(inside);
		expect(fs.statSync(inside).isDirectory()).toBe(true);

		const escapes = [
			path.join(outside, "nope"),
			`${knowledgeRoot}/../${path.basename(outside)}/nope`,
			knowledgeRoot,
		];
		for (const cwd of escapes) {
			const res = await t.post("/api/sessions", { cwd, createDirectory: true });
			expect(res.status).toBe(400);
		}
		expect(fs.existsSync(path.join(outside, "nope"))).toBe(false);

		const linked = path.join(knowledgeRoot, "link-out");
		fs.symlinkSync(outside, linked);
		expect((await t.post("/api/sessions", { cwd: path.join(linked, "nope"), createDirectory: true })).status).toBe(400);
		expect(fs.existsSync(path.join(outside, "nope"))).toBe(false);

		const missing = path.join(knowledgeRoot, "never-created");
		expect((await t.post("/api/sessions", { cwd: missing })).status).toBe(400);
		expect(fs.existsSync(missing)).toBe(false);
	});
});

describe("terminal sessions open as copies", () => {
	it("labels saved sessions the daemon never hosted as terminal sessions, including archived ones; hosted ones are unlabelled", async () => {
		const t = await startTestDaemon({ hostedSessionNames: ["hosted-here.jsonl"] });
		const terminalFile = writeFile(t, "terminal.jsonl");
		const hostedFile = writeFile(t, "hosted-here.jsonl");
		t.recent.push({ ...recentRow("terminal", terminalFile, 10), source: "terminal", cwdExists: false });
		t.recent.push({ ...recentRow("hosted-here", hostedFile, 20), source: "terminal" });
		const listed = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(listed.recent.find(s => s.id === "terminal")?.source).toBe("terminal");
		expect(listed.recent.find(s => s.id === "hosted-here")?.source).toBeUndefined();

		expect((await t.put("/api/sessions/terminal/archive")).status).toBeLessThan(300);
		const archived = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		const row = archived.archived?.find(s => s.id === "terminal");
		expect(row?.source).toBe("terminal");
		expect(row?.cwdExists).toBe(false);
	});

	it("turns an in-place resume of a file it never hosted into a copy, whatever the client asked", async () => {
		const dump = path.join(makeTmp(), "launch.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump", dump] });
		const terminalFile = writeFile(t, "still-open-in-terminal.jsonl");
		const before = fs.readFileSync(terminalFile);
		await createSession(t, { resumeSessionFile: terminalFile });
		const argv = readJsonLines(dump).map(line => line.argv as string[])[0]!;
		expect(argv).not.toContain("--resume");
		expect(argv.slice(argv.indexOf("--fork"))).toEqual(["--fork", terminalFile]);
		expect(fs.readFileSync(terminalFile)).toEqual(before);
	});

	it("records a hosted session file when its worker is ready and later resumes it in place, whatever its path spelling", async () => {
		const dump = path.join(makeTmp(), "launch.jsonl");
		const t = await startTestDaemon({ workerFlags: ["--dump", dump] });
		// The fake worker keeps its session file in its cwd; put that in the sessions dir, where resumes are allowed.
		const live = await createSession(t, { cwd: t.sessionsDir });
		expect(live.sessionFile).toBeDefined();
		await t.del(`/api/sessions/${live.id}`);
		t.recent.push({ ...recentRow("stopped-quickly", live.sessionFile!, 30), source: "terminal" });
		const listed = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		expect(listed.recent.find(s => s.id === "stopped-quickly")?.source).toBeUndefined();

		// The worker reported the agent-dir spelling; the request arrives symlink-resolved (macOS /var -> /private/var).
		if (!fs.existsSync(live.sessionFile!)) fs.writeFileSync(live.sessionFile!, "{}\n");
		await createSession(t, { resumeSessionFile: fs.realpathSync(live.sessionFile!) });
		const argv = readJsonLines(dump).map(line => line.argv as string[]).at(-1)!;
		expect(argv).toContain("--resume");
		expect(argv).not.toContain("--fork");
	});

	it("does not offer archived sessions' folders as recent project folders", async () => {
		const t = await startTestDaemon({ withoutConfiguredRoots: true });
		const file = writeFile(t, "archived.jsonl");
		t.recent.push({ ...recentRow("archived-one", file, Date.now()), cwd: "/work/archived-project" });
		expect((await t.put("/api/sessions/archived-one/archive")).status).toBeLessThan(300);
		const body = (await (await t.get("/api/new-session/suggestions")).json()) as { recent: Array<{ cwd: string }> };
		expect(body.recent.map(item => item.cwd)).not.toContain("/work/archived-project");
	});
});
