import * as zlib from "node:zlib";

export type StaticContentEncoding = "br" | "gzip" | "identity";
type CompressedEncoding = Exclude<StaticContentEncoding, "identity">;

const QUALITY_RE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
const JSON_COMPRESSION_THRESHOLD_BYTES = 1024;
const BROTLI_AVAILABLE = typeof zlib.brotliCompressSync === "function";

function qualityValue(raw: string): number {
	const value = raw.trim();
	return QUALITY_RE.test(value) ? Number(value) : 0;
}

/** Returns an explicit quality, wildcard quality, or the identity default for one coding. */
export function encodingQuality(header: string | null, coding: StaticContentEncoding): number {
	if (header === null || header.trim() === "") return coding === "identity" ? 1 : 0;

	let explicit = -1;
	let wildcard = -1;
	let start = 0;
	while (start < header.length) {
		const comma = header.indexOf(",", start);
		const end = comma === -1 ? header.length : comma;
		const item = header.slice(start, end);
		const semicolon = item.indexOf(";");
		const name = (semicolon === -1 ? item : item.slice(0, semicolon)).trim().toLowerCase();
		let quality = 1;
		let parameterStart = semicolon;
		while (parameterStart !== -1 && parameterStart < item.length) {
			const next = item.indexOf(";", parameterStart + 1);
			const parameter = item.slice(parameterStart + 1, next === -1 ? item.length : next);
			const equals = parameter.indexOf("=");
			if (equals !== -1 && parameter.slice(0, equals).trim().toLowerCase() === "q") {
				quality = qualityValue(parameter.slice(equals + 1));
			}
			parameterStart = next;
		}

		if (name === "*") wildcard = Math.max(wildcard, quality);
		else if (name === coding) explicit = Math.max(explicit, quality);
		start = end + 1;
	}

	if (explicit !== -1) return explicit;
	if (coding === "identity") return wildcard === 0 ? 0 : 1;
	return wildcard === -1 ? 0 : wildcard;
}

export function chooseStaticEncoding(header: string | null): StaticContentEncoding | null {
	const br = BROTLI_AVAILABLE ? encodingQuality(header, "br") : 0;
	const gzip = encodingQuality(header, "gzip");
	const identity = encodingQuality(header, "identity");
	if (br > 0 && br >= gzip && br >= identity) return "br";
	if (gzip > 0 && gzip >= identity) return "gzip";
	if (identity > 0) return "identity";
	if (br > 0) return "br";
	if (gzip > 0) return "gzip";
	return null;
}

export function compressBytes(bytes: Uint8Array, encoding: CompressedEncoding): Uint8Array {
	if (encoding === "br") {
		return zlib.brotliCompressSync(bytes, {
			params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
		});
	}
	return zlib.gzipSync(bytes, { level: zlib.constants.Z_BEST_SPEED });
}

export function addEncodingVary(headers: Headers): void {
	const value = headers.get("vary");
	if (value?.split(",").some(token => token.trim() === "*" || token.trim().toLowerCase() === "accept-encoding")) return;
	headers.set("Vary", value ? `${value}, Accept-Encoding` : "Accept-Encoding");
}

function responseWithHeaders(response: Response, headers: Headers): Response {
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Compresses eligible daemon API JSON; callers keep non-API and streaming responses out of this path. */
export async function compressApiJsonResponse(req: Request, response: Response): Promise<Response> {
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") return response;
	if (response.headers.has("content-encoding")) return response;

	const headers = new Headers(response.headers);
	addEncodingVary(headers);
	if (
		req.method === "HEAD" ||
		response.body === null ||
		response.status === 204 ||
		response.status === 304 ||
		encodingQuality(req.headers.get("accept-encoding"), "gzip") === 0
	) {
		return responseWithHeaders(response, headers);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength < JSON_COMPRESSION_THRESHOLD_BYTES) {
		return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
	}

	const compressed = compressBytes(bytes, "gzip");
	headers.set("Content-Encoding", "gzip");
	headers.delete("Content-Length");
	return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
}
