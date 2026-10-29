import { describe, expect, it } from "bun:test";
import type { ProcessInfo, SessionSummary, WorkerHealth } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyProcess, ORPHAN_GRACE_MS } from "../src/processes/classify";
import type { ProcessPorts } from "../src/processes/ports";
import { createProcessRoutes } from "../src/processes/routes";
import { parseLsofOutput, parsePsOutput, parseWin32ProcessOutput, ProcessScanner, scanOmpProcesses, sumProcessTreeRss } from "../src/processes/scan";

function fixture(name: string): string {
	return fs.readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");
}

function processFixture(): string {
	return fixture(process.platform === "win32" ? "processes.windows.json" : "processes.txt");
}

function platformSnapshot(posixOutput: string): string {
	if (process.platform !== "win32") return posixOutput;
	return JSON.stringify(parsePsOutput(posixOutput).map(row => ({
		ProcessId: row.pid,
		ParentProcessId: row.ppid,
		WorkingSetSize: row.rssBytes,
		CommandLine: row.command,
		CreationDate: new Date(row.startedAt).toISOString(),
	})));
}

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "deck-processes-"));
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "session-100",
		cwd: "/tmp/project",
		sessionFile: "/tmp/sessions/session-100.jsonl",
		state: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...overrides,
	};
}

function worker(overrides: Partial<WorkerHealth> = {}): WorkerHealth {
	return {
		sessionId: "session-100",
		pid: 100,
		state: "idle",
		rssBytes: 0,
		startedAt: 1,
		lastEventAt: 1,
		stalled: false,
		restarts: 0,
		...overrides,
	};
}

function processInfo(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
	return {
		pid: 301,
		ppid: 1,
		kind: "omp-helper",
		command: "/tmp/omp-helper",
		startedAt: 1,
		rssBytes: 100,
		state: "idle",
		...overrides,
	};
}

class FakeProcessPorts implements ProcessPorts {
	sessions: SessionSummary[] = [];
	workers: WorkerHealth[] = [];
	readonly stopped: string[] = [];

	liveSessions(): SessionSummary[] {
		return [...this.sessions];
	}

	async workerHealth(): Promise<WorkerHealth[]> {
		return [...this.workers];
	}

	async stopSession(sessionId: string): Promise<boolean> {
		this.stopped.push(sessionId);
		return true;
	}
}

async function callRoute(
	route: (req: Request, url: URL) => Promise<Response | undefined>,
	method: string,
	pathname: string,
	body?: unknown,
): Promise<Response | undefined> {
	const url = new URL(pathname, "http://127.0.0.1");
	const request = new Request(url.toString(), {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return route(request, url);
}

describe("process output parsing and classification", () => {
	it("maps platform process rows into RSS trees, cwd and session metadata", async () => {
		const now = Date.now();
		const ps = processFixture();
		const lsof = process.platform === "win32" ? "" : fixture("processes.lsof");
		const rows = process.platform === "win32" ? parseWin32ProcessOutput(ps) : parsePsOutput(ps);
		expect(rows.map(row => row.pid)).toEqual([100, 101, 102, 200]);
		expect(sumProcessTreeRss(rows, 100)).toBe((1200 + 500 + 250) * 1024);
		if (process.platform === "win32") expect(parseLsofOutput(lsof).get(100)).toBeUndefined();
		else expect(parseLsofOutput(lsof).get(100)).toMatchObject({ cwd: "/tmp/project", sessionFiles: ["/tmp/sessions/session-100.jsonl"] });

		const processes = await scanOmpProcesses([worker()], [session()], now, {
			readPs: async () => ps,
			readLsof: async () => lsof,
			statMtime: async () => now - 60_000,
		});
		const deckWorker = processes.find(item => item.pid === 100)!;
		expect(deckWorker).toMatchObject({
			kind: "omp-console-worker",
			cwd: "/tmp/project",
			sessionId: "session-100",
			sessionFile: "/tmp/sessions/session-100.jsonl",
			state: "active",
		});
		expect(deckWorker.rssBytes).toBe((1200 + 500 + 250) * 1024);
		expect(processes.find(item => item.pid === 200)?.kind).toBe("omp-broker");
		if (process.platform === "win32") expect(processes.find(item => item.pid === 101)?.sessionFile).toBeUndefined();
	});

	it("parses the Windows CIM fixture into process identities and RSS bytes", () => {
		const rows = parseWin32ProcessOutput(fixture("processes.windows.json"));
		expect(rows.map(({ pid, ppid, startedAt, rssBytes }) => [pid, ppid, startedAt, rssBytes])).toEqual([
			[100, 1, Date.parse("2026-10-20T10:00:00"), 1_228_800],
			[101, 100, Date.parse("2026-10-20T10:01:00"), 512_000],
			[102, 101, Date.parse("2026-10-20T10:02:00"), 256_000],
			[200, 1, Date.parse("2026-10-20T09:00:00"), 102_400],
		]);
		expect(rows[0]!.command).toBe("C:\\Users\\runneradmin\\work\\omp-console\\packages\\session-host\\src\\main.ts");
	});

	it("marks a surviving worker child orphan after 30 seconds but never orphans detached brokers by parentage", async () => {
		let ps = processFixture();
		const scanner = new ProcessScanner({ readPs: async () => ps, readLsof: async () => "" });
		const sessions = [session()];
		const started = Date.now();
		await scanner.scan([worker()], sessions, started);
		ps = platformSnapshot([
			"PID PPID LSTART RSS TTY COMMAND",
			"101 1 Tue Oct 20 10:01:00 2026 500 ?? /tmp/omp-helper",
			"102 1 Tue Oct 20 10:02:00 2026 250 ?? /usr/bin/tool child",
			"200 1 Tue Oct 20 09:00:00 2026 100 ?? daemon_broker --detached",
		].join("\n"));
		await scanner.scan([], [], started + 1);
		const processes = await scanner.scan([], [], started + ORPHAN_GRACE_MS + 2);
		expect(processes.find(item => item.pid === 101)?.state).toBe("orphan");
		expect(processes.find(item => item.pid === 102)?.state).toBe("orphan");
		expect(processes.find(item => item.pid === 200)?.state).not.toBe("orphan");
	});


	it("classifies recently written sessions as active and keeps a detached lsp mux non-orphan", () => {
		const now = 1_000_000;
		expect(classifyProcess(processInfo({ lastSessionWriteAt: now - 1 }), now).state).toBe("active");
		expect(classifyProcess(processInfo({ kind: "omp-lsp" }), now, { orphanSince: 0 }).state).toBe("idle");
	});
});

describe("process routes", () => {
	it("requires confirmation and limits terminal omp stops to SIGTERM", async () => {
		const ports = new FakeProcessPorts();
		let signals: Array<[number, string]> = [];
		const route = createProcessRoutes(ports, tempDir(), {
			scanner: new ProcessScanner({
				readPs: async () => platformSnapshot("100 1 Tue Oct 20 10:00:00 2026 1200 ?? /usr/local/bin/omp --cwd /tmp/a"),
				readLsof: async () => "",
			}),
			signalProcess: (pid, signal) => signals.push([pid, signal]),
		});
		try {
			const unconfirmed = await callRoute(route, "POST", "/api/processes/100/stop", { confirm: false });
			expect(unconfirmed?.status).toBe(400);
			const missing = await callRoute(route, "POST", "/api/processes/999/stop", { confirm: true });
			expect(missing?.status).toBe(404);
			const stopped = await callRoute(route, "POST", "/api/processes/100/stop", { confirm: true });
			expect(stopped?.status).toBe(202);
			expect(signals).toEqual([[100, "SIGTERM"]]);
		} finally {
			route.dispose();
		}
	});

	it("routes omp-console worker stop through the supervisor port", async () => {
		const ports = new FakeProcessPorts();
		ports.sessions = [session()];
		ports.workers = [worker()];
		const route = createProcessRoutes(ports, tempDir(), {
			scanner: new ProcessScanner({ readPs: async () => processFixture(), readLsof: async () => "" }),
			signalProcess: () => {
				throw new Error("omp-console workers must never be signaled directly");
			},
		});
		try {
			const stopped = await callRoute(route, "POST", "/api/processes/100/stop", { confirm: true });
			expect(stopped?.status).toBe(202);
			expect(ports.stopped).toEqual(["session-100"]);
		} finally {
			route.dispose();
		}
	});

	it("escalates an orphan from SIGTERM to SIGKILL after three seconds", async () => {
		const ports = new FakeProcessPorts();
		ports.sessions = [session()];
		ports.workers = [worker()];
		let ps = processFixture();
		let now = Date.now();
		const releaseSleep = Promise.withResolvers<void>();
		const signals: Array<[number, string]> = [];
		const route = createProcessRoutes(ports, tempDir(), {
			scanner: new ProcessScanner({ readPs: async () => ps, readLsof: async () => "" }),
			now: () => now,
			signalProcess: (pid, signal) => signals.push([pid, signal]),
			processAlive: () => true,
			sleep: ms => {
				expect(ms).toBe(3_000);
				return releaseSleep.promise;
			},
		});
		try {
			await callRoute(route, "GET", "/api/processes");
			ports.sessions = [];
			ports.workers = [];
			ps = platformSnapshot([
				"PID PPID LSTART RSS TTY COMMAND",
				"101 1 Tue Oct 20 10:01:00 2026 500 ?? /tmp/omp-helper",
				"102 1 Tue Oct 20 10:02:00 2026 250 ?? /usr/bin/tool child",
				"200 1 Tue Oct 20 09:00:00 2026 100 ?? daemon_broker --detached",
			].join("\n"));
			now += 2_001;
			await callRoute(route, "GET", "/api/processes");
			now += ORPHAN_GRACE_MS + 1;
			const stopped = await callRoute(route, "POST", "/api/processes/101/stop", { confirm: true });
			expect(stopped?.status).toBe(202);
			expect(signals).toEqual([[101, "SIGTERM"]]);
			releaseSleep.resolve();
			for (let i = 0; i < 50 && signals.length < 2; i++) await Bun.sleep(1);
			expect(signals).toEqual([[101, "SIGTERM"], [101, "SIGKILL"]]);
		} finally {
			releaseSleep.resolve();
			route.dispose();
		}
	});

	it("does not SIGKILL a pid that an unrelated process reused during the grace period", async () => {
		const ports = new FakeProcessPorts();
		ports.sessions = [session()];
		ports.workers = [worker()];
		let ps = processFixture();
		let now = Date.now();
		const releaseSleep = Promise.withResolvers<void>();
		const signals: Array<[number, string]> = [];
		const route = createProcessRoutes(ports, tempDir(), {
			scanner: new ProcessScanner({ readPs: async () => ps, readLsof: async () => "" }),
			now: () => now,
			signalProcess: (pid, signal) => signals.push([pid, signal]),
			processAlive: () => true,
			sleep: () => releaseSleep.promise,
		});
		try {
			await callRoute(route, "GET", "/api/processes");
			ports.sessions = [];
			ports.workers = [];
			ps = platformSnapshot([
				"PID PPID LSTART RSS TTY COMMAND",
				"101 1 Tue Oct 20 10:01:00 2026 500 ?? /tmp/omp-helper",
				"102 1 Tue Oct 20 10:02:00 2026 250 ?? /usr/bin/tool child",
			].join("\n"));
			now += 2_001;
			await callRoute(route, "GET", "/api/processes");
			now += ORPHAN_GRACE_MS + 1;
			expect((await callRoute(route, "POST", "/api/processes/102/stop", { confirm: true }))?.status).toBe(202);
			// The orphan exits and an unrelated program gets pid 102 (new start time, new command).
			ps = platformSnapshot(["PID PPID LSTART RSS TTY COMMAND", "102 1 Tue Oct 20 11:30:00 2026 900 ?? /usr/bin/vim notes.txt"].join("\n"));
			releaseSleep.resolve();
			for (let i = 0; i < 20; i++) await Bun.sleep(1);
			expect(signals).toEqual([[102, "SIGTERM"]]);
		} finally {
			releaseSleep.resolve();
			route.dispose();
		}
	});

	it("stops only idle omp-console sessions under the opt-in policy", async () => {
		const ports = new FakeProcessPorts();
		const now = 100_000;
		ports.sessions = [
			session({ id: "idle", lastActivityAt: now - 10_000 }),
			session({ id: "streaming", state: "streaming", lastActivityAt: now - 10_000 }),
			session({ id: "asking", state: "asking", awaitingAnswer: true, lastActivityAt: now - 10_000 }),
		];
		const route = createProcessRoutes(ports, tempDir(), {
			now: () => now,
			scanner: new ProcessScanner({ readPs: async () => platformSnapshot(""), readLsof: async () => "" }),
			policyCheckIntervalMs: 60_000,
		});
		try {
			const policy = await callRoute(route, "PUT", "/api/processes/policies", { idleStopAfterMs: 5_000, rssWarnBytes: 123_456 });
			expect(policy?.status).toBe(204);
			await route.checkIdleStops();
			expect(ports.stopped).toEqual(["idle"]);
		} finally {
			route.dispose();
		}
	});
});

	it("reuses a process scan for two seconds, then refreshes it", async () => {
		const ports = new FakeProcessPorts();
		let reads = 0;
		let now = 1_000;
		const scanner = new ProcessScanner({
			readPs: async () => {
				reads++;
				return processFixture();
			},
			readLsof: async () => "",
		});
		const route = createProcessRoutes(ports, tempDir(), { scanner, now: () => now });
		try {
			await callRoute(route, "GET", "/api/processes");
			await callRoute(route, "GET", "/api/processes");
			expect(reads).toBe(1);

			now += 2_000;
			await callRoute(route, "GET", "/api/processes");
			expect(reads).toBe(2);
		} finally {
			route.dispose();
		}
	});
