/**
 * `session-op` against a real worker process (scripted stub provider, isolated config root, no network): each
 * operation must change what omp's session actually does, not just reply `ok`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	CleanseRunSnapshot,
	SessionOp,
	SessionOpResult,
	SessionOpV3,
	SessionOpV3Result,
	WorkerAbortResult,
	WorkerRequestResult,
} from "@omp-console/protocol";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Fixture, newRoom, pidsMatching, sleep, snapshotText, waitUntil, type WorkerLine, type WorkerProcess } from "./harness";

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

let counter = 0;
async function op(worker: WorkerProcess, operation: SessionOp | SessionOpV3): Promise<WorkerRequestResult> {
	return worker.request<WorkerRequestResult>({ t: "session-op", id: `op-${++counter}`, op: operation });
}

function ok(reply: WorkerRequestResult): SessionOpResult | SessionOpV3Result {
	if (reply.t !== "session-op") throw new Error(`expected a session-op result, got ${JSON.stringify(reply)}`);
	return reply.result;
}

const failure = (reply: WorkerRequestResult) => (reply.t === "request-error" ? reply : undefined);
const stateLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "state" }> => line.t === "state");

function finishedTurnCount(worker: WorkerProcess): number {
	return worker.lines.filter(line => line.t === "notify" && line.reason === "turn-finished").length;
}

function latestTurnSummary(worker: WorkerProcess): string {
	return (
		worker.lines.findLast(
			(line): line is Extract<WorkerLine, { t: "notify" }> => line.t === "notify" && line.reason === "turn-finished",
		)?.summary ?? ""
	);
}

/** Entries of the session file, parsed. The worker writes it itself, so this is what a resume would read. */
function sessionEntries(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

async function liveGuest(f: Fixture, room: ReturnType<typeof newRoom>) {
	const guest = f.guest(room);
	await waitUntil("guest live", () => guest.getSnapshot().phase === "live" && guest.getSnapshot().state);
	return guest;
}

async function latestAgentEntryId(worker: WorkerProcess): Promise<string> {
	const result = ok(await op(worker, { op: "tree" }));
	if (!("tree" in result)) throw new Error("no session tree");
	const node = result.tree.findLast(candidate => candidate.role === "assistant" && candidate.onCurrentBranch);
	if (!node) throw new Error("no assistant answer entry");
	return node.entryId;
}

describe("session-op: modes", () => {
	test("loop repeats the user prompt to its count limit and then reports the completed iteration count", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		const enabled = ok(await op(worker, { op: "loop-mode", action: "toggle", args: "2" }));
		expect(enabled).toMatchObject({
			ok: true,
			loopMode: { active: true, iteration: 0, limit: "2 iterations", waitingForPrompt: true },
		});

		guest.sendPrompt("repeat this exactly");
		const answerCount = (): number => snapshotText(guest.getSnapshot()).split("echo:repeat this exactly").length - 1;
		await waitUntil("first loop answer", () => answerCount() >= 1, 30_000);
		await waitUntil("three loop answers", () => answerCount() >= 3, 60_000);
		await waitUntil("iteration budget exhausted", () => stateLines(worker).at(-1)?.loopMode?.active === false, 30_000);
		expect(answerCount()).toBe(3);
		expect(stateLines(worker).some(line => line.loopMode !== undefined && line.loopMode.iteration > 0)).toBe(true);
		expect(ok(await op(worker, { op: "loop-mode", action: "status" }))).toMatchObject({
			ok: true,
			loopMode: { active: false, iteration: 2 },
		});
	}, 120_000);

	test("loop conditions halt before resubmission, /loop off cancels the timer, and abort ends an active loop", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		const beforeCondition = finishedTurnCount(worker);
		await op(worker, { op: "loop-mode", action: "toggle", args: "--while false repeat only if true" });
		await waitUntil("condition turn finished", () => finishedTurnCount(worker) > beforeCondition, 30_000);
		await waitUntil("condition loop stopped", () => stateLines(worker).at(-1)?.loopMode?.active === false, 30_000);
		expect(latestTurnSummary(worker)).toContain("echo:repeat only if true");
		expect(ok(await op(worker, { op: "loop-mode", action: "status" }))).toMatchObject({
			loopMode: { active: false, message: expect.stringContaining("Loop condition") },
		});

		const beforeUnbounded = finishedTurnCount(worker);
		await op(worker, { op: "loop-mode", action: "toggle", args: "repeat until stopped" });
		await waitUntil("first unbounded loop answer", () => finishedTurnCount(worker) > beforeUnbounded);
		await op(worker, { op: "loop-mode", action: "disable" });
		await sleep(900);
		expect(finishedTurnCount(worker)).toBe(beforeUnbounded + 1);

		await op(worker, { op: "loop-mode", action: "toggle", args: "2 SLOW:abort this loop" });
		await waitUntil("loop turn streaming", () => stateLines(worker).at(-1)?.state === "streaming", 30_000);
		expect(await worker.request<WorkerAbortResult>({ t: "abort", id: "abort-loop-turn" })).toMatchObject({
			t: "aborted",
			aborted: true,
		});
		await waitUntil("aborted loop disabled", () => stateLines(worker).at(-1)?.loopMode?.active === false, 30_000);
	}, 120_000);

	test("loop state is cleared when the worker stops and the session resumes", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		const ready = await worker.ready();
		if (!ready.sessionFile) throw new Error("Expected a persisted session file");
		await op(worker, { op: "loop-mode", action: "toggle", args: "2 SLOW:clear on stop" });
		await waitUntil("loop turn streaming before stop", () => stateLines(worker).at(-1)?.state === "streaming", 30_000);
		worker.send({ t: "stop" });
		expect(await worker.exited).toBe(0);
		expect(stateLines(worker).at(-1)?.loopMode?.active).toBe(false);

		const resumed = fixture.spawn(room, ["--resume", ready.sessionFile]);
		await resumed.ready();
		await waitUntil("resumed worker reports no active loop", () => stateLines(resumed).at(-1)?.loopMode?.active === false);
	}, 90_000);

	test("Vibe restricts tools, registers and kills its worker sessions, aborts active turns, and restores tools", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\\n  sonic: stub/stub-model\\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		try {
			await op(worker, { op: "approval-mode", mode: "yolo" });
			await op(worker, { op: "vibe-mode", action: "toggle" });
			await waitUntil("Vibe mode active", () => stateLines(worker).at(-1)?.vibeMode?.active === true);

			const beforeRestricted = finishedTurnCount(worker);
			guest.sendPrompt("SLEEP:7");
			await waitUntil("restricted shell request ends", () => finishedTurnCount(worker) > beforeRestricted, 30_000);
			expect(latestTurnSummary(worker)).toContain("slept:");
			expect(pidsMatching("/bin/sleep 7")).toEqual([]);

			const beforeSpawn = finishedTurnCount(worker);
			guest.sendPrompt("VIBE:spawn a worker");
			const vibeState = await waitUntil(
				"Vibe worker registered",
				() => {
					const status = stateLines(worker).at(-1)?.vibeMode;
					return status?.active && status.workers.length === 1 ? status : undefined;
				},
				30_000,
			);
			const workerId = vibeState.workers[0]!;
			await waitUntil(
				"Vibe worker lifecycle reports start",
				() => worker.lines.some(line => line.t === "agent" && line.agentId === workerId && line.status === "started"),
				30_000,
			);

			// Let the spawn turn finish first: otherwise its own "streaming" state satisfies the wait below, the toggle
			// aborts that turn, and the SLOW prompt then runs its full 60 s after Vibe has ended.
			await waitUntil(
				"Vibe spawn turn finished",
				() => finishedTurnCount(worker) > beforeSpawn && stateLines(worker).at(-1)?.state === "idle",
				30_000,
			);
			const statesBeforeSlow = stateLines(worker).length;
			guest.sendPrompt("SLOW: parent turn must be aborted on Vibe exit");
			await waitUntil(
				"parent turn streaming in Vibe",
				() => stateLines(worker).slice(statesBeforeSlow).some(line => line.state === "streaming"),
				30_000,
			);
			await op(worker, { op: "vibe-mode", action: "toggle" });
			await waitUntil(
				"Vibe exit aborts parent and kills workers",
				() => stateLines(worker).at(-1)?.state === "idle" && stateLines(worker).at(-1)?.vibeMode?.active === false && stateLines(worker).at(-1)?.vibeMode?.workers.length === 0,
				30_000,
			);
			await waitUntil(
				"Vibe worker lifecycle reports cancellation",
				() => worker.lines.some(line => line.t === "agent" && line.agentId === workerId && line.status === "aborted"),
				30_000,
			);

			const beforeRestoredShell = finishedTurnCount(worker);
			guest.sendPrompt("SLEEP:1");
			await waitUntil("restored shell tool runs", () => finishedTurnCount(worker) > beforeRestoredShell, 30_000);
			expect(latestTurnSummary(worker)).toContain("slept:");
		} finally {
			if (worker.proc.exitCode === null) await op(worker, { op: "vibe-mode", action: "disable" }).catch(() => {});
		}
	}, 150_000);

	test("Vibe mode is rehydrated after a worker restart", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\\n  sonic: stub/stub-model\\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		const ready = await worker.ready();
		if (!ready.sessionFile) throw new Error("Expected a persisted session file");
		await op(worker, { op: "vibe-mode", action: "toggle" });
		await waitUntil("Vibe active before stop", () => stateLines(worker).at(-1)?.vibeMode?.active === true);
		worker.send({ t: "stop" });
		expect(await worker.exited).toBe(0);

		const resumed = fixture.spawn(room, ["--resume", ready.sessionFile]);
		await resumed.ready();
		await waitUntil("Vibe restored after resume", () => stateLines(resumed).at(-1)?.vibeMode?.active === true);
		await op(resumed, { op: "vibe-mode", action: "disable" });
		await waitUntil("restored Vibe mode exits", () => stateLines(resumed).at(-1)?.vibeMode?.active === false);
	}, 120_000);


	test("plan mode is journaled on and off, refuses to start a goal, and pauses an active goal until it ends", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		const { sessionFile } = await worker.ready();

		expect(ok(await op(worker, { op: "plan-mode", enabled: true }))).toEqual({ ok: true });
		// Idempotent: entering twice does not journal twice.
		expect(ok(await op(worker, { op: "plan-mode", enabled: true }))).toEqual({ ok: true });
		const planned = failure(await op(worker, { op: "goal", action: "set", objective: "ship it" }));
		expect(planned).toMatchObject({ code: "bad-request" });
		expect(planned?.message).toContain("plan mode");

		expect(ok(await op(worker, { op: "plan-mode", enabled: false }))).toEqual({ ok: true });
		const modes = sessionEntries(sessionFile!)
			.filter(entry => entry.type === "mode_change")
			.map(entry => entry.mode);
		expect(modes).toEqual(["plan", "none"]);

		expect(ok(await op(worker, { op: "goal", action: "set", objective: "ship it" }))).toEqual({ ok: true });
		await waitUntil("goal active", () => stateLines(worker).at(-1)?.goalActive === true);
		// The goal (often the agent's own) waits while the agent plans, then comes back.
		expect(ok(await op(worker, { op: "plan-mode", enabled: true }))).toEqual({ ok: true });
		await waitUntil("goal paused for planning", () => stateLines(worker).at(-1)?.goalActive === false);
		expect(ok(await op(worker, { op: "plan-mode", enabled: false }))).toEqual({ ok: true });
		await waitUntil("goal resumed", () => stateLines(worker).at(-1)?.goalActive === true);
	}, 90_000);

	test("a submitted plan is approved at once: nobody is asked, plan mode ends and the agent proceeds", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();
		const guest = await liveGuest(fixture, room);
		await op(worker, { op: "plan-mode", enabled: true });
		guest.sendPrompt("PLAN:ship the parser");
		await waitUntil(
			"plan executed",
			() => snapshotText(guest.getSnapshot()).includes("planned:") && stateLines(worker).at(-1)?.state === "idle",
			60_000,
		);
		expect(stateLines(worker).some(line => line.awaitingAnswer === true)).toBe(false);
		expect(snapshotText(guest.getSnapshot())).toContain("Plan approved");
		const modes = sessionEntries(sessionFile!)
			.filter(entry => entry.type === "mode_change")
			.map(entry => entry.mode);
		expect(modes).toEqual(["plan", "none"]);
	}, 120_000);

	test("goal: set, budget, pause, resume and drop move the state line; refusals are bad-request", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		await worker.ready();
		const goalState = () => stateLines(worker).at(-1);

		expect(failure(await op(worker, { op: "goal", action: "pause" }))).toMatchObject({ code: "bad-request" });
		expect(failure(await op(worker, { op: "goal", action: "budget", tokenBudget: 500 }))).toMatchObject({ code: "bad-request" });

		await op(worker, { op: "goal", action: "set", objective: "Make the build green", tokenBudget: 1000 });
		await waitUntil("goal active", () => goalState()?.goalActive === true && goalState());
		expect(goalState()?.goalObjective).toBe("Make the build green");
		const twice = failure(await op(worker, { op: "goal", action: "set", objective: "another" }));
		expect(twice).toMatchObject({ code: "bad-request" });
		expect(twice?.message).toContain("already active");

		await op(worker, { op: "goal", action: "budget", tokenBudget: 5000 });
		await op(worker, { op: "goal", action: "pause" });
		await waitUntil("goal paused", () => goalState()?.goalActive === false);
		await op(worker, { op: "goal", action: "resume" });
		await waitUntil("goal resumed", () => goalState()?.goalActive === true);
		await op(worker, { op: "goal", action: "drop" });
		await waitUntil("goal dropped", () => goalState()?.goalActive === false && goalState()?.goalObjective === undefined);
	}, 90_000);

	test("todos: the phases are replaced in the session and journaled as a user edit", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		const { sessionFile } = await worker.ready();
		const phases = [
			{ name: "Plan", tasks: [{ content: "Read the spec", status: "completed" as const }] },
			{
				name: "Build",
				tasks: [
					{ content: "Write the worker", status: "in_progress" as const },
					{ content: "Write the daemon", status: "pending" as const },
					{ content: "Wait for review", status: "blocked" as const },
				],
			},
		];
		expect(ok(await op(worker, { op: "todos", phases }))).toEqual({ ok: true });
		const edits = sessionEntries(sessionFile!).filter(entry => entry.type === "custom" && entry.customType === "user_todo_edit");
		expect(edits).toHaveLength(1);
		const journaled = (edits[0]!.data as { phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> }).phases;
		expect(journaled.map(phase => phase.name)).toEqual(["Plan", "Build"]);
		expect(journaled[1]!.tasks.map(task => `${task.status}:${task.content}`)).toEqual([
			"in_progress:Write the worker",
			"pending:Write the daemon",
			"blocked:Wait for review",
		]);

		// A second replacement replaces, it does not append.
		await op(worker, { op: "todos", phases: [{ name: "Only", tasks: [] }] });
		const latest = sessionEntries(sessionFile!).filter(entry => entry.type === "custom" && entry.customType === "user_todo_edit").at(-1);
		expect((latest!.data as { phases: unknown[] }).phases).toHaveLength(1);

		// A malformed op is refused with an answer instead of hanging the request.
		const malformed = failure(await worker.request<WorkerRequestResult>({ t: "session-op", id: "bad", op: { op: "todos", phases: [{ name: "x", tasks: [{ content: "y", status: "nope" }] }] } as unknown as SessionOp }));
		expect(malformed).toMatchObject({ code: "bad-request" });
	}, 90_000);

	test("approval mode: always-ask makes a shell call wait for an answer; the guest's answer lets it run", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		expect(ok(await op(worker, { op: "approval-mode", mode: "always-ask" }))).toEqual({ ok: true });
		guest.sendPrompt("SLEEP:1");
		const asking = await waitUntil("approval pending", () => stateLines(worker).find(line => line.pendingKind === "approval"));
		expect(asking.state).toBe("asking");
		const request = await waitUntil("approval request on the guest", () => guest.getSnapshot().uiRequest);
		guest.sendUiResponse(request.reqId, "Allow once");
		await waitUntil("command ran after the approval", () => snapshotText(guest.getSnapshot()).includes("slept:"));
	}, 90_000);

	test("host UI operations list, validate, and answer an open ask", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("ASK:choose one");
		const request = await waitUntil(
			"ask UI request",
			() => {
				const pending = guest.getSnapshot().uiRequest;
				return pending?.kind === "select" ? pending : undefined;
			},
			30_000,
		);
		await waitUntil("ask reported to daemon", () => stateLines(worker).at(-1)?.awaitingAnswer === true);

		const listed = ok(await op(worker, { op: "ui-requests" }));
		if (!("uiRequests" in listed)) throw new Error("no pending UI request list");
		expect(listed.uiRequests).toHaveLength(1);
		const pending = listed.uiRequests[0]!;
		expect(pending).toMatchObject({ reqId: String(request.reqId), kind: "select", title: "choose one" });
		if (pending.kind !== "select") throw new Error("ask request is not a select");
		expect((pending.options ?? []).map(option => option.label)).toEqual(["alpha (Recommended)", "beta", "Other (type your own)"]);
		expect(pending.at).toBeGreaterThan(0);
		expect(failure(await op(worker, { op: "ui-answer", reqId: "missing-request", value: "alpha" }))).toMatchObject({ code: "not-found" });
		expect(failure(await op(worker, { op: "ui-answer", reqId: pending.reqId, value: "not offered" }))).toMatchObject({ code: "bad-request" });
		expect(ok(await op(worker, { op: "ui-answer", reqId: pending.reqId, value: "alpha (Recommended)" }))).toEqual({ ok: true });
		expect(failure(await op(worker, { op: "ui-answer", reqId: pending.reqId, value: "alpha (Recommended)" }))).toMatchObject({ code: "conflict" });
		await waitUntil("ask answer consumed", () => snapshotText(guest.getSnapshot()).includes("asked-result:"));
		await waitUntil("ask no longer pending", () => stateLines(worker).at(-1)?.awaitingAnswer === false);
		expect(ok(await op(worker, { op: "ui-requests" }))).toEqual({ ok: true, uiRequests: [] });
	}, 90_000);

	test("quick replies are bounded, cached per latest answer, and suppressed while streaming or asking", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		const room = newRoom();
		const worker = fixture.spawn(room, [], {
			STUB_QUICK_REPLIES:
				JSON.stringify([
					"1. Continue",
					"- Please explain",
					`3. ${"x".repeat(81)}`,
					"4. Ignore",
					"5. Continue",
					"6. Approve and proceed",
					"7.   approve   AND proceed!",
					"8. What changed?",
					"9. Run the focused tests.",
					"10. Check the mobile layout.",
					"11. Summarize the result.",
					"12. What edge cases remain?",
					"13. Explain the next step.",
				]) ?? "[]",
		});
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("reply suggestions");
		await waitUntil("first reply answer", () => snapshotText(guest.getSnapshot()).includes("echo:reply suggestions"));
		await waitUntil("first reply turn idle", () => stateLines(worker).at(-1)?.state === "idle");
		const firstEntryId = await latestAgentEntryId(worker);
		const first = ok(await op(worker, { op: "quick-replies", entryId: firstEntryId }));
		if (!("replies" in first)) throw new Error("no quick replies");
		expect(first.replies).toEqual([
			"Continue",
			"Please explain",
			`${"x".repeat(79)}…`,
			"Ignore",
			"Approve and proceed",
			"What changed?",
			"Run the focused tests.",
			"Check the mobile layout.",
			"Summarize the result.",
			"What edge cases remain?",
		]);
		expect(first.replies).toHaveLength(10);
		expect(Array.from(first.replies[2]!).length).toBe(80);
		expect(ok(await op(worker, { op: "quick-replies", entryId: firstEntryId }))).toEqual(first);

		guest.sendPrompt("SLEEP:1");
		await waitUntil("second turn streaming", () => stateLines(worker).at(-1)?.state === "streaming");
		expect(ok(await op(worker, { op: "quick-replies", entryId: firstEntryId }))).toEqual({ ok: true, replies: [] });
		await waitUntil("second turn idle", () => stateLines(worker).at(-1)?.state === "idle", 30_000);
		const secondEntryId = await latestAgentEntryId(worker);
		expect(ok(await op(worker, { op: "quick-replies", entryId: firstEntryId }))).toEqual({ ok: true, replies: [] });
		expect(ok(await op(worker, { op: "quick-replies", entryId: secondEntryId }))).toEqual({ ok: true, replies: ["cache miss"] });

		guest.sendPrompt("ASK:answer before suggestions");
		const request = await waitUntil(
			"ask pending during quick-reply test",
			() => {
				const pending = guest.getSnapshot().uiRequest;
				return pending?.kind === "select" ? pending : undefined;
			},
			30_000,
		);
		expect(ok(await op(worker, { op: "quick-replies", entryId: secondEntryId }))).toEqual({ ok: true, replies: [] });
		guest.sendUiResponse(request.reqId, "alpha");
		await waitUntil("ask finished after answer", () => stateLines(worker).at(-1)?.state === "idle", 30_000);
	}, 120_000);

	test("keeps complete CJK suggestions when the output limit cuts off the final reply", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		const room = newRoom();
		const worker = fixture.spawn(room, [], {
			STUB_QUICK_REPLIES: '["已完成", "请检查核心路径", "请确认剩余事项',
			STUB_QUICK_REPLY_STOP_REASON: "length",
		});
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("truncated quick replies");
		await waitUntil("truncated-reply answer", () => snapshotText(guest.getSnapshot()).includes("echo:truncated quick replies"));
		await waitUntil("truncated-reply turn idle", () => stateLines(worker).at(-1)?.state === "idle");
		const entryId = await latestAgentEntryId(worker);
		expect(ok(await op(worker, { op: "quick-replies", entryId }))).toEqual({
			ok: true,
			replies: ["已完成", "请检查核心路径"],
		});
	}, 90_000);
});

describe("session-op: pause and queue", () => {
	test("pause does not abort an in-flight model turn and blocks queued work until resume", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();
		const guest = await liveGuest(fixture, room);

		guest.sendPrompt("WAIT:400:current-turn");
		await waitUntil("current turn streaming", () => stateLines(worker).at(-1)?.state === "streaming");
		expect(ok(await op(worker, { op: "pause", action: "pause" }))).toMatchObject({ ok: true, paused: true });
		const pausedState = await waitUntil("worker reports pause", () => stateLines(worker).findLast(line => line.paused));
		expect(typeof pausedState.pausedAt).toBe("number");
		expect(ok(await op(worker, { op: "queue", text: "after-pause" }))).toEqual({ ok: true, queued: 1 });

		await waitUntil(
			"current turn finishes while pause remains active",
			() => snapshotText(guest.getSnapshot()).includes("echo:current-turn") && stateLines(worker).at(-1)?.paused === true,
		);
		await sleep(150);
		expect(snapshotText(guest.getSnapshot())).not.toContain("echo:after-pause");
		const assistantMessages = sessionEntries(sessionFile!)
			.filter(entry => entry.type === "message" && typeof entry.message === "object" && entry.message !== null)
			.map(entry => entry.message as Record<string, unknown>)
			.filter(message => message.role === "assistant");
		expect(assistantMessages.some(message => message.stopReason === "aborted")).toBe(false);

		expect(ok(await op(worker, { op: "pause", action: "resume" }))).toMatchObject({ ok: true, paused: false });
		await waitUntil("queued turn starts after resume", () => snapshotText(guest.getSnapshot()).includes("echo:after-pause"));
		await waitUntil("queued turn completes", () => stateLines(worker).at(-1)?.state === "idle" && stateLines(worker).at(-1)?.paused === false);
		expect(snapshotText(guest.getSnapshot())).toContain("echo:current-turn");
		expect(snapshotText(guest.getSnapshot())).toContain("echo:after-pause");
	}, 90_000);

	test("queue follows an active turn, splits numbered prompts, and attaches images only to the first", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();
		const guest = await liveGuest(fixture, room);

		guest.sendPrompt("WAIT:400:active-turn");
		await waitUntil("active turn streaming", () => stateLines(worker).at(-1)?.state === "streaming");
		expect(ok(await op(worker, {
			op: "queue",
			text: "1. queued-one\n2. queued-two",
			images: [{ type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" }],
		}))).toEqual({ ok: true, queued: 2 });
		await waitUntil(
			"both queued answers complete",
			() => snapshotText(guest.getSnapshot()).includes("echo:queued-one") && snapshotText(guest.getSnapshot()).includes("echo:queued-two") && stateLines(worker).at(-1)?.state === "idle",
		);
		const text = snapshotText(guest.getSnapshot());
		expect(text.indexOf("echo:queued-one")).toBeLessThan(text.indexOf("echo:queued-two"));

		const userMessages = sessionEntries(sessionFile!)
			.filter(entry => entry.type === "message" && typeof entry.message === "object" && entry.message !== null)
			.map(entry => entry.message as Record<string, unknown>)
			.filter(message => message.role === "user");
		const imageMessages = userMessages.filter(message =>
			Array.isArray(message.content) &&
			message.content.some(block => typeof block === "object" && block !== null && !Array.isArray(block) && (block as Record<string, unknown>).type === "image"),
		);
		expect(imageMessages).toHaveLength(1);
		expect(imageMessages[0]?.content).toContainEqual({ type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" });
	}, 90_000);

	test("queue on an idle session starts the first message at once and runs the rest after it", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		expect(ok(await op(worker, { op: "queue", text: "1. idle-one\n2. idle-two" }))).toEqual({ ok: true, queued: 2 });
		await waitUntil(
			"both queued answers complete without another prompt",
			() => snapshotText(guest.getSnapshot()).includes("echo:idle-two") && stateLines(worker).at(-1)?.state === "idle",
		);
		const text = snapshotText(guest.getSnapshot());
		expect(text.indexOf("echo:idle-one")).toBeLessThan(text.indexOf("echo:idle-two"));
	}, 90_000);
	test("collaboration status reports the worker's connected guest participants", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		await liveGuest(fixture, room);

		const result = ok(await op(worker, { op: "collab-status" }));
		if (!("participants" in result)) throw new Error("worker did not return collaboration participants");
		expect(result.roomId).toBe(room.id);
		expect(result.participants.filter(participant => participant.role === "host")).toHaveLength(1);
		expect(result.participants.filter(participant => participant.role === "guest")).toHaveLength(1);
	}, 90_000);
});

describe("session-op: reads and context", () => {
	test("stats, tree and context describe the conversation that happened", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		const before = ok(await op(worker, { op: "stats" }));
		expect("stats" in before && before.stats.tokens.input + before.stats.tokens.output).toBe(0);

		guest.sendPrompt("first question");
		await waitUntil("first echo", () => snapshotText(guest.getSnapshot()).includes("echo:first question"));
		await waitUntil("idle", () => stateLines(worker).at(-1)?.state === "idle");
		guest.sendPrompt("second question");
		await waitUntil("second echo", () => snapshotText(guest.getSnapshot()).includes("echo:second question"));
		await waitUntil("idle again", () => stateLines(worker).at(-1)?.state === "idle");

		const statsResult = ok(await op(worker, { op: "stats" }));
		if (!("stats" in statsResult)) throw new Error("no stats");
		const { stats } = statsResult;
		// The stub reports 10 input and 5 output tokens per request.
		expect(stats.tokens.input).toBe(20);
		expect(stats.tokens.output).toBe(10);
		expect(stats.contextWindow).toBe(128000);
		expect(stats.byAgent.find(agent => agent.agentId === "Main")?.tokens).toBe(30);

		const treeResult = ok(await op(worker, { op: "tree" }));
		if (!("tree" in treeResult)) throw new Error("no tree");
		const { tree } = treeResult;
		const byId = new Map(tree.map(node => [node.entryId, node]));
		// Every parent link resolves inside the tree, exactly one node is the root, and the chain of
		// current-branch nodes ends at the last assistant message.
		expect(tree.filter(node => node.parentId === null)).toHaveLength(1);
		for (const node of tree) if (node.parentId !== null) expect(byId.has(node.parentId)).toBe(true);
		const users = tree.filter(node => node.role === "user");
		expect(users.map(node => node.preview).filter(text => text.includes("question"))).toHaveLength(2);
		const assistants = tree.filter(node => node.role === "assistant");
		expect(assistants.map(node => node.preview)).toEqual(expect.arrayContaining(["echo:first question", "echo:second question"]));
		expect([...users, ...assistants].every(node => node.onCurrentBranch)).toBe(true);

		const contextResult = ok(await op(worker, { op: "context" }));
		if (!("context" in contextResult)) throw new Error("no context");
		const { context } = contextResult;
		expect(context.window).toBe(128000);
		expect(context.total).toBeGreaterThan(0);
		expect(context.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(context.total);
		expect(context.parts.map(part => part.label)).toEqual(["System prompt", "System tools", "System context", "Skills", "Messages"]);
		expect(context.parts.find(part => part.label === "System prompt")?.tokens).toBeGreaterThan(0);
	}, 90_000);

	test("compact summarises the conversation into a compaction entry and refuses while a turn streams", async () => {
		// The default keeps 20k recent tokens verbatim, which would leave a three-turn conversation nothing to compact.
		fixture = new Fixture({ configYaml: "compaction:\n  keepRecentTokens: 1\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();
		const guest = await liveGuest(fixture, room);

		for (const text of ["alpha topic", "beta topic", "gamma topic"]) {
			guest.sendPrompt(text);
			await waitUntil(`echo of ${text}`, () => snapshotText(guest.getSnapshot()).includes(`echo:${text}`));
			await waitUntil("idle", () => stateLines(worker).at(-1)?.state === "idle");
		}
		expect(ok(await op(worker, { op: "compact", mode: "soft" }))).toEqual({ ok: true });
		expect(sessionEntries(sessionFile!).some(entry => entry.type === "compaction")).toBe(true);

		guest.sendPrompt("SLOW:busy");
		await waitUntil("streaming", () => stateLines(worker).at(-1)?.state === "streaming");
		const busy = failure(await op(worker, { op: "compact" }));
		expect(busy).toMatchObject({ code: "conflict" });
		expect(busy?.message).toContain("busy");
		await worker.request<WorkerLine>({ t: "abort", id: "stop-slow" });
	}, 120_000);

	test("handoff returns omp's handoff document, compacts the session with it, and works while the session is frozen", async () => {
		fixture = new Fixture({ configYaml: "compaction:\n  keepRecentTokens: 1\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();
		const guest = await liveGuest(fixture, room);
		for (const text of ["alpha topic", "beta topic"]) {
			guest.sendPrompt(text);
			await waitUntil(`echo of ${text}`, () => snapshotText(guest.getSnapshot()).includes(`echo:${text}`));
			await waitUntil("idle", () => stateLines(worker).at(-1)?.state === "idle");
		}
		// A project move freezes the source before it asks for the handoff; the freeze holds prompts, not this.
		await worker.request<WorkerLine>({ t: "freeze", id: "freeze-1", frozen: true });
		const result = ok(await op(worker, { op: "handoff", focus: "The work continues in /tmp/elsewhere." })) as { ok: true; document: string };
		expect(result.document.trim().length).toBeGreaterThan(0);
		const compaction = sessionEntries(sessionFile!).find(entry => entry.type === "compaction") as { summary?: string } | undefined;
		expect(compaction).toBeDefined();
		expect(compaction?.summary ?? "").toContain(result.document.trim().slice(0, 40));
	}, 120_000);

	test("dequeue removes a message waiting behind a running turn so it is never delivered", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);

		expect(failure(await op(worker, { op: "dequeue" }))).toMatchObject({ code: "not-found" });

		guest.sendPrompt("SLOW:hold the turn");
		await waitUntil("streaming", () => stateLines(worker).at(-1)?.state === "streaming");
		guest.sendPrompt("queued-one");
		guest.sendPrompt("queued-two");
		// Guest prompts reach the worker through the relay; both are queued behind the streaming turn shortly after.
		await sleep(800);

		// Remove the first one by index, the second one as "the last queued message".
		expect(ok(await op(worker, { op: "dequeue", index: 0 }))).toEqual({ ok: true });
		expect(ok(await op(worker, { op: "dequeue" }))).toEqual({ ok: true });
		expect(failure(await op(worker, { op: "dequeue" }))).toMatchObject({ code: "not-found" });

		const aborted = await worker.request<{ t: "aborted"; id: string; aborted: boolean }>({ t: "abort", id: "abort-slow" });
		expect(aborted.aborted).toBe(true);
		await waitUntil("idle", () => stateLines(worker).at(-1)?.state === "idle");
		const text = snapshotText(guest.getSnapshot());
		expect(text).not.toContain("echo:queued-one");
		expect(text).not.toContain("echo:queued-two");
	}, 90_000);
});
describe("session-op: rewind and input", () => {
	test("rewind points are newest-first and rewinding a user request moves the live branch back", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		const first = `first ${"x".repeat(130)}`;
		const second = "second question";

		guest.sendPrompt(first);
		await waitUntil("first response", () => snapshotText(guest.getSnapshot()).includes(`echo:${first}`));
		await waitUntil("first turn idle", () => stateLines(worker).at(-1)?.state === "idle");
		guest.sendPrompt(second);
		await waitUntil("second response", () => snapshotText(guest.getSnapshot()).includes(`echo:${second}`));
		await waitUntil("second turn idle", () => stateLines(worker).at(-1)?.state === "idle");

		const pointsResult = ok(await op(worker, { op: "rewind-points" }));
		if (!("points" in pointsResult)) throw new Error("no rewind points");
		// The answer the branch ends on (echo:second) is not a point: rewinding to it would change nothing.
		expect(pointsResult.points.map(point => [point.kind, point.preview])).toEqual([
			["user", second],
			["agent", `echo:${first}`.slice(0, 119) + "…"],
			["user", `${first.slice(0, 119)}…`],
		]);
		expect(pointsResult.points[0]?.at).toBeGreaterThan(0);

		const rewindResult = ok(await op(worker, { op: "rewind", entryId: pointsResult.points[0]!.entryId }));
		expect(rewindResult).toEqual({ ok: true, text: second });
		const treeResult = ok(await op(worker, { op: "tree" }));
		if (!("tree" in treeResult)) throw new Error("no session tree");
		const nodes = new Map(treeResult.tree.map(node => [node.entryId, node]));
		expect(nodes.get(pointsResult.points[0]!.entryId)?.onCurrentBranch).toBe(false);
		expect(nodes.get(pointsResult.points[1]!.entryId)?.onCurrentBranch).toBe(true);
		guest.sendPrompt("replacement question");
		await waitUntil("replacement response", () => snapshotText(guest.getSnapshot()).includes("echo:replacement question"));
		await waitUntil("replacement turn idle", () => stateLines(worker).at(-1)?.state === "idle");
		const branchedPoints = ok(await op(worker, { op: "rewind-points" }));
		if (!("points" in branchedPoints)) throw new Error("no branched rewind points");
		expect(branchedPoints.points.map(point => point.preview)).toEqual([
			"replacement question",
			`echo:${first}`.slice(0, 119) + "…",
			`${first.slice(0, 119)}…`,
		]);

		// Rewinding to an agent answer keeps it and drops what came after it.
		const answer = branchedPoints.points[1]!;
		expect(ok(await op(worker, { op: "rewind", entryId: answer.entryId }))).toEqual({ ok: true, text: "", keptThrough: answer.entryId });
		const afterAnswer = ok(await op(worker, { op: "tree" }));
		if (!("tree" in afterAnswer)) throw new Error("no session tree");
		const current = afterAnswer.tree.filter(node => node.onCurrentBranch && (node.role === "user" || node.role === "assistant"));
		expect(current.at(-1)?.entryId).toBe(answer.entryId);
		expect(current.some(node => node.entryId === branchedPoints.points[0]!.entryId)).toBe(false);
		const afterPoints = ok(await op(worker, { op: "rewind-points" }));
		if (!("points" in afterPoints)) throw new Error("no rewind points after the agent rewind");
		expect(afterPoints.points.map(point => point.kind)).toEqual(["user"]);
	}, 90_000);

	test("shell operations return output and status and preserve the context exclusion flag", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();

		const echoed = ok(await op(worker, { op: "shell", kind: "bash", code: "printf 'deck-shell-output'", excludeFromContext: false }));
		expect(echoed).toMatchObject({ ok: true, output: "deck-shell-output", exitCode: 0 });
		const failed = ok(await op(worker, { op: "shell", kind: "bash", code: "exit 7", excludeFromContext: false }));
		expect(failed).toMatchObject({ ok: true, exitCode: 7 });
		const excluded = ok(await op(worker, { op: "shell", kind: "bash", code: "printf 'deck-excluded-output'", excludeFromContext: true }));
		expect(excluded).toMatchObject({ ok: true, output: "deck-excluded-output", exitCode: 0 });

		const recorded = sessionEntries(sessionFile!).find(entry => {
			if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
			const message = entry.message as Record<string, unknown>;
			return message.role === "bashExecution" && message.output === "deck-excluded-output";
		});
		if (!recorded || typeof recorded.message !== "object" || recorded.message === null) {
			throw new Error("excluded shell execution was not recorded");
		}
		expect((recorded.message as Record<string, unknown>).excludeFromContext).toBe(true);
	}, 90_000);

	test("btw returns a side answer without adding it to the session transcript", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();
		const before = sessionEntries(sessionFile!).length;

		const result = ok(await op(worker, { op: "btw", question: "SIDE-QUESTION-ONLY" }));
		if (!("answer" in result)) throw new Error("no BTW answer");
		expect(result.answer).toContain("SIDE-QUESTION-ONLY");
		expect(sessionEntries(sessionFile!).length).toBe(before);

		// A follow-up continues the same topic (the same record id comes back); a stale topic id is refused.
		expect(result.recordId).toBeString();
		const followUp = ok(await op(worker, { op: "btw", question: "FOLLOW-UP", recordId: result.recordId }));
		if (!("answer" in followUp)) throw new Error("no BTW follow-up answer");
		expect(followUp.answer).toContain("FOLLOW-UP");
		expect(followUp.recordId).toBe(result.recordId);
		expect(sessionEntries(sessionFile!).length).toBe(before);
		expect(failure(await op(worker, { op: "btw", question: "lost", recordId: "no-such-topic" }))).toMatchObject({ code: "not-found" });
	}, 90_000);
	test("skills-installed reads the session workspace and isolated user registry without a network call", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		await worker.ready();

		expect(ok(await op(worker, { op: "skills-installed" }))).toEqual({ ok: true, installedSkills: [] });
	}, 90_000);
	test("Git operations reach GitModel in a real worker, including partial staging and a read-only revision", async () => {
		fixture = new Fixture();
		const source = vcs.git(import.meta.dir);
		if (!source) throw new Error("the session-host tests must run from a Git checkout");
		fs.rmSync(fixture.cwd, { recursive: true, force: true });
		await vcs.clone(source.info().repoRoot, fixture.cwd);
		const repository = vcs.requireGit(fixture.cwd);
		await repository.configSet("user.name", "Deck Worker Test");
		await repository.configSet("user.email", "deck-worker@example.invalid");
		await repository.configSet("commit.gpgsign", "false");
		await repository.configSet("core.hooksPath", path.join(fixture.root, "empty-hooks"));
		await repository.configSet("core.autocrlf", "false");

		const filePath = "deck-worker-git-fixture.txt";
		const original = `${Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		const edited = original.replace("line 2\n", "changed two\n").replace("line 28\n", "changed twenty-eight\n");
		await Bun.write(path.join(fixture.cwd, filePath), original);
		await repository.stageFiles([filePath]);
		await repository.commitCreate("worker fixture baseline", {});
		const baseline = await repository.headSha();
		if (!baseline) throw new Error("worker Git fixture baseline commit was not created");
		await Bun.write(path.join(fixture.cwd, filePath), edited);

		const worker = fixture.spawn(newRoom());
		await worker.ready();
		const workingResult = ok(await op(worker, { op: "git-view" }));
		if (!("git" in workingResult)) throw new Error("worker did not return Git status");
		expect(workingResult.git.unstaged.some(file => file.path === filePath)).toBe(true);

		const diffResult = ok(await op(worker, { op: "git-diff", path: filePath, area: "unstaged" }));
		if (!("gitDiff" in diffResult) || diffResult.gitDiff.kind !== "text") throw new Error("worker did not return a text diff");
		expect(diffResult.gitDiff.hunks).toHaveLength(2);
		const firstHunk = diffResult.gitDiff.hunks?.[0];
		if (!firstHunk) throw new Error("worker diff did not include its first hunk");

		const partialStage = ok(await op(worker, { op: "git-hunk", action: "stage", path: filePath, area: "unstaged", hunkIndex: 0, patchHash: firstHunk.patchHash }));
		if (!("git" in partialStage)) throw new Error("worker did not return status after staging a hunk");
		expect(partialStage.git.staged.some(file => file.path === filePath)).toBe(true);
		expect(partialStage.git.unstaged.some(file => file.path === filePath)).toBe(true);
		const stageRemaining = ok(await op(worker, { op: "git-stage", action: "stage", paths: [filePath] }));
		if (!("git" in stageRemaining)) throw new Error("worker did not return status after staging the file");
		expect(stageRemaining.git.unstaged).toHaveLength(0);

		const committed = ok(await op(worker, { op: "git-commit", message: "worker Git commit" }));
		if (!("git" in committed)) throw new Error("worker did not return status after committing");
		expect(committed.git.clean).toBe(true);
		expect(committed.git.headCommit?.subject).toBe("worker Git commit");

		const revision = ok(await op(worker, { op: "git-view", revision: baseline }));
		if (!("git" in revision)) throw new Error("worker did not return the revision view");
		expect(revision.git.readOnly).toBe(true);
		expect(revision.git.revision).toBe(baseline);
		const historicalDiff = ok(await op(worker, { op: "git-diff", path: filePath, area: "commit", revision: baseline }));
		if (!("gitDiff" in historicalDiff) || historicalDiff.gitDiff.kind !== "text") throw new Error("worker did not return the historical diff");
		expect(historicalDiff.gitDiff.hunks.flatMap(hunk => hunk.lines)).toContainEqual({ kind: "add", text: "line 1" });
	}, 90_000);
});

describe("session-op: terminal-only commands", () => {
	test("tan forks the parent transcript and persists a separate result session", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		const { sessionFile } = await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("tan-parent-history-marker");
		await waitUntil("parent history answer", () => snapshotText(guest.getSnapshot()).includes("echo:tan-parent-history-marker"));

		const result = ok(await op(worker, { op: "tan-start", work: "tan-isolated-work-marker" }));
		if (!("agentId" in result) || !("jobId" in result)) throw new Error("Tan returned no linked job and agent");
		const cloneFile = path.join(sessionFile!.slice(0, -6), `${result.agentId}.jsonl`);
		await waitUntil("forked Tan transcript", () => fs.existsSync(cloneFile), 60_000);
		await waitUntil("Tan transcript contains parent context and result", () => {
			try {
				const transcript = JSON.stringify(sessionEntries(cloneFile));
				return transcript.includes("tan-parent-history-marker") && transcript.includes("echo:tan-isolated-work-marker");
			} catch {
				return false;
			}
		}, 60_000);

		expect(result.agentId).toMatch(/^Tan-/);
		expect(result.jobId).toBeString();
	}, 120_000);

	test("tan registers the fork in the Agents snapshot and guests can stop it", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		const result = ok(await op(worker, { op: "tan-start", work: "WAIT:30000:tan-stop-marker" }));
		if (!("agentId" in result) || !("jobId" in result)) throw new Error("Tan returned no linked job and agent");

		const running = await waitUntil(
			"running Tan agent in the guest Agents snapshot",
			() => guest.getSnapshot().agents.find(agent => agent.id === result.agentId && agent.status === "running"),
			60_000,
		);
		expect(running).toMatchObject({ id: result.agentId, kind: "sub", status: "running", hasSessionFile: true });
		guest.sendAgentCmd("kill", result.agentId);
		const stopped = await waitUntil(
			"stopped Tan agent in the guest Agents snapshot",
			() => guest.getSnapshot().agents.find(agent => agent.id === result.agentId && agent.status === "aborted"),
			30_000,
		);
		expect(stopped).toMatchObject({ id: result.agentId, status: "aborted" });
	}, 90_000);

	test("omfg keeps generated rules unsaved until an edited, history-matched rule is accepted", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room, [], {
			STUB_OMFG_RULE:
				'{"name":"history-match","description":"Match the earlier echo","condition":"echo:omfg-history-marker","scope":"text","body":"Keep the earlier answer grounded."}',
		});
		const { sessionFile } = await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("omfg-history-marker");
		await waitUntil("OMFG history answer", () => snapshotText(guest.getSnapshot()).includes("echo:omfg-history-marker"));
		await waitUntil(
			"persisted OMFG history answer",
			() => JSON.stringify(sessionEntries(sessionFile!)).includes("echo:omfg-history-marker"),
		);
		const historyEntryCount = sessionEntries(sessionFile!).length;
		const generated = ok(
			await op(worker, { op: "omfg-generate", requestId: "omfg-accept", complaint: "Repeat the grounded answer" }),
		);
		if (!("candidate" in generated)) throw new Error("OMFG did not return a rule candidate");
		expect(generated.candidate.validated).toBe(true);
		expect(sessionEntries(sessionFile!).length).toBe(historyEntryCount);
		const rulePath = path.join(fixture.cwd, ".omp", "rules", "history-match.md");
		expect(fs.existsSync(rulePath)).toBe(false);

		const edited = generated.candidate.fileContent.replace(
			"Keep the earlier answer grounded.",
			"Keep the earlier response grounded in context.",
		);
		const saved = ok(
			await op(worker, {
				op: "omfg-save",
				requestId: "omfg-accept",
				fileContent: edited,
				scope: "project",
				overwrite: false,
				acceptUnvalidated: false,
			}),
		);
		if (!("save" in saved)) throw new Error("OMFG did not return a save result");
		expect(saved.save).toMatchObject({ kind: "saved", path: rulePath });
		expect(fs.readFileSync(rulePath, "utf8")).toBe(edited);
	}, 90_000);

	test("omfg cancellation aborts an in-flight generation without producing a candidate", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom(), [], { STUB_OMFG_DELAY_MS: "30000" });
		await worker.ready();
		const generation = op(worker, { op: "omfg-generate", requestId: "omfg-cancel", complaint: "Stop this generation" });
		await sleep(100);
		expect(ok(await op(worker, { op: "omfg-cancel", requestId: "omfg-cancel" }))).toEqual({ ok: true });
		expect(failure(await generation)).toMatchObject({ code: "conflict" });
	}, 30_000);

	test("cleanse runs a requested checker in the worker and exposes final diagnostics", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
		fs.writeFileSync(path.join(fixture.cwd, "src", "a.ts"), "export const value = 1;\n");
		const worker = fixture.spawn(newRoom());
		await worker.ready();
		const runId = "cleanse-fixture-run";
		expect(
			ok(
				await op(worker, {
					op: "cleanse-start",
					runId,
					scope: { kind: "request", request: "Run the fixture diagnostics command" },
					includeTests: false,
					maxAgents: 1,
				}),
			),
		).toEqual({ ok: true, runId });
		let snapshot: CleanseRunSnapshot | null = null;
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const state = ok(await op(worker, { op: "cleanse-state" }));
			if ("state" in state) {
				snapshot = state.state;
				if (snapshot && snapshot.status !== "running") break;
			}
			await sleep(50);
		}
		if (snapshot?.status === "failed") throw new Error(`Cleanse worker failed: ${snapshot.error ?? "unknown error"}`);
		expect(snapshot?.status).toBe("unresolved");
		expect(snapshot?.result?.diagnostics).toEqual([
			expect.objectContaining({ file: "src/a.ts", message: "fixture diagnostic" }),
		]);
		expect(snapshot?.checkers).toEqual([expect.objectContaining({ status: "completed" })]);
		expect(snapshot?.agents).toEqual([expect.objectContaining({ status: "completed" })]);
	}, 120_000);

	test("cleanse cancellation publishes a terminal cancelled state", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		const worker = fixture.spawn(newRoom(), [], { STUB_CLEANSE_DELAY_MS: "30000" });
		await worker.ready();
		const runId = "cleanse-cancel-run";
		expect(
			ok(
				await op(worker, {
					op: "cleanse-start",
					runId,
					scope: { kind: "request", request: "Wait for checker discovery" },
					includeTests: false,
					maxAgents: 1,
				}),
			),
		).toEqual({ ok: true, runId });
		expect(ok(await op(worker, { op: "cleanse-cancel", runId }))).toEqual({ ok: true });
		let snapshot: CleanseRunSnapshot | null = null;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const state = ok(await op(worker, { op: "cleanse-state" }));
			if ("state" in state) {
				snapshot = state.state;
				if (snapshot && snapshot.status !== "running") break;
			}
			await sleep(50);
		}
		expect(snapshot?.status).toBe("cancelled");
	}, 60_000);
	test("cleanse cancellation kills a running checker process", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		const worker = fixture.spawn(newRoom(), [], { STUB_CLEANSE_CHECKER_SLEEP: "true" });
		await worker.ready();
		const runId = "cleanse-checker-cancel-run";
		expect(
			ok(
				await op(worker, {
					op: "cleanse-start",
					runId,
					scope: { kind: "request", request: "Run the fixture diagnostics command" },
					includeTests: false,
					maxAgents: 1,
				}),
			),
		).toEqual({ ok: true, runId });

		const checkerPid = await waitUntil("long-running cleanse checker process", () => pidsMatching("/bin/sleep 30")[0], 60_000);
		const active = ok(await op(worker, { op: "cleanse-state" }));
		expect("state" in active && active.state?.checkers).toEqual([expect.objectContaining({ status: "running" })]);
		expect(ok(await op(worker, { op: "cleanse-cancel", runId }))).toEqual({ ok: true });

		let snapshot: CleanseRunSnapshot | null = null;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const state = ok(await op(worker, { op: "cleanse-state" }));
			if ("state" in state) {
				snapshot = state.state;
				if (snapshot && snapshot.status !== "running") break;
			}
			await sleep(50);
		}
		expect(snapshot?.status).toBe("cancelled");
		await waitUntil("cancelled checker process exit", () => !pidsMatching("/bin/sleep 30").includes(checkerPid), 30_000);
	}, 90_000);

	test("cleanse cancellation aborts a running repair agent", async () => {
		fixture = new Fixture({ configYaml: "modelRoles:\n  smol: stub/stub-model\n" });
		fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
		fs.writeFileSync(path.join(fixture.cwd, "src", "a.ts"), "export const value = 1;\n");
		const worker = fixture.spawn(newRoom(), [], { STUB_CLEANSE_REPAIR_DELAY_MS: "30000" });
		await worker.ready();
		const runId = "cleanse-repair-cancel-run";
		expect(
			ok(
				await op(worker, {
					op: "cleanse-start",
					runId,
					scope: { kind: "request", request: "Run the fixture diagnostics command" },
					includeTests: false,
					maxAgents: 1,
				}),
			),
		).toEqual({ ok: true, runId });

		let snapshot: CleanseRunSnapshot | null = null;
		const runningDeadline = Date.now() + 60_000;
		while (Date.now() < runningDeadline) {
			const state = ok(await op(worker, { op: "cleanse-state" }));
			if ("state" in state) {
				snapshot = state.state;
				if (snapshot?.agents.some(agent => agent.status === "running")) break;
			}
			await sleep(50);
		}
		expect(snapshot?.agents).toEqual([expect.objectContaining({ status: "running" })]);
		expect(ok(await op(worker, { op: "cleanse-cancel", runId }))).toEqual({ ok: true });

		const cancelledDeadline = Date.now() + 30_000;
		while (Date.now() < cancelledDeadline) {
			const state = ok(await op(worker, { op: "cleanse-state" }));
			if ("state" in state) {
				snapshot = state.state;
				if (snapshot && snapshot.status !== "running") break;
			}
			await sleep(50);
		}
		expect(snapshot?.status).toBe("cancelled");
		expect(snapshot?.agents).toEqual([expect.objectContaining({ status: "aborted" })]);
	}, 120_000);
});
