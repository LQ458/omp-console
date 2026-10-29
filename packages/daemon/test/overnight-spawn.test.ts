import { describe, expect, it } from "bun:test";
import { buildWorkerLaunchPlan } from "../src/supervisor";

const base = {
	workerCmd: ["bun", "session-host.ts"],
	cwd: "/work/project",
	relayUrl: "ws://127.0.0.1:7481",
	roomId: "room-id",
	registered: false,
	spec: { model: "stub/stub-model", overnight: { askTimeoutSec: 60, quiet: "quiet" as const } },
	env: { GIT_SSH_COMMAND: "ssh -F /tmp/ssh-config", OMP_CONSOLE_ROOM_KEY: "must-not-leak", OMP_CONSOLE_WRITE_TOKEN: "must-not-leak" },
	platform: "darwin",
};

describe("overnight worker launch plan", () => {
	it("applies the requested macOS scheduling class, nice value and non-interactive environment", () => {
		const plan = buildWorkerLaunchPlan(base);

		expect(plan.command.slice(0, 6)).toEqual(["/usr/sbin/taskpolicy", "-c", "utility", "/usr/bin/nice", "-n", "10"]);
		expect(plan.command.slice(6)).toEqual([
			"bun", "session-host.ts", "--cwd", "/work/project", "--relay", "ws://127.0.0.1:7481", "--room", "room-id", "--model", "stub/stub-model",
		]);
		expect(plan.env).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GIT_SSH_COMMAND: "ssh -F /tmp/ssh-config",
			GH_PROMPT_DISABLED: "1",
			npm_config_yes: "true",
			HOMEBREW_NO_AUTO_UPDATE: "1",
			OMP_CONSOLE_OVERNIGHT: "1",
		});
		expect(plan.env.OMP_CONSOLE_ROOM_KEY).toBeUndefined();
		expect(plan.env.OMP_CONSOLE_WRITE_TOKEN).toBeUndefined();
	});

	it("uses the silent priority pair only for silent mode and leaves normal launches unwrapped", () => {
		const silent = buildWorkerLaunchPlan({ ...base, spec: { overnight: { askTimeoutSec: 60, quiet: "silent" } } });
		expect(silent.command.slice(0, 6)).toEqual(["/usr/sbin/taskpolicy", "-c", "background", "/usr/bin/nice", "-n", "15"]);

		const normal = buildWorkerLaunchPlan({ ...base, spec: { overnight: { askTimeoutSec: 60, quiet: "normal" } } });
		expect(normal.command[0]).toBe("bun");
		expect(normal.env.OMP_CONSOLE_OVERNIGHT).toBe("1");
	});

	it("uses Linux nice priorities and adds ionice only for silent mode when available", () => {
		// The Linux plan resolves nice from PATH; on a Windows test host that can be Git for Windows' nice.exe.
		const nice = Bun.which("nice") ?? "nice";
		const quiet = buildWorkerLaunchPlan({
			...base,
			platform: "linux",
			ioniceAvailable: false,
			spec: { overnight: { askTimeoutSec: 60, quiet: "quiet" } },
		});
		expect(quiet.command.slice(0, 5)).toEqual([nice, "-n", "10", "bun", "session-host.ts"]);

		const silent = buildWorkerLaunchPlan({
			...base,
			platform: "linux",
			ioniceAvailable: true,
			spec: { overnight: { askTimeoutSec: 60, quiet: "silent" } },
		});
		expect(silent.command.slice(0, 7)).toEqual(["ionice", "-c3", nice, "-n", "15", "bun", "session-host.ts"]);

		const silentWithoutIonice = buildWorkerLaunchPlan({
			...base,
			platform: "linux",
			ioniceAvailable: false,
			spec: { overnight: { askTimeoutSec: 60, quiet: "silent" } },
		});
		expect(silentWithoutIonice.command.slice(0, 5)).toEqual([nice, "-n", "15", "bun", "session-host.ts"]);
	});

	it("does not wrap Windows launches in POSIX priority tools", () => {
		const plan = buildWorkerLaunchPlan({ ...base, platform: "win32" });
		expect(plan.command).toEqual([
			"bun", "session-host.ts", "--cwd", "/work/project", "--relay", "ws://127.0.0.1:7481",
			"--room", "room-id", "--model", "stub/stub-model",
		]);
	});
});
