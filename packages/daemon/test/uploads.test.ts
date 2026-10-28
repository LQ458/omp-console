import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type UploadRoutes, createUploadsRoutes, MAX_UPLOAD_BYTES, pruneSessionUploads } from "../src/uploads";

const roots: string[] = [];

function tempDir(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-uploads-"));
	roots.push(directory);
	return directory;
}

function routes(stateDir: string, now = Date.now): UploadRoutes {
	return createUploadsRoutes(stateDir, { isSessionLive: sessionId => sessionId === "session-1", now });
}

function uploadRequest(
	uploads: UploadRoutes,
	name: string | null,
	body: Uint8Array = new Uint8Array(),
	headers: Record<string, string> = {},
): Promise<Response> {
	const query = name === null ? "" : `?name=${encodeURIComponent(name)}`;
	const url = new URL(`/api/sessions/session-1/uploads${query}`, "http://deck.test");
	return uploads.handle(new Request(url.href, { method: "POST", headers, body }), url, "session-1");
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("session uploads", () => {
	it("streams exact bytes into a private session directory and sanitizes separators, leading dots, and NUL", async () => {
		const stateDir = tempDir();
		const uploads = routes(stateDir);
		await uploads.ready;
		const bytes = new Uint8Array([0, 255, 10, 13, 42]);
		const response = await uploadRequest(uploads, "../../..\\invoice\0\u001f.txt", bytes);
		const result = (await response.json()) as { path: string; name: string; size: number };
		const canonicalState = fs.realpathSync(stateDir);

		expect(response.status).toBe(201);
		expect(result.name).toBe("invoice.txt");
		expect(result.size).toBe(bytes.byteLength);
		expect(path.dirname(result.path)).toBe(path.join(canonicalState, "uploads", "session-1"));
		expect(path.basename(result.path)).toMatch(/^\d{8}-\d{6}-invoice\.txt$/);
		expect(fs.readFileSync(result.path)).toEqual(Buffer.from(bytes));
		expect(fs.statSync(path.join(canonicalState, "uploads")).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.dirname(result.path)).mode & 0o777).toBe(0o700);
		expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
	});

	it("accepts the x-file-name header when the query name is absent", async () => {
		const stateDir = tempDir();
		const uploads = routes(stateDir);
		await uploads.ready;
		const response = await uploadRequest(uploads, null, new Uint8Array([4, 5]), { "x-file-name": "scan.pdf" });
		const result = (await response.json()) as { path: string; name: string; size: number };

		expect(response.status).toBe(201);
		expect(result.name).toBe("scan.pdf");
		expect(result.size).toBe(2);
		expect(path.basename(result.path)).toMatch(/^\d{8}-\d{6}-scan\.pdf$/);
	});

	it("uses unique timestamped paths for repeated filenames", async () => {
		const stateDir = tempDir();
		const now = () => Date.UTC(2026, 9, 24, 18, 30, 5);
		const uploads = routes(stateDir, now);
		await uploads.ready;
		const first = await uploadRequest(uploads, "report.txt", new Uint8Array([1]));
		const second = await uploadRequest(uploads, "report.txt", new Uint8Array([2]));
		const firstFile = (await first.json()) as { path: string };
		const secondFile = (await second.json()) as { path: string };

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(path.basename(firstFile.path)).toBe("20261024-183005-report.txt");
		expect(path.basename(secondFile.path)).toBe("20261024-183005-report-1.txt");
		expect(fs.readFileSync(firstFile.path)).toEqual(Buffer.from([1]));
		expect(fs.readFileSync(secondFile.path)).toEqual(Buffer.from([2]));
	});

	it("rejects symlinked upload directories without writing through them", async () => {
		const stateDir = tempDir();
		const outside = tempDir();
		const uploadRoot = path.join(stateDir, "uploads");
		fs.mkdirSync(uploadRoot);
		fs.symlinkSync(outside, path.join(uploadRoot, "session-1"), "dir");
		const uploads = routes(stateDir);
		await uploads.ready;
		const response = await uploadRequest(uploads, "escape.txt", new Uint8Array([1]));

		expect(response.status).toBe(400);
		expect(fs.readdirSync(outside)).toEqual([]);
	});
	it("rejects a symlinked uploads root without writing outside the state directory", async () => {
		const stateDir = tempDir();
		const outside = tempDir();
		fs.symlinkSync(outside, path.join(stateDir, "uploads"), "dir");
		const uploads = routes(stateDir);

		const response = await uploadRequest(uploads, "escape.txt", new Uint8Array([1]));

		expect(response.status).toBe(400);
		expect(fs.readdirSync(outside)).toEqual([]);
	});


	it("rejects a declared body larger than 50 MiB before creating a file", async () => {
		const stateDir = tempDir();
		const uploads = routes(stateDir);
		await uploads.ready;
		const response = await uploadRequest(uploads, "large.bin", new Uint8Array(), {
			"content-length": String(MAX_UPLOAD_BYTES + 1),
		});
		const uploadRoot = path.join(fs.realpathSync(stateDir), "uploads");

		expect(response.status).toBe(413);
		expect(fs.existsSync(uploadRoot)).toBe(false);
	});
	it("rejects an oversized streamed body even when Content-Length is absent", async () => {
		const stateDir = tempDir();
		const uploads = routes(stateDir);
		await uploads.ready;
		const url = new URL("/api/sessions/session-1/uploads?name=large.bin", "http://deck.test");
		let remaining = MAX_UPLOAD_BYTES + 1;
		const chunk = new Uint8Array(1024 * 1024);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (remaining === 0) {
					controller.close();
					return;
				}
				const length = Math.min(chunk.byteLength, remaining);
				controller.enqueue(chunk.subarray(0, length));
				remaining -= length;
			},
		});
		const request = new Request(url.href, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body,
			duplex: "half",
		});

		const response = await uploads.handle(request, url, "session-1");
		const directory = path.join(fs.realpathSync(stateDir), "uploads", "session-1");
		expect(response.status).toBe(413);
		expect(fs.readdirSync(directory)).toEqual([]);
	});
	it("strips bidi and zero-width format characters that could disguise an extension", async () => {
		const stateDir = tempDir();
		const uploads = routes(stateDir);
		await uploads.ready;
		const url = new URL(`/api/sessions/session-1/uploads?name=${encodeURIComponent("photo\u202Egpj.exe\u200B")}`, "http://deck.test");
		const response = await uploads.handle(
			new Request(url.href, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" }),
			url,
			"session-1",
		);
		expect(response.status).toBe(201);
		const { name } = (await response.json()) as { name: string };
		expect(name).toBe("photogpj.exe");
	});

	it("prunes only regular files older than seven days and leaves a symlink target untouched", async () => {
		const stateDir = tempDir();
		const now = Date.UTC(2026, 9, 24, 18, 30, 5);
		const directory = path.join(stateDir, "uploads", "session-1");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const expired = path.join(directory, "expired.txt");
		const current = path.join(directory, "current.txt");
		const external = path.join(tempDir(), "external.txt");
		fs.writeFileSync(expired, "expired");
		fs.writeFileSync(current, "current");
		fs.writeFileSync(external, "keep");
		fs.utimesSync(expired, new Date(now - 7 * 24 * 60 * 60 * 1000 - 1), new Date(now - 7 * 24 * 60 * 60 * 1000 - 1));
		fs.symlinkSync(external, path.join(directory, "linked.txt"));

		const removed = await pruneSessionUploads(stateDir, now);

		expect(removed).toBe(1);
		expect(fs.existsSync(expired)).toBe(false);
		expect(fs.readFileSync(current, "utf8")).toBe("current");
		expect(fs.readFileSync(external, "utf8")).toBe("keep");
	});
	it("prunes expired uploads as route construction starts daemon cleanup", async () => {
		const stateDir = tempDir();
		const now = Date.UTC(2026, 9, 24, 18, 30, 5);
		const directory = path.join(stateDir, "uploads", "session-1");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const expired = path.join(directory, "expired.txt");
		fs.writeFileSync(expired, "expired");
		const old = new Date(now - 7 * 24 * 60 * 60 * 1000 - 1);
		fs.utimesSync(expired, old, old);
		const uploads = routes(stateDir, () => now);

		await uploads.ready;

		expect(fs.existsSync(expired)).toBe(false);
	});


	it("requires a live session before writing", async () => {
		const stateDir = tempDir();
		const uploads = routes(stateDir);
		await uploads.ready;
		const url = new URL("/api/sessions/session-2/uploads?name=ignored.txt", "http://deck.test");
		const response = await uploads.handle(new Request(url.href, { method: "POST", body: new Uint8Array([1]) }), url, "session-2");

		expect(response.status).toBe(404);
		expect(fs.existsSync(path.join(stateDir, "uploads"))).toBe(false);
	});
});
