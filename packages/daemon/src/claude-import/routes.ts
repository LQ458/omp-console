import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
	ClaudeImportItemResult,
	ClaudeImportJobResponse,
	ClaudeImportProject,
	ClaudeImportSession,
	ClaudeImportSettingsResponse,
	ClaudeImportSource,
	ClaudeImportSummary,
	ClaudeImportSessionsResponse,
	StartClaudeImportRequest,
	UpdateClaudeImportSettingsRequest,
} from "@omp-console/protocol";
import { CodexSessionStore } from "@oh-my-pi/pi-coding-agent/session/codex-session-store";
import { ClaudeSessionStore } from "@oh-my-pi/pi-coding-agent/session/claude-session-store";
import { persistForeignSession } from "@oh-my-pi/pi-coding-agent/session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionStore } from "@oh-my-pi/pi-coding-agent/session/foreign-session-store";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { cfgEnabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resolveClaudePaths } from "@oh-my-pi/pi-coding-agent/config/claude-paths";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCommandsEnableClaudeUser, cfgSkillsEnableClaudeUser } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { errorResponse, json } from "../api";
import { atomicWriteFile } from "../workspaces/files";

const IMPORTS_FILE = "foreign-session-imports.json";
const MAX_IMPORT_IDS = 100;
const MAX_ID_LENGTH = 256;
const MAX_SETTINGS_BODY_BYTES = 16 * 1024;
const JOB_TTL_MS = 15 * 60_000;
const MAX_RETAINED_JOBS = 128;

interface ImportRecord {
	source: ClaudeImportSource;
	sourceId: string;
	sourcePath: string;
	sessionId: string;
	importedAt: number;
	/** The imported omp session file; a record whose file was deleted no longer blocks re-import. */
	sessionFile?: string;
}

interface ImportIndex {
	version: 1;
	imports: ImportRecord[];
}

interface RunningJob extends ClaudeImportJobResponse {
	completedAt?: number;
}

interface ClaudeImportRouteOptions {
	agentDir: string;
	sessionDir: string;
	stateDir: string;
	/** Called with each new imported session file before it is reported. */
	onImported?: (sessionFile: string) => Promise<void>;
}

class ImportRouteError extends Error {
	constructor(readonly status: number, readonly code: "bad-request" | "not-found" | "internal", message: string) {
		super(message);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
	return isObject(error) && error.code === "ENOENT";
}

function sourceFor(url: URL): ClaudeImportSource {
	const source = url.searchParams.get("source") ?? "claude";
	if (source !== "claude" && source !== "codex") {
		throw new ImportRouteError(400, "bad-request", 'source must be "claude" or "codex"');
	}
	return source;
}

function sourceDirectory(source: ClaudeImportSource): string {
	const home = process.env.HOME?.trim() || os.homedir();
	return source === "claude" ? resolveClaudePaths(home).configDir : path.join(home, ".codex");
}

function makeStore(source: ClaudeImportSource, dir: string): ForeignSessionStore {
	return source === "claude" ? new ClaudeSessionStore(dir) : new CodexSessionStore(dir);
}

function importKey(record: Pick<ImportRecord, "source" | "sourceId" | "sourcePath">): string {
	return JSON.stringify([record.source, record.sourceId, record.sourcePath]);
}

function parseImportIndex(value: unknown): ImportIndex {
	if (!isObject(value) || value.version !== 1 || !Array.isArray(value.imports)) {
		throw new Error("Claude/Codex import state has an unsupported format");
	}
	const imports: ImportRecord[] = [];
	for (const item of value.imports) {
		if (
			!isObject(item) ||
			(item.source !== "claude" && item.source !== "codex") ||
			typeof item.sourceId !== "string" ||
			typeof item.sourcePath !== "string" ||
			typeof item.sessionId !== "string" ||
			typeof item.importedAt !== "number" ||
			(item.sessionFile !== undefined && typeof item.sessionFile !== "string")
		) {
			throw new Error("Claude/Codex import state contains an invalid record");
		}
		imports.push({
			source: item.source,
			sourceId: item.sourceId,
			sourcePath: item.sourcePath,
			sessionId: item.sessionId,
			importedAt: item.importedAt,
			...(typeof item.sessionFile === "string" ? { sessionFile: item.sessionFile } : {}),
		});
	}
	return { version: 1, imports };
}

async function readImportIndex(file: string): Promise<ImportIndex> {
	try {
		return parseImportIndex(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
	} catch (error) {
		if (isMissing(error)) return { version: 1, imports: [] };
		throw error;
	}
}

function messageCountRecord(source: ClaudeImportSource, value: unknown): boolean {
	if (!isObject(value)) return false;
	if (source === "claude") return value.type === "user" || value.type === "assistant";
	if (value.type === "response_item" && isObject(value.payload)) {
		return value.payload.type === "message" && (value.payload.role === "user" || value.payload.role === "assistant");
	}
	return false;
}

async function countMessages(info: ForeignSessionInfo): Promise<number> {
	if (info.messageCount !== undefined) return info.messageCount;
	let count = 0;
	const lines = readline.createInterface({ input: createReadStream(info.path, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		try {
			if (messageCountRecord(info.source, JSON.parse(line) as unknown)) count++;
		} catch {
			// Listing remains available for malformed transcripts; import reports the converter's item error.
		}
	}
	return count;
}

function brief(text: string | undefined): string | null {
	const normalized = text?.replace(/\s+/g, " ").trim();
	if (!normalized) return null;
	return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
}

function buildSession(info: ForeignSessionInfo, imported: ImportRecord | undefined, messageCount: number): ClaudeImportSession {
	const preview = brief(info.firstMessage);
	const title = info.title?.trim() || preview || path.basename(info.cwd) || info.id;
	return {
		id: info.id,
		source: info.source,
		projectPath: info.cwd,
		title,
		firstMessage: preview,
		messageCount,
		lastActivityAt: info.modified.getTime(),
		alreadyImported: imported !== undefined,
		...(imported === undefined ? {} : { importedSessionId: imported.sessionId }),
	};
}

/** The user's own global `enabledProviders` entries, unresolved: path-scoped `{ path, providers }` entries included. */
function globalEnabledProviders(settings: Settings): unknown[] {
	const raw = (settings.getGlobalSettings() as Record<string, unknown>).enabledProviders;
	return Array.isArray(raw) ? [...raw] : [];
}

function parseRequest(value: unknown): StartClaudeImportRequest {
	if (!isObject(value) || !Array.isArray(value.ids) || value.ids.length === 0 || value.ids.length > MAX_IMPORT_IDS) {
		throw new ImportRouteError(400, "bad-request", `ids must contain 1-${MAX_IMPORT_IDS} session ids`);
	}
	for (const id of value.ids) {
		if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
			throw new ImportRouteError(400, "bad-request", "ids must be safe session identifiers from the selected source");
		}
	}
	return { ids: [...value.ids] as string[] };
}

function parseSettingsRequest(value: unknown): UpdateClaudeImportSettingsRequest {
	if (
		!isObject(value) ||
		typeof value.userConfigEnabled !== "boolean" ||
		typeof value.userSkillsEnabled !== "boolean" ||
		typeof value.userCommandsEnabled !== "boolean"
	) {
		throw new ImportRouteError(400, "bad-request", "userConfigEnabled, userSkillsEnabled, and userCommandsEnabled must be booleans");
	}
	return {
		userConfigEnabled: value.userConfigEnabled,
		userSkillsEnabled: value.userSkillsEnabled,
		userCommandsEnabled: value.userCommandsEnabled,
	};
}
async function readJsonBody(req: Request, maxBytes: number, subject: string): Promise<unknown> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > maxBytes) throw new ImportRouteError(413, "bad-request", `${subject} request body too large`);
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new ImportRouteError(413, "bad-request", `${subject} request body too large`);
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new ImportRouteError(400, "bad-request", "body is not valid JSON");
	}
}

function settingsResponse(settings: Settings): ClaudeImportSettingsResponse {
	const claudeConfigDirOverride = (process.env.CLAUDE_CONFIG_DIR?.trim() ?? "") !== "";
	return {
		// The persisted choice only: CLAUDE_CONFIG_DIR turns Claude user config on regardless, and the panel shows that
		// separately, so saving other toggles never writes an opt-in the user did not make.
		userConfigEnabled: globalEnabledProviders(settings).includes("claude"),
		userSkillsEnabled: cfgSkillsEnableClaudeUser.get(settings),
		userCommandsEnabled: cfgCommandsEnableClaudeUser.get(settings),
		claudeConfigDirOverride,
	};
}

export async function createClaudeImportRoutes(options: ClaudeImportRouteOptions): Promise<(req: Request, url: URL) => Promise<Response | null>> {
	const indexFile = path.join(options.stateDir, IMPORTS_FILE);
	const index = await readImportIndex(indexFile);
	const importMap = new Map(index.imports.map(record => [importKey(record), record]));
	const sessionStorage = new FileSessionStorage();
	const jobs = new Map<string, RunningJob>();
	let jobQueue: Promise<void> = Promise.resolve();
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	const settings = async (): Promise<Settings> => Settings.loadIsolated({ agentDir: options.agentDir });

	async function readSourceSessions(source: ClaudeImportSource): Promise<{ dir: string; found: boolean; infos: ForeignSessionInfo[] }> {
		const dir = sourceDirectory(source);
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(dir);
		} catch (error) {
			if (isMissing(error)) return { dir, found: false, infos: [] };
			throw error;
		}
		if (!stat.isDirectory()) throw new Error(`${dir} exists but is not a directory`);
		return { dir, found: true, infos: await makeStore(source, dir).list() };
	}

	function settingsMethod(req: Request, url: URL): Promise<Response | null> {
		if (url.pathname !== "/api/claude-import/settings") return Promise.resolve(null);
		if (req.method === "GET") {
			return settings().then(value => json(200, settingsResponse(value)));
		}
		if (req.method !== "PUT") return Promise.resolve(errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET, PUT" }));
		return (async (): Promise<Response> => {
			const request = parseSettingsRequest(await readJsonBody(req, MAX_SETTINGS_BODY_BYTES, "settings"));
			const write = settingsWriteQueue.then(async () => {
				const current = await settings();
				// Edit the raw global list: the resolved value would drop other paths' scoped entries and flatten
				// project-layer values into the global file.
				const others = globalEnabledProviders(current).filter(entry => entry !== "claude");
				const next = request.userConfigEnabled ? [...others, "claude"] : others;
				cfgEnabledProviders.set(current, next as Parameters<typeof cfgEnabledProviders.set>[1]);
				cfgSkillsEnableClaudeUser.set(current, request.userSkillsEnabled);
				cfgCommandsEnableClaudeUser.set(current, request.userCommandsEnabled);
				await current.flush();
			});
			settingsWriteQueue = write.then(() => undefined, () => undefined);
			await write;
			return json(200, settingsResponse(await settings()));
		})();
	}

	async function importOne(source: ClaudeImportSource, info: ForeignSessionInfo): Promise<ClaudeImportItemResult> {
		const key = importKey({ source, sourceId: info.id, sourcePath: info.path });
		const already = await liveRecord(key);
		if (already) return { id: info.id, status: "already-imported", sessionId: already.sessionId };
		let record: ImportRecord;
		try {
			const sessionDir = computeDefaultSessionDir(info.cwd, sessionStorage, options.sessionDir);
			const imported = await persistForeignSession(makeStore(source, sourceDirectory(source)), info, { sessionDir });
			record = {
				source,
				sourceId: info.id,
				sourcePath: info.path,
				sessionId: imported.getSessionId(),
				importedAt: Date.now(),
				...(imported.getSessionFile() === undefined ? {} : { sessionFile: imported.getSessionFile() }),
			};
		} catch (error) {
			return { id: info.id, status: "error", error: errorMessage(error) };
		}
		// The import is omp console's own new session (no terminal omp writes it): it continues in place when opened.
		if (record.sessionFile !== undefined) await options.onImported?.(record.sessionFile);
		const nextMap = new Map(importMap).set(key, record);
		try {
			await atomicWriteFile(indexFile, `${JSON.stringify({ version: 1, imports: [...nextMap.values()] } satisfies ImportIndex)}\n`, 0o600);
		} catch (error) {
			// The omp session exists; only the de-duplication record is missing. Keep it for this run and say so.
			importMap.set(key, record);
			return { id: info.id, status: "imported", sessionId: record.sessionId, warning: `imported, but the import index could not be saved: ${errorMessage(error)}` };
		}
		importMap.set(key, record);
		return { id: info.id, status: "imported", sessionId: record.sessionId };
	}

	/** The record for a source transcript, or undefined when its imported session file has since been deleted. */
	async function liveRecord(key: string): Promise<ImportRecord | undefined> {
		const record = importMap.get(key);
		if (record?.sessionFile === undefined) return record;
		try {
			await fs.access(record.sessionFile);
			return record;
		} catch {
			importMap.delete(key);
			return undefined;
		}
	}

	function collectOldJobs(): void {
		for (const [id, job] of jobs) {
			if (job.completedAt !== undefined && Date.now() - job.completedAt > JOB_TTL_MS) jobs.delete(id);
		}
		while (jobs.size >= MAX_RETAINED_JOBS) {
			const oldest = [...jobs].find(([, job]) => job.completedAt !== undefined);
			if (!oldest) break;
			jobs.delete(oldest[0]);
		}
	}

	async function route(req: Request, url: URL): Promise<Response | null> {
		const settingsResponse = await settingsMethod(req, url);
		if (settingsResponse) return settingsResponse;
		if (url.pathname === "/api/claude-import/summary") {
			if (req.method !== "GET") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET" });
			const source = sourceFor(url);
			const { dir, found, infos } = await readSourceSessions(source);
			const response: ClaudeImportSummary = {
				dir,
				found,
				sessionCount: infos.length,
				projectCount: new Set(infos.map(info => info.cwd)).size,
			};
			return json(200, response);
		}
		if (url.pathname === "/api/claude-import/sessions") {
			if (req.method !== "GET") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET" });
			const source = sourceFor(url);
			const { dir, found, infos } = await readSourceSessions(source);
			const groups = new Map<string, ClaudeImportSession[]>();
			for (const info of infos) {
				const imported = await liveRecord(importKey({ source, sourceId: info.id, sourcePath: info.path }));
				const item = buildSession(info, imported, await countMessages(info));
				const sessions = groups.get(info.cwd) ?? [];
				sessions.push(item);
				groups.set(info.cwd, sessions);
			}
			const projects: ClaudeImportProject[] = [...groups]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([projectPath, sessions]) => ({ path: projectPath, sessions }));
			const response: ClaudeImportSessionsResponse = { source, dir, found, projects };
			return json(200, response);
		}
		if (url.pathname === "/api/claude-import") {
			if (req.method !== "POST") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "POST" });
			const source = sourceFor(url);
			const request = parseRequest(await readJsonBody(req, MAX_SETTINGS_BODY_BYTES, "import"));
			const { found, infos } = await readSourceSessions(source);
			if (!found) throw new ImportRouteError(404, "not-found", `${source === "claude" ? "Claude Code" : "Codex"} data folder was not found`);
			const byId = new Map(infos.map(info => [info.id, info]));
			const selected: ForeignSessionInfo[] = request.ids.map(id => {
				const info = byId.get(id);
				if (!info) throw new ImportRouteError(400, "bad-request", `session ${id} is no longer available in ${source}`);
				return info;
			});
			collectOldJobs();
			if (jobs.size >= MAX_RETAINED_JOBS) throw new ImportRouteError(429, "bad-request", "too many import jobs are running; wait for one to finish");
			const job: RunningJob = {
				jobId: randomUUID(),
				source,
				status: "running",
				total: selected.length,
				completed: 0,
				results: [],
			};
			jobs.set(job.jobId, job);
			const work = jobQueue.then(async () => {
				for (const info of selected) {
					job.results.push(await importOne(source, info));
					job.completed++;
					await Bun.sleep(0);
				}
				job.status = "complete";
				job.completedAt = Date.now();
			});
			jobQueue = work.then(() => undefined, () => undefined);
			void work.catch(error => {
				while (job.completed < job.total) {
					const info = selected[job.completed]!;
					job.results.push({ id: info.id, status: "error", error: errorMessage(error) });
					job.completed++;
				}
				job.status = "complete";
				job.completedAt = Date.now();
			});
			return json(202, { jobId: job.jobId, source, status: job.status, total: job.total, completed: 0, results: [] } satisfies ClaudeImportJobResponse);
		}
		const jobMatch = /^\/api\/claude-import\/jobs\/([^/]+)$/.exec(url.pathname);
		if (jobMatch) {
			if (req.method !== "GET") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET" });
			let jobId: string;
			try {
				jobId = decodeURIComponent(jobMatch[1]!);
			} catch {
				throw new ImportRouteError(400, "bad-request", "malformed import job id");
			}
			const job = jobs.get(jobId);
			if (!job) throw new ImportRouteError(404, "not-found", "import job was not found or has expired");
			const { completedAt: _completedAt, ...response } = job;
			return json(200, response satisfies ClaudeImportJobResponse);
		}
		return null;
	}

	return async (req, url): Promise<Response | null> => {
		try {
			return await route(req, url);
		} catch (error) {
			if (error instanceof ImportRouteError) return errorResponse(error.status, error.code, error.message);
			return errorResponse(500, "internal", errorMessage(error));
		}
	};
}
