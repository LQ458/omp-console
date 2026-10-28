/**
 * History:
 *
 *   GET  /api/history?workspace=&q=&limit=   -> HistoryResponse (nodes newest first, or best match first with `q`)
 *   POST /api/sessions/:id/key-points        -> 202; the worker writes the card in the background and it is stored
 *                                               under <stateDir>/history/<id>.json (404 for an unknown or stopped session)
 *
 * The returned handler also carries what main wires into the rest of the daemon: `recordEdge` (handoff, move and
 * plan-run relations), `beforeStop` (the supervisor's stop hook: write a model-generated card while the worker is
 * alive), `beforeSleep` (a model-free transcript checkpoint) and `dispose` (stops the idle summariser).
 */
import type { HistoryEdge } from "@omp-console/protocol";
import { errorResponse, json } from "../api";
import { decodeSegment, failure, methodNotAllowed, RouteError } from "../session-ops/http";
import type { HistoryPorts } from "./ports";
import { DEFAULT_HISTORY_LIMIT, HistoryService, type HistoryOptions, MAX_HISTORY_LIMIT } from "./service";

const HISTORY_ROUTE = /^\/api\/history$/;
const KEY_POINTS_ROUTE = /^\/api\/sessions\/([^/]+)\/key-points$/;

export interface HistoryRoutes {
	(req: Request, url: URL): Promise<Response | undefined>;
	recordEdge(edge: HistoryEdge): Promise<void>;
	beforeStop(sessionId: string): Promise<void>;
	beforeSleep(sessionId: string): Promise<void>;
	dispose(): void;
}

function parseLimit(raw: string | null): number | undefined {
	if (raw === null || raw === "") return undefined;
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
		throw new RouteError("bad-request", `limit must be an integer from 1 to ${MAX_HISTORY_LIMIT} (default ${DEFAULT_HISTORY_LIMIT})`);
	}
	return limit;
}

export function createHistoryRoutes(ports: HistoryPorts, stateDir: string, options: HistoryOptions = {}): HistoryRoutes {
	const service = new HistoryService(ports, stateDir, options);
	const log = options.log ?? (() => {});

	const handler = async (req: Request, url: URL): Promise<Response | undefined> => {
		if (HISTORY_ROUTE.test(url.pathname)) {
			try {
				if (req.method !== "GET") return methodNotAllowed(req, "GET");
				const workspace = url.searchParams.get("workspace") ?? undefined;
				const q = url.searchParams.get("q") ?? undefined;
				return json(200, await service.graph({ workspace, q, limit: parseLimit(url.searchParams.get("limit")) }));
			} catch (error) {
				return failure(error);
			}
		}
		const match = KEY_POINTS_ROUTE.exec(url.pathname);
		if (!match) return undefined;
		try {
			if (req.method !== "POST") return methodNotAllowed(req, "POST");
			const sessionId = decodeSegment(match[1]!);
			if (!sessionId) throw new RouteError("bad-request", "invalid session id");
			if (!ports.list().some(session => session.id === sessionId)) {
				return errorResponse(404, "not-found", `no live session ${sessionId}`);
			}
			// The model call takes seconds; the caller polls the history for the new card.
			void service.summarize(sessionId).catch(error => log(`history: key points for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`));
			return json(202, { sessionId });
		} catch (error) {
			return failure(error);
		}
	};

	return Object.assign(handler, {
		recordEdge: (edge: HistoryEdge) => service.recordEdge(edge),
		beforeStop: (sessionId: string) => service.summarizeBeforeStop(sessionId),
		beforeSleep: (sessionId: string) => service.beforeSleep(sessionId),
		dispose: () => service.dispose(),
	});
}
