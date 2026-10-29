/** Read-only listing of persisted omp sessions (`SessionManager.listAll`) mapped to the control API shape. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import type { SessionSummary } from "@omp-console/protocol";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { listAllSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { sessionPathKey } from "./session-key";

export type RecentSessionLister = () => Promise<SessionSummary[]>;

const TITLE_FALLBACK_CHARS = 80;
/** Prompts sit at the top of a session file; never read more than this to find one. */
const HEAD_BYTES = 64 * 1024;

/**
 * Label for a session without a stored title: the first line of its first user prompt, stripped of harness
 * context blocks (`<system-reminder>...`), collapsed to one line and capped. Undefined when nothing readable remains.
 */
export function titleFromFirstMessage(firstMessage: string | undefined): string | undefined {
	if (!firstMessage) return undefined;
	const text = firstMessage
		.replace(/<([a-z][\w-]*)>[\s\S]*?<\/\1>/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return undefined;
	return text.length > TITLE_FALLBACK_CHARS ? `${text.slice(0, TITLE_FALLBACK_CHARS - 1).trimEnd()}…` : text;
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * First prompt typed into a session, read from the top of its file. Prompts sent from a deck client are stored as
 * `custom_message` entries of type `collab-prompt`, which omp's own `firstMessage` skips, so it would otherwise
 * surface the first tool result of such a session.
 */
export function firstPromptFromHead(head: string): string | undefined {
	for (const line of head.split("\n")) {
		if (!line.startsWith("{")) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // the cut-off last line of a partial read
		}
		if (typeof entry !== "object" || entry === null || !("type" in entry)) continue;
		if (entry.type === "custom_message" && "customType" in entry && entry.customType === "collab-prompt" && "content" in entry) {
			const text = contentText(entry.content);
			if (text) return text;
		}
		if (entry.type === "message" && "message" in entry && typeof entry.message === "object" && entry.message !== null) {
			const message = entry.message;
			if ("role" in message && message.role === "user" && "content" in message) {
				const text = contentText(message.content);
				if (text) return text;
			}
		}
	}
	return undefined;
}


const promptCache = new Map<string, { mtimeMs: number; title: string | undefined }>();

function titleFromFile(file: string, mtimeMs: number): string | undefined {
	const key = sessionPathKey(file);
	const cached = promptCache.get(key);
	if (cached && cached.mtimeMs === mtimeMs) return cached.title;
	let title: string | undefined;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
			title = titleFromFirstMessage(firstPromptFromHead(buffer.toString("utf8", 0, read)));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		title = undefined;
	}
	promptCache.set(key, { mtimeMs, title });
	return title;
}

/** Every persisted session: omp's store, or `OMP_CONSOLE_SESSIONS_DIR` when the daemon runs on a separate one (sandbox). */
export function listSessionInfos(): ReturnType<typeof SessionManager.listAll> {
	const root = process.env.OMP_CONSOLE_SESSIONS_DIR;
	return root ? listAllSessions(new FileSessionStorage(), root) : SessionManager.listAll();
}

let persistedSessionsInFlight: Promise<SessionSummary[]> | undefined;

export class RecentSessionScanError extends Error {
	constructor(directory: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`Could not scan omp sessions in ${directory}: ${detail}`, { cause });
		this.name = "RecentSessionScanError";
	}
}

function sessionDirectoryForError(): string {
	const override = process.env.OMP_CONSOLE_SESSIONS_DIR;
	return override === undefined ? getSessionsDir(getAgentDir()) : path.resolve(override);
}
/**
 * Reads the store and each per-project folder for real (omp's lister swallows read errors and returns an empty list,
 * and an opened-but-unread directory handle does not prove readability), so an unreadable store or project folder is
 * reported instead of looking like "no sessions".
 */
async function sessionDirectoryIsReadable(directory: string): Promise<boolean> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return false;
		throw new RecentSessionScanError(directory, error);
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const bucket = path.join(directory, entry.name);
		try {
			await fs.promises.readdir(bucket);
		} catch (error) {
			if (!isEnoent(error)) throw new RecentSessionScanError(bucket, error);
		}
	}
	return true;
}


async function workingDirectoryExists(cwd: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(cwd)).isDirectory();
	} catch {
		return false;
	}
}

export const listPersistedSessions: RecentSessionLister = () => {
	if (persistedSessionsInFlight) return persistedSessionsInFlight;
	const directory = sessionDirectoryForError();
	const pending = Promise.resolve()
		.then(async () => {
			if (!await sessionDirectoryIsReadable(directory)) return [];
			return listSessionInfos();
		})
		.catch((error: unknown) => {
			if (error instanceof RecentSessionScanError) throw error;
			throw new RecentSessionScanError(directory, error);
		})
		.then(async infos => {
			const cwdExists = new Map<string, Promise<boolean>>();
			const exists = (cwd: string): Promise<boolean> => {
				const key = sessionPathKey(cwd);
				let result = cwdExists.get(key);
				if (result === undefined) {
					result = workingDirectoryExists(cwd);
					cwdExists.set(key, result);
				}
				return result;
			};
			return Promise.all(infos.map(async info => {
				const summary: SessionSummary = {
					id: info.id,
					cwd: info.cwd,
					sessionFile: info.path,
					source: "terminal",
					cwdExists: await exists(info.cwd),
					state: "stopped",
					createdAt: info.created.getTime(),
					lastActivityAt: info.modified.getTime(),
					agentCount: 0,
					goalActive: false,
					awaitingAnswer: false,
				};
				const title = info.title ?? titleFromFile(info.path, info.modified.getTime()) ?? titleFromFirstMessage(info.firstMessage);
				if (title !== undefined) summary.title = title;
				return summary;
			}));
		});
	persistedSessionsInFlight = pending;
	void pending.then(
		() => {
			if (persistedSessionsInFlight === pending) persistedSessionsInFlight = undefined;
		},
		() => {
			if (persistedSessionsInFlight === pending) persistedSessionsInFlight = undefined;
		},
	);
	return pending;
};
