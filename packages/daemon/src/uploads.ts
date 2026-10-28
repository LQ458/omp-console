import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { assertNoSymlinkPath, isEnoent, MoveFileError } from "./safety/files";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME_BYTES = 220;
const MAX_NAME_COLLISIONS = 10_000;

export interface SessionUploadResponse {
	path: string;
	name: string;
	size: number;
}

export interface UploadRoutesOptions {
	isSessionLive(sessionId: string): boolean;
	now?: () => number;
	log?: (message: string) => void;
}

export interface UploadRoutes {
	/** Starts pruning as soon as the daemon constructs its API routes; upload requests await completion. */
	ready: Promise<void>;
	handle(req: Request, url: URL, sessionId: string): Promise<Response>;
}

type UploadErrorCode = "bad-request" | "not-found" | "conflict" | "internal";

class UploadFault extends Error {
	constructor(
		readonly status: number,
		readonly code: UploadErrorCode,
		message: string,
	) {
		super(message);
	}
}

function errorResponse(status: number, code: UploadErrorCode, error: string): Response {
	return new Response(JSON.stringify({ error, code }), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function json(status: number, body: SessionUploadResponse): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function assertSafePath(target: string, allowMissingTail: boolean): Promise<void> {
	try {
		await assertNoSymlinkPath(target, allowMissingTail);
	} catch (error) {
		if (error instanceof MoveFileError) throw new UploadFault(400, "bad-request", "upload path contains a symlink");
		throw error;
	}
}

function validSessionId(sessionId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

function fitName(name: string, maxBytes: number): string {
	const extension = path.extname(name);
	const stem = extension === "" ? name : name.slice(0, -extension.length);
	const extensionBytes = Buffer.byteLength(extension, "utf8");
	if (extensionBytes >= maxBytes) throw new UploadFault(400, "bad-request", "file extension is too long");
	let result = "";
	for (const point of stem) {
		if (Buffer.byteLength(result, "utf8") + Buffer.byteLength(point, "utf8") + extensionBytes > maxBytes) break;
		result += point;
	}
	return `${result || "upload"}${extension}`;
}

function sanitizeName(raw: string): string {
	// Path separators, control characters and bidi/zero-width format characters (a U+202E override can disguise
	// `photo‮gpj.exe` as `photoexe.jpg`) never reach the stored name.
	const stripped = raw
		.replace(/[\\/]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
		.replace(/^\.+/, "")
		.trim();
	return fitName(stripped || "upload", MAX_NAME_BYTES);
}

function timestamp(now: number): string {
	return new Date(now).toISOString().slice(0, 19).replaceAll("-", "").replace("T", "-").replaceAll(":", "");
}

function collisionName(stamp: string, name: string, collision: number): string {
	const extension = path.extname(name);
	const stem = extension === "" ? name : name.slice(0, -extension.length);
	const suffix = collision === 0 ? "" : `-${collision}`;
	return `${stamp}-${stem}${suffix}${extension}`;
}

async function ensureUploadDirectory(directory: string): Promise<void> {
	await assertSafePath(directory, true);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await assertSafePath(directory, false);
	const info = await fs.lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new UploadFault(400, "bad-request", "upload path is not a directory");
	await fs.chmod(directory, 0o700);
}

/** Removes expired regular files without following any directory or file symlink. */
export async function pruneSessionUploads(stateDir: string, now = Date.now()): Promise<number> {
	const root = path.join(await fs.realpath(path.resolve(stateDir)), "uploads");
	await assertSafePath(root, true);
	try {
		const rootInfo = await fs.lstat(root);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new UploadFault(400, "bad-request", "upload path is not a directory");
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}
	const sessions = await fs.readdir(root, { withFileTypes: true });
	let removed = 0;
	for (const entry of sessions) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const directory = path.join(root, entry.name);
		await assertSafePath(directory, false);
		const directoryInfo = await fs.lstat(directory);
		if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) continue;
		for (const file of await fs.readdir(directory, { withFileTypes: true })) {
			if (!file.isFile() || file.isSymbolicLink()) continue;
			const target = path.join(directory, file.name);
			const info = await fs.lstat(target);
			if (!info.isFile() || info.isSymbolicLink() || now - info.mtimeMs <= UPLOAD_RETENTION_MS) continue;
			await fs.unlink(target);
			removed++;
		}
	}
	return removed;
}

async function writeUpload(req: Request, url: URL, stateDir: string, sessionId: string, now: number): Promise<Response> {
	if (!validSessionId(sessionId)) throw new UploadFault(400, "bad-request", "invalid session id");
	const nameInput = req.headers.get("x-file-name") ?? url.searchParams.get("name");
	if (nameInput === null || nameInput === "") throw new UploadFault(400, "bad-request", "file name is required");
	const name = sanitizeName(nameInput);
	const contentLength = req.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared < 0) throw new UploadFault(400, "bad-request", "invalid content length");
		if (declared > MAX_UPLOAD_BYTES) throw new UploadFault(413, "bad-request", "file exceeds 50 MiB");
	}

	const root = path.join(await fs.realpath(path.resolve(stateDir)), "uploads");
	const directory = path.join(root, sessionId);
	await ensureUploadDirectory(root);
	await ensureUploadDirectory(directory);

	const stamp = timestamp(now);
	let filePath: string | null = null;
	let handle: fs.FileHandle | null = null;
	let complete = false;
	const reader = req.body?.getReader();
	let size = 0;
	try {
		for (let collision = 0; collision < MAX_NAME_COLLISIONS; collision++) {
			const candidate = path.join(directory, collisionName(stamp, name, collision));
			try {
				handle = await fs.open(
					candidate,
					fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW,
					0o600,
				);
				filePath = candidate;
				break;
			} catch (error) {
				if (isCode(error, "EEXIST")) continue;
				throw error;
			}
		}
		if (handle === null || filePath === null) throw new UploadFault(409, "conflict", "could not allocate a unique upload name");

		if (reader !== undefined) {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (size + value.byteLength > MAX_UPLOAD_BYTES) {
					await reader.cancel().catch(() => {});
					throw new UploadFault(413, "bad-request", "file exceeds 50 MiB");
				}
				let offset = 0;
				while (offset < value.byteLength) {
					const result = await handle.write(value, offset, value.byteLength - offset);
					if (result.bytesWritten === 0) throw new Error("upload write made no progress");
					offset += result.bytesWritten;
				}
				size += value.byteLength;
			}
		}
		await handle.close();
		handle = null;
		complete = true;
		return json(201, { path: filePath, name, size });
	} finally {
		// Remove a partial file before anything that can throw (releaseLock throws after a cancelled read).
		if (handle !== null) await handle.close().catch(() => {});
		if (!complete && filePath !== null) await fs.unlink(filePath).catch(() => {});
		if (reader !== undefined) {
			try {
				reader.releaseLock();
			} catch {
				// Already cancelled or errored: nothing left to release.
			}
		}
	}
}

export function createUploadsRoutes(stateDir: string, options: UploadRoutesOptions): UploadRoutes {
	const now = options.now ?? Date.now;
	// A failed prune is logged and never blocks uploads: old files simply stay until the next start.
	const ready = pruneSessionUploads(stateDir, now()).then(
		() => undefined,
		() => {
			options.log?.("session upload pruning failed");
		},
	);
	return {
		ready,
		async handle(req, url, sessionId) {
			try {
				await ready;
				if (!options.isSessionLive(sessionId)) throw new UploadFault(404, "not-found", `no live session ${sessionId}`);
				return await writeUpload(req, url, stateDir, sessionId, now());
			} catch (error) {
				if (error instanceof UploadFault) return errorResponse(error.status, error.code, error.message);
				options.log?.("session upload failed");
				return errorResponse(500, "internal", "internal error");
			}
		},
	};
}
