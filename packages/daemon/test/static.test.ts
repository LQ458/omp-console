import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import * as path from "node:path";
import { IMMUTABLE_CACHE_CONTROL, isHashedAsset, serveStatic } from "../src/static";
import { rawRequest, startTestDaemon, stopTestDaemons } from "./harness";
import { makeTmp } from "./helpers";

afterEach(stopTestDaemons);

function buildWebDir(): { root: string; outside: string } {
	const base = makeTmp("deck-web-");
	const root = path.join(base, "dist");
	fs.mkdirSync(path.join(root, "assets"), { recursive: true });
	fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>deck</title>");
	fs.writeFileSync(path.join(root, "sw.js"), "self.addEventListener('fetch',()=>{})");
	fs.writeFileSync(path.join(root, "manifest.webmanifest"), "{}");
	fs.writeFileSync(path.join(root, "precache-manifest.json"), "[]");
	fs.writeFileSync(path.join(root, "icon-192.png"), "png");
	fs.writeFileSync(path.join(root, "assets", "c9vz2fn5.js"), "console.log(1)");
	fs.writeFileSync(path.join(root, "assets", "runtime.js"), "const repeated = 'compressible payload';\n".repeat(512));
	fs.writeFileSync(path.join(root, "assets", "app-a1b2c3d4e5.css"), "body{}");
	fs.mkdirSync(path.join(root, "docs"));
	fs.writeFileSync(path.join(root, "docs", "index.html"), "<title>docs</title>");
	// Secrets next to, not inside, the web root.
	fs.writeFileSync(path.join(base, "secret.txt"), "TOP-SECRET");
	fs.symlinkSync(path.join(base, "secret.txt"), path.join(root, "leak.txt"));
	return { root, outside: path.join(base, "secret.txt") };
}

describe("static cache policy", () => {
	it("revalidates index.html and sw.js, and caches hashed assets immutably", async () => {
		const { root } = buildWebDir();
		const t = await startTestDaemon({ webDir: root });
		for (const name of ["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/precache-manifest.json", "/icon-192.png"]) {
			const res = await t.get(name);
			expect({ name, status: res.status, cache: res.headers.get("cache-control") }).toEqual({ name, status: 200, cache: "no-cache" });
		}
		for (const name of ["/assets/c9vz2fn5.js", "/assets/app-a1b2c3d4e5.css"]) {
			const res = await t.get(name);
			expect({ name, status: res.status, cache: res.headers.get("cache-control") }).toEqual({ name, status: 200, cache: IMMUTABLE_CACHE_CONTROL });
		}
		expect((await t.get("/assets/c9vz2fn5.js")).headers.get("content-type")).toContain("javascript");
		expect(await (await t.get("/sw.js")).text()).toContain("addEventListener");
		expect((await t.get("/sw.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect((await t.get("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json");
	});

	it("answers conditional requests with 304 and supports HEAD", async () => {
		const { root } = buildWebDir();
		const t = await startTestDaemon({ webDir: root });
		const first = await t.get("/index.html");
		const etag = first.headers.get("etag")!;
		expect(etag).toBeTruthy();
		const second = await t.get("/index.html", { "If-None-Match": etag });
		expect(second.status).toBe(304);
		expect(second.headers.get("cache-control")).toBe("no-cache");
		const head = await fetch(`${t.url}/index.html`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});

	it("does not mistake ordinary names for content hashes", () => {
		expect(["c9vz2fn5.js", "app-a1b2c3d4e5.css", "chunk.0123abcd.js"].map(isHashedAsset)).toEqual([true, true, true]);
		expect(["index.html", "sw.js", "manifest.webmanifest", "precache-manifest.json", "manifest.json", "register.js", "icon-192.png", "favicon-32x32.png"].map(isHashedAsset)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});
});

describe("static compression", () => {
	it("negotiates br, gzip, and identity variants with independent validators", async () => {
		const { root } = buildWebDir();
		const file = path.join(root, "assets", "runtime.js");
		const original = fs.readFileSync(file);
		const request = (headers: Record<string, string>, method = "GET"): Request =>
			new Request("http://deck/assets/runtime.js", { method, headers });

		const identity = await serveStatic(request({ "Accept-Encoding": "identity" }), root);
		const identityEtag = identity.headers.get("etag")!;
		expect(identity.status).toBe(200);
		expect(identity.headers.get("content-encoding")).toBeNull();
		expect(identity.headers.get("vary")).toContain("Accept-Encoding");
		expect(Buffer.from(await identity.arrayBuffer())).toEqual(original);

		const brotli = await serveStatic(request({ "Accept-Encoding": "br, gzip" }), root);
		const brotliEtag = brotli.headers.get("etag")!;
		const brotliBody = Buffer.from(await brotli.arrayBuffer());
		expect(brotli.status).toBe(200);
		expect(brotli.headers.get("content-encoding")).toBe("br");
		expect(brotli.headers.get("content-length")).toBe(String(brotliBody.byteLength));
		expect(brotliEtag).not.toBe(identityEtag);
		expect(zlib.brotliDecompressSync(brotliBody)).toEqual(original);

		const brotliNotModified = await serveStatic(request({ "Accept-Encoding": "br, gzip", "If-None-Match": brotliEtag }), root);
		expect(brotliNotModified.status).toBe(304);
		expect(brotliNotModified.headers.get("content-encoding")).toBe("br");
		const wrongVariant = await serveStatic(request({ "Accept-Encoding": "gzip", "If-None-Match": brotliEtag }), root);
		expect(wrongVariant.status).toBe(200);

		const gzip = await serveStatic(request({ "Accept-Encoding": "br;q=0, gzip;q=1" }), root);
		const gzipEtag = gzip.headers.get("etag")!;
		const gzipBody = Buffer.from(await gzip.arrayBuffer());
		expect(gzip.headers.get("content-encoding")).toBe("gzip");
		expect(gzipEtag).not.toBe(brotliEtag);
		expect(zlib.gunzipSync(gzipBody)).toEqual(original);
		const gzipNotModified = await serveStatic(request({ "Accept-Encoding": "gzip", "If-None-Match": gzipEtag }), root);
		expect(gzipNotModified.status).toBe(304);
		expect(gzipNotModified.headers.get("content-encoding")).toBe("gzip");

		const identityOnly = await serveStatic(request({ "Accept-Encoding": "br;q=0, gzip;q=0, identity;q=1" }), root);
		expect(identityOnly.headers.get("content-encoding")).toBeNull();
		expect(Buffer.from(await identityOnly.arrayBuffer())).toEqual(original);
		const noCodingAccepted = await serveStatic(request({ "Accept-Encoding": "br;q=0, gzip;q=0, identity;q=0" }), root);
		expect(noCodingAccepted.status).toBe(406);

		const range = await serveStatic(request({ "Accept-Encoding": "gzip", Range: "bytes=0-2" }), root);
		expect(range.headers.get("content-encoding")).toBeNull();
		expect(Buffer.from(await range.arrayBuffer())).toEqual(original);
		const head = await serveStatic(request({ "Accept-Encoding": "gzip" }, "HEAD"), root);
		expect(head.status).toBe(200);
		expect(head.headers.get("content-encoding")).toBe("gzip");
		expect(head.headers.get("content-length")).toBe(gzip.headers.get("content-length"));
		expect(await head.text()).toBe("");

		const image = await serveStatic(new Request("http://deck/icon-192.png", { headers: { "Accept-Encoding": "gzip" } }), root);
		expect(image.headers.get("content-encoding")).toBeNull();
		expect(image.headers.get("vary")).toBeNull();
	});
});

describe("SPA fallback", () => {
	it("serves index.html for client routes, directory indexes for directories, 404 for missing files with extensions", async () => {
		const { root } = buildWebDir();
		const t = await startTestDaemon({ webDir: root });
		const route = await t.get("/sessions/abc123", { Accept: "text/html,application/xhtml+xml" });
		// A non-navigation client (curl, fetch) asking for an unknown extension-less path is not served the shell.
		expect((await t.get("/sessions/abc123")).status).toBe(404);
		expect(route.status).toBe(200);
		expect(await route.text()).toContain("<title>deck</title>");
		expect(await (await t.get("/docs/")).text()).toContain("<title>docs</title>");
		expect((await t.get("/assets/gone1234.js")).status).toBe(404);
		expect((await t.post("/", {})).status).toBe(405);
	});
	it("does not serve the SPA shell for missing PWA resources", async () => {
		const root = makeTmp("deck-web-pwa-missing-");
		fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>deck</title>");
		const t = await startTestDaemon({ webDir: root });
		for (const name of ["/sw.js", "/manifest.webmanifest", "/precache-manifest.json", "/icon-missing.png", "/apple-touch-icon.png"]) {
			const res = await t.get(name, { Accept: "text/html,application/xhtml+xml" });
			expect(res.status).toBe(404);
			expect(await res.text()).not.toContain("<title>deck</title>");
		}
	});

	it("is 404 when no web dir is configured or it is empty", async () => {
		const none = await startTestDaemon({});
		expect((await none.get("/")).status).toBe(404);
		const empty = await startTestDaemon({ webDir: makeTmp("deck-empty-") });
		expect((await empty.get("/anything")).status).toBe(404);
	});
});

describe("static path traversal", () => {
	it("never serves files outside the web root, however the path is encoded", async () => {
		const { root } = buildWebDir();
		const t = await startTestDaemon({ webDir: root });
		const port = t.daemon.port;
		const attempts = [
			"/../secret.txt",
			"/../../etc/passwd",
			"/assets/../../secret.txt",
			"/%2e%2e/secret.txt",
			"/%2E%2E/%2E%2E/etc/passwd",
			"/..%2fsecret.txt",
			"/%2e%2e%2fsecret.txt",
			"/..%5csecret.txt",
			"/assets%2f..%2f..%2fsecret.txt",
			"//etc/passwd",
			"/%2Fetc%2Fpasswd",
			"/%2fetc/passwd",
			"/a%00b",
			"/%c0%af..%c0%afsecret.txt",
			"/%zz",
		];
		for (const target of attempts) {
			const { status, text } = await rawRequest(port, target);
			expect({ target, ok: status === 400 || status === 404 }).toEqual({ target, ok: true });
			expect(text).not.toContain("TOP-SECRET");
			expect(text).not.toContain("root:");
		}
	});

	it("does not follow a symlink that leaves the web root", async () => {
		const { root } = buildWebDir();
		const t = await startTestDaemon({ webDir: root });
		const res = await t.get("/leak.txt");
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("TOP-SECRET");
	});
});

describe("widget frame", () => {
	it("is framable only by deck and lets widget scripts run with no network at all", async () => {
		const { root } = buildWebDir();
		const t = await startTestDaemon({ webDir: root });
		const res = await t.get("/widget-frame.html");
		expect(res.status).toBe(200);
		const csp = res.headers.get("content-security-policy") ?? "";
		const directives = new Map(csp.split(";").map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));
		expect(directives.get("default-src")).toEqual(["'none'"]);
		expect(directives.get("frame-ancestors")).toEqual(["'self'"]);
		expect(directives.get("script-src")).toEqual(["'unsafe-inline'"]);
		// No directive may let a widget reach a server: connect/frame fall back to default-src 'none'.
		expect(directives.has("connect-src")).toBe(false);
		expect(directives.has("frame-src")).toBe(false);
		expect(csp).not.toContain("unsafe-eval");
		// The app's own pages stay unframable and script-locked.
		const app = await t.get("/");
		expect(app.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(app.headers.get("content-security-policy")).toContain("script-src 'self'");
	});
});
