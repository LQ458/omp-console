import type { CacheWarmingRequest, QuotaResponse, SpawnEstimate } from "@omp-console/protocol";
import { errorResponse, json } from "../api";
import { EquivalenceValidationError } from "./equivalence";
import { QuotaController, type QuotaControllerOptions } from "./controller";
import type { QuotaPorts } from "./ports";

const QUOTA_PATH = "/api/quota";
const ESTIMATE_PATH = "/api/quota/estimate";
const EQUIVALENCE_PATH = "/api/quota/equivalence";
const CACHE_WARMING_PATH = "/api/quota/cache-warming";

class QuotaRequestError extends Error {}

function methodNotAllowed(req: Request, ...methods: string[]): Response {
	return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: methods.join(", ") });
}


function failure(error: unknown): Response {
	if (error instanceof EquivalenceValidationError || error instanceof QuotaRequestError) {
		return errorResponse(400, "bad-request", error.message);
	}
	return errorResponse(500, "internal", "internal error");
}

async function readJson(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw new QuotaRequestError("body must be valid JSON");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cacheWarmingBody(raw: unknown): CacheWarmingRequest {
	if (
		!isRecord(raw) ||
		Object.keys(raw).some(key => key !== "mode") ||
		(raw.mode !== "off" && raw.mode !== "streaming" && raw.mode !== "idle")
	) {
		throw new QuotaRequestError('body must be {"mode":"off"|"streaming"|"idle"}');
	}
	return { mode: raw.mode };
}

export interface QuotaRouteHandler {
	(req: Request, url: URL): Promise<Response | undefined>;
	close(): Promise<void>;
	/** Poll usage and re-run pacing now (the daemon calls this on a timer while sessions are live). */
	refresh(): Promise<QuotaResponse>;
}

export function createQuotaRoutes(
	ports: QuotaPorts,
	stateDir: string,
	options?: QuotaControllerOptions,
): QuotaRouteHandler {
	const controller = new QuotaController(ports, stateDir, options);
	const route = async (req: Request, url: URL): Promise<Response | undefined> => {
		if (url.pathname === QUOTA_PATH) {
			if (req.method !== "GET") return methodNotAllowed(req, "GET");
			try {
				const body: QuotaResponse = await controller.refresh();
				return json(200, body);
			} catch (error) {
				return failure(error);
			}
		}
		if (url.pathname === ESTIMATE_PATH) {
			if (req.method !== "GET") return methodNotAllowed(req, "GET");
			const profile = url.searchParams.get("profile");
			const model = url.searchParams.get("model");
			if (!profile?.trim() || !model?.trim()) return errorResponse(400, "bad-request", "profile and model are required");
			try {
				const body: SpawnEstimate = await controller.estimate(profile, model);
				return json(200, body);
			} catch (error) {
				return failure(error);
			}
		}
		if (url.pathname === EQUIVALENCE_PATH) {
			if (req.method !== "PUT") return methodNotAllowed(req, "PUT");
			try {
				const body = await readJson(req);
				await controller.setEquivalence(body);
				return new Response(null, { status: 204 });
			} catch (error) {
				return failure(error);
			}
		}
		if (url.pathname === CACHE_WARMING_PATH) {
			if (req.method !== "PUT") return methodNotAllowed(req, "PUT");
			try {
				const { mode } = cacheWarmingBody(await readJson(req));
				await controller.setCacheWarming(mode);
				return new Response(null, { status: 204 });
			} catch (error) {
				return failure(error);
			}
		}
		return undefined;
	};
	return Object.assign(route, { close: () => controller.close(), refresh: () => controller.refresh() });
}
