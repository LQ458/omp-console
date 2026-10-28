import type { ApiError, ProcessInfo, ProcessPoliciesRequest, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorResponse, json } from "../api";
import { ProcessScanner, type ProcessScanSources } from "./scan";
import type { ProcessPorts } from "./ports";

const PROCESSES_ROUTE = /^\/api\/processes(?:\/([^/]+)\/stop)?$/;
const POLICY_ROUTE = "/api/processes/policies";
const DEFAULT_RSS_WARN_BYTES = 1_500_000_000;
const DEFAULT_POLICY_CHECK_INTERVAL_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024;
const PROCESS_SCAN_CACHE_MS = 2_000;

type Signal = "SIGTERM" | "SIGKILL";
type Policy = ProcessPoliciesRequest;

export interface ProcessRoutesOptions {
	scanner?: ProcessScanner;
	scanSources?: ProcessScanSources;
	now?: () => number;
	signalProcess?: (pid: number, signal: Signal) => void;
	processAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	policyCheckIntervalMs?: number;
}

export type ProcessRouteHandler = ((req: Request, url: URL) => Promise<Response | undefined>) & {
	dispose(): void;
	checkIdleStops(): Promise<void>;
};

class ProcessRouteError extends Error {
	constructor(readonly code: ApiError["code"], message: string) {
		super(message);
	}
}

function statusForCode(code: ApiError["code"]): number {
	switch (code) {
		case "bad-request":
			return 400;
		case "not-found":
			return 404;
		case "conflict":
			return 409;
		case "forbidden":
			return 403;
		case "unauthorized":
			return 401;
		case "internal":
			return 500;
	}
}

function failure(error: unknown): Response {
	if (error instanceof ProcessRouteError) return errorResponse(statusForCode(error.code), error.code, error.message);
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = error.code;
		if (code === "bad-request" || code === "not-found" || code === "conflict" || code === "internal") {
			return errorResponse(statusForCode(code), code, error instanceof Error ? error.message : "process operation failed");
		}
	}
	return errorResponse(500, "internal", "internal error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(req: Request): Promise<unknown> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) throw new ProcessRouteError("bad-request", "request body too large");
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > MAX_BODY_BYTES) throw new ProcessRouteError("bad-request", "request body too large");
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new ProcessRouteError("bad-request", "body must be valid JSON");
	}
}

function parsePolicy(value: unknown): Policy {
	if (
		!isRecord(value) ||
		!(value.idleStopAfterMs === null || (Number.isSafeInteger(value.idleStopAfterMs) && (value.idleStopAfterMs as number) > 0)) ||
		!Number.isSafeInteger(value.rssWarnBytes) ||
		(value.rssWarnBytes as number) < 1
	) {
		throw new ProcessRouteError("bad-request", "idleStopAfterMs must be null or a positive integer and rssWarnBytes must be a positive integer");
	}
	return { idleStopAfterMs: value.idleStopAfterMs as number | null, rssWarnBytes: value.rssWarnBytes as number };
}

function validStoredPolicy(value: unknown): Policy | undefined {
	try {
		return parsePolicy(value);
	} catch {
		return undefined;
	}
}

function defaultSignalProcess(pid: number, signal: Signal): void {
	process.kill(pid, signal);
}

function defaultProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

function sessionCanIdleStop(session: SessionSummary, now: number, delay: number): boolean {
	return session.state === "idle" && !session.awaitingAnswer && now - session.lastActivityAt >= delay;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function createProcessRoutes(
	ports: ProcessPorts,
	stateDir: string,
	options: ProcessRoutesOptions = {},
): ProcessRouteHandler {
	const scanner = options.scanner ?? new ProcessScanner(options.scanSources);
	const now = options.now ?? Date.now;
	const signalProcess = options.signalProcess ?? defaultSignalProcess;
	const processAlive = options.processAlive ?? defaultProcessAlive;
	const sleep = options.sleep ?? Bun.sleep;
	const policyFile = path.join(stateDir, "process-policies.json");
	let policy: Policy | undefined;
	let policyRead: Promise<Policy> | undefined;
	let timer: Timer | undefined;
	let latestScan: ProcessInfo[] = [];
	let latestScanAt: number | undefined;
	let scanInFlight: Promise<ProcessInfo[]> | undefined;
	const stoppingSessions = new Set<string>();
	const escalations = new Set<Promise<void>>();

	async function getPolicy(): Promise<Policy> {
		if (policy) return policy;
		policyRead ??= (async () => {
			try {
				const stored: unknown = await Bun.file(policyFile).json();
				return validStoredPolicy(stored) ?? { idleStopAfterMs: null, rssWarnBytes: DEFAULT_RSS_WARN_BYTES };
			} catch {
				return { idleStopAfterMs: null, rssWarnBytes: DEFAULT_RSS_WARN_BYTES };
			}
		})();
		policy = await policyRead;
		return policy;
	}

	async function writePolicy(next: Policy): Promise<void> {
		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		const temporary = `${policyFile}.${crypto.randomUUID()}.tmp`;
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
			await handle.sync();
		} catch (error) {
			await handle.close();
			await fs.rm(temporary, { force: true });
			throw error;
		}
		await handle.close();
		try {
			await fs.rename(temporary, policyFile);
		} catch (error) {
			await fs.rm(temporary, { force: true });
			throw error;
		}
		policy = next;
		policyRead = Promise.resolve(next);
		if (next.idleStopAfterMs === null) stopTimer();
		else startTimer();
	}

	function startTimer(): void {
		if (timer) return;
		timer = setInterval(() => {
			void checkIdleStops().catch(() => {});
		}, options.policyCheckIntervalMs ?? DEFAULT_POLICY_CHECK_INTERVAL_MS);
		timer.unref();
	}

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	async function checkIdleStops(): Promise<void> {
		const current = await getPolicy();
		if (current.idleStopAfterMs === null) return;
		const at = now();
		for (const session of ports.liveSessions()) {
			if (!sessionCanIdleStop(session, at, current.idleStopAfterMs) || stoppingSessions.has(session.id)) continue;
			stoppingSessions.add(session.id);
			try {
				await ports.stopSession(session.id);
			} finally {
				stoppingSessions.delete(session.id);
			}
		}
	}

	async function scan(force = false): Promise<ProcessInfo[]> {
		const scanRequestedAt = now();
		if (!force && latestScanAt !== undefined && scanRequestedAt - latestScanAt < PROCESS_SCAN_CACHE_MS) return latestScan;
		if (scanInFlight) {
			if (!force) return scanInFlight;
			await scanInFlight;
		}
		const scanStartedAt = now();
		const pending = (async (): Promise<ProcessInfo[]> => {
			const [workers, sessions] = await Promise.all([ports.workerHealth(), Promise.resolve(ports.liveSessions())]);
			latestScan = await scanner.scan(workers, sessions, scanStartedAt);
			latestScanAt = now();
			return latestScan;
		})();
		scanInFlight = pending;
		try {
			return await pending;
		} finally {
			if (scanInFlight === pending) scanInFlight = undefined;
		}
	}

	function enqueueOrphanEscalation(info: ProcessInfo): void {
		const task = (async () => {
			await sleep(3_000);
			if (!processAlive(info.pid)) return;
			// Only the same process (pid and start time) is killed; a pid reused meanwhile is left alone.
			const again = await scan(true);
			if (again.some(process => process.pid === info.pid && process.startedAt === info.startedAt)) signalProcess(info.pid, "SIGKILL");
		})().catch(() => {});
		escalations.add(task);
		void task.finally(() => escalations.delete(task));
	}

	async function stopProcess(pid: number, confirm: boolean): Promise<Response> {
		if (!confirm) throw new ProcessRouteError("bad-request", 'body must be {"confirm":true}');
		const fresh = await scan(true);
		const candidate = fresh.find(process => process.pid === pid);
		if (!candidate || !latestScan.includes(candidate)) throw new ProcessRouteError("not-found", `process ${pid} not found in the latest scan`);
		if (candidate.kind === "omp-console-worker") {
			if (!candidate.sessionId || !ports.liveSessions().some(session => session.id === candidate.sessionId)) {
				throw new ProcessRouteError("not-found", `omp-console worker for process ${pid} is no longer live`);
			}
			if (!await ports.stopSession(candidate.sessionId)) throw new ProcessRouteError("not-found", `omp-console worker for process ${pid} is no longer live`);
			return json(202, { pid, stopping: true });
		}
		if (candidate.state === "orphan") {
			signalProcess(pid, "SIGTERM");
			enqueueOrphanEscalation(candidate);
			return json(202, { pid, stopping: true });
		}
		if (candidate.kind !== "omp-terminal") {
			throw new ProcessRouteError("conflict", "only omp-console workers, terminal omp sessions, and orphans can be stopped");
		}
		signalProcess(pid, "SIGTERM");
		return json(202, { pid, stopping: true });
	}

	const handler = async (req: Request, url: URL): Promise<Response | undefined> => {
		try {
			if (url.pathname === POLICY_ROUTE) {
				if (req.method !== "PUT") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "PUT" });
				await writePolicy(parsePolicy(await readJson(req)));
				return new Response(null, { status: 204 });
			}
			const match = PROCESSES_ROUTE.exec(url.pathname);
			if (!match) return undefined;
			if (match[1] === undefined) {
				if (req.method !== "GET") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET" });
				const [processes, policies] = await Promise.all([scan(), getPolicy()]);
				return json(200, { processes, policies });
			}
			if (req.method !== "POST") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "POST" });
			const parsedPid = Number(match[1]);
			if (!Number.isSafeInteger(parsedPid) || parsedPid <= 0) throw new ProcessRouteError("bad-request", "pid must be a positive integer");
			const body: unknown = await readJson(req);
			const confirm = isRecord(body) && body.confirm === true;
			return await stopProcess(parsedPid, confirm);
		} catch (error) {
			if (errorCode(error) === "ESRCH") return errorResponse(404, "not-found", "process is no longer running");
			return failure(error);
		}
	};

	handler.dispose = stopTimer;
	handler.checkIdleStops = checkIdleStops;
	return handler;
}
