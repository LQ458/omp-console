import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PairingCodeInfo } from "./device-auth";
import { atomicWriteFile } from "./workspaces/files";

const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

interface PairingRequest {
	id: string;
	createdAt: number;
}

interface PairingResponse extends PairingCodeInfo {
	id: string;
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("pairing control path must be a real directory");
	await fs.chmod(directory, 0o700);
}

/** The CLI writes a one-shot 0600 file; the daemon watches only its own state directory. */
export async function requestPairingCode(stateDir: string): Promise<PairingCodeInfo> {
	const directory = path.join(stateDir, "pair-requests");
	await ensurePrivateDirectory(directory);
	const id = randomUUID();
	const requestPath = path.join(directory, `${id}.request`);
	const responsePath = path.join(directory, `${id}.response`);
	await atomicWriteFile(requestPath, `${JSON.stringify({ id, createdAt: Date.now() } satisfies PairingRequest)}\n`, 0o600);
	const expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
	try {
		while (Date.now() < expiresAt) {
			try {
				const parsed: unknown = JSON.parse(await fs.readFile(responsePath, "utf8"));
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					const record = parsed as Record<string, unknown>;
					if (record.id === id && typeof record.code === "string" && typeof record.expiresAt === "number") {
						return { code: record.code, expiresAt: record.expiresAt };
					}
					if (record.id === id && typeof record.error === "string") throw new Error(record.error);
				}
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			await Bun.sleep(POLL_INTERVAL_MS);
		}
		throw new Error("no running daemon answered the local pairing request within 30 seconds");
	} finally {
		await Promise.all([
			fs.rm(requestPath, { force: true }),
			fs.rm(responsePath, { force: true }),
		]);
	}
}

export class PairingRequestWatcher {
	readonly #directory: string;
	readonly #store: { issuePairingCode(): Promise<PairingCodeInfo>; expirePairing(): Promise<void> };
	#timer: Timer | undefined;
	#running: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(stateDir: string, store: { issuePairingCode(): Promise<PairingCodeInfo>; expirePairing(): Promise<void> }) {
		this.#directory = path.join(stateDir, "pair-requests");
		this.#store = store;
	}

	async start(): Promise<void> {
		await ensurePrivateDirectory(this.#directory);
		await this.#poll();
		this.#timer = setInterval(() => {
			this.#running = this.#running.then(() => this.#poll()).catch(() => {});
		}, POLL_INTERVAL_MS);
		this.#timer.unref();
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#timer) clearInterval(this.#timer);
		await this.#running;
	}

	async #poll(): Promise<void> {
		if (this.#closed) return;
		await this.#store.expirePairing().catch(() => {});
		let entries: string[];
		try {
			entries = await fs.readdir(this.#directory);
		} catch {
			return;
		}
		for (const name of entries) {
			if (!/^[0-9a-f-]{36}\.request$/.test(name)) continue;
			const requestPath = path.join(this.#directory, name);
			const responsePath = requestPath.replace(/\.request$/, ".response");
			let request: PairingRequest;
			try {
				const stat = await fs.lstat(requestPath);
				if (
					!stat.isFile() ||
					stat.isSymbolicLink() ||
					(stat.mode & 0o777) !== 0o600 ||
					Date.now() - stat.mtimeMs > REQUEST_TIMEOUT_MS
				) {
					await fs.rm(requestPath, { force: true });
					continue;
				}
				const value: unknown = JSON.parse(await fs.readFile(requestPath, "utf8"));
				if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid request");
				const record = value as Record<string, unknown>;
				const id = name.slice(0, -".request".length);
				if (record.id !== id || typeof record.createdAt !== "number" || Date.now() - record.createdAt > REQUEST_TIMEOUT_MS) {
					throw new Error("expired request");
				}
				request = { id, createdAt: record.createdAt };
			} catch {
				await fs.rm(requestPath, { force: true });
				continue;
			}
			await fs.rm(requestPath, { force: true });
			try {
				const code = await this.#store.issuePairingCode();
				const response: PairingResponse = { id: request.id, ...code };
				await atomicWriteFile(responsePath, `${JSON.stringify(response)}\n`, 0o600);
			} catch {
				await atomicWriteFile(responsePath, `${JSON.stringify({ id: request.id, error: "could not issue a pairing code" })}\n`, 0o600);
			}
		}
	}
}
