import { afterEach, describe, expect, test } from "bun:test";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import {
	Fixture,
	newRoom,
	pidsMatching,
	type Room,
	sleep,
	snapshotText,
	waitUntil,
	type WorkerLine,
	type WorkerProcess,
} from "./harness";

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

async function liveGuest(f: Fixture, room: Room, name?: string) {
	const guest = f.guest(room, name);
	await waitUntil("guest live", () => guest.getSnapshot().phase === "live" && guest.getSnapshot().state);
	return guest;
}

const stateLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "state" }> => line.t === "state");

describe("worker over a relay", () => {
	test("ready, welcome with model/context/agents, and a prompt that streams into a final entry", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		const ready = await worker.ready();
		expect(ready.roomId).toBe(room.id);
		expect(ready.rootAgentId).toBe("Main");
		expect(ready.sessionFile).toEndWith(".jsonl");

		const guest = await liveGuest(fixture, room);
		const welcome = guest.getSnapshot();
		expect(welcome.state?.model?.id).toBe("stub-model");
		expect(welcome.state?.contextUsage?.contextWindow).toBe(128000);
		expect(welcome.agents.map(agent => agent.id)).toContain("Main");

		guest.sendPrompt("hello worker");
		await waitUntil("echo entry on the guest", () => snapshotText(guest.getSnapshot()).includes("echo:hello worker"));
		const finalText = snapshotText(guest.getSnapshot());
		expect(finalText).toContain("echo:hello worker");
		await waitUntil("turn-finished notify", () => worker.lines.find(line => line.t === "notify"));
		await waitUntil("guest working state cleared", () => guest.getSnapshot().working === false);

		// Daemon-facing status: idle -> streaming -> idle, and the summary of the finished turn.
		const states = stateLines(worker).map(line => line.state);
		expect(states).toContain("streaming");
		await waitUntil("idle state", () => stateLines(worker).at(-1)?.state === "idle");
		const notify = worker.lines.find(line => line.t === "notify");
		expect(notify).toMatchObject({ reason: "turn-finished" });
		expect(notify && "summary" in notify ? notify.summary : "").toContain("echo:hello worker");

		worker.send({ t: "ping", id: "p1" });
		await waitUntil("pong", () => worker.lines.find(line => line.t === "pong" && line.id === "p1"));
	}, 90_000);

	test("keeps guest traffic bounded for a 40 KiB streamed answer", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const answerBytes = 40 * 1024;
		const answer = Array.from(
			{ length: Math.ceil(answerBytes / 23) },
			(_, index) => `guest packet ${index.toString(16).padStart(4, "0")} data\n`,
		)
			.join("")
			.slice(0, answerBytes);
		const encodedAnswer = JSON.stringify(answer).slice(1, -1);
		const worker = fixture.spawn(room, [], { STUB_STREAM_BYTES: String(answerBytes) });
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		const bytesBefore = fixture.relay.bytesSentToGuests(room.id);

		guest.sendPrompt("STREAM_BYTES:");
		await waitUntil("complete 40 KiB answer at guest", () => snapshotText(guest.getSnapshot()).includes(encodedAnswer), 15_000);
		await waitUntil("worker idle after long answer", () => stateLines(worker).at(-1)?.state === "idle", 60_000);

		const sentBytes = fixture.relay.bytesSentToGuests(room.id) - bytesBefore;
		expect(sentBytes).toBeGreaterThanOrEqual(answerBytes);
		expect(sentBytes).toBeLessThan(1_000_000);
		console.log(`collab stream: ${answerBytes} answer bytes, ${sentBytes} guest bytes`);
	}, 90_000);

	test("gates agenda tools and the computer-use eval prelude by default, then exposes them when enabled", async () => {
		fixture = new Fixture();
		const defaultRoom = newRoom();
		const defaultWorker = fixture.spawn(defaultRoom, [], { OMP_CONSOLE_COMPUTER_USE: "0" });
		await defaultWorker.ready();
		const defaultReply = await defaultWorker.request<Extract<WorkerLine, { t: "catalog" }>>({
			t: "catalog",
			id: "default-catalog",
		});
		const defaultNames = defaultReply.catalog.tools.map(tool => tool.name);
		expect(defaultNames).not.toContain("agenda_today");
		expect(defaultNames).not.toContain("agenda_add");
		expect(defaultNames).not.toContain("agenda_complete");
		const defaultGuest = await liveGuest(fixture, defaultRoom);
		defaultGuest.sendPrompt("COMPUTER_PRELUDE:");
		await waitUntil("computer prelude absent by default", () => snapshotText(defaultGuest.getSnapshot()).includes("computer-prelude:absent"));

		const enabledRoom = newRoom();
		const enabledWorker = fixture.spawn(
			enabledRoom,
			["--agenda-tools", "on", "--computer-use", "on"],
			{ OMP_CONSOLE_COMPUTER_USE: "0" },
		);
		await enabledWorker.ready();
		const enabledReply = await enabledWorker.request<Extract<WorkerLine, { t: "catalog" }>>({
			t: "catalog",
			id: "enabled-catalog",
		});
		const enabledNames = enabledReply.catalog.tools.map(tool => tool.name);
		expect(enabledNames).toContain("agenda_today");
		expect(enabledNames).toContain("agenda_add");
		expect(enabledNames).toContain("agenda_complete");
		const enabledGuest = await liveGuest(fixture, enabledRoom);
		enabledGuest.sendPrompt("COMPUTER_PRELUDE:");
		await waitUntil("computer prelude available when enabled", () => snapshotText(enabledGuest.getSnapshot()).includes("computer-prelude:present"));
	}, 90_000);

	test("the room key and write token never reach a shell the agent runs", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("ENVPROBE:");
		await waitUntil("env probe result", () => /tool-done:/.test(snapshotText(guest.getSnapshot())), 30_000);
		const text = snapshotText(guest.getSnapshot());
		expect(text).toContain("PROBE_COUNT=0");
		expect(text).not.toContain(Buffer.from(room.key).toString("base64url"));
		expect(text).not.toContain(Buffer.from(room.token).toString("base64url"));
	}, 90_000);

	test("ask: a guest answer unblocks the turn; the question survives a guest reconnect without leaking", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();

		const first = await liveGuest(fixture, room, "first");
		const question = "pick one ".repeat(40).trim();
		first.sendPrompt(`ASK:${question}`);
		const request = await waitUntil("ask request on first guest", () => first.getSnapshot().uiRequest);
		const asking = await waitUntil("asking state with pending question", () =>
			stateLines(worker).find(line => line.state === "asking" && line.pendingQuestion),
		);
		expect(asking.pendingQuestion).toBe(`${question.slice(0, 199)}…`);
		expect(asking.pendingKind).toBe("ask");
		expect(asking.pendingQuestion).toHaveLength(200);
		expect(asking.awaitingAnswer).toBe(true);
		expect(worker.lines.find(line => line.t === "notify" && line.reason === "needs-answer")).toBeDefined();

		// The answering guest drops mid-question; a new one joins and is shown the same question.
		first.close();
		const second = await liveGuest(fixture, room, "second");
		const replayed = await waitUntil("ask replayed to second guest", () => second.getSnapshot().uiRequest);
		expect(replayed.reqId).toBe(request.reqId);

		second.sendUiResponse(replayed.reqId, "beta");
		await waitUntil("asked-result entry", () => snapshotText(second.getSnapshot()).includes("asked-result:"));
		expect(snapshotText(second.getSnapshot())).toContain("beta");
		const idle = await waitUntil("idle again with pending question cleared", () => {
			const last = stateLines(worker).at(-1);
			return last?.state === "idle" && !last.awaitingAnswer ? last : undefined;
		});
		expect(idle.pendingQuestion).toBeUndefined();
		expect(idle.pendingKind).toBeUndefined();
		expect(second.getSnapshot().uiRequest).toBeNull();

		// Nothing is wedged: the same session takes another prompt.
		second.sendPrompt("after ask");
		await waitUntil("post-ask echo", () => snapshotText(second.getSnapshot()).includes("echo:after ask"));
	}, 90_000);

	test("ask: with nobody answering, the configured ask timeout resolves the question and frees the turn", async () => {
		fixture = new Fixture({ configYaml: "ask:\n  timeout: 2\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("ASK:nobody home");
		await waitUntil("question shown", () => guest.getSnapshot().uiRequest);
		const shownAt = Date.now();
		await waitUntil("auto-resolved turn", () => snapshotText(guest.getSnapshot()).includes("asked-result:"), 30_000);
		expect(Date.now() - shownAt).toBeLessThan(15_000);
		expect(snapshotText(guest.getSnapshot())).toContain("alpha");
		await waitUntil("pending cleared", () => {
			const last = stateLines(worker).at(-1);
			return last?.state === "idle" && !last.awaitingAnswer;
		});
		expect(guest.getSnapshot().uiRequest).toBeNull();
	}, 90_000);

	test("abort from a guest stops the running turn and leaves the session usable", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		guest.sendPrompt("SLOW:never finishes on its own");
		await waitUntil("streaming", () => stateLines(worker).find(line => line.state === "streaming"));
		const abortedAt = Date.now();
		guest.sendAbort();
		await waitUntil("idle after abort", () => stateLines(worker).at(-1)?.state === "idle", 10_000);
		expect(Date.now() - abortedAt).toBeLessThan(8_000);
		await waitUntil("guest sees turn end", () => guest.getSnapshot().working === false);

		guest.sendPrompt("still alive");
		await waitUntil("echo after abort", () => snapshotText(guest.getSnapshot()).includes("echo:still alive"));
	}, 90_000);

	test("daemon abort command returns its result and leaves the real worker usable", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		guest.sendPrompt("SLOW:daemon command stops this turn");
		await waitUntil("streaming", () => stateLines(worker).find(line => line.state === "streaming"));
		worker.send({ t: "abort", id: "abort-request-1" });
		const aborted = await waitUntil(
			"worker abort result",
			() => worker.lines.find((line): line is Extract<WorkerLine, { t: "aborted" }> => line.t === "aborted" && line.id === "abort-request-1"),
		);
		expect(aborted).toMatchObject({ id: "abort-request-1", aborted: true });
		await waitUntil("idle after daemon abort", () => stateLines(worker).at(-1)?.state === "idle", 10_000);
		await waitUntil("guest sees daemon-aborted turn end", () => guest.getSnapshot().working === false);
		guest.sendPrompt("still usable after daemon abort");
		await waitUntil("echo after daemon abort", () =>
			snapshotText(guest.getSnapshot()).includes("echo:still usable after daemon abort"),
		);
	}, 90_000);

	test("model command results echo the request id on success and error", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		await worker.ready();

		worker.send({ t: "set-agent-model", id: "model-request-1", agentId: "Main", selector: "stub/stub-model-2" });
		const changed = await waitUntil(
			"model-set reply with matching id",
			() => worker.lines.find((line): line is Extract<WorkerLine, { t: "model-set" }> => line.t === "model-set" && line.id === "model-request-1"),
			5_000,
		);
		expect(changed).toMatchObject({ id: "model-request-1", agentId: "Main", model: "stub/stub-model-2" });

		worker.send({ t: "set-agent-model", id: "model-request-2", agentId: "Main", selector: "stub/no-such-model" });
		const rejected = await waitUntil(
			"model-error reply with matching id",
			() => worker.lines.find((line): line is Extract<WorkerLine, { t: "model-error" }> => line.t === "model-error" && line.id === "model-request-2"),
			5_000,
		);
		expect(rejected).toMatchObject({ id: "model-request-2", agentId: "Main" });
	}, 90_000);

	test("a task subagent appears under the root in the agents frame; the frame holds only this session's tree", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		guest.sendPrompt("TASK:delegate");
		const child = await waitUntil(
			"subagent in agents frame",
			() => guest.getSnapshot().agents.find(agent => agent.parentId === "Main"),
			30_000,
		);
		expect(child.kind).toBe("sub");
		expect(child.id).not.toBe("Main");
		await waitUntil("agentCount reported", () => stateLines(worker).find(line => line.agentCount >= 1), 30_000);

		// Every agent in the frame is the root or hangs below it: no other session's agents leak in.
		const agents = guest.getSnapshot().agents;
		const byId = new Map(agents.map(agent => [agent.id, agent]));
		for (const agent of agents) {
			let cursor: typeof agent | undefined = agent;
			for (let hops = 0; cursor && cursor.id !== "Main" && hops < 16; hops++)
				cursor = byId.get(cursor.parentId ?? "");
			expect(cursor?.id).toBe("Main");
		}
		await waitUntil(
			"task result reaches the root turn",
			() => snapshotText(guest.getSnapshot()).includes("sub-done"),
			60_000,
		);
	}, 120_000);

	test("a guest speaking another protocol version is refused with the documented error", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();

		const socket = new CollabSocket({
			wsUrl: `${fixture.relay.url}/r/${room.id}`,
			role: "guest",
			key: await importRoomKey(room.key),
		});
		const replies: unknown[] = [];
		socket.onOpen = () => socket.send({ t: "hello", proto: 99, name: "from the future" });
		socket.onFrame = frame => replies.push(frame);
		socket.connect();
		try {
			await waitUntil("error frame", () => replies.length > 0, 20_000);
		} finally {
			socket.close();
		}
		expect(replies[0]).toEqual({ t: "error", message: "protocol mismatch: host speaks v3, guest sent v99" });
		expect(replies.some(frame => (frame as { t: string }).t === "welcome")).toBe(false);
	}, 60_000);
});

describe("shutdown", () => {
	/** Starts a worker with a bash child (`sleep <n>`) running so there is something to orphan. */
	async function workerWithChild(seconds: number) {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt(`SLEEP:${seconds}`);
		await waitUntil("sleep child running", () => pidsMatching(`sleep ${seconds}`).length > 0, 30_000);
		return worker;
	}

	async function expectCleanExit(worker: WorkerProcess, seconds: number, trigger: () => void, code: number) {
		const startedAt = Date.now();
		trigger();
		const exitCode = await Promise.race([worker.exited, sleep(6_000).then(() => "timeout" as const)]);
		expect(exitCode).toBe(code);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		await waitUntil("no orphaned children", () => pidsMatching(`sleep ${seconds}`).length === 0, 2_000);
		expect(worker.proc.killed || worker.proc.exitCode !== null).toBe(true);
	}

	test("stop command ends the process within 5 s and leaves no children", async () => {
		const worker = await workerWithChild(7731);
		await expectCleanExit(worker, 7731, () => worker.send({ t: "stop" }), 0);
	}, 90_000);

	test("stdin EOF ends the process within 5 s and leaves no children", async () => {
		const worker = await workerWithChild(7732);
		await expectCleanExit(worker, 7732, () => void worker.proc.stdin.end(), 0);
	}, 90_000);

	test("SIGTERM ends the process within 5 s and leaves no children", async () => {
		const worker = await workerWithChild(7733);
		// SIGTERM goes through the shared postmortem handler: our teardown runs as its cleanup, then 128+15.
		await expectCleanExit(worker, 7733, () => worker.proc.kill("SIGTERM"), 143);
	}, 90_000);

	test("a pending question does not hold shutdown", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("ASK:left hanging");
		await waitUntil("question shown", () => guest.getSnapshot().uiRequest);
		const startedAt = Date.now();
		worker.send({ t: "stop" });
		expect(await worker.exited).toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	}, 90_000);
});

describe("resume and fork", () => {
	/** Runs a first worker through one turn, stops it, and returns its session file and id. */
	async function priorSession(f: Fixture) {
		const room = newRoom();
		const first = f.spawn(room);
		const ready = await first.ready();
		const guest = await liveGuest(f, room);
		guest.sendPrompt("remember this");
		await waitUntil("first turn", () => snapshotText(guest.getSnapshot()).includes("echo:remember this"));
		await waitUntil("idle", () => stateLines(first).at(-1)?.state === "idle");
		first.send({ t: "stop" });
		expect(await first.exited).toBe(0);
		return { file: ready.sessionFile as string, sessionId: ready.sessionId };
	}

	test("--resume continues the same session: same id, prior transcript replayed to a new guest", async () => {
		fixture = new Fixture();
		const prior = await priorSession(fixture);
		const room = newRoom();
		const worker = fixture.spawn(room, ["--resume", prior.file]);
		const ready = await worker.ready();
		expect(ready.sessionId).toBe(prior.sessionId);
		const guest = await liveGuest(fixture, room);
		await waitUntil("history replayed", () => snapshotText(guest.getSnapshot()).includes("echo:remember this"));
		guest.sendPrompt("and then");
		await waitUntil("new turn on resumed session", () => snapshotText(guest.getSnapshot()).includes("echo:and then"));
	}, 120_000);

	test("--fork starts a new session that carries the source history and leaves the source untouched", async () => {
		fixture = new Fixture();
		const prior = await priorSession(fixture);
		const before = await Bun.file(prior.file).text();
		const room = newRoom();
		const worker = fixture.spawn(room, ["--fork", prior.file]);
		const ready = await worker.ready();
		expect(ready.sessionId).not.toBe(prior.sessionId);
		expect(ready.sessionFile).not.toBe(prior.file);
		const guest = await liveGuest(fixture, room);
		await waitUntil("history carried into the fork", () =>
			snapshotText(guest.getSnapshot()).includes("echo:remember this"),
		);
		guest.sendPrompt("diverge");
		await waitUntil("turn on the fork", () => snapshotText(guest.getSnapshot()).includes("echo:diverge"));
		expect(await Bun.file(prior.file).text()).toBe(before);
	}, 120_000);
});
