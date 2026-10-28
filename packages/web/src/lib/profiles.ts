/**
 * Profile details (spec 3.1, 3.3, 3.4): what a task-agent definition declares, read from a live session's catalog
 * (`GET /api/sessions/:id/catalog`). The Settings list itself comes from `GET /api/profiles`, so the details are
 * loaded on first use and the list keeps working when no session is live.
 */
import type { AgentProfileDetail } from "@omp-console/protocol";
import { type DeckApi, DeckApiError } from "./api";

const TOOLS_SHOWN = 5;

/** `read, grep, edit +3`; "all tools" when the definition does not restrict them. */
export function toolsSummary(tools: readonly string[] | undefined): string {
	if (tools === undefined) return "all tools";
	if (tools.length === 0) return "no tools";
	if (tools.length <= TOOLS_SHOWN) return tools.join(", ");
	return `${tools.slice(0, TOOLS_SHOWN).join(", ")} +${tools.length - TOOLS_SHOWN}`;
}

export function spawnsSummary(spawns: readonly string[] | "*" | undefined): string {
	if (spawns === "*") return "any profile";
	if (spawns === undefined) return "not declared";
	if (spawns.length === 0) return "none";
	return spawns.join(", ");
}

/** Model line for a picker row: what the profile runs on now, else what its definition asks for. */
export function modelSummary(profile: Pick<AgentProfileDetail, "effectiveModel" | "definitionModels">): string {
	if (profile.effectiveModel) return profile.effectiveModel;
	return profile.definitionModels.length > 0 ? profile.definitionModels.join(", ") : "inherits the session model";
}

/** The `task` call that spawns this profile, for the "omp:" line. */
export function profileSpawnEquivalent(name: string): string {
	return `task({ "agent": "${name}", "task": "<what to do>", "solutionSpace": "…" })`;
}

export type DetailState =
	| { state: "idle" }
	| { state: "loading" }
	| { state: "ready"; byName: ReadonlyMap<string, AgentProfileDetail>; sessionId: string }
	/** No live session to read the catalog from; the list still works. */
	| { state: "no-session" }
	| { state: "error"; message: string };

export class ProfileDetailStore {
	readonly #api: DeckApi;
	readonly #preferred: string | undefined;
	readonly #listeners = new Set<() => void>();
	#state: DetailState = { state: "idle" };
	#inflight: Promise<void> | null = null;

	constructor(api: DeckApi, preferredSessionId?: string) {
		this.#api = api;
		this.#preferred = preferredSessionId;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): DetailState => this.#state;

	#set(state: DetailState): void {
		this.#state = state;
		for (const listener of this.#listeners) listener();
	}

	/** Loads once; a failed or session-less load is retried by the next call. Concurrent calls share one request. */
	ensure(): Promise<void> {
		if (this.#state.state === "ready") return Promise.resolve();
		if (this.#inflight) return this.#inflight;
		this.#inflight = this.#load().finally(() => {
			this.#inflight = null;
		});
		return this.#inflight;
	}

	async #load(): Promise<void> {
		this.#set({ state: "loading" });
		try {
			const sessions = await this.#api.listSessions();
			const target =
				sessions.live.find(s => s.id === this.#preferred)?.id ?? sessions.live[0]?.id ?? undefined;
			if (target === undefined) {
				this.#set({ state: "no-session" });
				return;
			}
			const catalog = await this.#api.catalog(target);
			this.#set({ state: "ready", byName: new Map(catalog.profiles.map(p => [p.name, p])), sessionId: target });
		} catch (err) {
			this.#set({ state: "error", message: describeDetailError(err) });
		}
	}
}

export function describeDetailError(err: unknown): string {
	if (!(err instanceof DeckApiError)) return err instanceof Error ? err.message : "unexpected error";
	switch (err.kind) {
		case "auth":
			return "The daemon refused this device.";
		case "network":
			return "The daemon is unreachable.";
		case "not-found":
			return "The daemon does not offer profile details for that session.";
		default:
			return `The daemon could not load profile details: ${err.message}`;
	}
}
