import type { ProcessInfo, SessionState } from "@omp-console/protocol";

export const ACTIVE_SESSION_WINDOW_MS = 10 * 60_000;
export const ORPHAN_GRACE_MS = 30_000;

export interface ProcessClassificationContext {
	workerState?: SessionState;
	orphanSince?: number;
}

export function classifyProcess(info: ProcessInfo, now = Date.now(), context: ProcessClassificationContext = {}): ProcessInfo {
	if (
		context.orphanSince !== undefined &&
		now - context.orphanSince >= ORPHAN_GRACE_MS &&
		info.kind !== "omp-broker" &&
		info.kind !== "omp-lsp"
	) {
		return { ...info, state: "orphan", reason: "process survived its omp-console worker" };
	}
	if (context.workerState === "streaming") return { ...info, state: "active", reason: "omp-console worker is streaming" };
	if (info.lastSessionWriteAt !== undefined && now - info.lastSessionWriteAt < ACTIVE_SESSION_WINDOW_MS) {
		return { ...info, state: "active", reason: "session file was written within 10 minutes" };
	}
	return { ...info, state: "idle", reason: undefined };
}
