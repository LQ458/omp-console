import type { CreateSessionRequest, PreflightCheck, SessionSummary, StartOvernightRequest, OvernightPolicy, OvernightTemplate } from "@omp-console/protocol";
import { errorResponse, json } from "../api";
import type { Supervisor } from "../supervisor";
import { overnightWorkerOptions, type OvernightController } from "./controller";
import { runOvernightPreflight, type PreflightOptions } from "./preflight";
import { OvernightStore } from "./store";

const MAX_TASK_LENGTH = 64 * 1024;
const MAX_PROMPT_LENGTH = 64 * 1024;
const SESSION_OVERNIGHT_ROUTE = /^\/api\/sessions\/([^/]+)\/overnight$/;
const POLICY_KEYS = new Set(["deadline", "askTimeoutSec", "quiet", "maxIdleContinuations", "keepAwake"]);

export interface OvernightRoutesOptions {
	controller: OvernightController;
	store: OvernightStore;
	supervisor: Supervisor;
	preflightOptions?: (cwd: string) => PreflightOptions;
}

export interface OvernightRoutes {
	parseStartRequest(value: unknown): StartOvernightRequest;
	prepareCreate(request: CreateSessionRequest): Promise<CreateSessionRequest>;
	onCreated(summary: SessionSummary, request: CreateSessionRequest): Promise<void>;
	handle(req: Request, url: URL): Promise<Response | undefined>;
	/** Stops an active overnight run (the user's Stop/abort); false when the session has none. */
	stopIfActive(sessionId: string): Promise<boolean>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(status: number, code: "bad-request" | "not-found" | "conflict" | "internal", message: string, headers?: Record<string, string>): Response {
	return errorResponse(status, code, message, headers);
}

function validDeadline(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6] ?? 0);
	const offsetHour = Number(match[9] ?? 0);
	const offsetMinute = Number(match[10] ?? 0);
	const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
	return year > 0 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59 &&
		offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}

function parsePolicy(value: unknown, partial: boolean): Partial<OvernightPolicy> {
	if (!isObject(value)) throw new Error("policy must be an object");
	for (const key of Object.keys(value)) if (!POLICY_KEYS.has(key)) throw new Error(`unknown policy field ${key}`);
	const policy: Partial<OvernightPolicy> = {};
	if (value.deadline !== undefined) {
		if (!validDeadline(value.deadline)) throw new Error("deadline must be ISO 8601 with an explicit UTC offset");
		policy.deadline = value.deadline;
	} else if (!partial) throw new Error("deadline is required");
	if (value.askTimeoutSec !== undefined) {
		if (typeof value.askTimeoutSec !== "number" || !Number.isSafeInteger(value.askTimeoutSec) || value.askTimeoutSec < 1 || value.askTimeoutSec > 86_400) {
			throw new Error("askTimeoutSec must be an integer between 1 and 86400");
		}
		policy.askTimeoutSec = value.askTimeoutSec;
	} else if (!partial) throw new Error("askTimeoutSec is required");
	if (value.quiet !== undefined) {
		if (value.quiet !== "normal" && value.quiet !== "quiet" && value.quiet !== "silent") throw new Error("quiet must be normal, quiet, or silent");
		policy.quiet = value.quiet;
	} else if (!partial) throw new Error("quiet is required");
	if (value.maxIdleContinuations !== undefined) {
		if (typeof value.maxIdleContinuations !== "number" || !Number.isSafeInteger(value.maxIdleContinuations) || value.maxIdleContinuations < 1 || value.maxIdleContinuations > 100) {
			throw new Error("maxIdleContinuations must be an integer between 1 and 100");
		}
		policy.maxIdleContinuations = value.maxIdleContinuations;
	} else if (!partial) throw new Error("maxIdleContinuations is required");
	if (value.keepAwake !== undefined) {
		if (typeof value.keepAwake !== "boolean") throw new Error("keepAwake must be a boolean");
		policy.keepAwake = value.keepAwake;
	} else if (!partial) throw new Error("keepAwake is required");
	return policy;
}

export function parseStartOvernightRequest(value: unknown): StartOvernightRequest {
	if (!isObject(value)) throw new Error("An Overnight run request must be an object.");
	for (const key of Object.keys(value)) if (key !== "task" && key !== "policy" && key !== "prompt") throw new Error(`Unknown Overnight run field: ${key}.`);
	if (typeof value.task !== "string" || value.task.trim() === "" || value.task.length > MAX_TASK_LENGTH) {
		throw new Error(`task must be a non-empty string of at most ${MAX_TASK_LENGTH} characters`);
	}
	const request: StartOvernightRequest = { task: value.task };
	if (value.policy !== undefined) {
		request.policy = parsePolicy(value.policy, true);
		if (request.policy.deadline !== undefined && Date.parse(request.policy.deadline) <= Date.now()) {
			throw new Error("deadline must be in the future");
		}
	}
	if (value.prompt !== undefined) {
		if (typeof value.prompt !== "string" || value.prompt.trim() === "" || value.prompt.length > MAX_PROMPT_LENGTH) {
			throw new Error(`prompt must be a non-empty string of at most ${MAX_PROMPT_LENGTH} characters`);
		}
		request.prompt = value.prompt;
	}
	return request;
}

function parseTemplate(value: unknown): OvernightTemplate {
	if (!isObject(value)) throw new Error("template must be an object");
	for (const key of Object.keys(value)) if (key !== "prompt" && key !== "policy") throw new Error(`unknown template field ${key}`);
	if (typeof value.prompt !== "string" || value.prompt.trim() === "" || value.prompt.length > MAX_PROMPT_LENGTH) {
		throw new Error(`prompt must be a non-empty string of at most ${MAX_PROMPT_LENGTH} characters`);
	}
	if (!isObject(value.policy)) throw new Error("policy must be an object");
	const deadlineLocalTime = value.policy.deadlineLocalTime;
	if (typeof deadlineLocalTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(deadlineLocalTime)) {
		throw new Error("deadlineLocalTime must be HH:mm in local time");
	}
	const policyInput = { ...value.policy };
	delete policyInput.deadlineLocalTime;
	if (Object.hasOwn(policyInput, "deadline")) throw new Error("template policy cannot set a deadline");
	const policy = parsePolicy({ ...policyInput, deadline: "2000-01-01T00:00:00Z" }, false);
	delete policy.deadline;
	return { prompt: value.prompt, policy: { ...policy, deadlineLocalTime } as OvernightTemplate["policy"] };
}

function nextLocalDeadline(localTime: string, now = new Date()): string {
	const [hours, minutes] = localTime.split(":").map(Number);
	const date = new Date(now);
	date.setHours(hours!, minutes!, 0, 0);
	if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
	const offset = -date.getTimezoneOffset();
	const sign = offset < 0 ? "-" : "+";
	const offsetText = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:00${offsetText}`;
}

function resolvePolicy(partial: Partial<OvernightPolicy> | undefined, template: OvernightTemplate): OvernightPolicy {
	const { deadlineLocalTime, ...defaults } = template.policy;
	return {
		...defaults,
		deadline: partial?.deadline ?? nextLocalDeadline(deadlineLocalTime),
		...(partial?.askTimeoutSec === undefined ? {} : { askTimeoutSec: partial.askTimeoutSec }),
		...(partial?.quiet === undefined ? {} : { quiet: partial.quiet }),
		...(partial?.maxIdleContinuations === undefined ? {} : { maxIdleContinuations: partial.maxIdleContinuations }),
		...(partial?.keepAwake === undefined ? {} : { keepAwake: partial.keepAwake }),
	};
}

function sessionId(segment: string): string {
	try {
		const value = decodeURIComponent(segment);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid session id");
		return value;
	} catch {
		throw new Error("invalid session id");
	}
}

async function readJson(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw new Error("body is not valid JSON");
	}
}

function methodNotAllowed(req: Request, methods: readonly string[]): Response {
	return fail(405, "bad-request", `method ${req.method} not allowed`, { Allow: methods.join(", ") });
}

export function createOvernightRoutes(options: OvernightRoutesOptions): OvernightRoutes {
	const { controller, store, supervisor } = options;
	const pendingAuthenticationBlocks = new WeakMap<CreateSessionRequest, string>();

	function parseStartRequest(value: unknown): StartOvernightRequest {
		return parseStartOvernightRequest(value);
	}

	async function prepareCreate(request: CreateSessionRequest): Promise<CreateSessionRequest> {
		const start = request.overnight;
		if (!start) return request;
		if (request.resumeSessionFile || request.forkFrom) throw new Error("Overnight runs can start only in a new session.");
		if (request.handoff !== undefined) throw new Error("An Overnight run cannot be combined with Continue in a new session.");
		const template = await store.template();
		const policy = resolvePolicy(start.policy, template);
		const prompt = start.prompt ?? template.prompt;
		const modelAvailability = options.preflightOptions?.(request.cwd).modelAvailability;
		let authenticationBlock: string | undefined;
		if (modelAvailability) {
			try {
				const result = await modelAvailability(request.model);
				if (!result.available) authenticationBlock = `Model authentication is unavailable; no work has started: ${result.detail}`;
			} catch (error) {
				authenticationBlock = `Model authentication could not be checked; no work has started: ${String(error)}`;
			}
		}
		// The first prompt is the long template, so a generated title would describe the template, not the task.
		const taskLine = start.task.trim().split("\n")[0]!.replace(/\s+/g, " ");
		const title = request.title ?? `Overnight run: ${taskLine.length > 60 ? `${taskLine.slice(0, 59)}…` : taskLine}`;
		const prepared: CreateSessionRequest = {
			...request,
			title,
			overnight: { ...start, prompt, policy },
			...(authenticationBlock ? {} : { handoff: `${prompt}\n\n## Task\n${start.task}` }),
		};
		if (authenticationBlock) pendingAuthenticationBlocks.set(prepared, authenticationBlock);
		return prepared;
	}

	async function onCreated(summary: SessionSummary, request: CreateSessionRequest): Promise<void> {
		if (request.overnight) {
			const policy = request.overnight.policy;
			if (!policy || !validDeadline(policy.deadline) || policy.askTimeoutSec === undefined || policy.quiet === undefined ||
				policy.maxIdleContinuations === undefined || policy.keepAwake === undefined) {
				throw new Error("overnight session policy was not normalized before worker creation");
			}
			if (controller.get(summary.id) === undefined) {
				await controller.start(summary.id, policy as OvernightPolicy);
				const authenticationBlock = pendingAuthenticationBlocks.get(request);
				if (authenticationBlock) controller.onInitialPromptFailure(summary.id, authenticationBlock);
			}
	}
	}

	async function startExisting(req: Request, match: RegExpExecArray): Promise<Response> {
		let id: string;
		try {
			id = sessionId(match[1]!);
		} catch (error) {
			return fail(400, "bad-request", error instanceof Error ? error.message : String(error));
		}
		const summary = supervisor.get(id);
		if (!summary) return fail(404, "not-found", `no live session ${id}`);
		if (controller.isActive(id)) return fail(409, "conflict", "This session already has an active Overnight run.");
		if (summary.state !== "idle" || summary.awaitingAnswer || summary.paused || summary.frozen) {
			return fail(409, "conflict", "Finish the current turn and answer pending questions before starting an Overnight run.");
		}
		let start: StartOvernightRequest;
		try {
			start = parseStartRequest(await readJson(req));
		} catch (error) {
			return fail(400, "bad-request", error instanceof Error ? error.message : String(error));
		}
		const template = await store.template();
		const policy = resolvePolicy(start.policy, template);
		const prompt = start.prompt ?? template.prompt;
		try {
			await supervisor.restart(id, false, overnightWorkerOptions(policy));
			await controller.start(id, policy);
			await supervisor.sendPrompt(id, `${prompt}\n\n## Task\n${start.task}`);
			return json(200, controller.get(id));
		} catch (error) {
			if (controller.isActive(id)) await controller.stop(id).catch(() => {});
			return fail(409, "conflict", error instanceof Error ? error.message : String(error));
		}
	}

	async function stopExisting(match: RegExpExecArray): Promise<Response> {
		let id: string;
		try {
			id = sessionId(match[1]!);
		} catch (error) {
			return fail(400, "bad-request", error instanceof Error ? error.message : String(error));
		}
		const state = await controller.stop(id);
		return state ? json(200, state) : fail(404, "not-found", "This session has no Overnight run history.");
	}

	async function handle(req: Request, url: URL): Promise<Response | undefined> {
		if (url.pathname === "/api/overnight/template") {
			if (req.method === "GET") return json(200, await store.template());
			if (req.method !== "PUT") return methodNotAllowed(req, ["GET", "PUT"]);
			let template: OvernightTemplate;
			try {
				template = parseTemplate(await readJson(req));
			} catch (error) {
				return fail(400, "bad-request", error instanceof Error ? error.message : String(error));
			}
			try {
				return json(200, await store.saveTemplate(template));
			} catch (error) {
				return fail(500, "internal", error instanceof Error ? error.message : String(error));
			}
		}
		if (url.pathname === "/api/overnight/preflight") {
			if (req.method !== "GET") return methodNotAllowed(req, ["GET"]);
			const cwd = url.searchParams.get("cwd");
			if (!cwd || !cwd.startsWith("/")) return fail(400, "bad-request", "cwd must be an absolute path");
			try {
				const result: { checks: PreflightCheck[] } = await runOvernightPreflight(cwd, options.preflightOptions?.(cwd));
				return json(200, result);
			} catch (error) {
				return fail(400, "bad-request", error instanceof Error ? error.message : String(error));
			}
		}
		const match = SESSION_OVERNIGHT_ROUTE.exec(url.pathname);
		if (!match) return undefined;
		if (req.method === "POST") return startExisting(req, match);
		if (req.method === "DELETE") return stopExisting(match);
		if (req.method === "GET") {
			let id: string;
			try {
				id = sessionId(match[1]!);
			} catch (error) {
				return fail(400, "bad-request", error instanceof Error ? error.message : String(error));
			}
			const state = controller.get(id);
			return state ? json(200, state) : fail(404, "not-found", "This session has no Overnight run history.");
		}
		return methodNotAllowed(req, ["GET", "POST", "DELETE"]);
	}

	async function stopIfActive(sessionId: string): Promise<boolean> {
		if (!controller.isActive(sessionId)) return false;
		await controller.stop(sessionId);
		return true;
	}

	return { handle, onCreated, parseStartRequest, prepareCreate, stopIfActive };
}
