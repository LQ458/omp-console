import { afterEach, describe, expect, it } from "bun:test";
import type { OvernightLastTurn, OvernightPolicy, OvernightSummary, WorkerOvernightOptions, WorkerStatus } from "@omp-console/protocol";
import type { SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OvernightController } from "../src/overnight/controller";
import { OvernightStore } from "../src/overnight/store";

const SESSION_ID = "overnight-test";
const roots: string[] = [];
const controllers: OvernightController[] = [];

afterEach(async () => {
	await Promise.all(controllers.splice(0).map(controller => controller.close()));
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeSupervisor {
	readonly summaries = new Map<string, SessionSummary>();
	readonly prompts: string[] = [];
	readonly restarts: Array<{ sessionId: string; options?: WorkerOvernightOptions }> = [];
	readonly notifications: string[] = [];
	readonly appliedOptions: Array<WorkerOvernightOptions | null> = [];
	aborts = 0;
	/** "idle": abort ends the turn; "stuck": accepted but the stream keeps going; "reject": abort throws. */
	abortBehavior: "idle" | "stuck" | "reject" = "idle";
	restartFailures = 0;
	clock = 1_800_000_000_000;

	constructor() {
		this.summaries.set(SESSION_ID, {
			id: SESSION_ID,
			cwd: "/work/project",
			state: "idle",
			createdAt: this.clock,
			lastActivityAt: this.clock,
			agentCount: 0,
			goalActive: false,
			awaitingAnswer: false,
		});
	}

	get(id: string): SessionSummary | undefined {
		return this.summaries.get(id);
	}

	list(): SessionSummary[] {
		return [...this.summaries.values()];
	}

	async sendPrompt(id: string, text: string): Promise<void> {
		this.prompts.push(text);
		const summary = this.summaries.get(id)!;
		summary.state = "streaming";
		summary.lastActivityAt = this.clock;
	}

	async abort(id: string): Promise<boolean> {
		this.aborts++;
		if (this.abortBehavior === "reject") throw new Error("abort timed out");
		const summary = this.summaries.get(id);
		if (summary && this.abortBehavior === "idle") summary.state = "idle";
		return true;
	}

	async restart(id: string, _restartAnyway?: boolean, options?: WorkerOvernightOptions): Promise<SessionSummary> {
		this.restarts.push({ sessionId: id, ...(options === undefined ? {} : { options: { ...options } }) });
		if (this.restartFailures > 0) {
			this.restartFailures--;
			throw new Error("worker startup failed");
		}
		const summary = this.summaries.get(id)!;
		summary.state = "idle";
		summary.awaitingAnswer = false;
		summary.paused = false;
		return summary;
	}

	async wake(id: string): Promise<SessionSummary> {
		const summary = this.summaries.get(id)!;
		summary.state = "idle";
		return summary;
	}

	setOvernightSummary(id: string, overnight: OvernightSummary | undefined): void {
		const summary = this.summaries.get(id);
		if (summary) summary.overnight = overnight;
	}

	async setOvernightOptions(_id: string, options: WorkerOvernightOptions | null): Promise<void> {
		this.appliedOptions.push(options);
	}
}

function setup(options: { now?: number; policy?: Partial<OvernightPolicy>; platform?: string; spawnCaffeinate?: (args: readonly string[]) => { kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> } } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-overnight-controller-"));
	roots.push(root);
	const supervisor = new FakeSupervisor();
	let now = options.now ?? supervisor.clock;
	supervisor.clock = now;
	const store = new OvernightStore(root);
	const policy: OvernightPolicy = {
		deadline: new Date(now + 3_600_000).toISOString(),
		askTimeoutSec: 60,
		quiet: "normal",
		maxIdleContinuations: 3,
		keepAwake: false,
		...options.policy,
	};
	const controller = new OvernightController({
		supervisor,
		store,
		now: () => now,
		...(options.platform === undefined ? {} : { platform: options.platform }),
		...(options.spawnCaffeinate === undefined ? {} : { spawnCaffeinate: options.spawnCaffeinate }),
		notify: (_id, phase) => {
			supervisor.notifications.push(phase);
		},
	});
	controllers.push(controller);
	return {
		controller,
		supervisor,
		store,
		policy,
		setNow(value: number) {
			now = value;
			supervisor.clock = value;
		},
	};
}

function turn(textTail = "unfinished", overrides: Partial<OvernightLastTurn> = {}): OvernightLastTurn {
	return { endedAt: Date.now(), stopReason: "stop", toolCalls: 0, textTail, ...overrides };
}

function stateLine(now: number, overrides: Partial<Extract<WorkerStatus, { t: "state" }>> = {}): Extract<WorkerStatus, { t: "state" }> {
	return {
		t: "state",
		state: "idle",
		paused: false,
		awaitingAnswer: false,
		goalActive: false,
		agentCount: 0,
		lastEventAt: now,
		...overrides,
	};
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
		await Bun.sleep(1);
	}
}

async function sendTurn(controller: OvernightController, supervisor: FakeSupervisor, lastTurn: OvernightLastTurn): Promise<void> {
	const summary = supervisor.get(SESSION_ID)!;
	const eventCount = controller.get(SESSION_ID)?.events.length ?? 0;
	const previousPhase = controller.get(SESSION_ID)?.phase;
	summary.state = "idle";
	summary.awaitingAnswer = false;
	controller.onWorkerStatus(SESSION_ID, { t: "turn-end", lastTurn });
	await waitFor(() => {
		const current = controller.get(SESSION_ID);
		return current !== undefined && (current.events.length > eventCount || current.phase !== previousPhase);
	}, "turn-end transition");
}

async function runDueAction(setNow: (value: number) => void, controller: OvernightController, supervisor: FakeSupervisor): Promise<void> {
	const state = controller.get(SESSION_ID)!;
	const promptCount = supervisor.prompts.length;
	setNow(state.nextActionAt ?? Date.now());
	supervisor.get(SESSION_ID)!.state = "idle";
	controller.onWorkerStatus(SESSION_ID, stateLine(Date.now()));
	await waitFor(() => supervisor.prompts.length > promptCount && supervisor.get(SESSION_ID)?.state === "streaming", "scheduled prompt");
}

describe("overnight controller", () => {
	it("completes on the marker, persists the morning report and notifies the owner", async () => {
		const { controller, supervisor, store, policy } = setup();
		await controller.start(SESSION_ID, policy);
		await sendTurn(controller, supervisor, turn("Done and verified. OVERNIGHT-COMPLETE"));

		const state = controller.get(SESSION_ID)!;
		expect(state.phase).toBe("complete");
		expect(state.report).toContain("## Final response");
		expect(state.report).toContain("Done and verified. OVERNIGHT-COMPLETE");
		await waitFor(() => supervisor.notifications.length === 1, "terminal notification");
		expect(supervisor.notifications).toEqual(["complete"]);
		expect((await store.loadStates())[0]?.report).toBe(state.report);
		expect(supervisor.appliedOptions).toEqual([null]);
	});

	it("continues after a premature stop and blocks only after the configured consecutive idle-continuation cap", async () => {
		const { controller, supervisor, policy, setNow } = setup({ policy: { maxIdleContinuations: 2 } });
		await controller.start(SESSION_ID, policy);

		await sendTurn(controller, supervisor, turn("still working"));
		await runDueAction(setNow, controller, supervisor);
		expect(controller.get(SESSION_ID)?.continuations).toBe(1);

		await sendTurn(controller, supervisor, turn("zero tools"));
		expect(controller.get(SESSION_ID)?.idleContinuations).toBe(1);
		await runDueAction(setNow, controller, supervisor);
		await sendTurn(controller, supervisor, turn("made progress", { toolCalls: 1 }));
		expect(controller.get(SESSION_ID)?.idleContinuations).toBe(0);
		await runDueAction(setNow, controller, supervisor);
		await sendTurn(controller, supervisor, turn("first idle stop"));
		expect(controller.get(SESSION_ID)?.idleContinuations).toBe(1);
		await runDueAction(setNow, controller, supervisor);
		await sendTurn(controller, supervisor, turn("second idle stop"));

		expect(controller.get(SESSION_ID)?.phase).toBe("blocked");
		expect(controller.get(SESSION_ID)?.idleContinuations).toBe(2);
		await waitFor(() => supervisor.notifications.length > 0, "blocked notification");
		expect(supervisor.notifications).toEqual(["blocked"]);
	});

	it("applies retry backoff in sequence, waits for usage reset, and clamps the wait to the deadline", async () => {
		const first = setup({ policy: { deadline: new Date(1_800_000_000_000 + 4 * 60 * 60_000).toISOString() } });
		await first.controller.start(SESSION_ID, first.policy);
		await sendTurn(first.controller, first.supervisor, turn("", { stopReason: "error", errorMessage: "503 temporary network failure" }));
		const retry1 = first.controller.get(SESSION_ID)!;
		expect(retry1.phase).toBe("waiting-retry");
		expect(retry1.nextActionAt).toBe(first.supervisor.clock + 60_000);
		await runDueAction(first.setNow, first.controller, first.supervisor);
		await sendTurn(first.controller, first.supervisor, turn("", { stopReason: "error", errorMessage: "503 temporary network failure" }));
		expect(first.controller.get(SESSION_ID)?.nextActionAt).toBe(first.supervisor.clock + 120_000);
		for (const delay of [5, 10, 15, 30, 30]) {
			await runDueAction(first.setNow, first.controller, first.supervisor);
			await sendTurn(first.controller, first.supervisor, turn("", { stopReason: "error", errorMessage: "503 temporary network failure" }));
			expect(first.controller.get(SESSION_ID)?.nextActionAt).toBe(first.supervisor.clock + delay * 60_000);
		}
		const reset = setup();
		await reset.controller.start(SESSION_ID, reset.policy);
		await sendTurn(reset.controller, reset.supervisor, turn("", { stopReason: "error", errorMessage: "503 temporary network failure" }));
		await runDueAction(reset.setNow, reset.controller, reset.supervisor);
		await sendTurn(reset.controller, reset.supervisor, turn("made progress", { toolCalls: 1 }));
		await runDueAction(reset.setNow, reset.controller, reset.supervisor);
		await sendTurn(reset.controller, reset.supervisor, turn("", { stopReason: "error", errorMessage: "503 temporary network failure" }));
		expect(reset.controller.get(SESSION_ID)?.nextActionAt).toBe(reset.supervisor.clock + 60_000);


		const usage = setup({ policy: { deadline: new Date(1_800_000_020_000).toISOString() } });
		usage.setNow(1_800_000_000_000);
		const usagePolicy = { ...usage.policy, deadline: new Date(1_800_000_020_000).toISOString() };
		await usage.controller.start(SESSION_ID, usagePolicy);
		await sendTurn(usage.controller, usage.supervisor, turn("", {
			stopReason: "error",
			errorMessage: "429 rate limit",
			retryAfterMs: 45_000,
		}));
		expect(usage.controller.get(SESSION_ID)?.phase).toBe("waiting-usage");
		expect(usage.controller.get(SESSION_ID)?.nextActionAt).toBe(Date.parse(usagePolicy.deadline));
		usage.setNow(Date.parse(usagePolicy.deadline));
		usage.supervisor.get(SESSION_ID)!.state = "idle";
		usage.controller.onWorkerStatus(SESSION_ID, stateLine(usage.supervisor.clock));
		await waitFor(() => usage.controller.get(SESSION_ID)?.phase === "wrapping-up" && usage.supervisor.prompts.length > 0, "deadline wrap-up prompt");
		expect(usage.supervisor.prompts[0]).toContain("deadline has passed");
		await sendTurn(usage.controller, usage.supervisor, turn("Morning report ready. OVERNIGHT-COMPLETE"));
		expect(usage.controller.get(SESSION_ID)?.phase).toBe("deadline");
	});

	it("does not prompt while streaming, asking or paused, and aborts an eventless stalled turn", async () => {
		const { controller, supervisor, policy, setNow } = setup();
		await controller.start(SESSION_ID, policy);
		await sendTurn(controller, supervisor, turn());
		const due = controller.get(SESSION_ID)!.nextActionAt!;
		setNow(due);
		const summary = supervisor.get(SESSION_ID)!;
		summary.state = "streaming";
		controller.onWorkerStatus(SESSION_ID, stateLine(due, { state: "streaming" }));
		await Bun.sleep(2);
		expect(supervisor.prompts).toHaveLength(0);
		summary.state = "asking";
		summary.awaitingAnswer = true;
		controller.onWorkerStatus(SESSION_ID, stateLine(due, { state: "asking", awaitingAnswer: true }));
		await Bun.sleep(2);
		expect(supervisor.prompts).toHaveLength(0);
		summary.state = "idle";
		summary.awaitingAnswer = false;
		summary.paused = true;
		controller.onWorkerStatus(SESSION_ID, stateLine(due, { paused: true }));
		await Bun.sleep(2);
		expect(supervisor.prompts).toHaveLength(0);
		summary.paused = false;
		controller.onWorkerStatus(SESSION_ID, stateLine(due));
		await waitFor(() => supervisor.prompts.length === 1, "prompt after session becomes idle");

		summary.state = "streaming";
		summary.lastActivityAt = due;
		setNow(due + 20 * 60_000);
		controller.onWorkerStatus(SESSION_ID, stateLine(due + 20 * 60_000, { state: "streaming" }));
		await waitFor(() => supervisor.aborts === 1, "stall abort");
		expect(controller.get(SESSION_ID)?.events.some(event => event.kind === "stall-abort")).toBe(true);
		// The turn that the stall abort ends must be continued, not treated as the user's Stop.
		await sendTurn(controller, supervisor, turn("", { stopReason: "aborted" }));
		expect(controller.get(SESSION_ID)?.phase).toBe("continuing");
	});

	it("treats the user's Stop during an overnight turn as stopping the run", async () => {
		const { controller, supervisor, policy } = setup();
		await controller.start(SESSION_ID, policy);
		await sendTurn(controller, supervisor, turn("", { stopReason: "aborted" }));
		expect(controller.get(SESSION_ID)?.phase).toBe("stopped");
		expect(supervisor.prompts).toHaveLength(0);
	});

	it("blocks at once on errors a retry cannot fix and after three unclassified errors in a row", async () => {
		const fatal = setup();
		await fatal.controller.start(SESSION_ID, fatal.policy);
		await sendTurn(fatal.controller, fatal.supervisor, turn("", {
			stopReason: "error",
			errorMessage: "Invalid prompt: your prompt was flagged as potentially violating our usage policy",
		}));
		expect(fatal.controller.get(SESSION_ID)?.phase).toBe("blocked");

		const odd = setup();
		await odd.controller.start(SESSION_ID, odd.policy);
		for (let attempt = 1; attempt <= 2; attempt++) {
			await sendTurn(odd.controller, odd.supervisor, turn("", { stopReason: "error", errorMessage: "something odd happened" }));
			expect(odd.controller.get(SESSION_ID)?.phase).toBe("waiting-retry");
			await runDueAction(odd.setNow, odd.controller, odd.supervisor);
		}
		await sendTurn(odd.controller, odd.supervisor, turn("", { stopReason: "error", errorMessage: "something odd happened" }));
		expect(odd.controller.get(SESSION_ID)?.phase).toBe("blocked");
	});

	it("limits crash restarts, resumes persisted controllers, stops cleanly and releases keep-awake", async () => {
		const args: string[][] = [];
		let killed = 0;
		const exited = Promise.withResolvers<number>();
		const first = setup({
			policy: { keepAwake: true },
			platform: "darwin",
			spawnCaffeinate: argv => {
				args.push([...argv]);
				return { kill: () => { killed++; exited.resolve(0); }, exited: exited.promise };
			},
		});
		await first.controller.start(SESSION_ID, first.policy);
		expect(args[0]?.slice(0, 5)).toEqual(["/usr/bin/caffeinate", "-i", "-s", "-w", String(process.pid)]);
		await first.controller.stop(SESSION_ID);
		expect(first.controller.get(SESSION_ID)?.phase).toBe("stopped");
		expect(killed).toBe(1);

		const linuxArgs: string[][] = [];
		let linuxKilled = 0;
		const linuxExited = Promise.withResolvers<number>();
		const linux = setup({
			policy: { keepAwake: true },
			platform: "linux",
			spawnCaffeinate: argv => {
				linuxArgs.push([...argv]);
				return { kill: () => { linuxKilled++; linuxExited.resolve(0); }, exited: linuxExited.promise };
			},
		});
		await linux.controller.start(SESSION_ID, linux.policy);
		expect(linuxArgs[0]).toEqual(["systemd-inhibit", "--what=idle:sleep", "--who=omp-console", "--why=Overnight run", "--mode=block", "tail", `--pid=${process.pid}`, "-f", "/dev/null"]);
		await linux.controller.stop(SESSION_ID);
		expect(linuxKilled).toBe(1);

		const crashed = setup();
		await crashed.controller.start(SESSION_ID, crashed.policy);
		for (let index = 0; index < 5; index++) {
			crashed.controller.onWorkerCrash({ sessionId: SESSION_ID, exitCode: 1, signal: null, restarts: index, willRestart: false });
			await waitFor(() => crashed.supervisor.restarts.length === index + 1, `worker restart ${index + 1}`);
		}
		crashed.controller.onWorkerCrash({ sessionId: SESSION_ID, exitCode: 1, signal: null, restarts: 5, willRestart: false });
		await waitFor(() => crashed.controller.get(SESSION_ID)?.phase === "blocked", "restart cap");
		expect(crashed.supervisor.restarts).toHaveLength(5);

		const recovering = setup();
		await recovering.controller.start(SESSION_ID, recovering.policy);
		recovering.supervisor.get(SESSION_ID)!.state = "crashed";
		recovering.supervisor.restartFailures = 1;
		recovering.controller.onWorkerCrash({ sessionId: SESSION_ID, exitCode: 1, signal: null, restarts: 2, willRestart: false });
		await waitFor(() => recovering.controller.get(SESSION_ID)?.phase === "waiting-retry", "failed restart backoff");
		recovering.setNow(recovering.controller.get(SESSION_ID)!.nextActionAt!);
		recovering.controller.onWorkerStatus(SESSION_ID, stateLine(recovering.supervisor.clock));
		await waitFor(() => recovering.supervisor.restarts.length === 2, "worker restart retry");
		await waitFor(() => recovering.controller.get(SESSION_ID)?.continuations === 1, "post-restart continuation");

		const persisted = setup();
		await persisted.controller.start(SESSION_ID, persisted.policy);
		await persisted.controller.close();
		const restored = new OvernightController({ supervisor: persisted.supervisor, store: persisted.store, now: () => persisted.supervisor.clock });
		controllers.push(restored);
		await restored.load();
		await restored.reconcile();
		expect(restored.get(SESSION_ID)?.events.some(event => event.kind === "daemon-resume")).toBe(true);
		expect(persisted.supervisor.restarts.at(-1)?.options).toEqual({ askTimeoutSec: 60, quiet: "normal" });
		expect(persisted.supervisor.prompts).toHaveLength(1);
	});

	it("after a daemon restart sends exactly one continuation, only once the session is resumed", async () => {
		const first = setup();
		await first.controller.start(SESSION_ID, first.policy);
		await sendTurn(first.controller, first.supervisor, turn("still working"));
		await first.controller.close();
		first.setNow(first.controller.get(SESSION_ID)!.nextActionAt! + 5_000);
		const restored = new OvernightController({ supervisor: first.supervisor, store: first.store, now: () => first.supervisor.clock });
		controllers.push(restored);
		await restored.load();
		// The session finished restoring and reports idle before `reconcile` runs: nothing may be sent yet.
		restored.onWorkerStatus(SESSION_ID, stateLine(first.supervisor.clock));
		await Bun.sleep(1_200);
		expect(first.supervisor.prompts).toHaveLength(0);
		await restored.reconcile();
		await waitFor(() => first.supervisor.prompts.length === 1, "one continuation after resume");
		await Bun.sleep(1_200);
		expect(first.supervisor.prompts).toHaveLength(1);
		expect(first.supervisor.restarts).toHaveLength(1);
	});

	it("restarts the worker when a stall abort does not end the stream, and when the abort itself fails", async () => {
		for (const behavior of ["stuck", "reject"] as const) {
			const t = setup();
			await t.controller.start(SESSION_ID, t.policy);
			t.supervisor.abortBehavior = behavior;
			const summary = t.supervisor.get(SESSION_ID)!;
			summary.state = "streaming";
			summary.lastActivityAt = t.supervisor.clock;
			t.setNow(t.supervisor.clock + 20 * 60_000);
			t.controller.onWorkerStatus(SESSION_ID, stateLine(t.supervisor.clock, { state: "streaming" }));
			await waitFor(() => t.supervisor.aborts === 1, `${behavior}: stall abort`);
			if (behavior === "stuck") {
				await Bun.sleep(5);
				expect(t.supervisor.restarts).toHaveLength(0);
				t.setNow(t.supervisor.clock + 2 * 60_000);
				t.controller.onWorkerStatus(SESSION_ID, stateLine(t.supervisor.clock, { state: "streaming" }));
			}
			await waitFor(() => t.supervisor.restarts.length === 1, `${behavior}: worker restart`);
			await Bun.sleep(5);
			expect(t.supervisor.aborts).toBe(1);
			expect(t.controller.get(SESSION_ID)?.events.some(event => event.kind === "worker-restart")).toBe(true);
		}
	});

	it("a turn that ends with OVERNIGHT-COMPLETE after the deadline passed still completes", async () => {
		const t = setup();
		await t.controller.start(SESSION_ID, t.policy);
		const summary = t.supervisor.get(SESSION_ID)!;
		summary.state = "streaming";
		summary.lastActivityAt = t.supervisor.clock;
		t.setNow(Date.parse(t.policy.deadline) + 1);
		t.controller.onWorkerStatus(SESSION_ID, stateLine(t.supervisor.clock, { state: "streaming" }));
		await waitFor(() => t.controller.get(SESSION_ID)?.phase === "wrapping-up", "deadline during a turn");
		// The worker emits `turn-end` before its idle state line; flipping the session to idle first would let a
		// recheck tick send the wrap-up prompt in between and turn this into the wrap-up turn.
		t.controller.onWorkerStatus(SESSION_ID, { t: "turn-end", lastTurn: turn("All done. OVERNIGHT-COMPLETE") });
		await waitFor(() => t.controller.get(SESSION_ID)?.phase !== "wrapping-up", "turn-end handled");
		summary.state = "idle";
		expect(t.controller.get(SESSION_ID)?.phase).toBe("complete");
		expect(t.supervisor.prompts).toHaveLength(0);
	});
});
