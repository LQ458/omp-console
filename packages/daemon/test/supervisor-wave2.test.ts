/**
 * Supervisor side of the wave-2 worker contract against the fake worker: request/reply plumbing for session ops,
 * usage, key points, titles and plugins, the status lines the daemon consumes (ext-ui, usage samples, titles) and the
 * quota policy it pushes. The worker itself is covered in packages/session-host.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ExtensionUiState, SessionOpV3 } from "@omp-console/protocol";
import { Supervisor, SupervisorError, type SupervisorOptions, type UsageSampleEvent } from "../src/supervisor";
import { fakeCmd, makeTmp, readJsonLines } from "./helpers";
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

const rejection = async (promise: Promise<unknown>): Promise<SupervisorError> => {
	try {
		await promise;
	} catch (error) {
		if (error instanceof SupervisorError) return error;
		throw error;
	}
	throw new Error("expected the request to be refused");
};

describe("wave-2 requests", () => {
	it("session ops, usage, key points, refine-title and plugins reach the worker and return its answers", async () => {
		const dir = makeTmp();
		const supervisor = make(["--card-title", "Parser port", "--card-decisions", "Use Rust|Keep the AST"]);
		const { id } = await supervisor.create({ cwd: dir });

		expect(await supervisor.sessionOp(id, { op: "plan-mode", enabled: true })).toEqual({ ok: true });
		const stats = await supervisor.sessionOp(id, { op: "stats" });
		expect(stats).toMatchObject({ ok: true, stats: { cost: 0.25, contextWindow: 128000 } });
		const tree = await supervisor.sessionOp(id, { op: "tree" });
		expect(tree).toMatchObject({ ok: true, tree: [{ entryId: "e1", parentId: null, onCurrentBranch: true }] });
		expect(await supervisor.usage(id)).toEqual([{ provider: "fake", limits: [] }]);

		const card = await supervisor.summarize(id);
		expect(card).toMatchObject({ sessionId: id, title: "Parser port", decisions: ["Use Rust", "Keep the AST"], files: ["src/fake.ts"] });

		const plugins = await supervisor.plugins(id);
		expect(plugins.map(plugin => `${plugin.id}:${plugin.enabled}`)).toEqual(["skill:fake-skill:true", "mcp:fake-server:false"]);
		await supervisor.togglePlugin(id, "mcp:fake-server", true);
	});

	it("a worker refusal keeps its code and message; an unknown session is not-found", async () => {
		const supervisor = make(["--keypoints-fail"]);
		const { id } = await supervisor.create({ cwd: makeTmp() });

		const goal = await rejection(supervisor.sessionOp(id, { op: "goal", action: "set", objective: "refuse" }));
		expect(goal).toMatchObject({ code: "bad-request" });
		expect(goal.message).toContain("Goal mode is disabled");
		expect(await rejection(supervisor.summarize(id))).toMatchObject({ code: "conflict" });
		expect(await rejection(supervisor.togglePlugin(id, "missing", false))).toMatchObject({ code: "not-found" });
		expect(await rejection(supervisor.sessionOp("nope", { op: "stats" }))).toMatchObject({ code: "not-found" });
		expect(await rejection(supervisor.plugins("nope"))).toMatchObject({ code: "not-found" });
	});

	it("a worker that does not answer fails the request on its own timeout; compaction gets the longer one", async () => {
		const dir = makeTmp();
		const supervisor = make(["--ignore-requests"], { sessionOpTimeoutMs: 80, usageTimeoutMs: 80, summarizeTimeoutMs: 80, pluginsTimeoutMs: 80, compactTimeoutMs: 80, commandTimeoutMs: 80 });
		const { id } = await supervisor.create({ cwd: dir });
		const requests = [
			() => supervisor.sessionOp(id, { op: "stats" }),
			() => supervisor.usage(id),
			() => supervisor.summarize(id),
			() => supervisor.plugins(id),
			() => supervisor.refineTitle(id),
		];
		for (const request of requests) expect(await rejection(request())).toMatchObject({ code: "internal" });

		// The fake answers compaction after 100 ms. Compaction is bounded by its own timeout, not the generic one.
		const patient = make(["--compact-delay-ms", "100"], { sessionOpTimeoutMs: 40, compactTimeoutMs: 600 });
		const { id: patientId } = await patient.create({ cwd: dir });
		expect(await patient.sessionOp(patientId, { op: "compact", mode: "soft" })).toEqual({ ok: true });
		const impatient = make(["--compact-delay-ms", "100"], { sessionOpTimeoutMs: 600, compactTimeoutMs: 40 });
		const { id: impatientId } = await impatient.create({ cwd: dir });
		expect(await rejection(impatient.sessionOp(impatientId, { op: "compact" }))).toMatchObject({ code: "internal" });
	});
	it("gives skill mutations their longer timeout and cancels an abandoned worker operation", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "skill-requests.jsonl");
		const supervisor = make(["--ignore-requests", "--dump-requests", dump], { sessionOpTimeoutMs: 600, skillsTimeoutMs: 80 });
		const { id } = await supervisor.create({ cwd: dir });
		const timeout = rejection(supervisor.sessionOp(id, {
			op: "skills-install",
			specs: ["@omp-console/review"],
			global: false,
			approvalId: "approval-1",
		}));
		const result = await Promise.race([
			timeout.then(error => ({ kind: "rejected" as const, error })),
			Bun.sleep(350).then(() => ({ kind: "slow" as const })),
		]);
		if (result.kind !== "rejected") throw new Error("skill mutation did not use its dedicated timeout");
		expect(result.error).toMatchObject({ code: "internal" });
		await until(() => readJsonLines(dump).some(line => line.t === "cancel-session-op"), "cancel-session-op after skill timeout");
		const requests = readJsonLines(dump);
		const sessionOp = requests.find(line => line.t === "session-op");
		const cancellation = requests.find(line => line.t === "cancel-session-op");
		if (!sessionOp || !cancellation) throw new Error("the timed-out operation should have a matching cancellation command");
		expect(cancellation.id).toBe(sessionOp.id);
	});
	it("cancels abandoned debug, diagnostics, and live-start operations in their worker", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "mode-ops.jsonl");
		const supervisor = make(["--ignore-requests", "--dump-requests", dump], { sessionOpTimeoutMs: 5_000 });
		const { id } = await supervisor.create({ cwd: dir });
		const ops: SessionOpV3[] = [
			{ op: "debug", action: "adapters" },
			{ op: "debug-diagnostics", action: "remote-debugger" },
			{ op: "live-mode", action: "start", offer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" },
		];

		for (const op of ops) {
			const previousIds = new Set(readJsonLines(dump)
				.filter(line => line.t === "session-op")
				.map(line => line.id));
			const abort = new AbortController();
			const pending = rejection(supervisor.sessionOp(id, op, abort.signal));
			await until(
				() => readJsonLines(dump).some(line => line.t === "session-op" && typeof line.id === "string" && !previousIds.has(line.id)),
				`${op.op} reached the fake worker`,
			);
			const request = readJsonLines(dump).find(
				line => line.t === "session-op" && typeof line.id === "string" && !previousIds.has(line.id),
			);
			if (!request || typeof request.id !== "string") throw new Error(`${op.op} request was not recorded`);
			abort.abort();
			expect(await pending).toMatchObject({ code: "conflict" });
			await until(
				() => readJsonLines(dump).some(line => line.t === "cancel-session-op" && line.id === request.id),
				`${op.op} worker request cancellation`,
				1_000,
			);
		}
	});

});

describe("wave-2 status lines", () => {
	const state = (text: string): ExtensionUiState => ({
		statuses: [{ key: "k", text }],
		widgets: [],
		panels: [{ key: "build", descriptor: { kind: "progress", title: "Build", value: 1, max: 2 } }],
		notifications: [],
	});

	it("ext-ui keeps the newest whole state per session, is empty before the first one, and resets when the worker restarts", async () => {
		const dir = makeTmp();
		const seen: Array<[string, ExtensionUiState]> = [];
		const script = JSON.stringify([
			{ at: 80, emit: { t: "ext-ui", state: state("one") } },
			{ at: 140, emit: { t: "ext-ui", state: state("two") } },
			// A line with the wrong shape is ignored, never stored.
			{ at: 200, emit: { t: "ext-ui", state: "garbage" } },
		]);
		const supervisor = make(["--script", script], { onExtUi: (id, extUi) => seen.push([id, extUi]) });
		const { id } = await supervisor.create({ cwd: dir });
		expect(supervisor.extensionUi(id)).toEqual({ statuses: [], widgets: [], panels: [], notifications: [] });
		await until(() => seen.length === 2, "two ext-ui lines");
		await Bun.sleep(150);
		expect(seen.map(([sessionId]) => sessionId)).toEqual([id, id]);
		expect(supervisor.extensionUi(id).statuses).toEqual([{ key: "k", text: "two" }]);
		expect(supervisor.extensionUi(id).panels[0]?.descriptor).toMatchObject({ kind: "progress" });
		expect(() => supervisor.extensionUi("nope")).toThrow(SupervisorError);
	});

	it("usage samples and titles are forwarded; a title also lands on the session summary", async () => {
		const dir = makeTmp();
		const samples: Array<[string, UsageSampleEvent]> = [];
		const titles: Array<[string, string]> = [];
		const script = JSON.stringify([
			{ at: 80, emit: { t: "usage-sample", agentId: "Main", provider: "anthropic", model: "claude-opus", tokens: 1200, cacheReadTokens: 30000, at: 1 } },
			{ at: 120, emit: { t: "usage-sample", agentId: "Main", provider: "anthropic", tokens: "many" } },
			{ at: 160, emit: { t: "title", title: "Fix the relay backoff" } },
			{ at: 200, emit: { t: "title", title: 42 } },
		]);
		const supervisor = make(["--script", script], {
			onUsageSample: (id, sample) => samples.push([id, sample]),
			onTitle: (id, title) => titles.push([id, title]),
		});
		const { id } = await supervisor.create({ cwd: dir });
		await until(() => titles.length === 1, "title line");
		await Bun.sleep(150);
		expect(samples).toEqual([[id, { t: "usage-sample", agentId: "Main", provider: "anthropic", model: "claude-opus", tokens: 1200, cacheReadTokens: 30000, at: 1 }]]);
		expect(titles).toEqual([[id, "Fix the relay backoff"]]);
		expect(supervisor.get(id)?.title).toBe("Fix the relay backoff");
	});

	it("refine-title is admitted and its title line arrives afterwards", async () => {
		const titles: string[] = [];
		const supervisor = make([], { onTitle: (_id, title) => titles.push(title) });
		const { id } = await supervisor.create({ cwd: makeTmp() });
		await supervisor.refineTitle(id);
		await until(() => titles.length === 1, "refined title");
		expect(titles[0]).toBe(`Refined ${id}`);
		expect(supervisor.get(id)?.title).toBe(`Refined ${id}`);
	});
});

describe("quota policy", () => {
	const policy = [{ provider: "anthropic", admitSpawns: false, holdPrompts: true, reason: "5h window at 96%" }];

	it("reaches every running worker, and a worker that starts later gets the current policy when it is ready", async () => {
		const dir = makeTmp();
		const dumpA = path.join(dir, "a.jsonl");
		const dumpB = path.join(dir, "b.jsonl");
		const first = make(["--dump-requests", dumpA]);
		const { id } = await first.create({ cwd: dir });
		first.pushQuotaPolicy(policy);
		await until(() => readJsonLines(dumpA).some(line => line.t === "quota-policy"), "policy delivered to the running worker");
		const sent = readJsonLines(dumpA).find(line => line.t === "quota-policy")!;
		expect(sent).toEqual({ t: "quota-policy", providers: policy });
		// A newer push replaces rather than merges: what the worker last received is the whole policy.
		first.pushQuotaPolicy([]);
		await until(() => readJsonLines(dumpA).filter(line => line.t === "quota-policy").length === 2, "second push");
		expect(readJsonLines(dumpA).filter(line => line.t === "quota-policy").at(-1)).toEqual({ t: "quota-policy", providers: [] });
		expect(first.get(id)?.state).toBe("idle");

		const late = make(["--dump-requests", dumpB]);
		late.pushQuotaPolicy(policy);
		await late.create({ cwd: dir });
		await until(() => readJsonLines(dumpB).some(line => line.t === "quota-policy"), "policy delivered at ready");
		expect(readJsonLines(dumpB).find(line => line.t === "quota-policy")).toEqual({ t: "quota-policy", providers: policy });
	});

	it("is not sent to a worker that is stopping, and an empty supervisor accepts a push", async () => {
		const supervisor = make([]);
		expect(() => supervisor.pushQuotaPolicy(policy)).not.toThrow();
		const dir = makeTmp();
		const dump = path.join(dir, "d.jsonl");
		const stopped = make(["--dump-requests", dump]);
		const { id } = await stopped.create({ cwd: dir });
		await stopped.stop(id);
		stopped.pushQuotaPolicy(policy);
		await Bun.sleep(100);
		expect(readJsonLines(dump).some(line => line.t === "quota-policy")).toBe(false);
	});
});

describe("before-stop hook", () => {
	it("runs while the worker is still up, before the stop command, and never holds the stop past its timeout", async () => {
		const dir = makeTmp();
		const dump = path.join(dir, "d.jsonl");
		const order: string[] = [];
		const supervisor = make(["--dump-requests", dump], {
			beforeStop: async id => {
				order.push(`hook:${supervisor.get(id)?.state}`);
				// The worker has not been told to stop yet: it still answers.
				order.push(`ping-lines:${readJsonLines(dump).filter(line => line.t === "stop").length}`);
				await supervisor.summarize(id);
				order.push("summarized");
			},
		});
		const { id } = await supervisor.create({ cwd: dir });
		expect(await supervisor.stop(id)).toBe(true);
		expect(order).toEqual(["hook:idle", "ping-lines:0", "summarized"]);
		expect(readJsonLines(dump).some(line => line.t === "stop")).toBe(true);
		expect(await supervisor.stop(id)).toBe(false);

		const hanging = make([], { beforeStop: () => new Promise(() => {}), beforeStopTimeoutMs: 100 });
		const { id: hangingId } = await hanging.create({ cwd: dir });
		const started = Date.now();
		expect(await hanging.stop(hangingId)).toBe(true);
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("a hook that throws does not prevent the stop", async () => {
		const logs: string[] = [];
		const supervisor = make([], { beforeStop: async () => Promise.reject(new Error("card failed")), log: message => logs.push(message) });
		const { id } = await supervisor.create({ cwd: makeTmp() });
		expect(await supervisor.stop(id)).toBe(true);
		expect(logs.some(line => line.includes("card failed"))).toBe(true);
	});
});
