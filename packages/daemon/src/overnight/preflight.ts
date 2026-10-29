import type { PreflightCheck } from "@omp-console/protocol";
import * as path from "node:path";

export interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	spawnError?: string;
}

export interface CommandOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs: number;
}

export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export interface PreflightOptions {
	run?: CommandRunner;
	platform?: string;
	computerUseEnabled?: boolean | (() => Promise<boolean>);
	modelAvailability?: (model?: string) => Promise<{ available: boolean; detail: string }>;
	usageWindowPercent?: () => Promise<number | undefined>;
	activeOvernightCount?: () => number;
}

const COMMAND_TIMEOUT_MS = 4_000;
const GIT_REMOTE_TIMEOUT_MS = 15_000;
const TIMEOUT = Symbol("overnight-preflight-timeout");
const SYSTEM_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=8", GH_PROMPT_DISABLED: "1" };
const LINUX_POWER_PROBE = [
	"for dir in /sys/class/power_supply/*; do",
	"  [ -d \"$dir\" ] || continue",
	"  type=$(cat \"$dir/type\" 2>/dev/null || :)",
	"  online=$(cat \"$dir/online\" 2>/dev/null || :)",
	"  status=$(cat \"$dir/status\" 2>/dev/null || :)",
	"  capacity=$(cat \"$dir/capacity\" 2>/dev/null || :)",
	"  printf '%s\\t%s\\t%s\\t%s\\n' \"$type\" \"$online\" \"$status\" \"$capacity\"",
	"done",
].join("\n");

const defaultRunner: CommandRunner = async (command, args, options) => {
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn([command, ...args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: error instanceof Error ? error.message : String(error) };
	}
	const timeout = Promise.withResolvers<true>();
	const timer = setTimeout(() => timeout.resolve(true), options.timeoutMs);
	let timedOut = false;
	try {
		const result = await Promise.race([child.exited.then(exitCode => ({ exitCode })), timeout.promise.then(() => ({ exitCode: null }))]);
		timedOut = result.exitCode === null;
		if (timedOut) child.kill("SIGKILL");
		const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return { exitCode: timedOut ? null : result.exitCode, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
	}
};

function check(id: string, label: string, status: PreflightCheck["status"], detail: string, fix?: string): PreflightCheck {
	return { id, label, status, detail, ...(fix === undefined ? {} : { fix }) };
}

function commandText(result: CommandResult): string {
	return `${result.stdout}\n${result.stderr}`.trim();
}

function failText(result: CommandResult): string {
	if (result.timedOut) return "command timed out";
	if (result.spawnError) return result.spawnError;
	return commandText(result) || `command exited ${result.exitCode ?? "without a status"}`;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
	const timeout = Promise.withResolvers<typeof TIMEOUT>();
	const timer = setTimeout(() => timeout.resolve(TIMEOUT), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function run(options: PreflightOptions, command: string, args: readonly string[], cwd: string, timeoutMs = COMMAND_TIMEOUT_MS, env?: Record<string, string>): Promise<CommandResult> {
	try {
		const result = await bounded(
			(options.run ?? defaultRunner)(command, args, { cwd, timeoutMs, ...((env === undefined) ? {} : { env }) }),
			timeoutMs,
		);
		return result === TIMEOUT ? { exitCode: null, stdout: "", stderr: "", timedOut: true } : result;
	} catch (error) {
		return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: error instanceof Error ? error.message : String(error) };
	}
}

async function diskCheck(options: PreflightOptions, cwd: string): Promise<PreflightCheck> {
	const result = await run(options, "df", ["-Pk", cwd], cwd);
	if (result.exitCode !== 0) return check("disk", "Disk space", "warn", `Could not read free space: ${failText(result)}`);
	const lines = result.stdout.trim().split("\n");
	const availableKb = Number(lines.at(-1)?.trim().split(/\s+/)[3]);
	if (!Number.isFinite(availableKb)) return check("disk", "Disk space", "warn", "Could not parse available disk space.");
	const availableGb = availableKb / 1024 / 1024;
	if (availableGb < 2) return check("disk", "Disk space", "fail", `${availableGb.toFixed(1)} GB available; at least 2 GB is required.`);
	if (availableGb < 10) return check("disk", "Disk space", "warn", `${availableGb.toFixed(1)} GB available; below the recommended 10 GB.`);
	return check("disk", "Disk space", "ok", `${availableGb.toFixed(1)} GB available.`);
}

async function gitChecks(options: PreflightOptions, cwd: string): Promise<PreflightCheck[]> {
	const [root, status, remotes] = await Promise.all([
		run(options, "git", ["rev-parse", "--show-toplevel"], cwd),
		run(options, "git", ["status", "--short", "--branch"], cwd),
		run(options, "git", ["remote"], cwd),
	]);
	if (root.exitCode !== 0) return [
		check("git", "Git repository", "fail", `cwd is not a usable git repository: ${failText(root)}`),
		check("working-tree", "Working tree", "warn", "Skipped because cwd is not a git repository."),
		check("remote", "Git remote", "warn", "Skipped because cwd is not a git repository."),
	];
	const rows: PreflightCheck[] = [check("git", "Git repository", "ok", `Repository: ${root.stdout.trim()}`)];
	if (status.exitCode !== 0) rows.push(check("working-tree", "Working tree", "warn", `Could not read git status: ${failText(status)}`));
	else {
		const changes = status.stdout.split("\n").slice(1).filter(line => line.trim() !== "");
		rows.push(changes.length === 0
			? check("working-tree", "Working tree", "ok", "Working tree is clean.")
			: check("working-tree", "Working tree", "warn", `${changes.length} changed or untracked path(s) are present.`));
	}
	if (remotes.exitCode !== 0) {
		rows.push(check("remote", "Git remote", "warn", `Could not list git remotes: ${failText(remotes)}`));
		return rows;
	}
	const remoteNames = remotes.stdout.split("\n").map(value => value.trim()).filter(Boolean);
	const remote = remoteNames.includes("origin") ? "origin" : remoteNames[0];
	if (!remote) {
		rows.push(check("remote", "Git remote", "warn", "No git remote is configured."));
		return rows;
	}
	const reachable = await run(options, "git", ["ls-remote", "--exit-code", remote, "HEAD"], cwd, GIT_REMOTE_TIMEOUT_MS, SYSTEM_ENV);
	rows.push(reachable.exitCode === 0
		? check("remote", "Git remote", "ok", `${remote} is reachable non-interactively.`)
		: check("remote", "Git remote", "warn", `${remote} is not reachable non-interactively: ${failText(reachable)}`));
	return rows;
}

async function batteryCheck(options: PreflightOptions, cwd: string): Promise<PreflightCheck> {
	const platform = options.platform ?? process.platform;
	if (platform === "linux") {
		const result = await run(options, "sh", ["-c", LINUX_POWER_PROBE], cwd);
		if (result.exitCode !== 0) return check("power", "Power source", "warn", `Could not read Linux power status: ${failText(result)}`);
		const rows = result.stdout.trim().split("\n").map(line => line.split("\t")).filter(row => row.some(Boolean));
		const onAc = rows.some(([type, online]) =>
			(type?.toLowerCase() === "mains" || type?.toLowerCase() === "ac" || type?.toLowerCase() === "usb" || type?.toLowerCase() === "usb_c") &&
			online === "1",
		) || rows.some(([type, , status]) => type?.toLowerCase() === "battery" && /^(charging|full|not charging)$/i.test(status?.trim() ?? ""));
		if (onAc) return check("power", "Power source", "ok", "Connected to AC power.");
		const capacity = rows
			.filter(([type]) => type?.toLowerCase() === "battery")
			.map(([, , , value]) => Number(value))
			.find(value => Number.isFinite(value) && value >= 0 && value <= 100);
		if (capacity !== undefined) return check("power", "Power source", "warn", `Running on battery at ${capacity}%; connect power before starting an Overnight run.`);
		return check("power", "Power source", "warn", "Linux power status did not report an AC source or battery percentage.");
	}
	if (platform !== "darwin") return check("power", "Power source", "warn", "Power status is unavailable on this platform.");
	const result = await run(options, "pmset", ["-g", "batt"], cwd);
	if (result.exitCode !== 0) return check("power", "Power source", "warn", `Could not read battery status: ${failText(result)}`);
	const output = result.stdout;
	if (/AC Power/i.test(output)) return check("power", "Power source", "ok", "Connected to AC power.");
	const percent = Number(/(\d{1,3})%/.exec(output)?.[1]);
	if (!Number.isFinite(percent)) return check("power", "Power source", "warn", "Running on battery; battery percentage was unavailable.");
	if (percent < 20) return check("power", "Power source", "fail", `Running on battery at ${percent}%; connect power before starting an Overnight run.`);
	return check("power", "Power source", "warn", `Running on battery at ${percent}%; connect power before starting an Overnight run.`);
}

async function keepAwakeCheck(options: PreflightOptions, cwd: string): Promise<PreflightCheck> {
	// Take and release a real inhibitor: `--version` succeeds even where polkit denies the lock to this user.
	const result = await run(
		options,
		"systemd-inhibit",
		["--what=idle:sleep", "--who=omp-console", "--why=Overnight preflight", "--mode=block", "true"],
		cwd,
	);
	return result.exitCode === 0
		? check("keep-awake", "Keep awake", "ok", "systemd-inhibit can hold an idle/sleep lock.")
		: check("keep-awake", "Keep awake", "warn", `systemd-inhibit could not hold an idle/sleep lock; Overnight runs will continue without keep-awake protection: ${failText(result)}`);
}

function parseProbeBoolean(result: CommandResult): "true" | "false" | undefined {
	if (result.exitCode !== 0) return undefined;
	const value = result.stdout.trim().toLowerCase();
	return value === "true" || value === "false" ? value : undefined;
}

async function screenRecordingProbe(options: PreflightOptions, cwd: string): Promise<{ checked: boolean; result: CommandResult }> {
	const jxa = await run(options, "osascript", ["-l", "JavaScript", "-e", 'ObjC.import("CoreGraphics"); $.CGPreflightScreenCaptureAccess() ? "true" : "false"'], cwd);
	const jxaValue = parseProbeBoolean(jxa);
	if (jxaValue !== undefined) return { checked: true, result: { ...jxa, stdout: jxaValue } };

	const toolchain = await run(options, "xcode-select", ["-p"], cwd);
	if (toolchain.exitCode !== 0) {
		return {
			checked: false,
			result: { ...jxa, stderr: `${failText(jxa)}; no active Xcode toolchain: ${failText(toolchain)}` },
		};
	}

	const swift = await run(options, "swift", ["-e", 'import CoreGraphics; print(CGPreflightScreenCaptureAccess() ? "true" : "false")'], cwd);
	const swiftValue = parseProbeBoolean(swift);
	if (swiftValue !== undefined) return { checked: true, result: { ...swift, stdout: swiftValue } };
	return {
		checked: false,
		result: { ...swift, stderr: `JavaScript for Automation failed: ${failText(jxa)}; Swift probe failed: ${failText(swift)}` },
	};
}


async function permissionsCheck(options: PreflightOptions, cwd: string): Promise<PreflightCheck[]> {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return [check("computer-use", "Computer use", "warn", "Computer use is macOS-only and unavailable on this host.")];
	let enabled: boolean | typeof TIMEOUT;
	try {
		enabled = typeof options.computerUseEnabled === "function"
			? await bounded(Promise.resolve(options.computerUseEnabled()), COMMAND_TIMEOUT_MS)
			: options.computerUseEnabled ?? (platform === "darwin" && process.env.OMP_CONSOLE_COMPUTER_USE !== "0");
	} catch (error) {
		return [
			check("accessibility", "Accessibility", "warn", `Could not determine computer-use settings: ${String(error)}`),
			check("screen-recording", "Screen Recording", "warn", `Could not determine computer-use settings: ${String(error)}`),
		];
	}
	if (enabled === TIMEOUT) {
		return [
			check("accessibility", "Accessibility", "warn", "Computer-use settings check timed out."),
			check("screen-recording", "Screen Recording", "warn", "Computer-use settings check timed out."),
		];
	}
	if (!enabled) {
		return [
			check("accessibility", "Accessibility", "ok", "Computer use is disabled for workers."),
			check("screen-recording", "Screen Recording", "ok", "Computer use is disabled for workers."),
		];
	}
	const [accessibility, screenProbe] = await Promise.all([
		run(options, "osascript", ["-l", "JavaScript", "-e", 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted() ? "true" : "false"'], cwd),
		screenRecordingProbe(options, cwd),
	]);
	const screen = screenProbe.result;
	const fix = "System Settings → Privacy & Security";
	return [
		accessibility.exitCode === 0 && /true/i.test(accessibility.stdout)
			? check("accessibility", "Accessibility", "ok", "Accessibility permission is available.")
			: check("accessibility", "Accessibility", "fail", `Accessibility permission is unavailable: ${failText(accessibility)}`, `${fix} → Accessibility`),
		!screenProbe.checked
			? check("screen-recording", "Screen Recording", "warn", `Could not determine Screen Recording permission: ${failText(screen)}`, `${fix} → Screen Recording`)
			: screen.stdout === "true"
				? check("screen-recording", "Screen Recording", "ok", "Screen Recording permission is available.")
				: check("screen-recording", "Screen Recording", "fail", "Screen Recording permission is unavailable.", `${fix} → Screen Recording`),
	];
}

export async function runOvernightPreflight(cwd: string, options: PreflightOptions = {}): Promise<{ checks: PreflightCheck[] }> {
	if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
	const platform = options.platform ?? process.platform;
	const tasks: Array<Promise<PreflightCheck[]>> = [
		gitChecks(options, cwd),
		permissionsCheck(options, cwd),
		(async () => [await diskCheck(options, cwd)])(),
		(async () => [await batteryCheck(options, cwd)])(),
		(async () => [check("sleep", "Sleep behavior", platform === "darwin" ? "warn" : "ok", platform === "darwin"
			? "Closing the lid sleeps the Mac unless clamshell mode has external power and a display."
			: "The host's lid-close behavior is not checked on this platform.")])(),
		(async () => {
			if (platform !== "darwin") return [check("thermal", "Thermal state", "ok", platform === "linux" ? "Thermal state was not checked on Linux." : "Thermal state was not checked on this platform.")];
			const result = await run(options, "pmset", ["-g", "therm"], cwd);
			if (result.exitCode !== 0) return [check("thermal", "Thermal state", "warn", `Could not read thermal state: ${failText(result)}`)];
			const limit = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(result.stdout);
			if (limit && Number(limit[1]) < 100) return [check("thermal", "Thermal state", "warn", `CPU speed limit is ${limit[1]}%.`)];
			return [check("thermal", "Thermal state", "ok", "No CPU speed limit below 100% was reported.")];
		})(),
		...(platform === "linux"
			? [(async () => [await keepAwakeCheck(options, cwd)])()]
			: platform === "win32"
				? [(async () => [check("keep-awake", "Keep awake", "warn", "Keep-awake is unavailable on Windows; Overnight runs continue without keep-awake protection.")])()]
				: []),
		(async () => {
			const result = await run(options, "gh", ["auth", "status"], cwd, COMMAND_TIMEOUT_MS, { GH_PROMPT_DISABLED: "1" });
			if (result.spawnError?.includes("No such file") || result.spawnError?.includes("not found")) return [check("gh-auth", "GitHub CLI auth", "ok", "gh is not installed; this check is optional.")];
			return [result.exitCode === 0
				? check("gh-auth", "GitHub CLI auth", "ok", "gh auth status succeeded.")
				: check("gh-auth", "GitHub CLI auth", "warn", `gh auth status failed: ${failText(result)}`)];
		})(),
		(async () => {
			const result = await run(options, "sudo", ["-n", "true"], cwd);
			return [result.exitCode === 0
				? check("sudo", "Admin access", "ok", "Admin access is available without a prompt.")
				: check("sudo", "Admin access", "warn", "No admin access; tasks that need it will be blocked.")];
		})(),
		(async () => {
			if (!options.modelAvailability) return [check("model", "Model authentication", "warn", "Daemon model-authentication status is unavailable.")];
			try {
				const result = await bounded(options.modelAvailability(), COMMAND_TIMEOUT_MS);
				if (result === TIMEOUT) return [check("model", "Model authentication", "warn", "Model-authentication check timed out.")];
				return [check("model", "Model authentication", result.available ? "ok" : "warn", result.detail)];
			} catch (error) {
				return [check("model", "Model authentication", "warn", `Could not read model-authentication status: ${String(error)}`)];
			}
		})(),
		(async () => {
			if (!options.usageWindowPercent) return [check("usage", "Usage window", "ok", "No current usage report is available.")];
			try {
				const usedPct = await bounded(options.usageWindowPercent(), COMMAND_TIMEOUT_MS);
				if (usedPct === TIMEOUT) return [check("usage", "Usage window", "warn", "Usage-window check timed out.")];
				if (usedPct === undefined) return [check("usage", "Usage window", "ok", "No current usage report is available.")];
				return [usedPct > 60
					? check("usage", "Usage window", "warn", `Current usage window is ${usedPct.toFixed(1)}% used.`)
					: check("usage", "Usage window", "ok", `Current usage window is ${usedPct.toFixed(1)}% used.`)];
			} catch (error) {
				return [check("usage", "Usage window", "warn", `Could not read usage status: ${String(error)}`)];
			}
		})(),
		(async () => {
			const count = options.activeOvernightCount?.() ?? 0;
			return [check("active-overnight", "Other Overnight runs", "ok", count === 1 ? "1 other Overnight run is active." : `${count} other Overnight runs are active.`)];
		})(),
	];
	const checks = (await Promise.all(tasks)).flat();
	return { checks };
}
