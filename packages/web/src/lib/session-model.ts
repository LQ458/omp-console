/**
 * Model and thinking level of the main session (spec 1.9), changed from the header. Both go to the root agent's
 * session-only endpoints, so omp's saved default is untouched. The host's `state` frame is the truth: a value the
 * daemon accepted is shown until the host reports its own value, which then wins even if it differs.
 */
import type { JournalEvent, ListModelsResponse, SetAgentThinkingRequest } from "@omp-console/protocol";
import { changeAgentModel, labelForSelector } from "./agent-models";
import { type DeckApi, DeckApiError } from "./api";

export type ThinkingLevel = SetAgentThinkingRequest["level"];

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"auto",
];

export type UsageRecorder = (event: Omit<JournalEvent, "at">) => void;

/** omp's own way to do the same thing, shown next to the control so the TUI becomes discoverable. */
export function modelEquivalent(selector: string | undefined): string {
	return selector ? `/switch ${selector}` : "/switch <model>";
}

export function thinkingEquivalent(level: string | undefined): string {
	return level ? `/effort ${level}` : "/effort <level>";
}

/** A value the daemon accepted, with what the host reported when it was applied. */
export interface Applied {
	value: string;
	baseline: string | undefined;
}

function sameModel(host: string, applied: string): boolean {
	return host === applied || applied.endsWith(`/${host}`);
}

/**
 * What to show for one control. No local value: the host's. A local value stays until the host reports something:
 * the same thing (settled) or a different thing (someone else changed it; the host wins). Until the host moves off
 * its baseline the accepted value is shown, so a host that does not echo still looks right.
 */
export function reflectHost(host: string | undefined, applied: Applied | null, kind: "model" | "text"): string | undefined {
	if (applied === null) return host;
	if (host === undefined) return applied.value;
	const same = kind === "model" ? sameModel : (a: string, b: string) => a === b;
	if (same(host, applied.value)) return host;
	if (applied.baseline === undefined) return host;
	return same(host, applied.baseline) ? applied.value : host;
}

/** The list entry (`provider/id`) a host-reported model id belongs to, so the picker can mark it. */
export function resolveCurrentSelector(models: ListModelsResponse | null, shown: string | undefined): string | undefined {
	if (shown === undefined) return undefined;
	const hit = models?.models.find(m => m.selector === shown || m.selector.endsWith(`/${shown}`));
	return hit?.selector ?? shown;
}

/** Short label for a model value when the picker list is not loaded: the id without its provider. */
export function shortModelName(value: string): string {
	return value.slice(value.lastIndexOf("/") + 1);
}

/** One sentence for the inline error under the thinking control. */
export function describeThinkingError(err: unknown): string {
	if (!(err instanceof DeckApiError)) return err instanceof Error ? err.message : "unexpected error";
	switch (err.kind) {
		case "auth":
			return "The daemon refused this device.";
		case "network":
			return "The daemon is unreachable. Nothing was changed.";
		case "not-found":
			return "That session or agent is gone, so nothing was changed.";
		case "conflict":
			return "The main agent has no live session right now, so the level was not changed.";
		case "bad-request":
			return `The daemon did not accept that level: ${err.message}`;
		case "server":
			return `The daemon failed: ${err.message}`;
	}
}

export type ControlName = "model" | "thinking";

export interface ControlSnapshot {
	/** The control with a request in flight; the other stays usable but one request runs at a time. */
	busy: ControlName | null;
	/** Value being sent while `busy`, shown as pending. */
	pending: string | null;
	error: { control: ControlName; message: string } | null;
	/** One line after the daemon accepted a change. */
	note: string | null;
	model: Applied | null;
	thinking: Applied | null;
}

const INITIAL: ControlSnapshot = { busy: null, pending: null, error: null, note: null, model: null, thinking: null };

export interface SessionControlDeps {
	api: DeckApi;
	sessionId: string;
	/** The session's root agent. */
	agentId: string;
	record: UsageRecorder;
	now?: () => number;
}

export class SessionControlStore {
	readonly #deps: SessionControlDeps;
	readonly #listeners = new Set<() => void>();
	#snapshot: ControlSnapshot = INITIAL;

	constructor(deps: SessionControlDeps) {
		this.#deps = deps;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): ControlSnapshot => this.#snapshot;

	#set(patch: Partial<ControlSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (const listener of this.#listeners) listener();
	}

	clearError(): void {
		if (this.#snapshot.error !== null) this.#set({ error: null });
	}

	/** Returns false when another change is still in flight (nothing is sent). */
	async setModel(selector: string, hostModel: string | undefined, models: ListModelsResponse | null): Promise<boolean> {
		if (this.#snapshot.busy !== null) return false;
		const { api, sessionId, agentId, record } = this.#deps;
		const now = this.#deps.now ?? Date.now;
		const started = now();
		this.#set({ busy: "model", pending: selector, error: null, note: null });
		const result = await changeAgentModel(api, sessionId, agentId, selector);
		const latencyMs = now() - started;
		if (!result.ok) {
			this.#set({ busy: null, pending: null, error: { control: "model", message: result.message } });
			record({ feature: "1.9.model", action: "set-model", outcome: "error", latencyMs, via: "direct", screen: "header", detail: selector, sessionId });
			return true;
		}
		const patch: Partial<ControlSnapshot> = {
			busy: null,
			pending: null,
			model: { value: result.model, baseline: hostModel },
			note: `Now using ${labelForSelector(models, result.model)}. This session only; your omp default is unchanged.`,
		};
		if (result.thinkingLevel !== undefined) {
			patch.thinking = { value: result.thinkingLevel, baseline: this.#snapshot.thinking?.baseline };
		}
		this.#set(patch);
		record({ feature: "1.9.model", action: "set-model", outcome: "ok", latencyMs, via: "direct", screen: "header", detail: selector, sessionId });
		return true;
	}

	async setThinking(level: ThinkingLevel, hostThinking: string | undefined): Promise<boolean> {
		if (this.#snapshot.busy !== null) return false;
		const { api, sessionId, agentId, record } = this.#deps;
		const now = this.#deps.now ?? Date.now;
		const started = now();
		this.#set({ busy: "thinking", pending: level, error: null, note: null });
		try {
			await api.setAgentThinking(sessionId, agentId, level);
		} catch (err) {
			this.#set({ busy: null, pending: null, error: { control: "thinking", message: describeThinkingError(err) } });
			record({ feature: "1.9.thinking", action: "set-thinking", outcome: "error", latencyMs: now() - started, via: "direct", screen: "header", detail: level, sessionId });
			return true;
		}
		this.#set({
			busy: null,
			pending: null,
			thinking: { value: level, baseline: hostThinking },
			note: `Thinking is now ${level}. This session only; your omp default is unchanged.`,
		});
		record({ feature: "1.9.thinking", action: "set-thinking", outcome: "ok", latencyMs: now() - started, via: "direct", screen: "header", detail: level, sessionId });
		return true;
	}
}
