import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DebugDiagnosticsOp, DebugSessionOp, SessionOpV3Result, WorkerRequestResult } from "@omp-console/protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { dapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import { DebugModeService } from "../src/debug-mode";
import { childPidsMatching } from "./host-test-helpers";
import {
	Fixture,
	newRoom,
	pidsMatching,
	waitUntil,
	type WorkerProcess,
} from "./harness";

let fixture: Fixture | undefined;
let workerForCleanup: WorkerProcess | undefined;
afterEach(async () => {
	if (workerForCleanup?.proc.exitCode === null) {
		workerForCleanup.send({ t: "stop" });
		await workerForCleanup.exited;
	}
	workerForCleanup = undefined;
	await fixture?.dispose();
	fixture = undefined;
});

let requestId = 0;
async function debugOp(worker: WorkerProcess, operation: DebugSessionOp): Promise<WorkerRequestResult> {
	return worker.request<WorkerRequestResult>({ t: "session-op", id: `debug-${++requestId}`, op: operation });
}
async function diagnosticsOp(worker: WorkerProcess, operation: DebugDiagnosticsOp): Promise<WorkerRequestResult> {
	return worker.request<WorkerRequestResult>({ t: "session-op", id: `debug-${++requestId}`, op: operation });
}

function result(reply: WorkerRequestResult): SessionOpV3Result {
	if (reply.t !== "session-op") throw new Error(`expected a debug result, got ${JSON.stringify(reply)}`);
	return reply.result;
}

describe("debug mode", () => {
	it("runs adapter discovery, launch, DAP inspection, control, attach, selection, and termination in a real worker", async () => {
		fixture = new Fixture();
		const adapterScript = path.resolve(import.meta.dir, "fixtures/dap-adapter.ts");
		const program = path.join(fixture.cwd, "sample.js");
		await fs.writeFile(program, "console.log('fixture target');\n");
		await fs.writeFile(
			path.join(fixture.cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"deck-fixture": {
						command: process.execPath,
						args: [adapterScript],
					languages: ["javascript"],
					fileTypes: [".js"],
					launchDefaults: {},
					attachDefaults: {},
					rootMarkers: [],
				},
				},
			}),
		);
		const worker = fixture.spawn(newRoom(), [], { OMP_CONSOLE_DAP_FIXTURE_IGNORE_SIGTERM: "1" });
		workerForCleanup = worker;
		await worker.ready();

		const adapters = result(await debugOp(worker, { op: "debug", action: "adapters" }));
		if (!("debugAdapters" in adapters)) throw new Error("worker returned no DAP adapters");
		expect(adapters.debugAdapters.find(adapter => adapter.name === "deck-fixture")).toMatchObject({ available: true, fileTypes: [".js"] });

		const launch = result(await debugOp(worker, {
			op: "debug",
			action: "launch",
			program: "sample.js",
			adapter: "deck-fixture",
			confirmed: true,
		}));
		if (!("debugSession" in launch)) throw new Error("worker returned no launched DAP session");
		const launchId = launch.debugSession.id;
		expect(launch.debugSession).toMatchObject({ adapter: "deck-fixture", status: "stopped", program, frameName: "main" });

		const threads = result(await debugOp(worker, { op: "debug", action: "threads" }));
		if (!("debugThreads" in threads)) throw new Error("worker returned no threads");
		expect(threads.debugThreads).toEqual([{ id: 1, name: "main thread" }]);
		const stack = result(await debugOp(worker, { op: "debug", action: "stack" }));
		if (!("debugStack" in stack)) throw new Error("worker returned no stack frames");
		expect(stack.debugStack[0]).toMatchObject({ name: "main", line: 1, source: { path: program } });
		const scopes = result(await debugOp(worker, { op: "debug", action: "scopes", frameId: 1 }));
		if (!("debugScopes" in scopes)) throw new Error("worker returned no scopes");
		expect(scopes.debugScopes).toEqual([{ name: "Locals", variablesReference: 10, expensive: false }]);
		const variables = result(await debugOp(worker, { op: "debug", action: "variables", reference: 10 }));
		if (!("debugVariables" in variables)) throw new Error("worker returned no variables");
		expect(variables.debugVariables).toEqual([{ name: "answer", value: "42", type: "number", variablesReference: 0 }]);
		const evaluated = result(await debugOp(worker, { op: "debug", action: "evaluate", expression: "answer", frameId: 1 }));
		if (!("debugValue" in evaluated)) throw new Error("worker returned no evaluation");
		expect(evaluated.debugValue).toBe("42");
		const output = result(await debugOp(worker, { op: "debug", action: "output" }));
		if (!("debugOutput" in output)) throw new Error("worker returned no DAP output");
		expect(output.debugOutput).toContain("DAP fixture ready");

		expect(result(await debugOp(worker, { op: "debug", action: "continue" }))).toMatchObject({ ok: true, debugSession: { status: "running" } });
		expect(result(await debugOp(worker, { op: "debug", action: "pause" }))).toMatchObject({ ok: true, debugSession: { status: "stopped", stopReason: "pause" } });
		expect(result(await debugOp(worker, { op: "debug", action: "step-over" }))).toMatchObject({ ok: true, debugSession: { status: "stopped" } });
		expect(result(await debugOp(worker, { op: "debug", action: "step-in" }))).toMatchObject({ ok: true, debugSession: { status: "stopped" } });
		expect(result(await debugOp(worker, { op: "debug", action: "step-out" }))).toMatchObject({ ok: true, debugSession: { status: "stopped" } });

		expect(result(await debugOp(worker, { op: "debug", action: "terminate" }))).toMatchObject({ ok: true, debugSession: { id: launchId, status: "terminated" } });

		const attach = result(await debugOp(worker, {
			op: "debug",
			action: "attach",
			port: 4711,
			host: "127.0.0.1",
			adapter: "deck-fixture",
			confirmed: true,
		}));
		if (!("debugSession" in attach)) throw new Error("worker returned no attached DAP session");
		const attachId = attach.debugSession.id;
		expect(attach.debugSession).toMatchObject({ adapter: "deck-fixture", status: "stopped" });
		const sessions = result(await debugOp(worker, { op: "debug", action: "sessions" }));
		if (!("debugSessions" in sessions)) throw new Error("worker returned no DAP sessions");
		expect(sessions.debugSessions.map(session => session.id)).toEqual([attachId]);
		expect(result(await debugOp(worker, { op: "debug", action: "select", sessionId: attachId }))).toMatchObject({ ok: true, debugSession: { id: attachId } });
		expect(result(await debugOp(worker, { op: "debug", action: "terminate" }))).toMatchObject({ ok: true, debugSession: { id: attachId, status: "terminated" } });
		const terminal = result(await diagnosticsOp(worker, { op: "debug-diagnostics", action: "terminal" }));
		expect(terminal).toMatchObject({
			ok: true,
			debugDiagnostic: { action: "terminal", text: expect.stringContaining("session runs in omp console") },
		});

		worker.send({ t: "stop" });
		await worker.exited;
		workerForCleanup = undefined;
		expect(pidsMatching(adapterScript)).toEqual([]);
	}, 90_000);

	it("keeps omp console session selection out of the process-wide DAP tool manager", async () => {
		fixture = new Fixture();
		const adapterScript = path.resolve(import.meta.dir, "fixtures/dap-adapter.ts");
		const program = path.join(fixture.cwd, "sample.js");
		await fs.writeFile(program, "console.log('fixture target');\n");
		await fs.writeFile(path.join(fixture.cwd, "dap.json"), JSON.stringify({
			adapters: {
				"deck-fixture": {
					command: process.execPath,
					args: [adapterScript],
					languages: ["javascript"],
					fileTypes: [".js"],
					launchDefaults: {},
					attachDefaults: {},
					rootMarkers: [],
				},
			},
		}));
		const service = new DebugModeService({
			sessionManager: { getCwd: () => fixture!.cwd },
		} as unknown as AgentSession);
		const activeBefore = dapSessionManager.getActiveSession()?.id ?? null;
		try {
			const launched = await service.run({ op: "debug", action: "launch", program, adapter: "deck-fixture", confirmed: true });
			if (!("debugSession" in launched)) throw new Error("Deck service returned no DAP session");
			await service.run({ op: "debug", action: "select", sessionId: launched.debugSession.id });
			expect(dapSessionManager.getActiveSession()?.id ?? null).toBe(activeBefore);
		} finally {
			await service.close();
		}
		expect(pidsMatching(adapterScript)).toEqual([]);
	}, 30_000);
	it("cancels an in-flight DAP launch in the worker and reaps its adapter", async () => {
		fixture = new Fixture();
		const adapterScript = path.resolve(import.meta.dir, "fixtures/dap-adapter.ts");
		const program = path.join(fixture.cwd, "sample.js");
		await fs.writeFile(program, "console.log('fixture target');\n");
		await fs.writeFile(path.join(fixture.cwd, "dap.json"), JSON.stringify({
			adapters: {
				"deck-fixture": {
					command: process.execPath,
					args: [adapterScript],
					languages: ["javascript"],
					fileTypes: [".js"],
					launchDefaults: {},
					attachDefaults: {},
					rootMarkers: [],
				},
			},
		}));
		const worker = fixture.spawn(newRoom(), [], { OMP_CONSOLE_DAP_FIXTURE_HOLD_INITIALIZE: "1" });
		workerForCleanup = worker;
		await worker.ready();

		const requestId = "abandoned-debug-launch";
		worker.send({
			t: "session-op",
			id: requestId,
			op: { op: "debug", action: "launch", program: "sample.js", adapter: "deck-fixture", confirmed: true },
		});
		await waitUntil("held DAP adapter process", () => childPidsMatching(worker.pid, adapterScript).length > 0);
		const adapterChildMarker = "omp-console-dap-fixture-child";
		await waitUntil("held DAP adapter child process", () => childPidsMatching(worker.pid, adapterChildMarker).length > 0);
		worker.send({ t: "cancel-session-op", id: requestId });
		const reply = await waitUntil(
			"debug launch cancellation reply",
			() => worker.lines.find(line => "id" in line && line.id === requestId),
		);
		expect(reply).toMatchObject({ t: "request-error", id: requestId });
		await waitUntil("DAP adapter process exit", () => childPidsMatching(worker.pid, adapterScript).length === 0);
		await waitUntil("DAP adapter child process exit", () => childPidsMatching(worker.pid, adapterChildMarker).length === 0);

		worker.send({ t: "stop" });
		await worker.exited;
		workerForCleanup = undefined;
	}, 30_000);

	it("rejects an aborted DAP operation before it can touch a manager", async () => {
		const service = new DebugModeService({
			sessionManager: { getCwd: () => "/tmp" },
		} as unknown as AgentSession);
		const abort = new AbortController();
		abort.abort(new Error("session operation cancelled"));
		try {
			await expect(service.run({ op: "debug", action: "adapters" }, abort.signal)).rejects.toThrow("session operation cancelled");
		} finally {
			await service.close();
		}
	});
});
