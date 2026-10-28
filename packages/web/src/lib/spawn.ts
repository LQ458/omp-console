/**
 * Spawning subagents from the GUI (spec 2.5, 2.6, 3.3): form rows, validation, the sequential batch run, the omp
 * `task` call the form is equivalent to, and the two window events that connect the panel to the rest of the app.
 */
import type { SpawnAgentRequest } from "@omp-console/protocol";
import { type DeckApi, DeckApiError } from "./api";
import type { UsageRecorder } from "./session-model";

export const OPEN_PANEL_EVENT = "omp-console:open-panel";
export const OPEN_AGENT_EVENT = "omp-console:open-agent";

/** Detail of an `omp-console:open-panel` event that opens the spawn dialog. */
export interface SpawnPanelDetail {
	panel: "spawn";
	profile?: string;
	task?: string;
	files?: string[];
}


/**
 * Asks the open session to show the spawn dialog. Returns true when a dialog took the request (the receiver calls
 * `preventDefault`), false when no session is open or the open one is read-only.
 */
export function openSpawnPanel(detail: Omit<SpawnPanelDetail, "panel"> = {}, target: EventTarget = window): boolean {
	const event = new CustomEvent<SpawnPanelDetail>(OPEN_PANEL_EVENT, { detail: { panel: "spawn", ...detail }, cancelable: true });
	return !target.dispatchEvent(event);
}

/** Null for any other panel or a malformed detail; unknown extra fields are ignored. */
export function parseSpawnPanelEvent(event: Event): SpawnPanelDetail | null {
	const detail: unknown = event instanceof CustomEvent ? event.detail : null;
	if (typeof detail !== "object" || detail === null) return null;
	const raw = detail as Record<string, unknown>;
	if (raw.panel !== "spawn") return null;
	const result: SpawnPanelDetail = { panel: "spawn" };
	if (typeof raw.profile === "string" && raw.profile.trim() !== "") result.profile = raw.profile.trim();
	if (typeof raw.task === "string") result.task = raw.task;
	if (Array.isArray(raw.files)) result.files = raw.files.filter((f): f is string => typeof f === "string");
	return result;
}

export function openAgent(agentId: string, target: EventTarget = window): void {
	target.dispatchEvent(new CustomEvent<{ agentId: string }>(OPEN_AGENT_EVENT, { detail: { agentId } }));
}

export function parseOpenAgentEvent(event: Event): string | null {
	const detail: unknown = event instanceof CustomEvent ? event.detail : null;
	if (typeof detail !== "object" || detail === null) return null;
	const id = (detail as { agentId?: unknown }).agentId;
	return typeof id === "string" && id !== "" ? id : null;
}

export interface SpawnRow {
	/** Stable React key and status key. */
	key: string;
	profile: string;
	task: string;
	name: string;
	files: string[];
	isolated: boolean;
}

export const MAX_BATCH_ROWS = 12;
const MAX_NAME_LENGTH = 64;

let rowSeq = 0;
export function emptyRow(profile = ""): SpawnRow {
	rowSeq++;
	return { key: `row-${rowSeq}`, profile, task: "", name: "", files: [], isolated: false };
}

export type PathResult = { ok: true; path: string } | { ok: false; message: string };

/** A typed file path: trimmed, an optional leading `@` and surrounding quotes dropped. */
export function normalizePath(input: string): PathResult {
	let value = input.trim();
	if (value.startsWith("@")) value = value.slice(1);
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
	if (value === "") return { ok: false, message: "Type a file path." };
	if (/[\r\n\0]/.test(value)) return { ok: false, message: "A path cannot contain line breaks." };
	return { ok: true, path: value };
}

/** Adds a path unless it is already listed. */
export function withPath(files: readonly string[], input: string): { files: string[]; error: string | null } {
	const result = normalizePath(input);
	if (!result.ok) return { files: [...files], error: result.message };
	if (files.includes(result.path)) return { files: [...files], error: `${result.path} is already listed.` };
	return { files: [...files, result.path], error: null };
}

export interface RowValidation {
	profile?: string;
	task?: string;
	name?: string;
}

/** Field errors for one row; empty object means it can be sent. */
export function validateRow(
	row: SpawnRow,
	knownProfiles: ReadonlySet<string>,
	takenNames: ReadonlySet<string> = new Set(),
): RowValidation {
	const errors: RowValidation = {};
	if (row.profile === "") errors.profile = "Choose an agent profile.";
	else if (!knownProfiles.has(row.profile)) errors.profile = `Agent profile "${row.profile}" is not available in this session.`;
	if (row.task.trim() === "") errors.task = "Describe the task.";
	const name = row.name.trim();
	if (name.length > MAX_NAME_LENGTH) errors.name = `Keep the name under ${MAX_NAME_LENGTH + 1} characters.`;
	else if (/[\r\n]/.test(name)) errors.name = "A name is one line.";
	else if (name !== "" && takenNames.has(name)) errors.name = "Another row already uses this name.";
	return errors;
}

/** Errors per row key for a whole batch; rows without problems are absent. Names must be unique across the batch. */
export function validateRows(rows: readonly SpawnRow[], knownProfiles: ReadonlySet<string>): Map<string, RowValidation> {
	const result = new Map<string, RowValidation>();
	const seen = new Set<string>();
	for (const row of rows) {
		const errors = validateRow(row, knownProfiles, seen);
		const name = row.name.trim();
		if (name !== "") seen.add(name);
		if (Object.keys(errors).length > 0) result.set(row.key, errors);
	}
	return result;
}

export function toSpawnRequest(row: SpawnRow): SpawnAgentRequest {
	const request: SpawnAgentRequest = { profile: row.profile, task: row.task.trim() };
	const name = row.name.trim();
	if (name !== "") request.name = name;
	if (row.isolated) request.isolated = true;
	if (row.files.length > 0) request.files = [...row.files];
	return request;
}

function mention(path: string): string {
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The task text omp sees: the task, then the files as `@path` mentions. */
export function taskWithFiles(row: Pick<SpawnRow, "task" | "files">): string {
	const task = row.task.trim();
	if (row.files.length === 0) return task;
	return `${task}\n\n${row.files.map(mention).join(" ")}`;
}

/**
 * The omp `task` tool call that does what the form does, for the "omp:" line. One row is a single call; several
 * rows are one batch call (`context` plus `tasks`, each with its own `agent`).
 */
export function taskEquivalent(rows: readonly SpawnRow[]): string {
	const item = (row: SpawnRow): Record<string, unknown> => {
		const entry: Record<string, unknown> = {};
		const name = row.name.trim();
		if (name !== "") entry.name = name;
		entry.agent = row.profile === "" ? "<profile>" : row.profile;
		entry.task = row.task.trim() === "" && row.files.length === 0 ? "<task>" : taskWithFiles(row);
		entry.solutionSpace = "…";
		if (row.isolated) entry.isolated = true;
		return entry;
	};
	if (rows.length === 1 && rows[0]) return `task(${JSON.stringify(item(rows[0]), null, 2)})`;
	return `task(${JSON.stringify({ context: "…", tasks: rows.map(item) }, null, 2)})`;
}

/** One sentence for the failed row. */
export function describeSpawnError(err: unknown): string {
	if (!(err instanceof DeckApiError)) return err instanceof Error ? err.message : "unexpected error";
	switch (err.kind) {
		case "auth":
			return "The daemon refused this device.";
		case "network":
			return "The daemon is unreachable. Nothing was started.";
		case "not-found":
			return "That session is gone, so nothing was started.";
		case "conflict":
			return `omp's spawn policy refused it: ${err.message}`;
		case "bad-request":
			return `The daemon did not accept it: ${err.message}`;
		case "server":
			return `The daemon failed: ${err.message}`;
	}
}

export type RowStatus =
	| { state: "idle" }
	| { state: "spawning" }
	| { state: "done"; agentId: string }
	| { state: "error"; message: string };

export interface SpawnRunDeps {
	api: DeckApi;
	sessionId: string;
	record: UsageRecorder;
	now?: () => number;
	/** Called with every status change, in order. */
	onStatus(key: string, status: RowStatus): void;
}

export interface SpawnRunResult {
	/** Agent ids in row order, only for rows that started. */
	agentIds: string[];
	failed: number;
}

/**
 * Sends the rows one after another through `spawnAgent`, in order, so agents are registered in the order the
 * person listed them. A row that fails does not stop the rest. Rows already `done` in `previous` are skipped, so
 * "retry failed" never starts an agent twice.
 */
export async function runSpawn(
	deps: SpawnRunDeps,
	rows: readonly SpawnRow[],
	previous: ReadonlyMap<string, RowStatus> = new Map(),
	via: "direct" | "graph" | "catalog" = "direct",
): Promise<SpawnRunResult> {
	const now = deps.now ?? Date.now;
	const agentIds: string[] = [];
	let failed = 0;
	let started = 0;
	for (const row of rows) {
		const before = previous.get(row.key);
		if (before?.state === "done") {
			agentIds.push(before.agentId);
			continue;
		}
		deps.onStatus(row.key, { state: "spawning" });
		const t0 = now();
		try {
			const response = await deps.api.spawnAgent(deps.sessionId, toSpawnRequest(row));
			agentIds.push(response.agentId);
			started++;
			deps.onStatus(row.key, { state: "done", agentId: response.agentId });
			deps.record({ feature: "2.5.spawn", action: "spawn", outcome: "ok", latencyMs: now() - t0, via, screen: "spawn", detail: row.profile, sessionId: deps.sessionId });
		} catch (err) {
			failed++;
			deps.onStatus(row.key, { state: "error", message: describeSpawnError(err) });
			deps.record({ feature: "2.5.spawn", action: "spawn", outcome: "error", latencyMs: now() - t0, via, screen: "spawn", detail: row.profile, sessionId: deps.sessionId });
		}
	}
	if (rows.length > 1) {
		deps.record({
			feature: "2.6.batch-spawn",
			action: "spawn-batch",
			outcome: failed === 0 ? "ok" : "error",
			via,
			screen: "spawn",
			detail: `rows=${rows.length} started=${started} failed=${failed}`,
			sessionId: deps.sessionId,
		});
	}
	return { agentIds, failed };
}
