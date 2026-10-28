/**
 * `POST /api/sessions/:id/ops`: one validated session operation; the worker runs it through omp's own session API.
 * This module validates the body and maps worker refusals (`bad-request`, `conflict`, `not-found`) to HTTP status.
 */
import { json } from "../api";
import { decodeSegment, failure, methodNotAllowed, readJsonBody, RouteError } from "./http";
import type { SessionOpsPorts } from "./ports";
import { parseSessionOp } from "./validate";

const OPS_ROUTE = /^\/api\/sessions\/([^/]+)\/ops$/;

export function createSessionOpsRoutes(ports: SessionOpsPorts): (req: Request, url: URL) => Promise<Response | undefined> {
	return async (req, url) => {
		const match = OPS_ROUTE.exec(url.pathname);
		if (!match) return undefined;
		try {
			if (req.method !== "POST") return methodNotAllowed(req, "POST");
			const sessionId = decodeSegment(match[1]!);
			if (!sessionId) throw new RouteError("bad-request", "invalid session id");
			const op = parseSessionOp(await readJsonBody(req));
			return json(200, await ports.sessionOp(sessionId, op, req.signal));
		} catch (error) {
			return failure(error);
		}
	};
}
