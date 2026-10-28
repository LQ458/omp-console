import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../workspaces/files";

interface PinFile {
	version: 1;
	sessionIds: string[];
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parsePinFile(text: string): PinFile {
	const value: unknown = JSON.parse(text);
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("sessionIds" in value) ||
		!Array.isArray(value.sessionIds) ||
		!value.sessionIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 512)
	) {
		throw new Error("pinned-sessions.json has an unsupported or invalid format");
	}
	return { version: 1, sessionIds: [...new Set(value.sessionIds)] };
}

/** Atomic daemon-state persistence for pin membership. */
export class PinStore {
	#file: string;
	#sessionIds = new Set<string>();
	#ready: Promise<void>;
	#writeTail: Promise<void> = Promise.resolve();
	#log: (message: string) => void;

	constructor(stateDir: string, log: (message: string) => void = () => {}) {
		this.#file = path.join(stateDir, "pinned-sessions.json");
		this.#log = log;
		this.#ready = this.#load().catch(error => {
			this.#log(`pin state could not be loaded; starting empty: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async list(): Promise<string[]> {
		await this.#ready;
		await this.#writeTail;
		return [...this.#sessionIds];
	}

	/** Synchronous membership for hot paths (auto-sleep eligibility); false until the file has loaded. */
	has(sessionId: string): boolean {
		return this.#sessionIds.has(sessionId);
	}

	async set(sessionId: string, pinned: boolean): Promise<boolean> {
		await this.#ready;
		return this.#enqueue(async () => {
			const next = new Set(this.#sessionIds);
			const hadPin = next.has(sessionId);
			if (hadPin === pinned) return pinned;
			if (pinned) next.add(sessionId);
			else next.delete(sessionId);
			const content = `${JSON.stringify({ version: 1, sessionIds: [...next] } satisfies PinFile)}\n`;
			await atomicWriteFile(this.#file, content, 0o600);
			this.#sessionIds = next;
			return pinned;
		});
	}

	async #load(): Promise<void> {
		let text: string;
		try {
			text = await Bun.file(this.#file).text();
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		let parsed: PinFile;
		try {
			parsed = parsePinFile(text);
		} catch {
			const corruptFile = `${this.#file}.corrupt-${Date.now()}`;
			let preservationError: string | undefined;
			try {
				await fs.rename(this.#file, corruptFile);
			} catch (error) {
				preservationError = error instanceof Error ? error.message : String(error);
			}
			this.#log(
				preservationError === undefined
					? `pin state is invalid; preserved as ${path.basename(corruptFile)} and starting empty`
					: `pin state is invalid; could not preserve ${path.basename(corruptFile)} (${preservationError}); starting empty`,
			);
			return;
		}
		this.#sessionIds = new Set(parsed.sessionIds);
		await fs.chmod(this.#file, 0o600);
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.#writeTail.then(operation);
		this.#writeTail = pending.then(() => undefined, () => undefined);
		return pending;
	}
}
