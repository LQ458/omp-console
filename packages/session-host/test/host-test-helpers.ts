import { descendantPids } from "../src/process-tree";
import { readProcessEntries } from "../src/process-tree-platform";

/** Clone a local test repository with LF worktrees before checkout, independent of the host Git config. */
export function cloneGitRepositoryWithAutocrlfOff(sourceRoot: string, target: string): void {
	const result = Bun.spawnSync(["git", "clone", "--local", "-c", "core.autocrlf=false", sourceRoot, target], {
		stdout: "ignore",
		stderr: "pipe",
		windowsHide: true,
	});
	if (!result.success) throw new Error(`git clone failed: ${result.stderr.toString()}`);
}

/** Matching pids in one worker's descendant tree. */
export function childPidsMatching(rootPid: number, needle: string): number[] {
	const entries = readProcessEntries();
	const parents = new Map(entries.map(entry => [entry.pid, entry.parentPid]));
	const descendants = new Set(descendantPids(rootPid, parents));
	return entries.filter(entry => descendants.has(entry.pid) && entry.commandLine.includes(needle)).map(entry => entry.pid);
}
