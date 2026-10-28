import type { ApiError, DraftPlan, DraftRun, ListDraftRunsResponse, ListPlanTemplatesResponse } from "@omp-console/protocol";
import { errorResponse, json } from "../api";
import type { PlanPorts } from "./ports";
import { PlanRunner, PlanValidationError, parseDraftPlan, type PlanRunnerOptions } from "./runner";
import { PlanTemplateNameError, PlanTemplates } from "./templates";

const SESSION_PLANS_ROUTE = /^\/api\/sessions\/([^/]+)\/plans(?:\/([^/]+))?$/;
const TEMPLATES_ROUTE = /^\/api\/plan-templates(?:\/([^/]+))?$/;


function statusForCode(code: ApiError["code"]): number {
	switch (code) {
		case "bad-request":
			return 400;
		case "not-found":
			return 404;
		case "conflict":
			return 409;
		case "unauthorized":
			return 401;
		case "forbidden":
			return 403;
		case "internal":
			return 500;
	}
}

function decodeSegment(value: string): string | undefined {
	try {
		const decoded = decodeURIComponent(value);
		return decoded.length > 0 && !decoded.includes("/") && !decoded.includes("\\") ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function portError(error: unknown): { code: ApiError["code"]; message: string } | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	const code = error.code;
	if (
		code !== "bad-request" &&
		code !== "not-found" &&
		code !== "conflict" &&
		code !== "internal"
	) return undefined;
	return { code, message: error.message };
}

function failure(error: unknown): Response {
	if (error instanceof PlanValidationError || error instanceof PlanTemplateNameError) {
		return errorResponse(400, "bad-request", error.message);
	}
	const port = portError(error);
	if (port) return errorResponse(statusForCode(port.code), port.code, port.message);
	return errorResponse(500, "internal", "internal error");
}

async function readPlan(req: Request): Promise<DraftPlan> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new PlanValidationError("body must be valid JSON");
	}
	const plan = parseDraftPlan(body);
	if (!plan) throw new PlanValidationError("body must be a draft plan");
	return plan;
}

function methodNotAllowed(req: Request, ...methods: string[]): Response {
	return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: methods.join(", ") });
}

export function createPlanRoutes(
	ports: PlanPorts,
	stateDir: string,
	options?: PlanRunnerOptions,
): (req: Request, url: URL) => Promise<Response | undefined> {
	const runner = new PlanRunner(ports, stateDir, options);
	const templates = new PlanTemplates(stateDir);

	return async (req, url) => {
		const templateMatch = TEMPLATES_ROUTE.exec(url.pathname);
		if (templateMatch) {
			try {
				if (!templateMatch[1]) {
					if (req.method !== "GET") return methodNotAllowed(req, "GET");
					const body: ListPlanTemplatesResponse = { templates: await templates.list() };
					return json(200, body);
				}
				if (req.method !== "PUT") return methodNotAllowed(req, "PUT");
				const name = decodeSegment(templateMatch[1]);
				if (!name) throw new PlanTemplateNameError(templateMatch[1]);
				const plan = await templates.save(name, await readPlan(req));
				return json(200, plan);
			} catch (error) {
				return failure(error);
			}
		}

		const match = SESSION_PLANS_ROUTE.exec(url.pathname);
		if (!match) return undefined;
		try {
			const sessionId = decodeSegment(match[1]!);
			if (!sessionId) throw new PlanValidationError("invalid session id");
			const runId = match[2] === undefined ? undefined : decodeSegment(match[2]);
			if (match[2] !== undefined && !runId) throw new PlanValidationError("invalid run id");
			if (runId === undefined) {
				if (req.method === "GET") {
					const body: ListDraftRunsResponse = { runs: runner.list(sessionId) };
					return json(200, body);
				}
				if (req.method === "POST") {
					const run: DraftRun = await runner.start(sessionId, await readPlan(req));
					return json(202, run);
				}
				return methodNotAllowed(req, "GET", "POST");
			}
			if (req.method === "GET") {
				const run = runner.get(sessionId, runId);
				return run ? json(200, run) : errorResponse(404, "not-found", `plan run ${JSON.stringify(runId)} not found`);
			}
			if (req.method === "DELETE") {
				const run = await runner.cancel(sessionId, runId);
				return run ? json(200, run) : errorResponse(404, "not-found", `plan run ${JSON.stringify(runId)} not found`);
			}
			return methodNotAllowed(req, "GET", "DELETE");
		} catch (error) {
			return failure(error);
		}
	};
}
