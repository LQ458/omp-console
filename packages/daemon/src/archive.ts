import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "./workspaces/files";
import { sessionPathKey } from "./session-key";

export interface ArchiveRecord {
	archivedAt: number;
	title?: string;
	cwd?: string;
	sessionFile?: string;
	lastActivityAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): ArchiveRecord | undefined {
	if (!isRecord(value) || typeof value.archivedAt !== "number" || !Number.isFinite(value.archivedAt)) return undefined;
	const result: ArchiveRecord = { archivedAt: value.archivedAt };
	for (const key of ["title", "cwd", "sessionFile"] as const) {
		const field = value[key];
		if (field !== undefined) {
			if (typeof field !== "string") return undefined;
			result[key] = field;
		}
	}
	if (value.lastActivityAt !== undefined) {
		if (typeof value.lastActivityAt !== "number" || !Number.isFinite(value.lastActivityAt)) return undefined;
		result.lastActivityAt = value.lastActivityAt;
	}
	return result;
}

function parseState(value: unknown): Map<string, ArchiveRecord> | undefined {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.sessions)) return undefined;
	const records = new Map<string, ArchiveRecord>();
	for (const [id, entry] of Object.entries(value.sessions)) {
		const record = parseRecord(entry);
		if (id === "" || record === undefined) return undefined;
		records.set(id, record);
	}
	return records;
}

function copyRecord(record: ArchiveRecord): ArchiveRecord {
	return { ...record };
}

/** Metadata-only archive index. Session files are never opened or modified here. */
export class ArchiveStore {
	readonly #file: string;
	#records: Map<string, ArchiveRecord>;
	readonly #deleted = new Set<string>();
	#writeTail: Promise<void> = Promise.resolve();

	constructor(file: string, records: Map<string, ArchiveRecord>) {
		this.#file = file;
		this.#records = records;
	}

	static async open(stateDir: string, log: (message: string) => void = () => {}): Promise<ArchiveStore> {
		const file = path.join(stateDir, "archived-sessions.json");
		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return new ArchiveStore(file, new Map());
			throw error;
		}

		let records: Map<string, ArchiveRecord> | undefined;
		try {
			records = parseState(JSON.parse(text) as unknown);
		} catch {
			records = undefined;
		}
		if (records !== undefined) return new ArchiveStore(file, records);

		const corruptFile = `${file}.corrupt-${Date.now()}`;
		let preservationError: string | undefined;
		try {
			await fs.rename(file, corruptFile);
		} catch (error) {
			preservationError = error instanceof Error ? error.message : String(error);
		}
		log(
			preservationError === undefined
				? `archive state is invalid; preserved as ${path.basename(corruptFile)} and starting empty`
				: `archive state is invalid; could not preserve ${path.basename(corruptFile)} (${preservationError}); starting empty`,
		);
		return new ArchiveStore(file, new Map());
	}

	/** Archived, or deleted while this daemon runs (lists cached elsewhere may still name it for a few seconds). */
	isArchived(id: string): boolean {
		return this.#records.has(id) || this.#deleted.has(id);
	}

	get(id: string): ArchiveRecord | undefined {
		const record = this.#records.get(id);
		return record === undefined ? undefined : copyRecord(record);
	}

	list(): Array<{ id: string; record: ArchiveRecord }> {
		return [...this.#records].map(([id, record]) => ({ id, record: copyRecord(record) }));
	}

	async archive(id: string, record: ArchiveRecord): Promise<ArchiveRecord> {
		const nextRecord = copyRecord(record);
		await this.#mutate(records => {
			records.set(id, nextRecord);
		});
		return copyRecord(nextRecord);
	}

	/** Drops a deleted session's record; it stays hidden from card and brief lists until the daemon restarts. */
	async forget(id: string): Promise<boolean> {
		this.#deleted.add(id);
		return this.#mutate(records => records.delete(id));
	}

	/** A deleted session that runs again (its transcript was put back) is no longer hidden. */
	revive(id: string): void {
		this.#deleted.delete(id);
	}

	async restore(id: string): Promise<boolean> {
		return this.#mutate(records => records.delete(id));
	}

	findBySessionFile(sessionFile: string): { id: string; record: ArchiveRecord } | undefined {
		const key = sessionPathKey(sessionFile);
		for (const [id, record] of this.#records) {
			if (record.sessionFile !== undefined && sessionPathKey(record.sessionFile) === key) return { id, record: copyRecord(record) };
		}
		return undefined;
	}

	async #mutate(change: (records: Map<string, ArchiveRecord>) => boolean | void): Promise<boolean> {
		const write = this.#writeTail.then(async () => {
			const next = new Map(this.#records);
			const changed = change(next);
			if (changed === false) return false;
			const sessions = Object.fromEntries(next);
			await atomicWriteFile(this.#file, `${JSON.stringify({ version: 1, sessions })}\n`, 0o600);
			this.#records = next;
			return true;
		});
		this.#writeTail = write.then(() => {}, () => {});
		return write;
	}
}
