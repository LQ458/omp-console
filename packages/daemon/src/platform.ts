import { readdirSync, writeFileSync, type Stats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const isWindows = process.platform === "win32";

/** Returns the POSIX privacy failure for a private 0600 file, or undefined when the file is safe. */
export function privateFileProblem(stat: Stats): string | undefined {
	if (!stat.isFile() || stat.isSymbolicLink()) return "must be a regular file";
	if (isWindows) return undefined;
	const uid = process.getuid?.();
	if (uid === undefined || stat.uid !== uid) return "must be owned by the daemon user";
	if ((stat.mode & 0o7777) !== 0o600) return "must have mode 0600";
	return undefined;
}

/** Opens a URL with the host's registered browser without invoking a shell. */
export function openUrl(url: string): boolean {
	const command = isWindows
		? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
		: process.platform === "darwin"
			? ["open", url]
			: process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
				? ["xdg-open", url]
				: undefined;
	if (!command) return false;
	try {
		return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

/** Finds an installed executable across PATH and the standard user install locations. */
export function findExecutable(name: string): string | undefined {
	const home = os.homedir();
	const directories = [...(process.env.PATH ?? "").split(path.delimiter), path.join(home, ".bun", "bin"), path.join(home, ".local", "bin")];
	const searchPath = [...new Set(directories.filter(Boolean))].join(path.delimiter);
	if (isWindows) {
		return Bun.which(`${name}.exe`, { PATH: searchPath }) ??
			Bun.which(`${name}.cmd`, { PATH: searchPath }) ??
			Bun.which(name, { PATH: searchPath }) ?? undefined;
	}
	return Bun.which(name, { PATH: searchPath }) ?? undefined;
}

/** Location appended by the Windows daemon runner. */
export function windowsLogFile(): string {
	const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
	return path.join(localAppData, "omp-console", "logs", "daemon.log");
}

function system32(executable: string): string {
	return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", executable);
}

function runIcacls(args: readonly string[]): void {
	const result = Bun.spawnSync([system32("icacls.exe"), ...args], { stdout: "ignore", stderr: "ignore", windowsHide: true });
	if (result.exitCode !== 0) {
		throw new Error(`could not make the state folder private (icacls ${args.slice(1).join(" ")}: exit ${result.exitCode})`);
	}
}

/** Marks a folder the daemon owns; with any of the daemon's own files it lets an existing folder be secured. */
const STATE_MARKER = ".omp-console-state";
const STATE_FILES = [STATE_MARKER, "env", "windows-service.json", "devices.json", "hosted-sessions.json", "live-sessions.json", "vapid-keys.json", "pairing-code", "config.json"];

/**
 * Windows has no 0600/0700 modes, so the daemon's private files rely on the state folder's ACL. The installer sets it,
 * but a daemon started any other way (plain mode, a custom --state-dir on a shared drive) must not trust an inherited
 * ACL: the folder gets explicit full-control entries for the current user and SYSTEM only, stops inheriting, and its
 * contents are reset to inherit just those. Failing to do so stops the daemon (fail closed).
 *
 * The reset is recursive, so it only runs on a folder that is empty or already holds omp-console state (never on a
 * mistyped --state-dir such as the profile or a drive root), and /L acts on links themselves instead of their targets.
 */
export function secureWindowsStateDirectory(stateDir: string): void {
	const entries = readdirSync(stateDir);
	// The marker is written only after a successful pass; the folder stays private and new files inherit its entries,
	// so later starts skip the (slow, recursive) icacls work. The installer redoes it on every install.
	if (entries.includes(STATE_MARKER)) return;
	if (entries.length > 0 && !STATE_FILES.some(name => entries.includes(name))) {
		throw new Error(`refusing to use ${stateDir} as the state folder: it is not empty and holds no omp-console state`);
	}
	const sidResult = Bun.spawnSync([system32("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
	const sid = /"(S-1-[0-9-]+)"/.exec(sidResult.stdout.toString())?.[1];
	if (sidResult.exitCode !== 0 || !sid) throw new Error("could not make the state folder private (current user SID unavailable)");
	runIcacls([stateDir, "/reset", "/Q"]);
	runIcacls([stateDir, "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/Q"]);
	runIcacls([stateDir, "/inheritance:r", "/Q"]);
	if (entries.length > 0) runIcacls([path.join(stateDir, "*"), "/reset", "/T", "/C", "/L", "/Q"]);
	writeFileSync(path.join(stateDir, STATE_MARKER), "omp-console state folder\n");
}

/** Returns whether the daemon can expose omp-console computer-use tools on a host platform. */
export function computerUseSupported(platform: string): boolean {
	return platform === "darwin";
}
