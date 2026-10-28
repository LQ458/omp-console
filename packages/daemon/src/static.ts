/**
 * Static web serving with SPA fallback.
 *
 * - `index.html`, `sw.js` and every non-hashed file: `Cache-Control: no-cache` (revalidate via ETag).
 * - Content-hashed build assets (`<hash>.js`, `name-<hash>.css`, ...): `public, max-age=31536000, immutable`.
 * - Extension-less paths that match no file fall back to `index.html` for navigations (`Accept: text/html`);
 *   missing files with an extension, and non-navigation requests, are 404 so a stale hashed asset never turns into HTML.
 * - Traversal is impossible by construction: `.`/`..` segments, encoded slashes, backslashes, NUL and empty
 *   interior segments are rejected with 400 before touching the disk, and the final real path (symlinks
 *   resolved) must stay inside the real web root.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addEncodingVary, chooseStaticEncoding, compressBytes, type StaticContentEncoding } from "./compression";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL = "no-cache";

/** 8+ char alphanumeric chunk containing a digit, set off by `-`, `_`, `.` or the start, before the extension. */
const HASHED_NAME_RE = /(?:^|[-._])(?=[a-z0-9]*\d)[a-z0-9]{8,}\.[a-z0-9]+$/i;
const NEVER_HASHED = new Set(["index.html", "sw.js", "manifest.webmanifest", "precache-manifest.json"]);
const HAS_EXTENSION_RE = /\.[A-Za-z0-9]+$/;
const PWA_ASSET_RE = /^(?:sw\.js|manifest\.webmanifest|precache-manifest\.json|apple-touch-icon\.png|icon-.+\.png)$/;
const COMPRESSIBLE_EXTENSIONS = new Set(["css", "html", "js", "json", "map", "mjs", "svg", "txt", "webmanifest"]);
const COMPRESSED_ASSET_CACHE_LIMIT_BYTES = 8 * 1024 * 1024;
const compressedAssetCache = new Map<string, Uint8Array>();
let compressedAssetCacheBytes = 0;

export function isHashedAsset(fileName: string): boolean {
	return !NEVER_HASHED.has(fileName) && HASHED_NAME_RE.test(fileName);
}

function isPwaAssetPath(segments: string[]): boolean {
	return segments.length === 1 && PWA_ASSET_RE.test(segments[0]!);
}

function rawPathOf(req: Request): string {
	const url = req.url;
	const schemeEnd = url.indexOf("//");
	const pathStart = schemeEnd === -1 ? 0 : url.indexOf("/", schemeEnd + 2);
	const rest = pathStart === -1 ? "/" : url.slice(pathStart);
	const cut = rest.search(/[?#]/);
	return cut === -1 ? rest : rest.slice(0, cut);
}

/** Decoded path segments, or `null` when the path could be a traversal attempt. */
function safeSegments(rawPath: string): string[] | null {
	if (!rawPath.startsWith("/")) return null;
	const raw = rawPath.slice(1).split("/");
	const segments: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const piece = raw[i]!;
		if (piece === "" && i === raw.length - 1) continue; // trailing slash
		let decoded: string;
		try {
			decoded = decodeURIComponent(piece);
		} catch {
			return null;
		}
		if (decoded === "" || decoded === "." || decoded === "..") return null;
		if (/[/\\\0]/.test(decoded)) return null;
		segments.push(decoded);
	}
	return segments;
}

function insideRoot(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root + path.sep);
}

async function realFile(root: string, candidate: string): Promise<string | null> {
	try {
		const real = await fs.realpath(candidate);
		if (!insideRoot(root, real)) return null;
		const stat = await fs.stat(real);
		return stat.isFile() ? real : null;
	} catch {
		return null;
	}
}

async function fileResponse(req: Request, file: string): Promise<Response> {
	const handle = Bun.file(file);
	const name = path.basename(file);
	const hashed = isHashedAsset(name);
	const compressible = COMPRESSIBLE_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());
	const baseEtag = `W/"${handle.size}-${Math.trunc(handle.lastModified)}"`;
	const headers = new Headers({
		"Cache-Control": hashed ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
		"Content-Type":
			name === "sw.js"
				? "text/javascript; charset=utf-8"
				: name === "manifest.webmanifest"
					? "application/manifest+json"
					: handle.type,
		"X-Content-Type-Options": "nosniff",
	});
	if (compressible) addEncodingVary(headers);

	const encoding: StaticContentEncoding | null =
		compressible && !req.headers.has("range") ? chooseStaticEncoding(req.headers.get("accept-encoding")) : "identity";
	if (encoding === null) {
		const rejected = plain(406, "not acceptable");
		const rejectedHeaders = new Headers(rejected.headers);
		if (compressible) addEncodingVary(rejectedHeaders);
		return new Response(rejected.body, { status: rejected.status, headers: rejectedHeaders });
	}

	const etag = encoding === "identity" ? baseEtag : `W/"${handle.size}-${Math.trunc(handle.lastModified)}-${encoding}"`;
	if (!hashed) headers.set("ETag", etag);
	if (!hashed && req.headers.get("if-none-match") === etag) {
		if (encoding !== "identity") headers.set("Content-Encoding", encoding);
		return new Response(null, { status: 304, headers });
	}

	if (encoding === "identity") {
		if (req.method === "HEAD") {
			headers.set("Content-Length", String(handle.size));
			return new Response(null, { status: 200, headers });
		}
		return new Response(handle, { status: 200, headers });
	}

	const cacheKey = `${file}\0${baseEtag}\0${encoding}`;
	let compressed = compressedAssetCache.get(cacheKey);
	if (compressed) {
		compressedAssetCache.delete(cacheKey);
		compressedAssetCache.set(cacheKey, compressed);
	} else {
		compressed = compressBytes(new Uint8Array(await handle.arrayBuffer()), encoding);
		if (compressed.byteLength <= COMPRESSED_ASSET_CACHE_LIMIT_BYTES) {
			while (compressedAssetCacheBytes + compressed.byteLength > COMPRESSED_ASSET_CACHE_LIMIT_BYTES) {
				const oldest = compressedAssetCache.entries().next();
				if (oldest.done) break;
				compressedAssetCache.delete(oldest.value[0]);
				compressedAssetCacheBytes -= oldest.value[1].byteLength;
			}
			if (compressedAssetCacheBytes + compressed.byteLength <= COMPRESSED_ASSET_CACHE_LIMIT_BYTES) {
				compressedAssetCache.set(cacheKey, compressed);
				compressedAssetCacheBytes += compressed.byteLength;
			}
		}
	}
	headers.set("Content-Encoding", encoding);
	headers.set("Content-Length", String(compressed.byteLength));
	if (req.method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(compressed, { status: 200, headers });
}

function plain(status: number, text: string): Response {
	return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** Serves `req` from `webDir`; `webDir` need not exist (every path is then 404). */
export async function serveStatic(req: Request, webDir: string | undefined): Promise<Response> {
	if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "method not allowed");
	if (!webDir) return plain(404, "not found");
	const segments = safeSegments(rawPathOf(req));
	if (!segments) return plain(400, "bad path");
	let root: string;
	try {
		root = await fs.realpath(path.resolve(webDir));
	} catch {
		return plain(404, "not found");
	}
	const candidate = path.join(root, ...segments);
	if (!insideRoot(root, candidate)) return plain(400, "bad path");

	let file = await realFile(root, candidate);
	if (!file) file = await realFile(root, path.join(candidate, "index.html"));
	if (file) return fileResponse(req, file);

	const last = segments[segments.length - 1] ?? "";
	// Only browser navigations fall back to the app shell: an API-style or probing client asking for a missing path gets 404.
	if (isPwaAssetPath(segments) || HAS_EXTENSION_RE.test(last) || !req.headers.get("accept")?.includes("text/html")) return plain(404, "not found");
	const index = await realFile(root, path.join(root, "index.html"));
	return index ? fileResponse(req, index) : plain(404, "not found");
}
