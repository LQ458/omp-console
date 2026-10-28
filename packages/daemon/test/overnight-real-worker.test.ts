import { afterEach, describe, expect, it } from "bun:test";
import type { ListSessionsResponse, OvernightState, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startTestDaemon, stopTestDaemons, type TestDaemon } from "./harness";
import { makeTmp } from "./helpers";

const SESSION_HOST_MAIN = path.resolve(import.meta.dir, "../../session-host/src/main.ts");
const STUB_PROVIDER = path.resolve(import.meta.dir, "../../session-host/test/fixtures/stub-provider.ts");
const cleanup: string[] = [];

afterEach(async () => {
	await stopTestDaemons();
	for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

async function startOvernightTestDaemon(script?: string): Promise<TestDaemon> {
	const agentDir = makeTmp("deck-overnight-agent-");
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	fs.symlinkSync(STUB_PROVIDER, path.join(agentDir, "extensions", "stub-provider.ts"));
	const configDirName = `.deck-test-overnight-${path.basename(agentDir)}`;
	cleanup.push(agentDir, path.join(os.homedir(), configDirName));
	return startTestDaemon({
		agentDir,
		features: {
			librarian: false,
			agenda: false,
			quickAsk: false,
			peers: false,
			openrouterDecisions: false,
			computerUse: false,
			overnight: true,
		},
		workerCmd: [process.execPath, SESSION_HOST_MAIN],
		workerEnv: {
			PI_CONFIG_DIR: configDirName,
			OMP_CONSOLE_COMPUTER_USE: "0",
			...(script ? { STUB_OVERNIGHT_SCRIPT: script } : {}),
		},
	});
}

function overnightRequest(task: string, prompt?: string): Record<string, unknown> {
	return {
		cwd: process.cwd(),
		model: "stub/stub-model",
		overnight: {
			task,
			...(prompt ? { prompt } : {}),
			policy: {
				deadline: `${new Date(Date.now() + 15 * 60_000).toISOString().slice(0, -1)}+00:00`,
				askTimeoutSec: 1,
				quiet: "normal",
				maxIdleContinuations: 3,
				keepAwake: false,
			},
		},
	};
}

async function waitForState(
	daemon: TestDaemon,
	sessionId: string,
	predicate: (state: OvernightState) => boolean,
	timeoutMs: number,
): Promise<OvernightState> {
	const deadline = Date.now() + timeoutMs;
	let lastState: OvernightState | undefined;
	while (Date.now() < deadline) {
		const response = await daemon.get(`/api/sessions/${sessionId}/overnight`);
		if (response.ok) {
			lastState = (await response.json()) as OvernightState;
			if (predicate(lastState)) return lastState;
		}
		await Bun.sleep(50);
	}
	throw new Error(`Overnight state did not reach the expected transition: ${JSON.stringify(lastState)}`);
}

async function createOvernight(daemon: TestDaemon, task: string, prompt?: string): Promise<SessionSummary> {
	const response = await daemon.post("/api/sessions", overnightRequest(task, prompt));
	if (response.status !== 201) throw new Error(`create overnight failed (${response.status}): ${await response.text()}`);
	const summary = (await response.json()) as SessionSummary;
	expect(summary.overnight?.phase).toBe("running");
	return summary;
}

describe("overnight sessions with the real session-host worker", () => {
	it("continues two premature turns before accepting the completion marker", async () => {
		const daemon = await startOvernightTestDaemon("continue-twice");
		const session = await createOvernight(daemon, "Exercise continuation recovery");
		const complete = await waitForState(daemon, session.id, state => state.phase === "complete", 90_000);
		expect(complete.continuations).toBe(2);
		expect(complete.events.filter(event => event.kind === "continue")).toHaveLength(2);
		expect(complete.report).toContain("- Result: Completed");
	}, 120_000);

	it("forwards a no-browser ask timeout answer and stops the controller without stopping the session", async () => {
		const daemon = await startOvernightTestDaemon();
		const session = await createOvernight(daemon, "Choose the conservative option", "ASK:");
		const answered = await waitForState(
			daemon,
			session.id,
			state => state.events.some(event => event.kind === "auto-answer"),
			10_000,
		);
		const answerEvent = answered.events.find(event => event.kind === "auto-answer");
		expect(answerEvent?.detail).toContain("alpha");
		let stopped: Response | undefined;
		const stopDeadline = Date.now() + 5_000;
		for (;;) {
			const response = await daemon.del(`/api/sessions/${session.id}/overnight`);
			if (response.status !== 409 || Date.now() >= stopDeadline) {
				stopped = response;
				break;
			}
			await response.arrayBuffer();
			await Bun.sleep(25);
		}
		expect(stopped?.status).toBe(200);
		const finalState = (await stopped!.json()) as OvernightState;
		expect(finalState.phase).toBe("stopped");
		let command: Response | undefined;
		const commandDeadline = Date.now() + 5_000;
		for (;;) {
			const response = await daemon.post(`/api/sessions/${session.id}/command`, { text: "/rename Overnight Mode Stopped" });
			if (response.status !== 409 || Date.now() >= commandDeadline) {
				command = response;
				break;
			}
			await response.arrayBuffer();
			await Bun.sleep(25);
		}
		expect(command?.status).toBe(202);
		const titleDeadline = Date.now() + 5000;
		let title: string | undefined;
		while (Date.now() < titleDeadline && title !== "Overnight Mode Stopped") {
			const response = await daemon.get("/api/sessions");
			title = ((await response.json()) as ListSessionsResponse).live.find(row => row.id === session.id)?.title;
			if (title !== "Overnight Mode Stopped") await Bun.sleep(25);
		}
		expect(title).toBe("Overnight Mode Stopped");
	}, 60_000);

	it("retries after a retryable network failure", async () => {
		const daemon = await startOvernightTestDaemon("network-once");
		const session = await createOvernight(daemon, "Recover from one network failure");
		const complete = await waitForState(daemon, session.id, state => state.phase === "complete", 75_000);
		expect(complete.events.some(event => event.kind === "retry-wait")).toBe(true);
		expect(complete.continuations).toBe(1);
		expect(complete.report).toContain("Recovered from the temporary network failure");
	}, 90_000);
	it("waits for a rate-limit reset before resuming", async () => {
		const daemon = await startOvernightTestDaemon("rate-limit-once");
		const session = await createOvernight(daemon, "Recover from one rate limit");
		const complete = await waitForState(daemon, session.id, state => state.phase === "complete", 30_000);
		expect(complete.events.some(event => event.kind === "usage-wait")).toBe(true);
		expect(complete.continuations).toBe(1);
		expect(complete.report).toContain("Recovered from the temporary rate limit");
	}, 60_000);

});
