/**
 * State behind the Settings "Agent models" panel: task-agent profiles and model roles from the daemon, plus the
 * edit flow. These writes change the user's omp configuration (`task.agentModelOverrides`, `modelRoles`) and apply to
 * NEW spawns in every session, so nothing is sent until the person has chosen a value AND confirmed it
 * (`choose` -> `confirm` stage -> `confirm()`); `confirm()` outside the confirm stage does nothing.
 */
import type { AgentProfileSummary, ListModelsResponse } from "@omp-console/protocol";
import type { DeckApi } from "./api";
import { describeControlError } from "./agent-api";

export type EditTarget = { kind: "profile"; name: string } | { kind: "role"; role: string };

export type EditStage = "choose" | "confirm" | "saving";

export interface PendingEdit {
	target: EditTarget;
	stage: EditStage;
	/** Value in effect before the edit (override or role selector), for the confirm sentence. */
	before: string | undefined;
	/** The chosen value; `null` clears a profile override. Undefined until chosen. */
	selector: string | null | undefined;
	error: string | null;
}

export type LoadState = "idle" | "loading" | "ready" | "error";

export interface ProfileConfigSnapshot {
	load: LoadState;
	loadError: string | null;
	profiles: readonly AgentProfileSummary[];
	roles: Readonly<Record<string, string>>;
	models: ListModelsResponse | null;
	modelsError: string | null;
	edit: PendingEdit | null;
	/** One line after a successful write; cleared by the next edit. */
	saved: string | null;
}

const INITIAL: ProfileConfigSnapshot = {
	load: "idle",
	loadError: null,
	profiles: [],
	roles: {},
	models: null,
	modelsError: null,
	edit: null,
	saved: null,
};

export function targetLabel(target: EditTarget): string {
	return target.kind === "profile" ? `profile ${target.name}` : `role ${target.role}`;
}

export class ProfileConfigStore {
	readonly #api: DeckApi;
	readonly #listeners = new Set<() => void>();
	#snapshot: ProfileConfigSnapshot = INITIAL;
	#generation = 0;

	constructor(api: DeckApi) {
		this.#api = api;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): ProfileConfigSnapshot => this.#snapshot;

	#commit(patch: Partial<ProfileConfigSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (const listener of this.#listeners) listener();
	}

	/** Loads profiles and models. A later call wins over an earlier one still in flight. */
	async load(): Promise<void> {
		const generation = ++this.#generation;
		this.#commit({ load: "loading", loadError: null });
		const [profiles, models] = await Promise.allSettled([this.#api.listProfiles(), this.#api.listModels()]);
		if (generation !== this.#generation) return;
		if (profiles.status === "rejected") {
			this.#commit({ load: "error", loadError: describeControlError(profiles.reason, "load") });
			return;
		}
		this.#commit({
			load: "ready",
			loadError: null,
			profiles: profiles.value.profiles,
			roles: profiles.value.roles,
			models: models.status === "fulfilled" ? models.value : null,
			modelsError: models.status === "rejected" ? describeControlError(models.reason, "load") : null,
		});
	}

	/** Opens the chooser for one profile or role. */
	begin(target: EditTarget): void {
		if (this.#snapshot.edit?.stage === "saving") return;
		const before =
			target.kind === "profile"
				? this.#snapshot.profiles.find(profile => profile.name === target.name)?.override
				: this.#snapshot.roles[target.role];
		this.#commit({ edit: { target, stage: "choose", before, selector: undefined, error: null }, saved: null });
	}

	/** Picks the new value and moves to the confirm step; nothing is written yet. */
	choose(selector: string | null): void {
		const edit = this.#snapshot.edit;
		if (!edit || edit.stage === "saving") return;
		if (selector === null && edit.target.kind === "role") return; // roles cannot be cleared
		this.#commit({ edit: { ...edit, stage: "confirm", selector, error: null } });
	}

	/** Back from the confirm step to the chooser. */
	back(): void {
		const edit = this.#snapshot.edit;
		if (!edit || edit.stage !== "confirm") return;
		this.#commit({ edit: { ...edit, stage: "choose", error: null } });
	}

	cancel(): void {
		if (this.#snapshot.edit?.stage === "saving") return;
		this.#commit({ edit: null });
	}

	/** The only place a write is sent. A failure keeps the confirm step open with the reason. */
	async confirm(): Promise<boolean> {
		const edit = this.#snapshot.edit;
		if (!edit || edit.stage !== "confirm" || edit.selector === undefined) return false;
		const { target, selector } = edit;
		this.#commit({ edit: { ...edit, stage: "saving", error: null } });
		try {
			if (target.kind === "profile") await this.#api.setProfileModel(target.name, selector);
			else await this.#api.setModelRole(target.role, selector as string);
		} catch (err) {
			this.#commit({
				edit: {
					...edit,
					stage: "confirm",
					error: describeControlError(err, target.kind === "profile" ? "profile-model" : "model-role"),
				},
			});
			return false;
		}
		this.#commit({
			edit: null,
			saved:
				selector === null
					? `Cleared the override for ${targetLabel(target)}.`
					: `Set ${targetLabel(target)} to ${selector}.`,
		});
		await this.load();
		return true;
	}
}
