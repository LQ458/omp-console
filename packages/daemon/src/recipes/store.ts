import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionRecipe, SessionRecipeInput } from "@omp-console/protocol";
import { atomicWriteFile } from "../workspaces/files";

interface RecipeFile {
	version: 1;
	recipes: SessionRecipe[];
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecipe(value: unknown): value is SessionRecipe {
	if (typeof value !== "object" || value === null) return false;
	if (
		!("id" in value) || typeof value.id !== "string" || value.id.length === 0 ||
		!("name" in value) || typeof value.name !== "string" || value.name.length === 0 ||
		!("cwd" in value) || typeof value.cwd !== "string" || value.cwd.length === 0 ||
		!("machineId" in value) || typeof value.machineId !== "string" || value.machineId.length === 0 ||
		!("prompt" in value) || typeof value.prompt !== "string" || value.prompt.length === 0 ||
		!("createdAt" in value) || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) ||
		!("updatedAt" in value) || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)
	) return false;
	if ("model" in value && value.model !== undefined && typeof value.model !== "string") return false;
	return !(
		"thinkingLevel" in value &&
		value.thinkingLevel !== undefined &&
		(typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel))
	);
}

function parseRecipeFile(text: string): RecipeFile {
	const value: unknown = JSON.parse(text);
	if (
		typeof value !== "object" || value === null ||
		!("version" in value) || value.version !== 1 ||
		!("recipes" in value) || !Array.isArray(value.recipes) ||
		!value.recipes.every(isRecipe)
	) {
		throw new Error("recipes.json has an unsupported or invalid format");
	}
	const recipes = value.recipes;
	if (new Set(recipes.map(recipe => recipe.id)).size !== recipes.length) {
		throw new Error("recipes.json contains duplicate ids");
	}
	return { version: 1, recipes };
}

/** Atomic daemon-state persistence for saved session starts. */
export class RecipeStore {
	#file: string;
	#recipes: SessionRecipe[] = [];
	#ready: Promise<void>;
	#writeTail: Promise<void> = Promise.resolve();
	#log: (message: string) => void;

	constructor(stateDir: string, log: (message: string) => void = () => {}) {
		this.#file = path.join(stateDir, "recipes.json");
		this.#log = log;
		this.#ready = this.#load().catch(error => {
			this.#log(`recipe state could not be loaded; starting empty: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async list(): Promise<SessionRecipe[]> {
		await this.#ready;
		await this.#writeTail;
		return this.#recipes.map(recipe => ({ ...recipe }));
	}

	async get(id: string): Promise<SessionRecipe | undefined> {
		await this.#ready;
		await this.#writeTail;
		for (const recipe of this.#recipes) {
			if (recipe.id === id) return { ...recipe };
		}
		return undefined;
	}

	async create(input: SessionRecipeInput, now = Date.now()): Promise<SessionRecipe> {
		await this.#ready;
		return this.#enqueue(async () => {
			const recipe: SessionRecipe = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
			const next = [...this.#recipes, recipe];
			await this.#persist(next);
			this.#recipes = next;
			return { ...recipe };
		});
	}

	async update(id: string, input: SessionRecipeInput, now = Date.now()): Promise<SessionRecipe | undefined> {
		await this.#ready;
		return this.#enqueue(async () => {
			const index = this.#recipes.findIndex(recipe => recipe.id === id);
			if (index < 0) return undefined;
			const current = this.#recipes[index]!;
			const updated: SessionRecipe = { id, ...input, createdAt: current.createdAt, updatedAt: now };
			const next = [...this.#recipes];
			next[index] = updated;
			await this.#persist(next);
			this.#recipes = next;
			return { ...updated };
		});
	}

	async remove(id: string): Promise<boolean> {
		await this.#ready;
		return this.#enqueue(async () => {
			const index = this.#recipes.findIndex(recipe => recipe.id === id);
			if (index < 0) return false;
			const next = this.#recipes.filter((_, itemIndex) => itemIndex !== index);
			await this.#persist(next);
			this.#recipes = next;
			return true;
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
		let parsed: RecipeFile;
		try {
			parsed = parseRecipeFile(text);
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
					? `recipe state is invalid; preserved as ${path.basename(corruptFile)} and starting empty`
					: `recipe state is invalid; could not preserve ${path.basename(corruptFile)} (${preservationError}); starting empty`,
			);
			return;
		}
		this.#recipes = parsed.recipes;
		await fs.chmod(this.#file, 0o600);
	}

	async #persist(recipes: SessionRecipe[] = this.#recipes): Promise<void> {
		const content = `${JSON.stringify({ version: 1, recipes } satisfies RecipeFile)}\n`;
		await atomicWriteFile(this.#file, content, 0o600);
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.#writeTail.then(operation);
		this.#writeTail = pending.then(() => undefined, () => undefined);
		return pending;
	}
}
