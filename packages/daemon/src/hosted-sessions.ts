import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "./workspaces/files";
import { sessionPathKey } from "./session-key";

/**
 * Canonical comparison key for a session file. POSIX retains the historical real-parent-plus-name spelling; Windows
 * resolves the complete native path to collapse junctions and 8.3 aliases.
 */
export function canonicalSessionFile(file: string): string {
	const directory = path.dirname(file);
	try {
		return sessionPathKey(path.join(realpathSync(directory), path.basename(file)));
	} catch {
		return sessionPathKey(path.resolve(file));
	}
}

/**
 * Session files this daemon has hosted. A saved session in the shared omp store that is not in this set was started by
 * terminal omp (or another client), may still be open there, and must be opened as a copy, never resumed in place.
 */
export class HostedSessionStore {
	readonly #file: string;
	readonly #files: Set<string>;
	#writeTail: Promise<void> = Promise.resolve();

	private constructor(file: string, files: Set<string>) {
		this.#file = file;
		this.#files = files;
	}

	static async open(stateDir: string): Promise<HostedSessionStore> {
		const file = path.join(stateDir, "hosted-sessions.json");
		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		let files = new Set<string>();
		try {
			const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
			if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { files?: unknown }).files)) {
				files = new Set((parsed as { files: unknown[] }).files.filter((item): item is string => typeof item === "string").map(canonicalSessionFile));
			}
		} catch {
			// Absent, unreadable or corrupt state only means saved sessions open as copies until they are hosted again:
			// the safe direction, so it never stops the daemon from starting.
		}
		return new HostedSessionStore(file, files);
	}

	has(sessionFile: string): boolean {
		return this.#files.has(canonicalSessionFile(sessionFile));
	}

	/** Records the files of sessions this daemon is hosting now; persists only when something new appears. */
	remember(sessionFiles: Iterable<string>): Promise<void> {
		let changed = false;
		for (const raw of sessionFiles) {
			const file = canonicalSessionFile(raw);
			if (!this.#files.has(file)) {
				this.#files.add(file);
				changed = true;
			}
		}
		if (!changed) return this.#writeTail;
		const snapshot = `${JSON.stringify({ version: 1, files: [...this.#files] })}\n`;
		this.#writeTail = this.#writeTail.then(() => atomicWriteFile(this.#file, snapshot, 0o600)).catch(() => {});
		return this.#writeTail;
	}
}
