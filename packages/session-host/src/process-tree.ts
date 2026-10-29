/**
 * Descendant process bookkeeping for shutdown. A worker owns the shells, language servers and MCP stdio
 * servers its session spawned; a graceful stop disposes them, this is the backstop that leaves no orphan if
 * one survives (a shell that ignored the abort, a server whose parent handle was lost).
 */
import { logger } from "@oh-my-pi/pi-utils";
import { killWindowsProcessTree, readProcessEntries } from "./process-tree-platform";

function killDirectChildren(rootPid: number, parents: Map<number, number>): void {
	for (const [pid, parentPid] of parents) {
		if (parentPid === rootPid) killWindowsProcessTree(pid);
	}
}

/** Map of pid -> ppid for every visible process. Empty when enumeration is unavailable. */
export function readParentMap(): Map<number, number> {
	const map = new Map<number, number>();
	if (process.platform === "win32") {
		// Windows keeps a dead parent's id in ParentProcessId and reuses ids, so a recorded parent may be a newer,
		// unrelated process (and even a descendant, forming a cycle). An edge whose parent started after the child is
		// stale and is dropped, so a tree kill never reaches processes the worker did not start.
		const entries = readProcessEntries();
		const createdAt = new Map(entries.map(entry => [entry.pid, entry.createdAt]));
		for (const entry of entries) {
			const parentCreated = createdAt.get(entry.parentPid);
			if (entry.createdAt !== undefined && parentCreated !== undefined && parentCreated > entry.createdAt) continue;
			map.set(entry.pid, entry.parentPid);
		}
		return map;
	}
	try {
		const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
		});
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
	// A visited set keeps a malformed snapshot (a cycle, or Windows' pid 0 listing itself as its parent) from recursing forever.
	const visited = new Set<number>([rootPid]);
	const visit = (pid: number): void => {
		for (const child of children.get(pid) ?? []) {
			if (visited.has(child)) continue;
			visited.add(child);
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
	const parents = readParentMap();
	const pids = descendantPids(rootPid, parents);
	if (process.platform === "win32") {
		killDirectChildren(rootPid, parents);
		return pids;
	}
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
	if (process.platform === "win32") {
		killDirectChildren(rootPid, readParentMap());
		return;
	}
	signalAll(descendantPids(rootPid), "SIGKILL");
}
