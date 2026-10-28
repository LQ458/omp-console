import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "./workspaces/files";

const TOKEN_BYTES = 32;
const PAIRING_LIFETIME_MS = 10 * 60_000;
const PAIRING_ATTEMPTS = 5;
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface DeviceInfo {
	id: string;
	label: string;
	createdAt: number;
	lastSeenAt: number;
}
interface StoredDevice extends DeviceInfo {
	tokenHash: string;
}



interface ActivePairingCode {
	value: string;
	expiresAt: number;
	attempts: number;
}

export interface PairingCodeInfo {
	code: string;
	expiresAt: number;
}

export type PairResult =
	| { ok: true; device: DeviceInfo; token: string }
	| { ok: false; reason: "wrong" | "expired" | "unavailable" | "invalid-label" };

function tokenDigest(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

/** Constant-time equality for fixed-size SHA-256 digests. */
export function constantTimeHashEqual(expectedHex: string, actual: Uint8Array): boolean {
	if (!/^[a-f0-9]{64}$/.test(expectedHex) || actual.byteLength !== 32) return false;
	return timingSafeEqual(Buffer.from(expectedHex, "hex"), actual);
}

export function isDeviceToken(token: string): boolean {
	if (!TOKEN_RE.test(token)) return false;
	const bytes = Buffer.from(token, "base64url");
	return bytes.byteLength === TOKEN_BYTES && bytes.toString("base64url") === token;
}

function readToken(headers: Headers): string | undefined {
	const authorization = headers.get("authorization");
	let bearer: string | undefined;
	if (authorization !== null) {
		const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
		if (!match || !isDeviceToken(match[1]!)) return undefined;
		bearer = match[1]!;
	}
	let cookie: string | undefined;
	const rawCookie = headers.get("cookie");
	if (rawCookie !== null) {
		for (const item of rawCookie.split(";")) {
			const separator = item.indexOf("=");
			if (separator < 0 || item.slice(0, separator).trim() !== "omc_device") continue;
			if (cookie !== undefined) return undefined;
			const value = item.slice(separator + 1).trim();
			if (!isDeviceToken(value)) return undefined;
			cookie = value;
		}
	}
	return bearer ?? cookie;
}

function newPairingCode(): string {
	const bytes = randomBytes(8);
	let value = "";
	for (const byte of bytes) value += PAIRING_ALPHABET[byte & 31];
	return value;
}

function displayCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function isStoredDevice(value: unknown): value is StoredDevice {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && record.id.length > 0 &&
		typeof record.label === "string" && typeof record.createdAt === "number" && Number.isFinite(record.createdAt) &&
		typeof record.lastSeenAt === "number" && Number.isFinite(record.lastSeenAt) &&
		typeof record.tokenHash === "string" && /^[a-f0-9]{64}$/.test(record.tokenHash);
}

function deviceInfo(device: StoredDevice): DeviceInfo {
	return { id: device.id, label: device.label, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt };
}

export class DeviceAuthStore {
	readonly #filePath: string;
	readonly #pairingPath: string;
	readonly #devices = new Map<string, StoredDevice>();
	readonly #workerTokens = new Map<string, { id: string; digest: Buffer }>();
	/** Devices whose revocation is being saved: no snapshot written meanwhile may contain them. */
	readonly #revoking = new Set<string>();
	#pairing: ActivePairingCode | undefined;
	#persistTail: Promise<void> = Promise.resolve();
	#closed = false;
	readonly #now: () => number;

	private constructor(stateDir: string, now: () => number) {
		this.#filePath = path.join(stateDir, "devices.json");
		this.#pairingPath = path.join(stateDir, "pairing-code");
		this.#now = now;
	}

	static async open(stateDir: string, onStartupCode: (pairing: PairingCodeInfo) => void, now: () => number = Date.now): Promise<DeviceAuthStore> {

		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		const directory = await fs.lstat(stateDir);
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("device state path must be a real directory");
		await fs.chmod(stateDir, 0o700);
		const store = new DeviceAuthStore(stateDir, now);
		try {
			const file = await fs.lstat(store.#filePath);
			if (!file.isFile() || file.isSymbolicLink()) throw new Error("devices.json must be a regular file");
			const parsed: unknown = JSON.parse(await fs.readFile(store.#filePath, "utf8"));
			if (!Array.isArray(parsed) || !parsed.every(isStoredDevice)) throw new Error("devices.json has an invalid format");
			for (const device of parsed) {
				if (store.#devices.has(device.id)) throw new Error("devices.json contains a duplicate device id");
				store.#devices.set(device.id, device);
			}
			await fs.chmod(store.#filePath, 0o600);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		if (store.#devices.size === 0) {
			const pairing = await store.issuePairingCode();
			onStartupCode(pairing);
		} else {
			await fs.rm(store.#pairingPath, { force: true });
		}

		return store;
	}

	get pairedDeviceCount(): number {
		return this.#devices.size;
	}

	list(): DeviceInfo[] {
		return [...this.#devices.values()].map(deviceInfo);
	}

	async authenticate(headers: Headers): Promise<string | undefined> {
		const token = readToken(headers);
		if (token === undefined) return undefined;
		const digest = tokenDigest(token);
		let identity: string | undefined;
		for (const device of this.#devices.values()) {
			if (constantTimeHashEqual(device.tokenHash, digest)) identity = device.id;
		}
		for (const worker of this.#workerTokens.values()) {
			if (timingSafeEqual(worker.digest, digest)) identity = worker.id;
		}
		if (identity === undefined) return undefined;
		const device = this.#devices.get(identity);
		const now = this.#now();
		if (device && now - device.lastSeenAt >= 60_000) {
			device.lastSeenAt = now;
			// `lastSeenAt` is informational: a failed save must not turn every request into an error.
			this.#persist().catch(() => {});
		}
		return identity;
	}

	isActiveIdentity(id: string): boolean {
		if (id.startsWith("worker:")) {
			for (const worker of this.#workerTokens.values()) if (worker.id === id) return true;
			return false;
		}
		return this.#devices.has(id);
	}

	async issuePairingCode(): Promise<PairingCodeInfo> {
		this.#assertOpen();
		const code = newPairingCode();
		const expiresAt = this.#now() + PAIRING_LIFETIME_MS;
		await atomicWriteFile(this.#pairingPath, `${displayCode(code)}\n`, 0o600);
		this.#pairing = { value: code, expiresAt, attempts: 0 };
		return { code: displayCode(code), expiresAt };
	}

	async pair(codeInput: string, labelInput: string): Promise<PairResult> {
		this.#assertOpen();
		if (this.#expirePairingIfNeeded()) {
			await fs.rm(this.#pairingPath, { force: true });
			return { ok: false, reason: "expired" };
		}
		const pairing = this.#pairing;
		if (!pairing) return { ok: false, reason: "unavailable" };
		const code = codeInput.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
		if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) || code !== pairing.value) {
			pairing.attempts++;
			if (pairing.attempts >= PAIRING_ATTEMPTS) await this.#burnPairing();
			return { ok: false, reason: "wrong" };
		}
		const label = labelInput.trim();
		if (!label || label.length > 100) return { ok: false, reason: "invalid-label" };
		const token = randomBytes(TOKEN_BYTES).toString("base64url");
		const now = this.#now();
		const device: StoredDevice = {
			id: randomUUID(),
			label,
			createdAt: now,
			lastSeenAt: now,
			tokenHash: tokenDigest(token).toString("hex"),
		};
		this.#pairing = undefined;
		this.#devices.set(device.id, device);
		try {
			await this.#persist();
			await fs.rm(this.#pairingPath, { force: true });
		} catch (error) {
			this.#devices.delete(device.id);
			throw error;
		}
		return { ok: true, device: deviceInfo(device), token };
	}

	async remove(id: string): Promise<boolean> {
		this.#assertOpen();
		if (!this.#devices.has(id) || this.#revoking.has(id)) return false;
		// Save the revocation first: if the write fails the device stays, so a retry still finds it and a
		// restart can never bring back a device the user saw disappear.
		this.#revoking.add(id);
		try {
			await this.#persist();
			this.#devices.delete(id);
		} finally {
			this.#revoking.delete(id);
		}
		return true;
	}

	createWorkerToken(sessionId: string): string {
		this.#assertOpen();
		const token = randomBytes(TOKEN_BYTES).toString("base64url");
		const id = `worker:${sessionId}:${randomUUID()}`;
		const digest = tokenDigest(token);
		this.#workerTokens.set(digest.toString("hex"), { id, digest });
		return token;
	}

	revokeWorkerToken(token: string): void {
		if (!isDeviceToken(token)) return;
		this.#workerTokens.delete(tokenDigest(token).toString("hex"));
	}

	async expirePairing(): Promise<void> {
		if (this.#expirePairingIfNeeded()) await fs.rm(this.#pairingPath, { force: true });
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#workerTokens.clear();
		// A failed save was already reported to its caller; it must not abort daemon shutdown.
		await this.#persistTail.catch(() => {});
	}

	#expirePairingIfNeeded(): boolean {
		if (this.#pairing && this.#pairing.expiresAt <= this.#now()) {
			this.#pairing = undefined;
			return true;
		}
		return false;
	}

	async #burnPairing(): Promise<void> {
		this.#pairing = undefined;
		await fs.rm(this.#pairingPath, { force: true });
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("device authentication store is closed");
	}

	#persist(): Promise<void> {
		const devices = [...this.#devices.values()].filter(device => !this.#revoking.has(device.id));
		const snapshot = `${JSON.stringify(devices)}\n`;
		const write = this.#persistTail.catch(() => {}).then(() => atomicWriteFile(this.#filePath, snapshot, 0o600));
		this.#persistTail = write;
		return write;
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
