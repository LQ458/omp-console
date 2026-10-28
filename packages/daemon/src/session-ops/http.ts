/**
 * HTTP plumbing shared by the session-ops, plugins and history route modules: error mapping and path-segment
 * decoding. Same shapes as `plans/routes.ts`; kept here so these three areas do not each carry a copy.
 */
import type { ApiError } from "@omp-console/protocol";
import { errorResponse } from "../api";

/** Thrown by a route module for a request it refuses (malformed body, bad path segment). */
export class RouteError extends Error {
	constructor(
		readonly code: Extract<ApiError["code"], "bad-request" | "not-found" | "conflict">,
		message: string,
	) {
		super(message);
		this.name = "RouteError";
	}
}

export function statusForCode(code: ApiError["code"]): number {
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

/** One path segment, URL-decoded; `undefined` for an empty segment or one that smuggles a separator. */
export function decodeSegment(value: string): string | undefined {
	try {
		const decoded = decodeURIComponent(value);
		return decoded.length > 0 && !decoded.includes("/") && !decoded.includes("\\") ? decoded : undefined;
	} catch {
		return undefined;
	}
}

/** Maps a thrown `RouteError` or a port/supervisor error carrying an `ApiError` code to its response. */
export function failure(error: unknown): Response {
	if (error instanceof Error && "code" in error) {
		const code = error.code;
		if (code === "bad-request" || code === "not-found" || code === "conflict" || code === "internal") {
			return errorResponse(statusForCode(code), code, error.message);
		}
	}
	return errorResponse(500, "internal", "internal error");
}

export function methodNotAllowed(req: Request, ...methods: string[]): Response {
	return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: methods.join(", ") });
}

const MAX_BODY_BYTES = 256 * 1024;

/** The request body as JSON; an empty body is `undefined`. */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > maxBytes) throw new RouteError("bad-request", "request body too large");
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new RouteError("bad-request", "request body too large");
	if (bytes.byteLength === 0) return undefined;
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new RouteError("bad-request", "body must be valid JSON");
	}
}
