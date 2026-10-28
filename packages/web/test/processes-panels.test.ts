import { describe, expect, it } from "bun:test";
import type { ProcessInfo } from "@omp-console/protocol";
import { confirmAndStopProcess, filterProcesses, processAction, processActionLabel, totalRssBytes } from "../src/lib/processes";

function process(patch: Partial<ProcessInfo> = {}): ProcessInfo {
	return { pid: 1, ppid: 0, kind: "omp-console-worker", command: "omp-console worker", startedAt: 0, rssBytes: 100, state: "active", ...patch };
}

describe("process inventory", () => {
	it("filters by real process fields and state", () => {
		const values = [
			process({ pid: 1, cwd: "/repo/relay", sessionId: "relay" }),
			process({ pid: 2, kind: "omp-terminal", command: "omp --cwd /repo/docs", cwd: "/repo/docs", state: "idle" }),
			process({ pid: 3, kind: "omp-helper", command: "daemon_broker", state: "orphan" }),
		];
		expect(filterProcesses(values, "docs").map(item => item.pid)).toEqual([2]);
		expect(filterProcesses(values, "", "orphan").map(item => item.pid)).toEqual([3]);
		expect(totalRssBytes(values)).toBe(300);
	});

	it("maps stop labels to the safety boundary for each process kind", () => {
		expect(processAction(process({ kind: "omp-console-worker" }))).toBe("stop");
		expect(processActionLabel("ask-stop")).toContain("SIGTERM");
		expect(processAction(process({ kind: "omp-terminal" }))).toBe("ask-stop");
		expect(processAction(process({ kind: "omp-helper", state: "orphan" }))).toBe("kill");
		expect(processAction(process({ kind: "omp-broker", state: "idle" }))).toBeNull();
	});

	it("does not call the stop endpoint when confirmation is declined", async () => {
		let calls = 0;
		const result = await confirmAndStopProcess(process({ pid: 42 }), () => false, async () => {
			calls += 1;
		});
		expect(result).toBe("cancelled");
		expect(calls).toBe(0);
	});

	it("sends the confirmed PID and reports a terminal SIGTERM action", async () => {
		let pid = 0;
		let prompt = "";
		const result = await confirmAndStopProcess(process({ pid: 42, kind: "omp-terminal" }), message => {
			prompt = message;
			return true;
		}, async value => {
			pid = value;
		});
		expect(result).toBe("stopped");
		expect(pid).toBe(42);
		expect(prompt).toContain("SIGTERM");
	});
});
