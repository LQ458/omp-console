import { describe, expect, it } from "bun:test";
import type { CommandOptions, CommandResult } from "../src/overnight/preflight";
import type { PreflightCheck } from "@omp-console/protocol";
import { runOvernightPreflight } from "../src/overnight/preflight";

interface Call {
	command: string;
	args: readonly string[];
	options: CommandOptions;
}

function result(exitCode: number, stdout = "", stderr = ""): CommandResult {
	return { exitCode, stdout, stderr, timedOut: false };
}

function checksById(checks: PreflightCheck[]): Map<string, PreflightCheck> {
	return new Map(checks.map(item => [item.id, item]));
}
describe("overnight preflight", () => {
	it("reports low battery, missing remote, no sudo and missing computer-use permissions without prompting", async () => {
		const calls: Call[] = [];
		const preflight = await runOvernightPreflight("/tmp/project", {
			platform: "darwin",
			computerUseEnabled: true,
			run: async (command, args, options) => {
				calls.push({ command, args, options });
				if (command === "git" && args[0] === "rev-parse") return result(0, "/tmp/project\n");
				if (command === "git" && args[0] === "status") return result(0, "## main\n M src/file.ts\n");
				if (command === "git" && args[0] === "remote") return result(0, "");
				if (command === "df") return result(0, "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100000000 50000000 50000000 50% /\n");
				if (command === "pmset" && args[1] === "batt") return result(0, "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123): 15%; discharging; 2:30 remaining\n");
				if (command === "pmset" && args[1] === "therm") return result(0, "CPU_Speed_Limit = 80\n");
				if (command === "osascript") return result(0, "false\n");
				if (command === "sudo") return result(1, "", "a password is required");
				if (command === "gh") return result(0, "");
				throw new Error(`unexpected command ${command} ${args.join(" ")}`);
			},
		});
		const checks = checksById(preflight.checks);

		expect(checks.get("power")?.status).toBe("fail");
		expect(checks.get("remote")?.detail).toContain("No git remote");
		expect(checks.get("working-tree")?.status).toBe("warn");
		expect(checks.get("sudo")?.detail).toContain("No admin access");
		expect(checks.get("accessibility")?.status).toBe("fail");
		expect(checks.get("screen-recording")?.status).toBe("fail");
		expect(checks.get("thermal")?.status).toBe("warn");
		expect(calls.some(call => call.command === "git" && call.args[0] === "ls-remote")).toBe(false);
		expect(calls.some(call => call.command === "sudo" && call.args.join(" ") === "-n true")).toBe(true);
		expect(calls.find(call => call.command === "osascript" && call.args.at(-1)?.includes("ApplicationServices"))?.options.timeoutMs).toBe(4_000);
	});

	it("uses the non-interactive Swift probe when JavaScript for Automation cannot bind CoreGraphics", async () => {
		const preflight = await runOvernightPreflight("/tmp/project", {
			platform: "darwin",
			computerUseEnabled: true,
			run: async (command, args) => {
				if (command === "git" && args[0] === "rev-parse") return result(0, "/tmp/project\n");
				if (command === "git" && args[0] === "status") return result(0, "## main\n");
				if (command === "git" && args[0] === "remote") return result(0, "");
				if (command === "df") return result(0, "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100000000 50000000 50000000 50% /\n");
				if (command === "pmset" && args[1] === "batt") return result(0, "Now drawing from 'AC Power'\n");
				if (command === "pmset" && args[1] === "therm") return result(0, "CPU_Speed_Limit = 100\n");
				if (command === "osascript") {
					return args.at(-1)?.includes("ApplicationServices")
						? result(0, "true\n")
						: result(1, "", "CGPreflightScreenCaptureAccess is not a function");
				}
				if (command === "xcode-select") return result(0, "/Applications/Xcode.app/Contents/Developer\n");
				if (command === "swift") return result(0, "true\n");
				if (command === "sudo" || command === "gh") return result(0, "");
				throw new Error(`unexpected command ${command} ${args.join(" ")}`);
			},
		});

		expect(checksById(preflight.checks).get("screen-recording")?.status).toBe("ok");
	});


	it("uses non-interactive remote settings and marks AC power as ready", async () => {
		const calls: Call[] = [];
		const preflight = await runOvernightPreflight("/tmp/project", {
			platform: "darwin",
			computerUseEnabled: false,
			run: async (command, args, options) => {
				calls.push({ command, args, options });
				if (command === "git" && args[0] === "rev-parse") return result(0, "/tmp/project\n");
				if (command === "git" && args[0] === "status") return result(0, "## main\n");
				if (command === "git" && args[0] === "remote") return result(0, "origin\n");
				if (command === "git" && args[0] === "ls-remote") return result(128, "", "could not read from remote");
				if (command === "df") return result(0, "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100000000 50000000 50000000 50% /\n");
				if (command === "pmset" && args[1] === "batt") return result(0, "Now drawing from 'AC Power'\n");
				if (command === "pmset" && args[1] === "therm") return result(0, "CPU_Speed_Limit = 100\n");
				if (command === "gh") return result(0, "");
				if (command === "sudo") return result(0, "");
				throw new Error(`unexpected command ${command} ${args.join(" ")}`);
			},
		});
		const checks = checksById(preflight.checks);
		const remote = calls.find(call => call.command === "git" && call.args[0] === "ls-remote");

		expect(checks.get("power")?.status).toBe("ok");
		expect(checks.get("remote")?.status).toBe("warn");
		expect(remote?.args).toEqual(["ls-remote", "--exit-code", "origin", "HEAD"]);
		expect(remote?.options.timeoutMs).toBe(15_000);
		expect(remote?.options.env).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=8",
			GH_PROMPT_DISABLED: "1",
		});
		expect(checks.get("accessibility")?.status).toBe("ok");
	});
	it("uses Linux power files, skips macOS permission probes, and checks systemd-inhibit", async () => {
		const calls: Call[] = [];
		const preflight = await runOvernightPreflight("/tmp/project", {
			platform: "linux",
			computerUseEnabled: true,
			run: async (command, args, options) => {
				calls.push({ command, args, options });
				if (command === "git" && args[0] === "rev-parse") return result(0, "/tmp/project\n");
				if (command === "git" && args[0] === "status") return result(0, "## main\n");
				if (command === "git" && args[0] === "remote") return result(0, "");
				if (command === "df") return result(0, "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 100000000 50000000 50000000 50% /\n");
				if (command === "sh") return result(0, "Mains\t1\t\t\n");
				if (command === "systemd-inhibit") return args.at(-1) === "true" ? result(0) : result(2, "", "unexpected args");
				if (command === "gh") return { ...result(127), spawnError: "not found" };
				if (command === "sudo") return result(1, "", "not allowed");
				throw new Error(`unexpected command ${command} ${args.join(" ")}`);
			},
		});
		const checks = checksById(preflight.checks);

		expect(checks.get("power")?.status).toBe("ok");
		expect(checks.get("thermal")?.detail).toContain("not checked on Linux");
		expect(checks.get("computer-use")?.detail).toContain("macOS-only");
		expect(checks.get("keep-awake")?.status).toBe("ok");
		expect(calls.some(call => call.command === "osascript" || call.command === "pmset")).toBe(false);
	});
	it("on Linux, a discharging battery is not AC power and a denied inhibitor is a warning", async () => {
		const preflight = await runOvernightPreflight("/tmp/project", {
			platform: "linux",
			run: async (command, args) => {
				if (command === "git" && args[0] === "rev-parse") return result(0, "/tmp/project\n");
				if (command === "git" && args[0] === "status") return result(0, "## main\n");
				if (command === "git" && args[0] === "remote") return result(0, "");
				if (command === "df") return result(0, "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 100000000 50000000 50000000 50% /\n");
				if (command === "sh") return result(0, "Battery\t\tDischarging\t17\n");
				if (command === "systemd-inhibit") return result(1, "", "Failed to inhibit: Access denied");
				if (command === "gh") return { ...result(127), spawnError: "not found" };
				if (command === "sudo") return result(1, "", "not allowed");
				throw new Error(`unexpected command ${command} ${args.join(" ")}`);
			},
		});
		const checks = checksById(preflight.checks);
		expect(checks.get("power")).toMatchObject({ status: "warn" });
		expect(checks.get("power")?.detail).toContain("17%");
		expect(checks.get("keep-awake")).toMatchObject({ status: "warn" });
		expect(checks.get("keep-awake")?.detail).toContain("Access denied");
	});
});
