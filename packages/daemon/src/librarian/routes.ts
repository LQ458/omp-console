import type { CardsResponse, ReturnBrief, SessionCard, SetCardTitleRequest } from "@omp-console/protocol";
import { errorResponse, json } from "../api";
import { decodeSegment, failure, methodNotAllowed, readJsonBody, RouteError } from "../session-ops/http";
import type { LibrarianPorts } from "./ports";
import { LibrarianService, MAX_CARD_LIMIT, type LibrarianOptions } from "./service";

const CARDS_ROUTE = "/api/cards";
const REFRESH_ROUTE = "/api/cards/refresh";
const CARD_TITLE_ROUTE = /^\/api\/cards\/([^/]+)\/title(?:\/(undo))?$/;
const BRIEF_ROUTE = "/api/brief";

export interface LibrarianRoutes {
	(req: Request, url: URL): Promise<Response | undefined>;
	dispose(): void;
	/** The session's card title, for notifications. */
	cardTitle(sessionId: string): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(raw: string | null): number | undefined {
	if (raw === null || raw === "") return undefined;
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CARD_LIMIT) {
		throw new RouteError("bad-request", `limit must be an integer from 1 to ${MAX_CARD_LIMIT}`);
	}
	return limit;
}

function parseIncludeScheduled(raw: string | null): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new RouteError("bad-request", "includeScheduled must be true or false");
}

function parseSince(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	const since = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(since)) {
		throw new RouteError("bad-request", "since must be a finite millisecond timestamp");
	}
	return since;
}

export function createLibrarianRoutes(
	ports: LibrarianPorts,
	stateDir: string,
	options: LibrarianOptions = {},
): LibrarianRoutes {
	const service = new LibrarianService(ports, stateDir, options);

	const handler = async (req: Request, url: URL): Promise<Response | undefined> => {
		if (url.pathname === CARDS_ROUTE) {
			try {
				if (req.method !== "GET") return methodNotAllowed(req, "GET");
				const query = {
					limit: parseLimit(url.searchParams.get("limit")),
					workspace: url.searchParams.get("workspace") || undefined,
					includeScheduled: parseIncludeScheduled(url.searchParams.get("includeScheduled")),
				};
				const response: CardsResponse = await service.cards(query);
				return json(200, response);
			} catch (error) {
				return failure(error);
			}
		}

		if (url.pathname === REFRESH_ROUTE) {
			try {
				if (req.method !== "POST") return methodNotAllowed(req, "POST");
				const body = await readJsonBody(req);
				if (body !== undefined && !isRecord(body)) throw new RouteError("bad-request", "body must be an object");
				let sessionIds: string[] | undefined;
				if (isRecord(body) && body.sessionIds !== undefined) {
					if (!Array.isArray(body.sessionIds) || !body.sessionIds.every(id => typeof id === "string" && id.length > 0)) {
						throw new RouteError("bad-request", "sessionIds must be an array of non-empty strings");
					}
					sessionIds = body.sessionIds;
				}
				await service.refresh(sessionIds);
				return json(202, { accepted: true });
			} catch (error) {
				return failure(error);
			}
		}

		const titleMatch = CARD_TITLE_ROUTE.exec(url.pathname);
		if (titleMatch) {
			try {
				if (req.method !== "POST") return methodNotAllowed(req, "POST");
				const sessionId = decodeSegment(titleMatch[1]!);
				if (!sessionId) throw new RouteError("bad-request", "invalid session id");
				if (titleMatch[2] === "undo") {
					const result = await service.undoTitle(sessionId);
					if (result.kind === "not-found") return errorResponse(404, "not-found", "session card not found");
					if (result.kind === "no-history") return errorResponse(409, "conflict", "session card has no title to undo");
					return json(200, result.card);
				}
				const body = await readJsonBody(req);
				if (!isRecord(body) || typeof body.title !== "string") throw new RouteError("bad-request", "title must be a string");
				const title = body.title.trim();
				if (!title || title.length > 200) throw new RouteError("bad-request", "title must contain 1 to 200 characters");
				const request: SetCardTitleRequest = { title };
				const card: SessionCard | undefined = await service.setTitle(sessionId, request.title);
				return card ? json(200, card) : errorResponse(404, "not-found", "session card not found");
			} catch (error) {
				return failure(error);
			}
		}

		if (url.pathname === BRIEF_ROUTE) {
			try {
				if (req.method !== "GET") return methodNotAllowed(req, "GET");
				const response: ReturnBrief = await service.brief(parseSince(url.searchParams.get("since")));
				return json(200, response);
			} catch (error) {
				return failure(error);
			}
		}


		return undefined;
	};
	return Object.assign(handler, { dispose: () => service.dispose(), cardTitle: (sessionId: string) => service.cardTitle(sessionId) });
}
