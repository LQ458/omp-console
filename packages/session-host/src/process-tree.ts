/**
 * Descendant process bookkeeping for shutdown. A worker owns the shells, language servers and MCP stdio
 * servers its session spawned; a graceful stop disposes them, this is the backstop that leaves no orphan if
 * one survives (a shell that ignored the abort, a server whose parent handle was lost).
 */
import { logger } from "@oh-my-pi/pi-utils";

/** Map of pid -> ppid for every process visible to the user. Empty when `ps` is unavailable. */
export function readParentMap(): Map<number, number> {
	const map = new Map<number, number>();
	try {
		const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
		if (!result.success) return map;
		for (const line of result.stdout.toString().split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
			if (match) map.set(Number(match[1]), Number(match[2]));
		}
	} catch (error) {
		logger.debug("process scan failed", { error: String(error) });
	}
	return map;
}

/** All transitive children of `rootPid`, deepest first so a parent is never killed before its children. */
export function descendantPids(rootPid: number, parents: Map<number, number> = readParentMap()): number[] {
	const children = new Map<number, number[]>();
	for (const [pid, ppid] of parents) {
		const siblings = children.get(ppid) ?? [];
		siblings.push(pid);
		children.set(ppid, siblings);
	}
	const ordered: number[] = [];
	const visit = (pid: number): void => {
		for (const child of children.get(pid) ?? []) {
			visit(child);
			ordered.push(child);
		}
	};
	visit(rootPid);
	return ordered;
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
	for (const pid of pids) {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone, or not ours to signal
		}
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** SIGTERM every descendant, wait briefly, SIGKILL survivors. Returns the pids that needed SIGKILL. */
export async function killDescendants(rootPid: number, graceMs = 300): Promise<number[]> {
	const pids = descendantPids(rootPid);
	if (pids.length === 0) return [];
	signalAll(pids, "SIGTERM");
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && pids.some(alive)) await Bun.sleep(25);
	const survivors = pids.filter(alive);
	signalAll(survivors, "SIGKILL");
	return survivors;
}

/** Synchronous variant for the exit watchdog, where awaiting is not an option. */
export function killDescendantsNow(rootPid: number): void {
	signalAll(descendantPids(rootPid), "SIGKILL");
}
