import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaudeImportJobResponse, ClaudeImportSessionsResponse, ClaudeImportSummary, ListSessionsResponse } from "@omp-console/protocol";
import { YAML } from "bun";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { listPersistedSessions } from "../src/recent";
import { type TestDaemon, startTestDaemon, stopTestDaemons } from "./harness";
import { makeTmp } from "./helpers";

// Windows resolves the home folder from USERPROFILE (os.homedir), other platforms from HOME.
const ISOLATED_SOURCE_ENV = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "OMP_CONSOLE_SESSIONS_DIR"] as const;
let previousSourceEnv = new Map<string, string | undefined>();

afterEach(async () => {
	await stopTestDaemons();
	for (const [key, value] of previousSourceEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	previousSourceEnv.clear();
});

function useIsolatedSources(home: string, claudeDir: string): void {
	previousSourceEnv = new Map(ISOLATED_SOURCE_ENV.map(key => [key, process.env[key]]));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	delete process.env.OMP_CONSOLE_SESSIONS_DIR;
}

function claudeProjectDir(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function writeJsonLines(file: string, records: readonly unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

function createClaudeFixture(root: string, projects: readonly string[]): void {
	const first = path.join(root, "projects", claudeProjectDir(projects[0]!));
	const second = path.join(root, "projects", claudeProjectDir(projects[1]!));
	const now = new Date("2026-10-20T12:00:00.000Z");
	const user = (text: string, uuid: string, parentUuid: string | null = null) => ({
		type: "user",
		uuid,
		parentUuid,
		timestamp: now.toISOString(),
		cwd: projects[0],
		message: { role: "user", content: text },
	});
	const assistant = (text: string, uuid: string, parentUuid: string) => ({
		type: "assistant",
		uuid,
		parentUuid,
		timestamp: now.toISOString(),
		cwd: projects[0],
		message: {
			id: `response-${uuid}`,
			model: "claude-fixture",
			content: [{ type: "text", text }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	});
	writeJsonLines(path.join(first, "claude-one.jsonl"), [
		user("Please inspect the project.", "one-user"),
		{
			type: "assistant",
			uuid: "one-tool-call",
			parentUuid: "one-user",
			timestamp: now.toISOString(),
			cwd: projects[0],
			message: {
				id: "response-one-tool-call",
				model: "claude-fixture",
				content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
				stop_reason: "tool_use",
				usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{
			type: "user",
			uuid: "one-tool-result",
			parentUuid: "one-tool-call",
			timestamp: now.toISOString(),
			cwd: projects[0],
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "fixture contents" }] },
		},
		assistant("The project uses a fixture.", "one-final", "one-tool-result"),
	]);
	writeJsonLines(path.join(first, "claude-two.jsonl"), [
		user("Summarize the project history.", "two-user"),
		assistant("The history is a fixture.", "two-final", "two-user"),
	]);
	fs.mkdirSync(second, { recursive: true });
	fs.writeFileSync(path.join(second, "claude-broken.jsonl"), "not valid JSON\n");
	writeJsonLines(path.join(root, "history.jsonl"), [
		{ sessionId: "claude-one", timestamp: now.getTime(), display: "Please inspect the project.", project: projects[0] },
		{ sessionId: "claude-one", timestamp: now.getTime() + 1000, display: "Check the result.", project: projects[0] },
		{ sessionId: "claude-two", timestamp: now.getTime() + 2000, display: "Summarize the project history.", project: projects[0] },
		{ sessionId: "claude-broken", timestamp: now.getTime() + 3000, display: "Open the broken transcript.", project: projects[1] },
	]);
}

async function finishImportJob(
	t: TestDaemon,
	source: string,
	initial: ClaudeImportJobResponse,
	headers?: Record<string, string>,
): Promise<ClaudeImportJobResponse> {
	let job = initial;
	const deadline = Date.now() + 10_000;
	while (job.status === "running") {
		if (Date.now() >= deadline) throw new Error(`import job ${job.jobId} did not finish`);
		await Bun.sleep(10);
		const response = await t.get(`/api/claude-import/jobs/${encodeURIComponent(job.jobId)}?source=${source}`, headers);
		expect(response.status).toBe(200);
		job = (await response.json()) as ClaudeImportJobResponse;
	}
	return job;
}

async function openClaudeFixture(): Promise<{ t: TestDaemon; root: string; home: string; projects: [string, string] }> {
	const home = makeTmp("omp-console-import-home-");
	const root = path.join(home, ".claude");
	const projects: [string, string] = [makeTmp("omp-console-import-project-a-"), makeTmp("omp-console-import-project-b-")];
	fs.mkdirSync(root, { recursive: true });
	createClaudeFixture(root, projects);
	useIsolatedSources(home, root);
	const agentDir = makeTmp("omp-console-import-agent-");
	const stateDir = makeTmp("omp-console-import-state-");
	const settings = [
		"enabledProviders:",
		"  - codex",
		"  - path: /nonexistent/elsewhere",
		"    providers: [cursor]",
		"retainedCustomSetting: keep-me",
		"",
	].join("\n");
	fs.writeFileSync(path.join(agentDir, "config.yml"), settings);
	process.env.OMP_CONSOLE_SESSIONS_DIR = getSessionsDir(agentDir);
	const t = await startTestDaemon({
		agentDir,
		stateDir,
		listRecent: listPersistedSessions,
	});
	return { t, root, home, projects };
}

describe("Claude Code and Codex import API", () => {
	it("summarizes and groups Claude sessions, safely imports them, and persists idempotency", async () => {
		const { t, root, projects } = await openClaudeFixture();

		const summaryResponse = await t.get("/api/claude-import/summary");
		expect(summaryResponse.status).toBe(200);
		const summary = (await summaryResponse.json()) as ClaudeImportSummary;
		expect(summary).toEqual({ dir: root, found: true, sessionCount: 3, projectCount: 2 });

		const listingResponse = await t.get("/api/claude-import/sessions?source=claude");
		expect(listingResponse.status).toBe(200);
		const listing = (await listingResponse.json()) as ClaudeImportSessionsResponse;
		expect(listing.projects.map(project => project.path).sort()).toEqual([...projects].sort());
		expect(listing.projects.flatMap(project => project.sessions.map(session => session.id)).sort()).toEqual([
			"claude-broken",
			"claude-one",
			"claude-two",
		]);
		const first = listing.projects.flatMap(project => project.sessions).find(session => session.id === "claude-one");
		expect(first?.firstMessage).toBe("Please inspect the project.");
		expect(first?.messageCount).toBe(2);
		expect(first?.alreadyImported).toBe(false);

		const traversal = await t.post("/api/claude-import?source=claude", { ids: ["../outside"] });
		expect(traversal.status).toBe(400);

		const unauthenticated = await t.unauthenticated("/api/claude-import/summary");
		expect(unauthenticated.status).toBe(401);

		const started = await t.post("/api/claude-import?source=claude", { ids: ["claude-one", "claude-two", "claude-broken"] });
		expect(started.status).toBe(202);
		const initial = (await started.json()) as ClaudeImportJobResponse;
		const result = await finishImportJob(t, "claude", initial);
		expect(result.completed).toBe(3);
		expect(result.results.map(item => item.status)).toEqual(["imported", "imported", "error"]);
		expect(result.results[2]?.error).toContain("no readable records");

		const importedIds = result.results.slice(0, 2).map(item => item.sessionId!);
		const visible = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
		const rows = [...visible.live, ...visible.recent];
		for (const id of importedIds) {
			const row = rows.find(session => session.id === id);
			expect(row).toBeDefined();
			expect(row?.sessionFile?.startsWith(t.sessionsDir)).toBe(true);
		}

		const refreshed = (await (await t.get("/api/claude-import/sessions?source=claude")).json()) as ClaudeImportSessionsResponse;
		expect(refreshed.projects.flatMap(project => project.sessions).find(session => session.id === "claude-one")?.alreadyImported).toBe(true);
		const repeatedStart = await t.post("/api/claude-import?source=claude", { ids: ["claude-one"] });
		const repeated = await finishImportJob(t, "claude", (await repeatedStart.json()) as ClaudeImportJobResponse);
		expect(repeated.results[0]?.status).toBe("already-imported");
		expect(repeated.results[0]?.sessionId).toBe(result.results[0]?.sessionId);
		await t.daemon.stop();
		const restarted = await startTestDaemon({
			agentDir: t.agentDir,
			stateDir: t.stateDir,
			listRecent: listPersistedSessions,
			pair: false,
		});
		const afterRestartStart = await restarted.post("/api/claude-import?source=claude", { ids: ["claude-one"] }, { Cookie: t.cookie });
		const afterRestart = await finishImportJob(
			restarted,
			"claude",
			(await afterRestartStart.json()) as ClaudeImportJobResponse,
			{ Cookie: t.cookie },
		);
		expect(afterRestart.results[0]?.status).toBe("already-imported");
		expect(afterRestart.results[0]?.sessionId).toBe(result.results[0]?.sessionId);

		// A deleted imported session no longer blocks importing the transcript again.
		const importedRow = rows.find(session => session.id === result.results[0]?.sessionId);
		fs.rmSync(importedRow!.sessionFile!);
		const relisted = (await (await restarted.get("/api/claude-import/sessions?source=claude", { Cookie: t.cookie })).json()) as ClaudeImportSessionsResponse;
		expect(relisted.projects.flatMap(project => project.sessions).find(session => session.id === "claude-one")?.alreadyImported).toBe(false);
		const reimportStart = await restarted.post("/api/claude-import?source=claude", { ids: ["claude-one"] }, { Cookie: t.cookie });
		const reimport = await finishImportJob(restarted, "claude", (await reimportStart.json()) as ClaudeImportJobResponse, { Cookie: t.cookie });
		expect(reimport.results[0]?.status).toBe("imported");
		expect(reimport.results[0]?.sessionId).not.toBe(result.results[0]?.sessionId);
	});

	it("supports Codex transcripts and preserves unrelated omp settings when enabling Claude sources", async () => {
		const { t, home, root } = await openClaudeFixture();
		const codexProject = makeTmp("omp-console-codex-project-");
		const codexFile = path.join(home, ".codex", "sessions", "2026", "10", "rollout-one.jsonl");
		writeJsonLines(codexFile, [
			{ type: "session_meta", payload: { id: "codex-one", cwd: codexProject, timestamp: "2026-10-18T10:00:00.000Z" } },
			{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review this project." }] } },
			{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "It is a fixture." }] } },
		]);

		const codexSummary = (await (await t.get("/api/claude-import/summary?source=codex")).json()) as ClaudeImportSummary;
		expect(codexSummary).toMatchObject({ dir: path.join(home, ".codex"), found: true, sessionCount: 1, projectCount: 1 });
		const started = await t.post("/api/claude-import?source=codex", { ids: ["codex-one"] });
		expect(started.status).toBe(202);
		const job = await finishImportJob(t, "codex", (await started.json()) as ClaudeImportJobResponse);
		expect(job.results[0]?.status).toBe("imported");
		expect(job.results[0]?.sessionId).toBeDefined();

		const settingsResponse = await t.get("/api/claude-import/settings");
		expect(settingsResponse.status).toBe(200);
		// CLAUDE_CONFIG_DIR turns Claude user config on, but the persisted choice stays the user's own.
		expect(await settingsResponse.json()).toMatchObject({ userConfigEnabled: false, claudeConfigDirOverride: true });
		const skillsOnly = await t.put("/api/claude-import/settings", {
			userConfigEnabled: false,
			userSkillsEnabled: true,
			userCommandsEnabled: false,
		});
		expect(skillsOnly.status).toBe(200);
		const afterSkills = YAML.parse(await Bun.file(path.join(t.agentDir, "config.yml")).text()) as { enabledProviders?: unknown[] };
		expect(afterSkills.enabledProviders).not.toContain("claude");
		const saved = await t.put("/api/claude-import/settings", {
			userConfigEnabled: true,
			userSkillsEnabled: true,
			userCommandsEnabled: true,
		});
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			userConfigEnabled: true,
			userSkillsEnabled: true,
			userCommandsEnabled: true,
			claudeConfigDirOverride: true,
		});
		const config = YAML.parse(await Bun.file(path.join(t.agentDir, "config.yml")).text()) as {
			enabledProviders?: unknown[];
			retainedCustomSetting?: string;
			skills?: { enableClaudeUser?: boolean };
			commands?: { enableClaudeUser?: boolean };
		};
		expect(config.retainedCustomSetting).toBe("keep-me");
		expect(config.enabledProviders).toContain("codex");
		expect(config.enabledProviders).toContain("claude");
		expect(config.enabledProviders).toContainEqual({ path: "/nonexistent/elsewhere", providers: ["cursor"] });
		expect(config.skills?.enableClaudeUser).toBe(true);
		expect(config.commands?.enableClaudeUser).toBe(true);
		expect(process.env.CLAUDE_CONFIG_DIR).toBe(root);
	});

	it("reports an absent Claude config directory without failing", async () => {
		const { t, root } = await openClaudeFixture();
		fs.rmSync(root, { recursive: true, force: true });
		const summaryResponse = await t.get("/api/claude-import/summary");
		expect(summaryResponse.status).toBe(200);
		expect(await summaryResponse.json()).toEqual({ dir: root, found: false, sessionCount: 0, projectCount: 0 });
	});
});
