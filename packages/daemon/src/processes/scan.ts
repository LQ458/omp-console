import type { ProcessInfo, SessionSummary, WorkerHealth } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyProcess } from "./classify";

const COMMAND_TIMEOUT_MS = 2_000;

type ProcessKind = ProcessInfo["kind"];

export interface PsProcess {
	pid: number;
	ppid: number;
	startedAt: number;
	rssBytes: number;
	tty: string;
	command: string;
}

export interface LsofProcessFiles {
	cwd?: string;
	sessionFiles: string[];
}

export interface ProcessScanSources {
	readPs?: () => Promise<string>;
	readLsof?: (pids: readonly number[]) => Promise<string>;
	statMtime?: (filePath: string) => Promise<number | undefined>;
}

function parsePositiveInteger(value: string): number | undefined {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function parsePsOutput(output: string): PsProcess[] {
	const processes: PsProcess[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const columns = trimmed.split(/\s+/);
		if (columns.length < 10) continue;
		const pid = parsePositiveInteger(columns[0]!);
		const ppid = Number(columns[1]);
		const rssKb = Number(columns[7]);
		if (pid === undefined || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isFinite(rssKb) || rssKb < 0) continue;
		const startedAt = Date.parse(columns.slice(2, 7).join(" "));
		if (!Number.isFinite(startedAt)) continue;
		processes.push({
			pid,
			ppid,
			startedAt,
			rssBytes: Math.trunc(rssKb * 1024),
			tty: columns[8]!,
			command: columns.slice(9).join(" "),
		});
	}
	return processes;
}

/** Parses the Windows CIM process snapshot; process-file handles are unavailable on Windows. */
export function parseWin32ProcessOutput(output: string): PsProcess[] {
	if (output.trim() === "") return [];
	const parsed: unknown = JSON.parse(output);
	const values = Array.isArray(parsed) ? parsed : [parsed];
	const processes: PsProcess[] = [];
	for (const value of values) {
		if (typeof value !== "object" || value === null) continue;
		const row = value as {
			ProcessId?: unknown;
			ParentProcessId?: unknown;
			WorkingSetSize?: unknown;
			CommandLine?: unknown;
			CreationDate?: unknown;
		};
		const pid = parsePositiveInteger(String(row.ProcessId ?? ""));
		const ppid = Number(row.ParentProcessId);
		const rssBytes = Number(row.WorkingSetSize);
		if (pid === undefined || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(rssBytes) || rssBytes < 0) continue;
		const startedAt = typeof row.CreationDate === "string" ? Date.parse(row.CreationDate) : 0;
		processes.push({
			pid,
			ppid,
			startedAt: Number.isFinite(startedAt) ? startedAt : 0,
			rssBytes,
			tty: "??",
			command: typeof row.CommandLine === "string" ? row.CommandLine : "",
		});
	}
	return processes;
}

export function parseLsofOutput(output: string): Map<number, LsofProcessFiles> {
	const result = new Map<number, LsofProcessFiles>();
	let pid: number | undefined;
	let descriptor = "";
	for (const line of output.split("\n")) {
		if (!line) continue;
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			pid = parsePositiveInteger(value);
			if (pid !== undefined && !result.has(pid)) result.set(pid, { sessionFiles: [] });
			continue;
		}
		if (field === "f") {
			descriptor = value;
			continue;
		}
		if (field !== "n" || pid === undefined) continue;
		const processFiles = result.get(pid);
		if (!processFiles) continue;
		if (descriptor === "cwd") processFiles.cwd = value;
		else if (value.endsWith(".jsonl")) processFiles.sessionFiles.push(value);
	}
	return result;
}

function commandKind(command: string): ProcessKind | undefined {
	const lower = process.platform === "win32" ? command.toLowerCase().replaceAll("\\", "/") : command.toLowerCase();
	if (lower.includes("daemon_broker")) return "omp-broker";
	if (lower.includes("lsp_mux")) return "omp-lsp";
	if (lower.includes("__omp_worker_js_eval") || lower.includes("__omp_worker_eval")) return "omp-eval";
	if (lower.includes("__omp_worker_tab") || lower.includes("browser-worker") || lower.includes("omp-browser")) return "omp-browser";
	if (lower.includes("text-predict") || lower.includes("text_predict")) return "omp-helper";
	if (lower.includes("packages/session-host/src/main") || lower.includes("omp-console-worker")) return "omp-console-worker";
	if (lower.includes("packages/daemon/src/main") || lower.includes("omp-console-daemon")) return "omp-console-daemon";
	const firstToken = command.trim().split(/\s+/, 1)[0] ?? "";
	if (path.basename(firstToken).toLowerCase() === "omp" || lower.includes("packages/coding-agent/src/cli") || lower.includes("packages/coding-agent/dist/cli")) {
		return "omp-terminal";
	}
	return undefined;
}

function descendantOf(pid: number, workerPids: ReadonlySet<number>, parentByPid: ReadonlyMap<number, number>): boolean {
	const seen = new Set<number>();
	let parent = parentByPid.get(pid);
	while (parent !== undefined && !seen.has(parent)) {
		if (workerPids.has(parent)) return true;
		seen.add(parent);
		parent = parentByPid.get(parent);
	}
	return false;
}

export function sumProcessTreeRss(processes: readonly PsProcess[], rootPid: number): number {
	const children = new Map<number, number[]>();
	for (const process of processes) {
		const list = children.get(process.ppid) ?? [];
		list.push(process.pid);
		children.set(process.ppid, list);
	}
	const byPid = new Map(processes.map(process => [process.pid, process]));
	const pending = [rootPid];
	const visited = new Set<number>();
	let total = 0;
	while (pending.length > 0) {
		const pid = pending.pop()!;
		if (visited.has(pid)) continue;
		visited.add(pid);
		total += byPid.get(pid)?.rssBytes ?? 0;
		for (const child of children.get(pid) ?? []) pending.push(child);
	}
	return total;
}

async function readCommand(command: string[]): Promise<string> {
	const child = Bun.spawn(command, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
		windowsHide: process.platform === "win32",
	});
	const output = new Response(child.stdout).text();
	const exitCode = await child.exited;
	const text = await output;
	if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}`);
	return text;
}

async function defaultReadPs(): Promise<string> {
	if (process.platform === "win32") {
		return readCommand([
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine,CreationDate | ConvertTo-Json -Compress",
		]);
	}
	return readCommand(["ps", "-axo", "pid,ppid,lstart,rss,tty,command"]);
}

async function defaultReadLsof(pids: readonly number[]): Promise<string> {
	if (pids.length === 0 || process.platform === "win32") return "";
	return readCommand(["lsof", "-p", pids.join(","), "-Fpcfn"]);
}

async function defaultStatMtime(filePath: string): Promise<number | undefined> {
	try {
		return (await fs.stat(filePath)).mtimeMs;
	} catch {
		return undefined;
	}
}

export async function scanOmpProcesses(
	workers: readonly WorkerHealth[],
	sessions: readonly SessionSummary[],
	now = Date.now(),
	sources: ProcessScanSources = {},
	/** pid → start time of children of omp-console workers seen earlier; a reused pid (other start time) is not tracked. */
	trackedPids: ReadonlyMap<number, number> = new Map(),
): Promise<ProcessInfo[]> {
	const rows = process.platform === "win32" ? parseWin32ProcessOutput(await (sources.readPs ?? defaultReadPs)()) : parsePsOutput(await (sources.readPs ?? defaultReadPs)());
	const parentByPid = new Map(rows.map(row => [row.pid, row.ppid]));
	const workerByPid = new Map(workers.filter(worker => worker.pid > 0).map(worker => [worker.pid, worker]));
	const workerPids = new Set(workerByPid.keys());
	const sessionById = new Map(sessions.map(session => [session.id, session]));
	const candidates: Array<{ row: PsProcess; kind: ProcessKind; worker?: WorkerHealth }> = [];
	for (const row of rows) {
		const worker = workerByPid.get(row.pid);
		const descendant = descendantOf(row.pid, workerPids, parentByPid);
		const kind = worker ? "omp-console-worker" : commandKind(row.command) ?? (descendant || trackedPids.get(row.pid) === row.startedAt ? "omp-helper" : undefined);
		if (kind) candidates.push({ row, kind, ...(worker ? { worker } : {}) });
	}
	const lsofOutput = await (sources.readLsof ?? defaultReadLsof)(candidates.map(candidate => candidate.row.pid)).catch(() => "");
	const openFiles = parseLsofOutput(lsofOutput);
	const statMtime = sources.statMtime ?? defaultStatMtime;
	const results: ProcessInfo[] = [];
	for (const { row, kind, worker } of candidates) {
		const details = openFiles.get(row.pid);
		const session = worker ? sessionById.get(worker.sessionId) : undefined;
		const sessionFile = session?.sessionFile ?? details?.sessionFiles[0];
		const sessionId = worker?.sessionId ?? (sessionFile ? path.basename(sessionFile, ".jsonl") : undefined);
		const lastSessionWriteAt = sessionFile ? await statMtime(sessionFile) : undefined;
		const base: ProcessInfo = {
			pid: row.pid,
			ppid: row.ppid,
			kind,
			command: row.command,
			startedAt: row.startedAt,
			rssBytes: sumProcessTreeRss(rows, row.pid),
			state: "idle",
			...(details?.cwd === undefined && session?.cwd === undefined ? {} : { cwd: details?.cwd ?? session?.cwd }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(sessionFile === undefined ? {} : { sessionFile }),
			...(lastSessionWriteAt === undefined ? {} : { lastSessionWriteAt }),
		};
		results.push(classifyProcess(base, now, { workerState: worker?.state }));
	}
	return results;
}

export class ProcessScanner {
	readonly #sources: ProcessScanSources;
	/** Worker pid → its children as pid → start time, so a pid reused by an unrelated process is never mistaken for one. */
	readonly #workerChildren = new Map<number, Map<number, number>>();
	readonly #deadWorkers = new Map<number, { since: number; children: Map<number, number> }>();

	constructor(sources: ProcessScanSources = {}) {
		this.#sources = sources;
	}

	async scan(workers: readonly WorkerHealth[], sessions: readonly SessionSummary[], now = Date.now()): Promise<ProcessInfo[]> {
		const trackedPids = new Map<number, number>();
		for (const children of this.#workerChildren.values()) for (const [pid, startedAt] of children) trackedPids.set(pid, startedAt);
		for (const worker of this.#deadWorkers.values()) for (const [pid, startedAt] of worker.children) trackedPids.set(pid, startedAt);
		const processes = await scanOmpProcesses(workers, sessions, now, this.#sources, trackedPids);
		const byPid = new Map(processes.map(process => [process.pid, process]));
		const allWorkerPids = new Set(workers.filter(worker => worker.pid > 0).map(worker => worker.pid));
		const activeWorkerPids = new Set(
			workers.filter(worker => worker.pid > 0 && worker.state !== "stopped" && worker.state !== "crashed" && byPid.has(worker.pid)).map(worker => worker.pid),
		);
		const currentChildren = new Map<number, Map<number, number>>();
		for (const process of processes) {
			for (const workerPid of activeWorkerPids) {
				if (process.pid !== workerPid && isDescendantOfInfo(process.pid, workerPid, byPid)) {
					const children = currentChildren.get(workerPid) ?? new Map<number, number>();
					children.set(process.pid, process.startedAt);
					currentChildren.set(workerPid, children);
				}
			}
		}
		for (const [workerPid, children] of this.#workerChildren) {
			if (!activeWorkerPids.has(workerPid) && !this.#deadWorkers.has(workerPid)) {
				this.#deadWorkers.set(workerPid, { since: now, children: new Map(children) });
			}
		}
		for (const worker of workers) {
			if (worker.pid > 0 && allWorkerPids.has(worker.pid) && !activeWorkerPids.has(worker.pid) && !this.#deadWorkers.has(worker.pid)) {
				this.#deadWorkers.set(worker.pid, { since: now, children: new Map(this.#workerChildren.get(worker.pid) ?? []) });
			}
		}
		this.#workerChildren.clear();
		for (const [pid, children] of currentChildren) this.#workerChildren.set(pid, children);

		for (const [workerPid, dead] of this.#deadWorkers) {
			const liveChildren = [...dead.children].flatMap(([pid, startedAt]) => (byPid.get(pid)?.startedAt === startedAt ? [pid] : []));
			if (liveChildren.length === 0) {
				this.#deadWorkers.delete(workerPid);
				continue;
			}
			for (const pid of liveChildren) {
				const process = byPid.get(pid)!;
				byPid.set(pid, classifyProcess(process, now, { orphanSince: dead.since }));
			}
		}
		return processes.map(process => byPid.get(process.pid) ?? process);
	}
}

function isDescendantOfInfo(pid: number, ancestorPid: number, byPid: ReadonlyMap<number, ProcessInfo>): boolean {
	const seen = new Set<number>();
	let current = byPid.get(pid);
	while (current && !seen.has(current.pid)) {
		if (current.ppid === ancestorPid) return true;
		seen.add(current.pid);
		current = byPid.get(current.ppid);
	}
	return false;
}
