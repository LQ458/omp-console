import type {
	ApiError,
	CreateSessionRequest,
	HistoryEdge,
	KeyPoints,
	QuickAskRequest,
	QuickAskResponse,
	QuickAskSource,
	RuleFileWrite,
	SessionSummary,
	StartWorkspaceSessionRequest,
	Workspace,
} from "@omp-console/protocol";
import { prompt } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import handoffTemplate from "./handoff.md" with { type: "text" };
import quickAskTemplate from "./quick-ask.md" with { type: "text" };
import { atomicWriteFile } from "./files";
import { discoverWorkspaces, workspaceOf, type WorkspaceDiscoveryOptions } from "./discover";
import type { QuickAskSessionRequest, WorkspacePorts } from "./ports";
import { readWorkspaceRule, WorkspaceRuleError, writeWorkspaceRule } from "./rules";
import { errorResponse, json } from "../api";

const WORKSPACE_ROUTE = /^\/api\/workspaces(?:\/([^/]+)(?:\/(sessions|color|rules\/(.+)))?)?$/;
const QUICK_ASK_ROUTE = "/api/quick-ask";
const MAX_BODY_BYTES = 320 * 1024;
const MAX_PROMPT_LENGTH = 64 * 1024;
const QUICK_ASK_SOURCES = ["siyuan", "repo", "web", "history"] as const;
const QUICK_ASK_SOURCE_NAMES: Record<(typeof QUICK_ASK_SOURCES)[number], string> = {
	siyuan: "SiYuan through the siyuan-local MCP; cite block IDs",
	repo: "the knowledge repository; cite repository file paths",
	web: "web search; cite source URLs",
	history: "past omp sessions from the history index; cite session IDs",
};

export interface WorkspaceRouteOptions {
	discovery?: WorkspaceDiscoveryOptions;
	quickAsk?: { enabled: boolean; sources: readonly QuickAskSource[] };
	now?: () => number;
}
class WorkspaceRouteError extends Error {
	constructor(readonly code: ApiError["code"], message: string) {
		super(message);
	}
}

interface QuickAskRecord {
	date: string;
	sessionId: string;
	sessionFile?: string;
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
	if (error instanceof WorkspaceRuleError) return errorResponse(statusForCode(error.code), error.code, error.message);
	if (error instanceof WorkspaceRouteError) return errorResponse(statusForCode(error.code), error.code, error.message);
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = error.code;
		if (code === "bad-request" || code === "not-found" || code === "conflict" || code === "internal") {
			const message = error instanceof Error ? error.message : "workspace operation failed";
			return errorResponse(statusForCode(code), code, message);
		}
	}
	return errorResponse(500, "internal", "internal error");
}

async function readJson(req: Request): Promise<unknown> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) throw new WorkspaceRouteError("bad-request", "request body too large");
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > MAX_BODY_BYTES) throw new WorkspaceRouteError("bad-request", "request body too large");
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new WorkspaceRouteError("bad-request", "body must be valid JSON");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new WorkspaceRouteError("bad-request", "invalid encoded path component");
	}
}

function parseStartRequest(value: unknown): StartWorkspaceSessionRequest {
	if (!isRecord(value)) throw new WorkspaceRouteError("bad-request", "body must be an object");
	const request: StartWorkspaceSessionRequest = {};
	if (value.prompt !== undefined) {
		if (typeof value.prompt !== "string" || value.prompt.length > MAX_PROMPT_LENGTH) {
			throw new WorkspaceRouteError("bad-request", "prompt must be a string no longer than 64 KB");
		}
		request.prompt = value.prompt;
	}
	if (value.handoffFromSessionId !== undefined) {
		if (typeof value.handoffFromSessionId !== "string" || value.handoffFromSessionId.trim() === "") {
			throw new WorkspaceRouteError("bad-request", "handoffFromSessionId must be a non-empty string");
		}
		request.handoffFromSessionId = value.handoffFromSessionId;
	}
	if (value.model !== undefined) {
		if (typeof value.model !== "string" || value.model.trim() === "") {
			throw new WorkspaceRouteError("bad-request", "model must be a non-empty string");
		}
		request.model = value.model;
	}
	return request;
}

function parseRuleWrite(value: unknown): RuleFileWrite {
	if (!isRecord(value) || (value.visibility !== "private" && value.visibility !== "shared") || typeof value.content !== "string") {
		throw new WorkspaceRouteError("bad-request", 'body must be {"visibility":"private"|"shared","content":string}');
	}
	return { visibility: value.visibility, content: value.content };
}

function parseQuickAsk(value: unknown, allowedSources: readonly QuickAskSource[]): QuickAskRequest {
	if (!isRecord(value) || typeof value.question !== "string" || value.question.trim() === "" || value.question.length > MAX_PROMPT_LENGTH) {
		throw new WorkspaceRouteError("bad-request", "question must be a non-empty string no longer than 64 KB");
	}
	if (value.sources !== undefined && (!Array.isArray(value.sources) || !value.sources.every(source => QUICK_ASK_SOURCES.includes(source as (typeof QUICK_ASK_SOURCES)[number])))) {
		throw new WorkspaceRouteError("bad-request", "sources must contain only siyuan, repo, web, or history");
	}
	const sources = value.sources === undefined ? undefined : [...new Set(value.sources as QuickAskSource[])];
	if (sources?.some(source => !allowedSources.includes(source))) throw new WorkspaceRouteError("bad-request", "sources must be enabled in the daemon quick-ask allowlist");
	return { question: value.question, ...(sources === undefined ? {} : { sources }) };
}

function dateKey(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}


function pointsContext(points: KeyPoints): Record<string, unknown> {
	return {
		title: points.title,
		goal: points.goal ?? "",
		decisions: points.decisions,
		files: points.files,
		outcome: points.outcome ?? "",
		openQuestions: points.openQuestions,
	};
}

function renderHandoff(points: KeyPoints): string {
	return prompt.render(handoffTemplate, pointsContext(points)).trim();
}

/** The new session's instruction when the user handed work over without typing a prompt of their own. */
const CONTINUE_AFTER_HANDOFF =
	"Continue the work from this handoff in this workspace now, from its next step, within the constraints it lists. Stop and ask instead only if the handoff says the work is finished or is waiting on the user (a question, an approval, a choice).";

function handoffFocus(workspace: Workspace): string {
	return [
		`The work continues right away in a new session in the ${workspace.name} workspace at ${workspace.root}.`,
		"Write the handoff for that session: the task in progress and the user's latest request about it, what is already done and verified, decisions and constraints the user gave, and the exact next step.",
		"Describe the work, not this handoff request. Give absolute file paths.",
	].join(" ");
}

function renderQuickAsk(question: string, sources: readonly (typeof QUICK_ASK_SOURCES)[number][]): string {
	const names = sources.map(source => QUICK_ASK_SOURCE_NAMES[source]);
	return prompt.render(quickAskTemplate, { question, sources: names }).trim();
}

function validColorOverrides(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const result: Record<string, number> = {};
	for (const [id, hue] of Object.entries(value)) {
		if (typeof hue === "number" && Number.isFinite(hue) && hue >= 0 && hue < 360) result[id] = hue;
	}
	return result;
}

async function readColorOverrides(filePath: string): Promise<Record<string, number>> {
	try {
		return validColorOverrides(await Bun.file(filePath).json());
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
		return {};
	}
}

async function readQuickAskRecord(filePath: string, date: string): Promise<QuickAskRecord | undefined> {
	try {
		const value: unknown = await Bun.file(filePath).json();
		if (!isRecord(value) || value.date !== date || typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
		return {
			date,
			sessionId: value.sessionId,
			...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
		};
	} catch {
		return undefined;
	}
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await atomicWriteFile(filePath, `${JSON.stringify(value)}\n`, 0o600);
}

function quickAskSources(input: QuickAskRequest, allowedSources: readonly QuickAskSource[]): readonly QuickAskSource[] {
	return input.sources ?? allowedSources;
}

export function createWorkspaceRoutes(
	ports: WorkspacePorts,
	stateDir: string,
	options: WorkspaceRouteOptions = {},
): (req: Request, url: URL) => Promise<Response | undefined> {
	const discovery = options.discovery ?? {};
	const now = options.now ?? Date.now;
	const colorsFile = path.join(stateDir, "workspace-colors.json");
	const quickAskDirectory = path.join(stateDir, "quick-ask");
	let quickAskQueue = Promise.resolve();

	async function withQuickAskLock<T>(fn: () => Promise<T>): Promise<T> {
		const previous = quickAskQueue;
		const next = Promise.withResolvers<void>();
		quickAskQueue = next.promise;
		await previous;
		try {
			return await fn();
		} finally {
			next.resolve();
		}
	}

	/**
	 * The handoff a new workspace session starts from. An idle source session runs omp's handoff, which also compacts
	 * it, so the work moves instead of being duplicated at full context; a busy source (a turn still running), or a
	 * handoff that fails, falls back to the librarian's key points and leaves the source untouched.
	 */
	async function handoffFrom(sourceId: string, workspace: Workspace): Promise<string> {
		if (!ports.liveSessions().some(session => session.id === sourceId && session.state !== "asleep")) {
			throw new WorkspaceRouteError("not-found", `session ${JSON.stringify(sourceId)} is not live`);
		}
		try {
			const document = await ports.handoffDocument(sourceId, handoffFocus(workspace));
			return `Handoff from the session where this work started:\n<handoff>\n${document}\n</handoff>`;
		} catch {
			const points = await ports.keyPoints(sourceId);
			if (!points || points.sessionId !== sourceId) {
				throw new WorkspaceRouteError("not-found", `key points for session ${JSON.stringify(sourceId)} not found`);
			}
			return renderHandoff(points);
		}
	}

	async function workspacesWithState(): Promise<Workspace[]> {
		const [workspaces, colors] = await Promise.all([discoverWorkspaces(discovery), readColorOverrides(colorsFile)]);
		// Hidden sessions (quick-ask, report) are omp console's own; the count is the user's sessions only.
		const sessions = ports.liveSessions().filter(session => !session.hidden && session.state !== "asleep");
		for (const workspace of workspaces) {
			workspace.liveSessions = sessions.filter(session => workspaceOf(session.cwd, [workspace]) !== undefined).length;
			const hue = colors[workspace.id];
			if (typeof hue === "number") workspace.hueOverride = hue;
		}
		return workspaces;
	}

	async function findWorkspace(id: string): Promise<Workspace> {
		const workspace = (await workspacesWithState()).find(candidate => candidate.id === id);
		if (!workspace) throw new WorkspaceRouteError("not-found", `workspace ${JSON.stringify(id)} not found`);
		return workspace;
	}

	async function quickAsk(input: QuickAskRequest): Promise<QuickAskResponse> {
		return withQuickAskLock(async () => {
			const workspace = (await workspacesWithState()).find(candidate => candidate.kind === "knowledge");
			if (!workspace) throw new WorkspaceRouteError("not-found", "knowledge workspace is not available");
			const date = dateKey(now());
			const recordPath = path.join(quickAskDirectory, `${date}.json`);
			const previous = await readQuickAskRecord(recordPath, date);
			const live = previous ? ports.liveSessions().find(session => session.id === previous.sessionId) : undefined;
			let session: SessionSummary;
			if (live) {
				session = live;
			} else {
				const request: QuickAskSessionRequest = {
					cwd: workspace.root,
					...(previous?.sessionFile ? { resumeSessionFile: previous.sessionFile } : {}),
					title: "quick-ask",
					profile: "kb",
					hidden: true,
				};
				session = await ports.createQuickAskSession(request);
			}
			await writeJson(recordPath, { date, sessionId: session.id, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}) });
			await ports.sendPrompt(session.id, renderQuickAsk(input.question, quickAskSources(input, options.quickAsk?.sources ?? [])));
			const updated = ports.liveSessions().find(candidate => candidate.id === session.id);
			if (updated?.sessionFile && updated.sessionFile !== session.sessionFile) {
				await writeJson(recordPath, { date, sessionId: session.id, sessionFile: updated.sessionFile });
			}
			return { sessionId: session.id };
		});
	}

	return async (req, url) => {
		try {
			if (url.pathname === QUICK_ASK_ROUTE) {
				if (options.quickAsk?.enabled !== true) return undefined;
				if (req.method !== "POST") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "POST" });
				const result = await quickAsk(parseQuickAsk(await readJson(req), options.quickAsk.sources));
				return json(202, result);
			}
			const match = WORKSPACE_ROUTE.exec(url.pathname);
			if (!match) return undefined;
			if (match[1] === undefined) {
				if (req.method !== "GET") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET" });
				return json(200, { workspaces: await workspacesWithState() });
			}
			const id = decodeSegment(match[1]);
			const workspace = await findWorkspace(id);
			const action = match[2];
			if (action === "sessions") {
				if (req.method !== "POST") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "POST" });
				const request = parseStartRequest(await readJson(req));
				const sourceId = request.handoffFromSessionId;
				if (sourceId !== undefined && !ports.liveSessions().some(session => session.id === sourceId && session.state !== "asleep")) {
					throw new WorkspaceRouteError("not-found", `session ${JSON.stringify(sourceId)} is not live`);
				}
				// A handed-over session keeps the source's model unless the request picked one.
				const model =
					request.model ??
					(sourceId === undefined ? undefined : ports.liveSessions().find(session => session.id === sourceId)?.model);
				const createRequest: CreateSessionRequest = {
					cwd: workspace.root,
					...(model === undefined ? {} : { model }),
				};
				// The new session exists before the handoff compacts the source, so a failed start leaves the source as it was.
				const session = await ports.createSession(createRequest);
				let firstMessage = request.prompt ?? "";
				if (sourceId !== undefined) {
					const handoff = await handoffFrom(sourceId, workspace);
					firstMessage = `${handoff}\n\n${request.prompt ?? CONTINUE_AFTER_HANDOFF}`;
				}
				if (firstMessage.length > 0) await ports.sendPrompt(session.id, firstMessage);
				if (request.handoffFromSessionId) {
					const edge: HistoryEdge = { from: request.handoffFromSessionId, to: session.id, kind: "handoff" };
					await ports.recordEdge(edge);
				}
				return json(201, session);
			}
			if (action === "color") {
				if (req.method !== "PUT") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "PUT" });
				const body: unknown = await readJson(req);
				if (!isRecord(body) || !(body.hue === null || (typeof body.hue === "number" && Number.isFinite(body.hue) && body.hue >= 0 && body.hue < 360))) {
					throw new WorkspaceRouteError("bad-request", "hue must be null or a number from 0 inclusive to 360 exclusive");
				}
				const colors = await readColorOverrides(colorsFile);
				if (body.hue === null) delete colors[id];
				else colors[id] = body.hue;
				await writeJson(colorsFile, colors);
				return new Response(null, { status: 204 });
			}
			if (action?.startsWith("rules/")) {
				if (match[3] === undefined) throw new WorkspaceRouteError("bad-request", "rule path is required");
				const rulePath = decodeSegment(match[3]);
				if (req.method === "GET") return json(200, await readWorkspaceRule(workspace.root, rulePath));
				if (req.method === "PUT") {
					await writeWorkspaceRule(workspace.root, rulePath, parseRuleWrite(await readJson(req)));
					return new Response(null, { status: 204 });
				}
				return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET, PUT" });
			}
			return undefined;
		} catch (error) {
			return failure(error);
		}
	};
}
