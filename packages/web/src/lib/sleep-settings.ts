import type { DeckApi } from "./api";

export interface SleepSettingsSnapshot {
	load: "loading" | "ready" | "error";
	minutes: number | null;
	draft: string;
	saving: boolean;
	message: string | null;
	error: string | null;
}

const INITIAL_SNAPSHOT: SleepSettingsSnapshot = {
	load: "loading",
	minutes: null,
	draft: "",
	saving: false,
	message: null,
	error: null,
};

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export class SleepSettingsStore {
	readonly #api: DeckApi;
	readonly #listeners = new Set<() => void>();
	#snapshot: SleepSettingsSnapshot = INITIAL_SNAPSHOT;
	#generation = 0;
	#loadController: AbortController | null = null;

	constructor(api: DeckApi) {
		this.#api = api;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): SleepSettingsSnapshot => this.#snapshot;

	#commit(patch: Partial<SleepSettingsSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (const listener of this.#listeners) listener();
	}

	/** Loads the current daemon value; a later load replaces an older pending request. */
	async load(): Promise<void> {
		const generation = ++this.#generation;
		this.#loadController?.abort();
		const controller = new AbortController();
		this.#loadController = controller;
		this.#commit({ load: "loading", error: null, message: null });
		try {
			const settings = await this.#api.getSleepSettings(controller.signal);
			if (generation !== this.#generation) return;
			this.#commit({
				load: "ready",
				minutes: settings.minutes,
				draft: String(settings.minutes),
				saving: false,
				message: null,
				error: null,
			});
		} catch (error) {
			if (generation !== this.#generation || controller.signal.aborted) return;
			this.#commit({ load: "error", minutes: null, draft: "", saving: false, message: null, error: errorMessage(error, "The auto-sleep setting could not be loaded.") });
		}
	}

	setDraft(draft: string): void {
		if (this.#snapshot.load !== "ready" || this.#snapshot.saving) return;
		this.#commit({ draft, error: null, message: null });
	}

	/** Saves a whole non-negative minute value, including zero (the daemon's Off setting). */
	async save(): Promise<boolean> {
		const snapshot = this.#snapshot;
		if (snapshot.load !== "ready" || snapshot.saving) return false;
		const text = snapshot.draft.trim();
		const minutes = Number(text);
		if (text === "" || !Number.isSafeInteger(minutes) || minutes < 0) {
			this.#commit({ error: "Enter a whole number of minutes greater than or equal to 0.", message: null });
			return false;
		}
		const generation = this.#generation;
		this.#commit({ saving: true, error: null, message: null });
		try {
			const settings = await this.#api.setSleepSettings(minutes);
			if (generation !== this.#generation) return false;
			this.#commit({ minutes: settings.minutes, draft: String(settings.minutes), saving: false, message: "Saved.", error: null });
			return true;
		} catch (error) {
			if (generation !== this.#generation) return false;
			this.#commit({ saving: false, message: null, error: errorMessage(error, "The auto-sleep setting could not be saved.") });
			return false;
		}
	}

	dispose(): void {
		this.#generation++;
		this.#loadController?.abort();
		this.#loadController = null;
		this.#listeners.clear();
	}
}
