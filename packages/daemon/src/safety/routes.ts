import type { ApiError, DriftSuggestion, GateStatusResponse, MoveConfirmRequest, MovePrepareRequest } from "@omp-console/protocol";
import { isWindows } from "../platform";
import { errorResponse, json } from "../api";
import { readGateStatus, type GateOptions } from "./gate";
import { DriftTracker, type DriftOptions } from "./drift";
import { MoveError, MoveService, type MoveServiceOptions } from "./move";
import { MoveFileError } from "./files";
import type { SafetyPorts } from "./ports";


const SESSION_DRIFT_ROUTE = /^\/api\/sessions\/([^/]+)\/drift(?:\/([^/]+)\/dismiss)?$/;
const MOVES_ROUTE = /^\/api\/moves(?:\/([^/]+)(?:\/(confirm|undo))?)?$/;
const GATE_PATH = "/api/gate";

export interface SafetyRouteOptions {
	gate?: GateOptions;
	drift?: DriftOptions;
	move?: MoveServiceOptions;
	/** Unexpected (500) errors are logged here with their stack; the response stays generic. */
	log?: (message: string) => void;
}

export interface SafetyRouteHandler {
	(req: Request, url: URL): Promise<Response | undefined>;
	captureSessionBaseline(sessionId: string, cwd: string): Promise<void>;
}

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

function methodNotAllowed(req: Request, ...methods: string[]): Response {
	return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: methods.join(", ") });
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw new MoveError("body must be valid JSON", "bad-request");
	}
}

async function readMovePrepare(req: Request): Promise<MovePrepareRequest> {
	const value = await readJson(req);
	if (!isObject(value) || typeof value.suggestionId !== "string" || typeof value.slug !== "string") {
		throw new MoveError("body must contain suggestionId and slug", "bad-request");
	}
	return { suggestionId: value.suggestionId, slug: value.slug };
}

async function readMoveConfirm(req: Request): Promise<MoveConfirmRequest> {
	let value: unknown;
	try {
		value = await req.json();
	} catch {
		throw new MoveError("native move confirmation is required", "forbidden");
	}
	if (!isObject(value) || typeof value.nonce !== "string" || typeof value.token !== "string") {
		throw new MoveError("native move confirmation is required", "forbidden");
	}
	return { nonce: value.nonce, token: value.token };
}

function portError(error: unknown): { code: ApiError["code"]; message: string } | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	const code = error.code;
	if (
		code !== "bad-request" &&
		code !== "not-found" &&
		code !== "conflict" &&
		code !== "forbidden" &&
		code !== "internal"
	) return undefined;
	return { code, message: error.message };
}

function failure(error: unknown, log?: (message: string) => void): Response {
	if (error instanceof MoveError) return errorResponse(statusForCode(error.code), error.code, error.message);
	if (error instanceof MoveFileError) return errorResponse(statusForCode(error.code), error.code, error.message);
	const port = portError(error);
	if (port) return errorResponse(statusForCode(port.code), port.code, port.message);
	log?.(`safety route failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	return errorResponse(500, "internal", "internal error");
}

export function createSafetyRoutes(
	ports: SafetyPorts,
	stateDir: string,
	options: SafetyRouteOptions = {},
): SafetyRouteHandler {
	const drift = new DriftTracker(stateDir, options.drift);
	const moves = options.move?.projectsRoot === undefined ? undefined : new MoveService(ports, drift, stateDir, options.move);

	const handler = async (req: Request, url: URL): Promise<Response | undefined> => {
		if (url.pathname === GATE_PATH) {
			if (req.method !== "GET") return methodNotAllowed(req, "GET");
			try {
				const body: GateStatusResponse = await readGateStatus(options.gate);
				return json(200, body);
			} catch {
				return errorResponse(500, "internal", "could not read action gate status");
			}
		}

		const driftMatch = SESSION_DRIFT_ROUTE.exec(url.pathname);
		if (driftMatch) {
			const sessionId = decodeSegment(driftMatch[1]!);
			if (!sessionId) return errorResponse(400, "bad-request", "invalid session id");
			if (driftMatch[2] !== undefined) {
				if (req.method !== "POST") return methodNotAllowed(req, "POST");
				const suggestionId = decodeSegment(driftMatch[2]);
				if (!suggestionId) return errorResponse(400, "bad-request", "invalid suggestion id");
				try {
					await drift.dismiss(sessionId, suggestionId);
					return new Response(null, { status: 204 });
				} catch (error) {
					if (error instanceof Error && error.message === "drift suggestion not found") {
						return errorResponse(404, "not-found", error.message);
					}
					return failure(error, options.log);
				}
			}
			if (req.method !== "GET") return methodNotAllowed(req, "GET");
			try {
				const cwd = ports.sessionCwd(sessionId);
				const kind = ports.sessionWorkspaceKind(sessionId);
				if (!cwd || !kind) return errorResponse(404, "not-found", `session ${JSON.stringify(sessionId)} not found`);
				const suggestion: DriftSuggestion | null = await drift.detect(sessionId, cwd, kind);
				return json(200, suggestion);
			} catch (error) {
				return failure(error, options.log);
			}
		}

		const movesMatch = MOVES_ROUTE.exec(url.pathname);
		if (!movesMatch) return undefined;
		if (isWindows) return errorResponse(409, "conflict", "Project moves require the macOS app");
		if (!moves) return undefined;
		try {
			if (!movesMatch[1]) {
				if (req.method === "GET") return json(200, { moves: await moves.list() });
				if (req.method === "POST") return json(201, await moves.prepare(await readMovePrepare(req)));
				return methodNotAllowed(req, "GET", "POST");
			}
			const moveId = decodeSegment(movesMatch[1]);
			if (!moveId) throw new MoveError("invalid move id", "bad-request");
			if (movesMatch[2] === "confirm") {
				if (req.method !== "POST") return methodNotAllowed(req, "POST");
				return json(200, await moves.confirm(moveId, await readMoveConfirm(req)));
			}
			if (movesMatch[2] === "undo") {
				if (req.method !== "POST") return methodNotAllowed(req, "POST");
				await moves.undo(moveId);
				return new Response(null, { status: 204 });
			}
			if (req.method === "GET") return json(200, await moves.detail(moveId));
			return methodNotAllowed(req, "GET");
		} catch (error) {
			return failure(error, options.log);
		}
	};

	return Object.assign(handler, {
		captureSessionBaseline: (sessionId: string, cwd: string) => drift.captureSessionBaseline(sessionId, cwd),
	});
}
