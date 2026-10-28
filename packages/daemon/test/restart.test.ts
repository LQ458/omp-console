import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import type { ListSessionsResponse, SessionSummary } from "@omp-console/protocol";
import * as path from "node:path";
import { startDaemon, type Daemon } from "../src/server";
import type { RestartNotice } from "../src/api";
import { pairDaemon, type TestDaemon, startTestDaemon, stopTestDaemons } from "./harness";
import { until } from "./ws-helpers";
import { fakeCmd, makeTmp, readJsonLines } from "./helpers";

const restartedDaemons: Daemon[] = [];

afterEach(async () => {
	delete process.env.OMP_CONSOLE_SESSIONS_DIR;
	await Promise.all(restartedDaemons.splice(0).map(daemon => daemon.stop()));
	await stopTestDaemons();
});

async function liveSession(t: TestDaemon, id: string, state: SessionSummary["state"]): Promise<SessionSummary> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const response = await t.get("/api/sessions");
		const body = (await response.json()) as ListSessionsResponse;
		const session = body.live.find(row => row.id === id);
		if (session?.state === state) return session;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${id} to become ${state}`);
		await Bun.sleep(20);
	}
}

describe("daemon restart recovery", () => {
	it("resumes the same live session without sending a prompt and reports the interrupted turn", async () => {
		const stateScript = JSON.stringify([
			{
				at: 10,
				emit: {
					t: "state",
					state: "streaming",
					awaitingAnswer: false,
				goalActive: false,
				agentCount: 1,
				lastEventAt: "now",
				},
			},
		]);
		const requestLog = path.join(makeTmp("deck-restart-requests-"), "worker.jsonl");
		const first = await startTestDaemon({ workerFlags: ["--script", stateScript, "--dump-requests", requestLog] });
		const createdResponse = await first.post("/api/sessions", {
			cwd: first.dir,
			model: "openai-codex/gpt-6-luna",
			title: "Resilience task",
		});
		expect(createdResponse.status).toBe(201);
		const created = (await createdResponse.json()) as SessionSummary;
		await liveSession(first, created.id, "streaming");
		fs.writeFileSync(path.join(first.dir, `${created.id}.jsonl`), "{}\n");

		await first.daemon.stop();
		// The fake worker writes its session file into the cwd: make that the active session store.
		process.env.OMP_CONSOLE_SESSIONS_DIR = first.dir;
		const resumed = await startDaemon({
			port: 0,
			stateDir: first.stateDir,
			workerCmd: fakeCmd("--dump-requests", requestLog),
			listRecent: async () => [...first.recent],
			stopGraceMs: 300,
			termGraceMs: 300,
			readyTimeoutMs: 5_000,
			restartBackoffMs: [30, 60],
			areaTimers: false,
			knowledgeRoot: makeTmp("deck-knowledge-"),
			projectRoots: [makeTmp("deck-projects-")],
			agentDir: first.agentDir,
			workerEnv: { PI_CONFIG_DIR: makeTmp("deck-config-"), PI_CODING_AGENT_DIR: first.agentDir },
		});
		restartedDaemons.push(resumed);

		const listResponse = await fetch(`${resumed.url}/api/sessions`, { headers: { Cookie: first.cookie } });
		const list = (await listResponse.json()) as ListSessionsResponse;
		expect(list.live.map(session => session.id)).toEqual([created.id]);
		expect(list.live[0]).toMatchObject({ id: created.id, cwd: first.dir, model: "openai-codex/gpt-6-luna", title: "Resilience task", state: "idle" });
		expect(list.live[0]?.sessionFile).toBe(path.join(first.dir, `${created.id}.jsonl`));
		const roomResponse = await fetch(`${resumed.url}/api/sessions/${encodeURIComponent(created.id)}/room`, {
			method: "POST",
			headers: { Cookie: first.cookie, "content-type": "application/json" },
			body: JSON.stringify({ permission: "full" }),
		});
		expect(roomResponse.status).toBe(200);
		const room = (await roomResponse.json()) as { roomId: string; link: string };
		expect(room.link).toContain(`/r/${room.roomId}`);
		expect(room.roomId).not.toBe(created.roomId);

		const noticeResponse = await fetch(`${resumed.url}/api/restart-notice`, { headers: { Cookie: first.cookie } });
		expect(noticeResponse.status).toBe(200);
		const notice = (await noticeResponse.json()) as RestartNotice;
		expect(notice).toMatchObject({ resumed: 1, interruptedTitles: ["Resilience task"] });
		expect(notice.at).toBeGreaterThan(0);
		expect(readJsonLines(requestLog).some(command => command.t === "send-prompt")).toBe(false);
	});

	it("waits for restart restoration before returning a session room link", async () => {
		const requestLog = path.join(makeTmp("deck-restart-requests-"), "worker.jsonl");
		const first = await startTestDaemon({ workerFlags: ["--dump-requests", requestLog] });
		const createdResponse = await first.post("/api/sessions", {
			cwd: first.dir,
			model: "fake/model",
			title: "Delayed room lookup",
		});
		expect(createdResponse.status).toBe(201);
		const created = (await createdResponse.json()) as SessionSummary;
		await liveSession(first, created.id, "idle");
		fs.writeFileSync(path.join(first.dir, `${created.id}.jsonl`), "{}\n");
		await first.daemon.stop();

		process.env.OMP_CONSOLE_SESSIONS_DIR = first.dir;
		const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
		const port = portProbe.port;
		portProbe.stop(true);
		if (port === undefined) throw new Error("failed to reserve a test port");

		const starting = startDaemon({
			port,
			stateDir: first.stateDir,
			workerCmd: fakeCmd("--ready-delay-ms", "1000", "--dump-requests", requestLog),
			listRecent: async () => [...first.recent],
			stopGraceMs: 300,
			termGraceMs: 300,
			readyTimeoutMs: 5_000,
			restartBackoffMs: [30, 60],
			areaTimers: false,
			knowledgeRoot: makeTmp("deck-knowledge-"),
			projectRoots: [makeTmp("deck-projects-")],
			agentDir: first.agentDir,
			workerEnv: { PI_CONFIG_DIR: makeTmp("deck-config-"), PI_CODING_AGENT_DIR: first.agentDir },
		}).then(daemon => {
			restartedDaemons.push(daemon);
			return daemon;
		});
		let listening = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: first.cookie } });
				if (health.status === 200) {
					listening = true;
					break;
				}
			} catch {
				await Bun.sleep(10);
			}
		}
		if (!listening) throw new Error("restarted daemon did not begin listening");

		const baseUrl = `http://127.0.0.1:${port}`;
		const roomRequest = fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/room`, {
			method: "POST",
			headers: { Cookie: first.cookie, "content-type": "application/json" },
			body: JSON.stringify({ permission: "full" }),
		});
		const [, roomResponse] = await Promise.all([starting, roomRequest]);
		expect(roomResponse.status).toBe(200);
		const room = (await roomResponse.json()) as { roomId: string; link: string };
		expect(room.link).toContain(`/r/${room.roomId}`);
		expect(room.roomId).not.toBe(created.roomId);
	});

	it("keeps asleep sessions dormant across restart and wakes the same id on a room link", async () => {
		const dump = path.join(makeTmp("deck-asleep-launches-"), "launches.jsonl");
		const first = await startTestDaemon({ workerFlags: ["--dump", dump] });
		const createdResponse = await first.post("/api/sessions", { cwd: first.sessionsDir, title: "Sleeping session" });
		expect(createdResponse.status).toBe(201);
		const created = (await createdResponse.json()) as SessionSummary;
		const transcript = '{"type":"message","text":"persist across restart"}\n';
		fs.writeFileSync(created.sessionFile!, transcript);
		expect((await first.post(`/api/sessions/${created.id}/sleep`)).status).toBe(200);
		const stateFile = path.join(first.stateDir, "live-sessions.json");
		await until(() => {
			try {
				const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { asleep?: Array<{ id: string }> };
				return state.asleep?.some(session => session.id === created.id) === true;
			} catch {
				return false;
			}
		}, "asleep session is durably recorded");
		expect(readJsonLines(dump)).toHaveLength(1);

		await first.daemon.stop();
		const resumed = await startDaemon({
			port: 0,
			stateDir: first.stateDir,
			workerCmd: fakeCmd("--dump", dump),
			listRecent: async () => [...first.recent],
			stopGraceMs: 300,
			termGraceMs: 300,
			readyTimeoutMs: 5_000,
			restartBackoffMs: [30, 60],
			areaTimers: false,
			knowledgeRoot: makeTmp("deck-knowledge-"),
			projectRoots: [makeTmp("deck-projects-")],
			agentDir: first.agentDir,
			workerEnv: { PI_CONFIG_DIR: makeTmp("deck-config-"), PI_CODING_AGENT_DIR: first.agentDir },
		});
		restartedDaemons.push(resumed);
		expect(resumed.supervisor.get(created.id)).toMatchObject({ id: created.id, state: "asleep" });
		expect(await resumed.supervisor.health()).toEqual([]);
		expect(readJsonLines(dump)).toHaveLength(1);

		const [left, right] = await Promise.all([
			fetch(`${resumed.url}/api/sessions/${created.id}/room`, { method: "POST", headers: { Cookie: first.cookie } }),
			fetch(`${resumed.url}/api/sessions/${created.id}/room`, { method: "POST", headers: { Cookie: first.cookie } }),
		]);
		expect(left.status).toBe(200);
		expect(right.status).toBe(200);
		expect(((await left.json()) as { roomId: string }).roomId).toBe(((await right.json()) as { roomId: string }).roomId);
		expect(resumed.supervisor.get(created.id)).toMatchObject({ id: created.id, state: "idle" });
		expect(fs.readFileSync(created.sessionFile!, "utf8")).toBe(transcript);
		expect(readJsonLines(dump)).toHaveLength(2);
	});

	it("recovers waking entries as asleep and drops only malformed session rows", async () => {
		const stateDir = makeTmp("deck-waking-recovery-state-");
		const sessionsDir = makeTmp("deck-waking-recovery-store-");
		const cwd = makeTmp("deck-waking-recovery-cwd-");
		const wakingFile = path.join(sessionsDir, "waking.jsonl");
		const asleepFile = path.join(sessionsDir, "asleep.jsonl");
		const invalidFile = path.join(sessionsDir, "invalid.jsonl");
		for (const file of [wakingFile, asleepFile, invalidFile]) fs.writeFileSync(file, "transcript\n");
		fs.writeFileSync(
			path.join(stateDir, "live-sessions.json"),
			JSON.stringify({
				version: 1,
				sessions: [
					{ id: "waking", cwd, sessionFile: wakingFile, state: "waking", createdAt: 1, lastActivityAt: 2 },
					{ id: "invalid", cwd, sessionFile: invalidFile, state: "future-state", createdAt: 1, lastActivityAt: 2 },
				],
				asleep: [{ id: "already-asleep", cwd, sessionFile: asleepFile, state: "asleep", createdAt: 1, lastActivityAt: 2 }],
				restartNotice: null,
			}),
		);
		process.env.OMP_CONSOLE_SESSIONS_DIR = sessionsDir;
		const daemon = await startDaemon({
			port: 0,
			stateDir,
			workerCmd: fakeCmd(),
			listRecent: async () => [],
			areaTimers: false,
			knowledgeRoot: makeTmp("deck-knowledge-"),
			projectRoots: [makeTmp("deck-projects-")],
			agentDir: makeTmp("deck-agent-"),
			workerEnv: { PI_CONFIG_DIR: makeTmp("deck-config-"), PI_CODING_AGENT_DIR: makeTmp("deck-agent-env-") },
		});
		restartedDaemons.push(daemon);

		expect(daemon.supervisor.get("waking")).toMatchObject({ id: "waking", state: "asleep", sessionFile: wakingFile });
		expect(daemon.supervisor.get("already-asleep")).toMatchObject({ id: "already-asleep", state: "asleep", sessionFile: asleepFile });
		expect(daemon.supervisor.get("invalid")).toBeUndefined();
		expect(await daemon.supervisor.health()).toEqual([]);
	});

	it("persists sleep settings across daemon restarts and lets the stored value override the CLI default", async () => {
		const first = await startTestDaemon({ sleepAfterMinutes: 7 });
		const changed = await first.put("/api/settings/sleep", { minutes: 23 });
		expect(changed.status).toBe(200);
		await first.daemon.stop();
		process.env.OMP_CONSOLE_SESSIONS_DIR = first.sessionsDir;
		const restarted = await startDaemon({
			port: 0,
			stateDir: first.stateDir,
			workerCmd: fakeCmd(),
			sleepAfterMinutes: 3,
			listRecent: async () => [...first.recent],
			areaTimers: false,
			knowledgeRoot: makeTmp("deck-knowledge-"),
			projectRoots: [makeTmp("deck-projects-")],
			agentDir: first.agentDir,
			workerEnv: { PI_CONFIG_DIR: makeTmp("deck-config-"), PI_CODING_AGENT_DIR: first.agentDir },
		});
		restartedDaemons.push(restarted);

		const response = await fetch(`${restarted.url}/api/settings/sleep`, { headers: { Cookie: first.cookie } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ minutes: 23 });
	});

	it("never resumes a snapshot entry outside the session store, with a missing cwd, hidden, or archived", async () => {
		const stateDir = makeTmp("deck-restart-state-");
		const store = makeTmp("deck-restart-store-");
		const outside = makeTmp("deck-restart-outside-");
		const outsideFile = path.join(outside, "evil.jsonl");
		const missingFile = path.join(store, "never-written.jsonl");
		const insideFile = path.join(store, "hidden.jsonl");
		fs.writeFileSync(outsideFile, "");
		fs.writeFileSync(insideFile, "");
		const archivedFile = path.join(store, "archived.jsonl");
		fs.writeFileSync(archivedFile, "{}\n");
		fs.writeFileSync(
			path.join(stateDir, "archived-sessions.json"),
			JSON.stringify({
				version: 1,
				sessions: {
					archived: {
						archivedAt: 5,
						title: "Archived session",
						cwd: store,
						sessionFile: archivedFile,
						lastActivityAt: 4,
					},
				},
			}),
		);
		fs.writeFileSync(
			path.join(stateDir, "live-sessions.json"),
			JSON.stringify({
				version: 1,
				restartNotice: null,
				sessions: [
					{ id: "outside", cwd: outside, sessionFile: outsideFile, state: "idle" },
					{ id: "gone-cwd", cwd: path.join(outside, "missing"), sessionFile: insideFile, state: "idle" },
					{ id: "hidden", cwd: store, sessionFile: insideFile, state: "idle", hidden: true, title: "Agenda" },
					{ id: "archived", cwd: store, sessionFile: archivedFile, state: "streaming", title: "Archived session" },
					{ id: "unsaved", cwd: store, sessionFile: missingFile, state: "streaming" },
				],
			}),
		);
		process.env.OMP_CONSOLE_SESSIONS_DIR = store;
		const requestLog = path.join(makeTmp("deck-restart-requests-"), "worker.jsonl");
		const daemon = await startDaemon({
			port: 0,
			stateDir,
			workerCmd: fakeCmd("--dump-requests", requestLog),
			listRecent: async () => [],
			stopGraceMs: 300,
			termGraceMs: 300,
			readyTimeoutMs: 5_000,
			restartBackoffMs: [30, 60],
			areaTimers: false,
			knowledgeRoot: makeTmp("deck-knowledge-"),
			projectRoots: [makeTmp("deck-projects-")],
		});
		restartedDaemons.push(daemon);
		const cookie = await pairDaemon(daemon.url, stateDir);
		const list = (await (await fetch(`${daemon.url}/api/sessions`, { headers: { Cookie: cookie } })).json()) as ListSessionsResponse;
		expect(list.live).toEqual([]);
		expect(list.archived?.map(session => session.id)).toEqual(["archived"]);
		// Nothing valid was left to resume, so there is no restart to report.
		const notice = (await (await fetch(`${daemon.url}/api/restart-notice`, { headers: { Cookie: cookie } })).json()) as RestartNotice | null;
		expect(notice).toBeNull();
		const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "live-sessions.json"), "utf8")) as { sessions: unknown[] };
		expect(persisted.sessions).toEqual([]);
	});
});
