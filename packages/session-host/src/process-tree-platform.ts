import { logger } from "@oh-my-pi/pi-utils";

export interface ProcessEntry {
	pid: number;
	parentPid: number;
	commandLine: string;
	/** Creation time in ms (Windows only); a parent id is stale when the "parent" started after the child. */
	createdAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Snapshot visible process ids, parent ids, and command lines for tree cleanup and test probes. */
export function readProcessEntries(): ProcessEntry[] {
	try {
		if (process.platform === "win32") {
			const powershell = Bun.which("powershell.exe") ?? "powershell.exe";
			const result = Bun.spawnSync(
				[
					powershell,
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{n='Created';e={ if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } }} | ConvertTo-Json -Compress",
				],
				{ stdout: "pipe", stderr: "ignore", windowsHide: true },
			);
			if (!result.success) return [];
			const parsed: unknown = JSON.parse(result.stdout.toString());
			const rows = Array.isArray(parsed) ? parsed : [parsed];
			const entries: ProcessEntry[] = [];
			for (const row of rows) {
				if (!isRecord(row) || typeof row.ProcessId !== "number" || typeof row.ParentProcessId !== "number") continue;
				entries.push({
					pid: row.ProcessId,
					parentPid: row.ParentProcessId,
					commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "",
					...(typeof row.Created === "number" ? { createdAt: row.Created } : {}),
				});
			}
			return entries;
		}

		const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="], {
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
		});
		if (!result.success) return [];
		const entries: ProcessEntry[] = [];
		for (const line of result.stdout.toString().split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			if (match) entries.push({ pid: Number(match[1]), parentPid: Number(match[2]), commandLine: match[3] ?? "" });
		}
		return entries;
	} catch (error) {
		logger.debug("process snapshot failed", { error: String(error) });
		return [];
	}
}

function taskkillTree(pid: number): void {
	try {
		const taskkill = Bun.which("taskkill.exe") ?? "taskkill.exe";
		Bun.spawnSync([taskkill, "/PID", String(pid), "/T", "/F"], {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
	} catch (error) {
		logger.debug("taskkill failed", { pid, error: String(error) });
	}
}

/** Terminate a process and its complete child tree on Windows. */
export function killWindowsProcessTree(pid: number): void {
	if (process.platform === "win32") taskkillTree(pid);
}

/** Force-terminate one process and its complete child tree on every supported host. */
export function killProcessTreeNow(pid: number): void {
	if (process.platform === "win32") {
		taskkillTree(pid);
		return;
	}
	const entries = readProcessEntries();
	const children = new Map<number, number[]>();
	for (const entry of entries) {
		const siblings = children.get(entry.parentPid) ?? [];
		siblings.push(entry.pid);
		children.set(entry.parentPid, siblings);
	}
	const descendants: number[] = [];
	const visited = new Set<number>([pid]);
	const visit = (parentPid: number): void => {
		for (const childPid of children.get(parentPid) ?? []) {
			if (visited.has(childPid)) continue;
			visited.add(childPid);
			visit(childPid);
			descendants.push(childPid);
		}
	};
	visit(pid);
	for (const childPid of [...descendants, pid]) {
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// already gone, or not ours to signal
		}
	}
}

/** Kill the trees rooted at newly spawned descendants matching a caller-owned predicate on Windows. */
export function killNewMatchingChildrenNow(
	rootPid: number,
	knownPids: ReadonlySet<number>,
	matches: (entry: ProcessEntry) => boolean,
): void {
	if (process.platform !== "win32") return;
	const entries = readProcessEntries();
	const byPid = new Map(entries.map(entry => [entry.pid, entry]));
	const processes = new Set<number>();
	for (const entry of entries) {
		if (knownPids.has(entry.pid) || !matches(entry)) continue;
		let ancestor = entry;
		const visited = new Set<number>();
		while (ancestor.parentPid !== rootPid && !visited.has(ancestor.pid)) {
			visited.add(ancestor.pid);
			const parent = byPid.get(ancestor.parentPid);
			if (!parent) break;
			ancestor = parent;
		}
		if (ancestor.parentPid === rootPid) processes.add(entry.pid);
	}
	for (const pid of processes) taskkillTree(pid);
}
