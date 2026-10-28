/**
 * Local usage journal and in-place feedback (spec 0.5 / 0.6): append-only JSONL under the daemon state dir.
 *
 *   journal.jsonl   one `JournalEvent` per line
 *   feedback.jsonl  one `FeedbackEntry` per line
 *
 * Both files are created mode 0600. When an append would take a file past `maxFileBytes` (10 MB) it becomes
 * `<name>.1` (replacing the previous `.1`: one previous generation is kept) and a fresh file starts.
 *
 * Nothing but fixed identifiers is accepted: every field is validated against a closed set of keys, short
 * length limits and enums, and unknown keys are dropped before anything touches disk, so a client bug cannot
 * leak prompt text, file contents or credentials into the journal through extra fields.
 */
import type { FeedbackEntry, JournalEvent, JournalResponse } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_JOURNAL_EVENTS_PER_CALL = 200;
export const MAX_IDENTIFIER_LENGTH = 64;
export const MAX_DETAIL_LENGTH = 120;
export const MAX_SESSION_ID_LENGTH = 128;
export const MAX_FEEDBACK_LENGTH = 2000;
export const DEFAULT_JOURNAL_MAX_FILE_BYTES = 10 * 1024 * 1024;

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "error", "abandoned"]);
const VIA: ReadonlySet<string> = new Set(["catalog", "suggestion", "palette", "graph", "composer", "direct"]);
/** Largest timestamp a JavaScript `Date` represents. */
const MAX_TIMESTAMP = 8.64e15;
const MAX_LATENCY_MS = 24 * 60 * 60 * 1000;

export class JournalValidationError extends Error {
	override readonly name = "JournalValidationError";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(source: Record<string, unknown>, key: string, max: number, where: string): string {
	const value = source[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new JournalValidationError(`${where}.${key} must be a non-empty string`);
	}
	if (value.length > max) throw new JournalValidationError(`${where}.${key} must be at most ${max} characters`);
	return value;
}

function optionalText(source: Record<string, unknown>, key: string, max: number, where: string): string | undefined {
	if (source[key] === undefined) return undefined;
	const value = source[key];
	if (typeof value !== "string") throw new JournalValidationError(`${where}.${key} must be a string`);
	if (value.length > max) throw new JournalValidationError(`${where}.${key} must be at most ${max} characters`);
	return value === "" ? undefined : value;
}

function timestamp(source: Record<string, unknown>, where: string): number {
	const at = source.at;
	if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > MAX_TIMESTAMP) {
		throw new JournalValidationError(`${where}.at must be a millisecond timestamp`);
	}
	return at;
}

export function parseJournalEvent(raw: unknown, where = "event"): JournalEvent {
	if (!isObject(raw)) throw new JournalValidationError(`${where} must be an object`);
	const outcome = raw.outcome;
	if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
		throw new JournalValidationError(`${where}.outcome must be ok, error or abandoned`);
	}
	const event: JournalEvent = {
		at: timestamp(raw, where),
		feature: requiredText(raw, "feature", MAX_IDENTIFIER_LENGTH, where),
		action: requiredText(raw, "action", MAX_IDENTIFIER_LENGTH, where),
		outcome: outcome as JournalEvent["outcome"],
	};
	if (raw.latencyMs !== undefined) {
		const latency = raw.latencyMs;
		if (typeof latency !== "number" || !Number.isFinite(latency) || latency < 0 || latency > MAX_LATENCY_MS) {
			throw new JournalValidationError(`${where}.latencyMs must be a non-negative number of milliseconds`);
		}
		event.latencyMs = latency;
	}
	if (raw.via !== undefined) {
		if (typeof raw.via !== "string" || !VIA.has(raw.via)) {
			throw new JournalValidationError(`${where}.via must be one of ${[...VIA].join(", ")}`);
		}
		event.via = raw.via as NonNullable<JournalEvent["via"]>;
	}
	const screen = optionalText(raw, "screen", MAX_IDENTIFIER_LENGTH, where);
	if (screen !== undefined) event.screen = screen;
	const detail = optionalText(raw, "detail", MAX_DETAIL_LENGTH, where);
	if (detail !== undefined) event.detail = detail;
	const sessionId = optionalText(raw, "sessionId", MAX_SESSION_ID_LENGTH, where);
	if (sessionId !== undefined) event.sessionId = sessionId;
	return event;
}

export function parseJournalEvents(body: unknown): JournalEvent[] {
	if (!isObject(body) || !Array.isArray(body.events)) {
		throw new JournalValidationError('body must be {"events": JournalEvent[]}');
	}
	if (body.events.length > MAX_JOURNAL_EVENTS_PER_CALL) {
		throw new JournalValidationError(`at most ${MAX_JOURNAL_EVENTS_PER_CALL} events per call`);
	}
	return body.events.map((raw, index) => parseJournalEvent(raw, `events[${index}]`));
}

export function parseFeedbackEntry(raw: unknown): FeedbackEntry {
	if (!isObject(raw)) throw new JournalValidationError("body must be a FeedbackEntry object");
	const entry: FeedbackEntry = {
		at: timestamp(raw, "feedback"),
		screen: requiredText(raw, "screen", MAX_IDENTIFIER_LENGTH, "feedback"),
		text: requiredText(raw, "text", MAX_FEEDBACK_LENGTH, "feedback"),
	};
	const feature = optionalText(raw, "feature", MAX_IDENTIFIER_LENGTH, "feedback");
	if (feature !== undefined) entry.feature = feature;
	return entry;
}

export interface JournalOptions {
	/** Rotation threshold per file; default 10 MB. */
	maxFileBytes?: number;
}

export class Journal {
	readonly #journalFile: string;
	readonly #feedbackFile: string;
	readonly #maxFileBytes: number;
	/** Serializes appends, rotation and wipes: one writer at a time keeps lines whole and rotation race-free. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(stateDir: string, options: JournalOptions = {}) {
		this.#journalFile = path.join(stateDir, "journal.jsonl");
		this.#feedbackFile = path.join(stateDir, "feedback.jsonl");
		this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_JOURNAL_MAX_FILE_BYTES;
	}

	#exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(task, task);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	/** Append validated events (the caller validates with `parseJournalEvents`). */
	recordEvents(events: readonly JournalEvent[]): Promise<void> {
		if (events.length === 0) return Promise.resolve();
		return this.#exclusive(() => this.#append(this.#journalFile, events));
	}

	recordFeedback(entry: FeedbackEntry): Promise<void> {
		return this.#exclusive(() => this.#append(this.#feedbackFile, [entry]));
	}

	/** The most recent `limit` journal events and feedback entries, oldest first. */
	read(limit: number): Promise<JournalResponse> {
		return this.#exclusive(async () => ({
			events: await this.#readLast<JournalEvent>(this.#journalFile, limit),
			feedback: await this.#readLast<FeedbackEntry>(this.#feedbackFile, limit),
		}));
	}

	/** Delete the journal and the feedback, including the rotated generation of each. */
	clear(): Promise<void> {
		return this.#exclusive(async () => {
			for (const file of [this.#journalFile, this.#feedbackFile]) {
				for (const target of [file, `${file}.1`]) {
					await fs.rm(target, { force: true });
				}
			}
		});
	}

	async #append(file: string, rows: readonly unknown[]): Promise<void> {
		const payload = `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
		const bytes = Buffer.byteLength(payload);
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const size = await fs.stat(file).then(
			stats => stats.size,
			() => 0,
		);
		// A single batch bigger than the limit still lands: it starts a fresh generation instead of being refused.
		if (size > 0 && size + bytes > this.#maxFileBytes) await fs.rename(file, `${file}.1`);
		const handle = await fs.open(file, "a", 0o600);
		try {
			await handle.chmod(0o600);
			await handle.appendFile(payload);
		} finally {
			await handle.close();
		}
	}

	async #readLast<T>(file: string, limit: number): Promise<T[]> {
		const rows: T[] = [];
		for (const source of [`${file}.1`, file]) {
			const text = await Bun.file(source)
				.text()
				.catch(() => "");
			for (const line of text.split("\n")) {
				if (!line) continue;
				try {
					rows.push(JSON.parse(line) as T);
				} catch {
					// A torn line (crash mid-append) is skipped, not fatal.
				}
			}
		}
		return limit >= rows.length ? rows : rows.slice(rows.length - limit);
	}
}
