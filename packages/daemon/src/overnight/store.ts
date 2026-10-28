import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { OvernightPhase, OvernightPolicy, OvernightQuiet, OvernightState, OvernightTemplate } from "@omp-console/protocol";
import { DEFAULT_OVERNIGHT_TEMPLATE } from "./prompts";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { atomicWriteFile } from "../workspaces/files";

const PHASES: readonly OvernightPhase[] = [
	"running",
	"continuing",
	"waiting-retry",
	"waiting-usage",
	"recovering",
	"wrapping-up",
	"complete",
	"deadline",
	"blocked",
	"stopped",
];
const QUIET: readonly OvernightQuiet[] = ["normal", "quiet", "silent"];

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPolicy(value: unknown): value is OvernightPolicy {
	if (!record(value)) return false;
	return typeof value.deadline === "string" && Number.isFinite(Date.parse(value.deadline)) &&
		/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.deadline) &&
		numberIn(value.askTimeoutSec, 1, 86_400) && QUIET.includes(value.quiet as OvernightQuiet) &&
		numberIn(value.maxIdleContinuations, 1, 100) && typeof value.keepAwake === "boolean";
}

function numberIn(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validTemplate(value: unknown): value is OvernightTemplate {
	if (!record(value) || typeof value.prompt !== "string" || value.prompt.length === 0 || value.prompt.length > 64 * 1024 || !record(value.policy)) {
		return false;
	}
	const policy = value.policy;
	return typeof policy.deadlineLocalTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(policy.deadlineLocalTime) &&
		numberIn(policy.askTimeoutSec, 1, 86_400) && QUIET.includes(policy.quiet as OvernightQuiet) &&
		numberIn(policy.maxIdleContinuations, 1, 100) && typeof policy.keepAwake === "boolean";
}

function validState(value: unknown): value is OvernightState {
	if (!record(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0 ||
		typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || !validPolicy(value.policy) ||
		!PHASES.includes(value.phase as OvernightPhase) || !numberIn(value.continuations, 0, Number.MAX_SAFE_INTEGER) ||
		!numberIn(value.idleContinuations, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(value.events)) return false;
	if (value.nextActionAt !== undefined && (typeof value.nextActionAt !== "number" || !Number.isFinite(value.nextActionAt))) return false;
	if (value.report !== undefined && typeof value.report !== "string") return false;
	return value.events.every(event => record(event) && typeof event.at === "number" && Number.isFinite(event.at) &&
		typeof event.kind === "string" && typeof event.detail === "string");
}

/** Atomic private JSON files for templates and each session's overnight state. */
export class OvernightStore {
	readonly #directory: string;
	readonly #log: (message: string) => void;

	constructor(stateDir: string, log: (message: string) => void = () => {}) {
		this.#directory = path.join(stateDir, "overnight");
		this.#log = log;
	}

	async template(): Promise<OvernightTemplate> {
		const file = path.join(this.#directory, "template.json");
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch (error) {
			if (isEnoent(error)) return structuredClone(DEFAULT_OVERNIGHT_TEMPLATE);
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("overnight template is invalid JSON");
		}
		if (!validTemplate(parsed)) throw new Error("overnight template has an invalid shape");
		return parsed;
	}

	async saveTemplate(value: unknown): Promise<OvernightTemplate> {
		if (!validTemplate(value)) throw new Error("template requires a non-empty prompt and valid policy fields");
		const template = structuredClone(value);
		await atomicWriteFile(path.join(this.#directory, "template.json"), `${JSON.stringify(template, null, 2)}\n`, 0o600);
		return template;
	}

	async saveState(state: OvernightState): Promise<void> {
		await atomicWriteFile(this.#stateFile(state.sessionId), `${JSON.stringify(state)}\n`, 0o600);
	}

	async loadStates(): Promise<OvernightState[]> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(this.#directory, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const states: OvernightState[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "template.json") continue;
			const file = path.join(this.#directory, entry.name);
			try {
				const parsed: unknown = JSON.parse(await Bun.file(file).text());
				if (validState(parsed) && path.basename(this.#stateFile(parsed.sessionId)) === entry.name) states.push(parsed);
				else this.#log(`ignoring invalid overnight state ${entry.name}`);
			} catch (error) {
				this.#log(`ignoring unreadable overnight state ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return states;
	}

	#stateFile(sessionId: string): string {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("invalid overnight session id");
		return path.join(this.#directory, `${sessionId}.json`);
	}
}
