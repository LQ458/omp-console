import { afterEach, describe, expect, it } from "bun:test";
import type { SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { type CrashEvent, defaultMaxWorkers, type NotifyEvent, Supervisor, type SupervisorOptions } from "../src/supervisor";
import { fakeCmd, isAlive, makeTmp, readJsonLines } from "./helpers";
import { until } from "./ws-helpers";

const RELAY = "ws://127.0.0.1:9";

let supervisors: Supervisor[] = [];

function make(flags: string[], overrides: Partial<SupervisorOptions> = {}): Supervisor {
	const supervisor = new Supervisor({
		workerCmd: fakeCmd(...flags),
		relayUrl: () => RELAY,
		stopGraceMs: 300,
		termGraceMs: 300,
		readyTimeoutMs: 5_000,
		restartBackoffMs: [30, 60],
		...overrides,
	});
	supervisors.push(supervisor);
	return supervisor;
}

afterEach(async () => {
	await Promise.all(supervisors.map(s => s.shutdown()));
	supervisors = [];
});

describe("supervisor: default worker limit", () => {
	it("scales with memory between 8 and 32", () => {
		expect(defaultMaxWorkers(7.7e9)).toBe(8);
		expect(defaultMaxWorkers(36 * 2 ** 30)).toBe(25);
		expect(defaultMaxWorkers(128 * 2 ** 30)).toBe(32);
	});
});

describe("supervisor: ready and state parsing", () => {
	it("summarises ready+state lines, passes contract args and delivers secrets on first stdin line", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launch.jsonl");
		const supervisor = make(["--dump", dump]);
		const summary = await supervisor.create({ cwd: dir, model: "anthropic/x" });

		expect(summary.state).toBe("idle");
		expect(summary.cwd).toBe(dir);
		expect(summary.model).toBe("anthropic/x");
		expect(summary.thinkingLevel).toBe("medium");
		expect(summary.title).toBe(`fake ${summary.id}`);
		expect(summary.rootAgentId).toBe(`root-${summary.id}`);
		expect(summary.sessionFile).toBe(path.join(dir, `${summary.id}.jsonl`));
		expect(summary.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(summary.agentCount).toBe(1);

		const [launch] = readJsonLines(dump);
		const args = launch!.argv as string[];
		expect(args.slice(args.indexOf("--cwd"))).toEqual([
			"--cwd",
			dir,
			"--relay",
			RELAY,
			"--room",
			summary.roomId!,
			"--agenda-tools",
			"off",
			"--computer-use",
			"off",
			"--model",
			"anthropic/x",
		]);
		const secrets = supervisor.roomSecrets(summary.id)!;
		expect(launch!.key).toBe(Buffer.from(secrets.key).toString("base64url"));
		expect(launch!.token).toBe(Buffer.from(secrets.writeToken).toString("base64url"));
		expect(launch!.hasRoomKeyEnv).toBe(false);
		expect(launch!.hasWriteTokenEnv).toBe(false);
		expect(secrets.key.byteLength).toBe(32);
		expect(secrets.writeToken.byteLength).toBe(16);
		// Never on the command line.
		expect(args.join(" ")).not.toContain(launch!.key as string);
		expect(args.join(" ")).not.toContain(launch!.token as string);
	});

	it("maps resume and fork requests to worker flags", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launch.jsonl");
		const supervisor = make(["--dump", dump]);
		await supervisor.create({ cwd: dir, resumeSessionFile: path.join(dir, "old.jsonl") });
		await supervisor.create({ cwd: dir, forkFrom: { sessionFile: "/s/a.jsonl", entryId: "e9" } });
		await supervisor.create({ cwd: dir, forkFrom: { sessionFile: "/s/b.jsonl" } });
		const [resume, forkEntry, forkPlain] = readJsonLines(dump).map(l => l.argv as string[]);
		expect(resume!.slice(resume!.indexOf("--resume"))).toEqual(["--resume", path.join(dir, "old.jsonl")]);
		expect(forkEntry!.slice(forkEntry!.indexOf("--fork"))).toEqual(["--fork", "/s/a.jsonl:e9"]);
		expect(forkPlain!.slice(forkPlain!.indexOf("--fork"))).toEqual(["--fork", "/s/b.jsonl"]);
	});

	it("rejects a second worker for a session file that is already hosted", async () => {
		const dir = makeTmp();
		const supervisor = make([]);
		const file = path.join(dir, "same.jsonl");
		await supervisor.create({ cwd: dir, resumeSessionFile: file });
		await expect(supervisor.create({ cwd: dir, resumeSessionFile: file })).rejects.toMatchObject({ code: "conflict" });
		expect(supervisor.list()).toHaveLength(1);
	});

	it("counts starting candidates against the worker limit", async () => {
		const dir = makeTmp();
		const supervisor = make(["--no-ready"], { maxWorkers: 1, readyTimeoutMs: 100 });
		const first = supervisor.create({ cwd: dir }).then(
			() => undefined,
			error => error,
		);

		await expect(supervisor.create({ cwd: dir })).rejects.toMatchObject({ code: "conflict" });
		await expect(first).resolves.toMatchObject({ code: "internal" });
	});

	it("offers the oldest eligible idle worker when the worker limit is reached", async () => {
		const dir = makeTmp();
		const supervisor = make([], { maxWorkers: 1 });
		const live = await supervisor.create({ cwd: dir });
		fs.writeFileSync(live.sessionFile!, "transcript\n");

		await expect(supervisor.create({ cwd: dir })).rejects.toMatchObject({
			code: "conflict",
			sleepCandidate: { id: live.id, title: live.title, idleMinutes: 0 },
		});
	});
	
	it("does not offer an active streaming worker as a sleep candidate", async () => {
		const dir = makeTmp();
		const supervisor = make(["--streaming-forever"], { maxWorkers: 1 });
		const streaming = await supervisor.create({ cwd: dir });
		fs.writeFileSync(streaming.sessionFile!, "transcript\n");
		await until(() => supervisor.get(streaming.id)?.state === "streaming", "streaming worker stays active");

		await expect(supervisor.create({ cwd: dir })).rejects.toMatchObject({ code: "conflict", sleepCandidate: undefined });
		expect(supervisor.get(streaming.id)?.state).toBe("streaming");
	});

	it("sleeps without the before-stop hook and coalesces concurrent wakes on the same transcript", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launches.jsonl");
		let beforeStopCalls = 0;
		const supervisor = make(["--dump", dump], {
			beforeStop: async () => {
				beforeStopCalls++;
			},
		});
		const first = await supervisor.create({ cwd: dir });
		const file = first.sessionFile!;
		const transcript = '{"type":"message","text":"keep this transcript"}\n';
		fs.writeFileSync(file, transcript);
		const pid = (await supervisor.health()).find(worker => worker.sessionId === first.id)!.pid;

		expect(await supervisor.sleep(first.id)).toBe(true);
		await until(() => !isAlive(pid), "sleep releases the worker process");
		expect(supervisor.get(first.id)).toMatchObject({ id: first.id, state: "asleep", sessionFile: file });
		expect(supervisor.roomSecrets(first.id)).toBeUndefined();
		expect(beforeStopCalls).toBe(0);

		const [left, right] = await Promise.all([supervisor.wake(first.id), supervisor.wake(first.id)]);
		expect(left.id).toBe(first.id);
		expect(right.id).toBe(first.id);
		expect(supervisor.get(first.id)).toMatchObject({ id: first.id, state: "idle", sessionFile: file });
		expect(fs.readFileSync(file, "utf8")).toBe(transcript);
		expect(readJsonLines(dump)).toHaveLength(2);
	});

	it("automatically sleeps only idle, persisted, visible sessions without a blocked external policy", async () => {
		const dir = makeTmp();
		const blocked = new Set<string>();
		let pinnedId: string | undefined;
		let autoSleepReady = false;
		const supervisor = make([], {
			sleepAfterMinutes: 0.01,
			sleepPollMs: 10,
			sleepBlocked: session => !autoSleepReady || blocked.has(session.id),
			isPinned: sessionId => sessionId === pinnedId,
		});
		const create = async (request: Omit<Parameters<Supervisor["create"]>[0], "cwd">, persistFile = true): Promise<SessionSummary> => {
			const summary = await supervisor.create({ cwd: dir, ...request });
			if (persistFile && summary.sessionFile) fs.writeFileSync(summary.sessionFile, "");
			return summary;
		};
		const noFile = await create({}, false);
		const hidden = await create({ hidden: true });
		const guest = await create({});
		const pinned = await create({});
		pinnedId = pinned.id;
		blocked.add(guest.id);
		const asker = make(["--asking"], { sleepAfterMinutes: 0.01, sleepPollMs: 10 });
		const asking = await asker.create({ cwd: dir });
		fs.writeFileSync(asking.sessionFile!, "");
		const streamer = make(["--streaming-forever"], { sleepAfterMinutes: 0.01, sleepPollMs: 10 });
		const streaming = await streamer.create({ cwd: dir });
		fs.writeFileSync(streaming.sessionFile!, "");
		await until(() => streamer.get(streaming.id)?.state === "streaming", "streaming worker reports its active state");
		const eligible = await create({});
		autoSleepReady = true;
		const eligiblePid = (await supervisor.health()).find(worker => worker.sessionId === eligible.id)!.pid;

		await until(() => supervisor.get(eligible.id)?.state === "asleep", "idle worker automatically sleeps");
		await until(() => !isAlive(eligiblePid), "automatic sleep releases the worker process");
		expect(asking.awaitingAnswer).toBe(true);
		await Bun.sleep(100);

		expect(supervisor.get(eligible.id)?.state).toBe("asleep");
		expect(supervisor.get(noFile.id)?.state).toBe("idle");
		expect(supervisor.get(hidden.id)?.state).toBe("idle");
		expect(supervisor.get(guest.id)?.state).toBe("idle");
		expect(supervisor.get(pinned.id)?.state).toBe("idle");
		expect(asker.get(asking.id)?.state).toBe("asking");
		expect(streamer.get(streaming.id)?.state).toBe("streaming");
	});
	it("keeps idle paused sessions awake during automatic sleep", async () => {
		const script = JSON.stringify([
			{
				at: 30,
				emit: { t: "state", state: "idle", awaitingAnswer: false, goalActive: false, agentCount: 1, paused: true, pausedAt: 123, lastEventAt: "now" },
			},
		]);
		const supervisor = make(["--script", script], { sleepAfterMinutes: 0.01, sleepPollMs: 10 });
		const session = await supervisor.create({ cwd: makeTmp() });
		fs.writeFileSync(session.sessionFile!, "transcript\n");
		const pid = (await supervisor.health()).find(worker => worker.sessionId === session.id)!.pid;

		await until(() => supervisor.get(session.id)?.paused === true, "worker reports paused");
		await Bun.sleep(800);
		expect(supervisor.get(session.id)).toMatchObject({ id: session.id, state: "idle", paused: true, pausedAt: 123 });
		expect(isAlive(pid)).toBe(true);
	});
	it("keeps a worker awake while a worker request is in flight", async () => {
		const dir = makeTmp();
		const supervisor = make(["--ignore-requests"], { summarizeTimeoutMs: 5_000 });
		const live = await supervisor.create({ cwd: dir });
		fs.writeFileSync(live.sessionFile!, "transcript\n");
		const pending = supervisor.summarize(live.id).catch(() => undefined);
		await expect(supervisor.sleep(live.id)).rejects.toMatchObject({ code: "conflict" });
		expect(supervisor.get(live.id)?.state).toBe("idle");
		await supervisor.stop(live.id);
		await pending;
	});

	it("rolls back a sleep when a wake wins before the worker is terminated", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launches.jsonl");
		const transition = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const supervisor = make(["--dump", dump], {
			onSessionsChanged: async sessions => {
				if (sessions.some(session => session.state === "asleep")) {
					transition.resolve();
					await release.promise;
				}
			},
		});
		const live = await supervisor.create({ cwd: dir });
		fs.writeFileSync(live.sessionFile!, "transcript\n");
		const sleep = supervisor.sleep(live.id).then(value => ({ value }), error => ({ error }));
		await transition.promise;
		const wake = supervisor.wake(live.id);
		release.resolve();
		const [sleepResult, awakened] = await Promise.all([sleep, wake]);

		expect(sleepResult).toHaveProperty("error");
		expect(awakened).toMatchObject({ id: live.id, state: "idle" });
		expect(readJsonLines(dump)).toHaveLength(1);
	});
	it("reports a conflict when a wake starts while sleep is terminating the old worker", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launches.jsonl");
		const supervisor = make(["--ignore-stop", "--ignore-term", "--dump", dump], { stopGraceMs: 100, termGraceMs: 300 });
		const first = await supervisor.create({ cwd: dir });
		fs.writeFileSync(first.sessionFile!, "transcript\n");
		const pid = (await supervisor.health()).find(worker => worker.sessionId === first.id)!.pid;
		const sleep = supervisor.sleep(first.id);
		await until(() => supervisor.get(first.id)?.state === "asleep", "sleep transition begins");
		const wake = supervisor.wake(first.id);

		await expect(sleep).rejects.toMatchObject({ code: "conflict" });
		const awakened = await wake;
		expect(awakened).toMatchObject({ id: first.id, state: "idle" });
		expect(isAlive(pid)).toBe(false);
		expect(readJsonLines(dump)).toHaveLength(2);
	});

	it("does not let a later ready line hijack another live worker", async () => {
		const dir = makeTmp();
		const reannounceFile = path.join(dir, "reannounce.txt");
		const resumeFile = path.join(dir, "newcomer.jsonl");
		const logs: string[] = [];
		const supervisor = make(["--reannounce-file", reannounceFile], { log: message => logs.push(message) });
		const existing = await supervisor.create({ cwd: dir });
		const newcomer = await supervisor.create({ cwd: dir, resumeSessionFile: resumeFile });
		const pids = (await supervisor.health()).map(worker => worker.pid);

		try {
			fs.writeFileSync(reannounceFile, `${existing.id}\n`);
			await until(() => logs.some(message => message.includes("already held by another live worker")), "ready collision rejected");

			expect(supervisor.get(existing.id)?.sessionFile).toBe(existing.sessionFile);
			expect(supervisor.get(newcomer.id)).toMatchObject({ id: newcomer.id, state: "crashed", sessionFile: resumeFile });
			await supervisor.shutdown();
			expect(pids.every(pid => !isAlive(pid))).toBe(true);
		} finally {
			await supervisor.shutdown();
			for (const pid of pids) {
				if (isAlive(pid)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
			}
		}
	});

	it("surfaces a worker fatal line as the create error and leaves no process behind", async () => {
		const dir = makeTmp();
		const supervisor = make(["--fatal", "no such model", "--dump", path.join(dir, "d.jsonl")]);
		await expect(supervisor.create({ cwd: dir })).rejects.toMatchObject({ code: "internal", message: "no such model" });
		expect(supervisor.list()).toHaveLength(0);
	});

	it("kills a worker that never becomes ready", async () => {
		const dir = makeTmp();
		const childFile = path.join(dir, "child.pid");
		const supervisor = make(["--no-ready", "--spawn-child", childFile], { readyTimeoutMs: 300 });
		await expect(supervisor.create({ cwd: dir })).rejects.toMatchObject({ code: "internal" });
		const childPid = Number(fs.readFileSync(childFile, "utf8"));
		await until(() => !isAlive(childPid), "straggler child killed");
	});

	it("fails create with a clear error when the worker command does not exist", async () => {
		const supervisor = new Supervisor({ workerCmd: ["/nonexistent/omp-console-worker"], relayUrl: () => RELAY });
		supervisors.push(supervisor);
		await expect(supervisor.create({ cwd: makeTmp() })).rejects.toMatchObject({ code: "internal" });
	});
});

describe("supervisor: agent model changes", () => {
	it("returns a conflict when the worker does not answer within the configured timeout", async () => {
		const supervisor = make(["--ignore-model"], { modelChangeTimeoutMs: 15 });
		const { id } = await supervisor.create({ cwd: makeTmp() });

		await expect(supervisor.setAgentModel(id, "Main", "role-coder")).rejects.toMatchObject({
			code: "conflict",
			message: "timed out waiting for agent Main model change",
		});
	});
	it("does not resolve a later model change from an earlier timed-out reply", async () => {
		const logs: string[] = [];
		const supervisor = make(["--model-delay-sequence", "150,80", "--model-result-selector"], {
			modelChangeTimeoutMs: 100,
			log: message => logs.push(message),
		});
		const { id } = await supervisor.create({ cwd: makeTmp() });

		await expect(supervisor.setAgentModel(id, "Main", "first-selector")).rejects.toMatchObject({
			code: "conflict",
			message: "timed out waiting for agent Main model change",
		});
		const result = await supervisor.setAgentModel(id, "Main", "second-selector");
		expect(result.t).toBe("model-set");
		if (result.t !== "model-set") throw new Error("expected model-set reply");
		expect(result.model).toBe("second-selector");
		expect(logs.some(message => message.includes("dropping unmatched model reply"))).toBe(true);
	});

});

describe("supervisor: notifications", () => {
	it("forwards notify lines with the session id and title", async () => {
		const dir = makeTmp();
		const notes: NotifyEvent[] = [];
		const script = JSON.stringify([{ at: 50, emit: { t: "notify", reason: "needs-answer", summary: "pick one" } }]);
		const supervisor = make(["--script", script], { onNotify: e => notes.push(e) });
		const summary = await supervisor.create({ cwd: dir });
		await until(() => notes.length === 1, "notify forwarded");
		expect(notes[0]).toEqual({ sessionId: summary.id, title: `fake ${summary.id}`, reason: "needs-answer", summary: "pick one" });
	});

	it("copies loop and Vibe mode updates into session summaries", async () => {
		const script = JSON.stringify([
			{
				at: 30,
				emit: {
					t: "state",
					state: "asking",
					awaitingAnswer: true,
					goalActive: true,
					agentCount: 3,
					lastEventAt: "now",
					loopMode: { active: true, iteration: 2, limit: "5 iterations", waitingForPrompt: false },
					vibeMode: { active: true, workers: ["Vibeprobe"] },
				},
			},
			{
				at: 400,
				emit: {
					t: "state",
					state: "idle",
					awaitingAnswer: false,
					goalActive: false,
					agentCount: 0,
					lastEventAt: "now",
					loopMode: { active: false, iteration: 2, waitingForPrompt: false },
					vibeMode: { active: false, workers: [] },
				},
			},
		]);
		const supervisor = make(["--script", script]);
		const { id } = await supervisor.create({ cwd: makeTmp() });
		await until(() => supervisor.get(id)?.state === "asking", "asking state");
		expect(supervisor.get(id)).toMatchObject({
			awaitingAnswer: true,
			goalActive: true,
			agentCount: 3,
			loopMode: { active: true, iteration: 2, limit: "5 iterations" },
			vibeMode: { active: true, workers: ["Vibeprobe"] },
		});
		await until(() => supervisor.get(id)?.state === "idle" && supervisor.get(id)?.vibeMode?.active === false, "modes cleared");
		expect(supervisor.get(id)).toMatchObject({
			loopMode: { active: false, iteration: 2 },
			vibeMode: { active: false, workers: [] },
		});
	});

	it("reports the goal objective while the state line carries one and clears it when it stops", async () => {
		const script = JSON.stringify([
			{ at: 30, emit: { t: "state", state: "streaming", awaitingAnswer: false, goalActive: true, goalObjective: "Ship the migration", agentCount: 1, lastEventAt: "now" } },
			{ at: 400, emit: { t: "state", state: "idle", awaitingAnswer: false, goalActive: false, agentCount: 1, lastEventAt: "now" } },
		]);
		const supervisor = make(["--script", script]);
		const { id } = await supervisor.create({ cwd: makeTmp() });
		await until(() => supervisor.get(id)?.goalObjective === "Ship the migration", "goal objective");
		expect(supervisor.get(id)).toMatchObject({ goalActive: true, goalObjective: "Ship the migration" });
		await until(() => supervisor.get(id)?.state === "idle" && supervisor.get(id)?.goalActive === false, "goal cleared");
		expect(supervisor.get(id)).not.toHaveProperty("goalObjective");
	});
});

describe("supervisor: crash handling", () => {
	it("restarts a crashed worker once, resuming its session file, and reports the restart", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launch.jsonl");
		const crashes: CrashEvent[] = [];
		const supervisor = make(["--crash-once", path.join(dir, "marker"), "--dump", dump], { onCrash: e => crashes.push(e) });
		const { id, sessionFile } = await supervisor.create({ cwd: dir });
		await until(async () => (await supervisor.health())[0]?.restarts === 1 && supervisor.get(id)?.state === "idle", "restarted and idle");

		expect(crashes).toHaveLength(1);
		expect(crashes[0]).toMatchObject({ sessionId: id, exitCode: 1, willRestart: true, restarts: 0 });
		const launches = readJsonLines(dump).map(l => l.argv as string[]);
		expect(launches).toHaveLength(2);
		// The restart resumes the same session file and keeps the same room.
		expect(launches[1]!.slice(launches[1]!.indexOf("--resume"))).toEqual(["--resume", sessionFile!]);
		expect(launches[1]![launches[1]!.indexOf("--room") + 1]).toBe(launches[0]![launches[0]!.indexOf("--room") + 1]);
		expect(supervisor.get(id)?.state).toBe("idle");
	});

	it("restarts an idle worker from its session file under the same id and room credentials", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launches.jsonl");
		const supervisor = make(["--dump", dump]);
		const session = await supervisor.create({ cwd: dir });
		const transcript = '{"type":"message","text":"resume this session"}\n';
		fs.writeFileSync(session.sessionFile!, transcript);
		const originalSecrets = supervisor.roomSecrets(session.id)!;

		const restarted = await supervisor.restart(session.id);
		expect(restarted).toMatchObject({ id: session.id, state: "idle", sessionFile: session.sessionFile, roomId: session.roomId });
		expect(supervisor.roomSecrets(session.id)).toEqual(originalSecrets);
		expect(fs.readFileSync(session.sessionFile!, "utf8")).toBe(transcript);
		const launches = readJsonLines(dump);
		expect(launches).toHaveLength(2);
		expect(launches[1]!.key).toBe(launches[0]!.key);
		expect(launches[1]!.token).toBe(launches[0]!.token);
		expect((launches[1]!.argv as string[]).slice(-2)).toEqual(["--resume", session.sessionFile!]);
	});

	it("refuses busy restarts unless confirmed, then aborts before reopening the same session", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launches.jsonl");
		const requests = path.join(dir, "requests.jsonl");
		const supervisor = make(["--streaming-forever", "--dump", dump, "--dump-requests", requests]);
		const session = await supervisor.create({ cwd: dir });
		fs.writeFileSync(session.sessionFile!, "transcript\n");
		await until(() => supervisor.get(session.id)?.state === "streaming", "worker streaming");

		await expect(supervisor.restart(session.id)).rejects.toMatchObject({ code: "conflict" });
		expect(readJsonLines(dump)).toHaveLength(1);
		expect(supervisor.get(session.id)?.state).toBe("streaming");

		const restarted = await supervisor.restart(session.id, true);
		expect(restarted.id).toBe(session.id);
		expect(restarted.sessionFile).toBe(session.sessionFile);
		await until(() => supervisor.get(session.id)?.state === "streaming", "restarted worker streaming");
		const commands = fs.readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		expect(commands.some(command => command.t === "abort")).toBe(true);
		const launches = readJsonLines(dump);
		expect(launches).toHaveLength(2);
		expect((launches[1]!.argv as string[]).slice(-2)).toEqual(["--resume", session.sessionFile!]);
	});
	it("keeps a restricted tool set on the restart (the hidden agenda session must never regain all tools)", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launch.jsonl");
		const supervisor = make(["--crash-once", path.join(dir, "marker"), "--dump", dump]);
		const { id } = await supervisor.create({ cwd: dir, toolAllowlist: ["agenda_today", "agenda_add"] });
		await until(async () => (await supervisor.health())[0]?.restarts === 1 && supervisor.get(id)?.state === "idle", "restarted");
		const launches = readJsonLines(dump).map(l => l.argv as string[]);
		expect(launches).toHaveLength(2);
		for (const argv of launches) expect(argv[argv.indexOf("--tools") + 1]).toBe("agenda_today,agenda_add");
	});

	it("gives up after two automatic restarts and stays crashed", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launch.jsonl");
		const crashes: CrashEvent[] = [];
		const supervisor = make(["--crash-after", "40", "--dump", dump], { onCrash: e => crashes.push(e) });
		const { id } = await supervisor.create({ cwd: dir });
		await until(() => crashes.length === 3, "three crashes");
		expect(crashes.map(c => c.willRestart)).toEqual([true, true, false]);

		await Bun.sleep(300); // no fourth launch may appear
		expect(readJsonLines(dump)).toHaveLength(3);
		expect(supervisor.get(id)?.state).toBe("crashed");
		const [health] = await supervisor.health();
		expect(health).toMatchObject({ sessionId: id, restarts: 2, state: "crashed", stalled: false });
	});

	it("does not restart a worker that is being stopped", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "launch.jsonl");
		const crashes: CrashEvent[] = [];
		const supervisor = make(["--dump", dump], { onCrash: e => crashes.push(e) });
		const { id } = await supervisor.create({ cwd: dir });
		expect(await supervisor.stop(id)).toBe(true);
		await Bun.sleep(150);
		expect(crashes).toHaveLength(0);
		expect(readJsonLines(dump)).toHaveLength(1);
		expect(supervisor.get(id)).toBeUndefined();
	});
});

describe("supervisor: stall detection and health", () => {
	it("flags a streaming worker with no event for stalledAfterMs, not an idle or active one", async () => {
		const dir = makeTmp();
		const stalledSup = make(["--streaming-forever"], { stalledAfterMs: 150 });
		const idleSup = make([], { stalledAfterMs: 150 });
		const stalled = await stalledSup.create({ cwd: dir });
		await idleSup.create({ cwd: dir });
		await until(() => stalledSup.get(stalled.id)?.state === "streaming", "streaming");
		expect((await stalledSup.health())[0]!.stalled).toBe(false);
		await Bun.sleep(250);
		const [health] = await stalledSup.health();
		expect(health!.stalled).toBe(true);
		expect((await idleSup.health())[0]!.stalled).toBe(false);
		expect(health!.pid).toBeGreaterThan(0);
		expect(health!.rssBytes).toBeGreaterThan(1_000_000);
	});

	it("clears the stall flag when a new event arrives", async () => {
		const dir = makeTmp();
		// The scripted event comes well after the stall threshold, and the check polls, so a slow machine only widens
		// the stalled window instead of skipping it; after the event the session is fresh for another 400 ms.
		const script = JSON.stringify([
			{ at: 1500, emit: { t: "state", state: "streaming", awaitingAnswer: false, goalActive: false, agentCount: 1, lastEventAt: "now" } },
		]);
		const supervisor = make(["--streaming-forever", "--script", script], { stalledAfterMs: 400 });
		await supervisor.create({ cwd: dir });
		await until(async () => (await supervisor.health())[0]!.stalled === true, "stalled before the scripted event", 5_000);
		await until(async () => (await supervisor.health())[0]!.stalled === false, "stall cleared by the scripted event", 5_000);
	});

	it("never flags a paused turn as stalled: it emits nothing on purpose", async () => {
		const dir = makeTmp();
		const script = JSON.stringify([
			{ at: 50, emit: { t: "state", state: "streaming", awaitingAnswer: false, goalActive: false, agentCount: 1, lastEventAt: "now", paused: true, pausedAt: Date.now() } },
		]);
		const supervisor = make(["--streaming-forever", "--script", script], { stalledAfterMs: 150 });
		const session = await supervisor.create({ cwd: dir });
		await until(() => supervisor.get(session.id)?.paused === true, "paused");
		await Bun.sleep(400);
		const [health] = await supervisor.health();
		expect(health!.state).toBe("streaming");
		expect(health!.stalled).toBe(false);
	});

	it("stamps a turn through questions and reports its duration when it ends", async () => {
		const dir = makeTmp();
		const notes: NotifyEvent[] = [];
		const script = JSON.stringify([
			{ at: 50, emit: { t: "state", state: "streaming", awaitingAnswer: false, goalActive: false, agentCount: 1, lastEventAt: "now" } },
			{ at: 200, emit: { t: "state", state: "asking", awaitingAnswer: true, goalActive: false, agentCount: 1, lastEventAt: "now" } },
			{ at: 350, emit: { t: "state", state: "idle", awaitingAnswer: false, goalActive: false, agentCount: 1, lastEventAt: "now" } },
			{ at: 420, emit: { t: "notify", reason: "turn-finished" } },
		]);
		const supervisor = make(["--script", script], { onNotify: event => notes.push(event) });
		const created = await supervisor.create({ cwd: dir });
		await until(() => supervisor.get(created.id)?.state === "streaming", "streaming");
		const started = supervisor.get(created.id)?.turnStartedAt;
		expect(started).toBeNumber();
		await until(() => supervisor.get(created.id)?.state === "asking", "asking");
		expect(supervisor.get(created.id)?.turnStartedAt).toBe(started!);
		await until(() => supervisor.get(created.id)?.state === "idle", "idle");
		expect(supervisor.get(created.id)?.turnStartedAt).toBeUndefined();
		await until(() => notes.length === 1, "turn-finished notify");
		expect(notes[0]).toMatchObject({ sessionId: created.id, reason: "turn-finished" });
		expect(notes[0]!.durationMs).toBeGreaterThan(100);
	});
});

describe("supervisor: stop escalation and shutdown", () => {
	it("stops cooperatively via the stop command without signals", async () => {
		const dir = makeTmp();
		const supervisor = make([]);
		const { id } = await supervisor.create({ cwd: dir });
		const pid = (await supervisor.health())[0]!.pid;
		const started = Date.now();
		await supervisor.stop(id);
		expect(Date.now() - started).toBeLessThan(250); // well inside stopGraceMs: no escalation
		expect(isAlive(pid)).toBe(false);
	});

	it("escalates to SIGTERM when the worker ignores stop", async () => {
		const dir = makeTmp();
		const supervisor = make(["--ignore-stop"]);
		const { id } = await supervisor.create({ cwd: dir });
		const pid = (await supervisor.health())[0]!.pid;
		const started = Date.now();
		await supervisor.stop(id);
		const took = Date.now() - started;
		expect(took).toBeGreaterThanOrEqual(280);
		expect(took).toBeLessThan(2_000);
		expect(isAlive(pid)).toBe(false);
	});

	it("escalates to SIGKILL when the worker ignores stop and SIGTERM, and kills its process group", async () => {
		const dir = makeTmp();
		const childFile = path.join(dir, "child.pid");
		const supervisor = make(["--ignore-stop", "--ignore-term", "--spawn-child", childFile]);
		const { id } = await supervisor.create({ cwd: dir });
		const pid = (await supervisor.health())[0]!.pid;
		const childPid = Number(fs.readFileSync(childFile, "utf8"));
		expect(isAlive(childPid)).toBe(true);
		const started = Date.now();
		await supervisor.stop(id);
		expect(Date.now() - started).toBeGreaterThanOrEqual(580); // stop grace + term grace
		expect(isAlive(pid)).toBe(false);
		await until(() => !isAlive(childPid), "child in worker group killed");
	});

	it("sweeps stragglers even when the worker exits cleanly", async () => {
		const dir = makeTmp();
		const childFile = path.join(dir, "child.pid");
		const supervisor = make(["--spawn-child", childFile]);
		const { id } = await supervisor.create({ cwd: dir });
		const childPid = Number(fs.readFileSync(childFile, "utf8"));
		await supervisor.stop(id);
		await until(() => !isAlive(childPid), "straggler swept after clean exit");
	});

	it("shutdown stops every worker, including stubborn ones and ones still starting, and refuses new sessions", async () => {
		const dir = makeTmp();
		const supervisor = make(["--ignore-stop", "--ignore-term"]);
		const a = await supervisor.create({ cwd: dir });
		const b = await supervisor.create({ cwd: dir });
		const pids = (await supervisor.health()).map(h => h.pid);
		expect(pids).toHaveLength(2);
		expect(a.id).not.toBe(b.id);
		await supervisor.shutdown();
		for (const pid of pids) expect(isAlive(pid)).toBe(false);
		expect(supervisor.list()).toHaveLength(0);
		await expect(supervisor.create({ cwd: dir })).rejects.toMatchObject({ code: "conflict" });

		const startingSup = make(["--no-ready"]);
		const pending = startingSup.create({ cwd: dir });
		pending.catch(() => {});
		await Bun.sleep(150);
		await startingSup.shutdown();
		await expect(pending).rejects.toMatchObject({ code: "conflict" });
	});

	it("stop of an unknown session id reports false", async () => {
		expect(await make([]).stop("nope")).toBe(false);
	});
});
