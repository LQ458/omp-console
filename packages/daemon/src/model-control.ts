import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentProfileSummary, ListModelsResponse, ListProfilesResponse, ModelOption } from "@omp-console/protocol";
import { getAgentDir, getModelDbPath } from "@oh-my-pi/pi-utils/dirs";
import { logger } from "@oh-my-pi/pi-utils";
import { findAllNearestProjectConfigDirs } from "@oh-my-pi/pi-coding-agent/config";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveAgentModelSelection, resolveModelOverride, resolveSessionModelSelector } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgProvidersCacheWarming } from "@oh-my-pi/pi-coding-agent/session/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { getKnownRoleIds } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const MODEL_CACHE_MS = 30_000;
const TASK_AGENT_CONFIG_SOURCE = ".omp";

type ControlErrorCode = "bad-request" | "not-found";

export class ModelControlError extends Error {
	constructor(
		readonly code: ControlErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ModelControlError";
	}
}

interface ModelContext {
	settings: Settings;
	registry: ModelRegistry;
	models: ModelOption[];
	expiresAt: number;
}

interface AgentDirectory {
	dir: string;
	source: "project" | "user";
}

async function loadAgentDirectory(directory: AgentDirectory): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(directory.dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name));
	const agents = await Promise.all(
		files.map(async entry => {
			const filePath = path.join(directory.dir, entry.name);
			try {
				return parseAgent(filePath, await Bun.file(filePath).text(), directory.source, "warn");
			} catch (error) {
				logger.warn("failed to read task-agent definition", {
					filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
		}),
	);
	return agents.filter((agent): agent is AgentDefinition => agent !== undefined);
}

function modelSelector(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}
function modelRoles(settings: Settings): Record<string, string> {
	const roles: Record<string, string> = Object.create(null);
	for (const [role, selector] of Object.entries(settings.getModelRoles())) {
		if (typeof selector === "string") roles[role] = selector;
	}
	return roles;
}


export class ModelControl {
	readonly #agentDir: string;
	readonly #baseCwd: string;
	readonly #contexts = new Map<string, ModelContext>();
	#authStoragePromise: Promise<AuthStorage> | undefined;
	#writeSettingsPromise: Promise<Settings> | undefined;
	#writeChain: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(agentDir: string = getAgentDir(), baseCwd: string = process.cwd()) {
		this.#agentDir = path.resolve(agentDir);
		this.#baseCwd = path.resolve(baseCwd);
	}

	/** The daemon's own registry and settings (same auth storage) for background models (librarian). */
	async backgroundModelContext(): Promise<{ registry: ModelRegistry; settings: Settings }> {
		const context = await this.#context(this.#baseCwd);
		return { registry: context.registry, settings: context.settings };
	}

	async listModels(): Promise<ListModelsResponse> {
		const context = await this.#context(this.#baseCwd);
		return { models: context.models, roles: modelRoles(context.settings) };
	}

	async availableModelCount(): Promise<number> {
		const context = await this.#context(this.#baseCwd);
		const providerAuth = new Map<string, boolean>();
		let count = 0;
		for (const model of context.models) {
			if (!model.available) continue;
			let hasAuth = providerAuth.get(model.provider);
			if (hasAuth === undefined) {
				hasAuth = await this.hasProviderAuth(model.provider);
				providerAuth.set(model.provider, hasAuth);
			}
			if (hasAuth) count++;
		}
		return count;
	}

	async listProfiles(cwd?: string): Promise<ListProfilesResponse> {
		const resolvedCwd = cwd === undefined ? this.#baseCwd : await this.#validateCwd(cwd);
		const context = await this.#context(resolvedCwd);
		const agents = await this.#agents(resolvedCwd, cwd !== undefined);
		const overrides = cfgTaskAgentModelOverrides.get(context.settings);
		const profiles: AgentProfileSummary[] = agents.map(agent => {
			const override = Object.hasOwn(overrides, agent.name) ? overrides[agent.name] : undefined;
			const definitionModels = agent.model === undefined ? [] : Array.isArray(agent.model) ? [...agent.model] : [agent.model];
			const summary: AgentProfileSummary = {
				name: agent.name,
				source: agent.source as AgentProfileSummary["source"],
				definitionModels,
			};
			if (agent.description) summary.description = agent.description;
			if (typeof override === "string") summary.override = override;
			else if (Array.isArray(override) && override[0]) summary.override = override[0];

			// Without a declared model or saved override, task execution may inherit the live session model.
			if (override !== undefined || agent.model !== undefined) {
				const selection = resolveAgentModelSelection({
					settingsOverride: override,
					agentModel: agent.model,
					settings: context.settings,
				});
				const resolved = resolveModelOverride(selection.patterns, context.registry, context.settings).model;
				if (resolved) summary.effectiveModel = modelSelector(resolved);
			}
			return summary;
		});
		return { profiles, roles: modelRoles(context.settings) };
	}

	async setProfileModel(name: string, selector: string | null, cwd?: string): Promise<void> {
		const resolvedCwd = cwd === undefined ? this.#baseCwd : await this.#validateCwd(cwd);
		const agents = await this.#agents(resolvedCwd, cwd !== undefined);
		const profileExists = agents.some(agent => agent.name === name);
		if (!profileExists && selector !== null) throw new ModelControlError("not-found", `no profile ${name}`);
		const context = await this.#context(resolvedCwd);
		if (!profileExists && !Object.hasOwn(cfgTaskAgentModelOverrides.get(context.settings), name)) {
			throw new ModelControlError("not-found", `no profile or saved override ${name}`);
		}
		this.#validateSelector(selector, context, true);
		await this.#write(settings => {
			cfgTaskAgentModelOverrides.setEntry(settings, name, selector ?? undefined);
		});
		this.#invalidate();
	}

	async setModelRole(role: string, selector: string, cwd?: string): Promise<void> {
		const resolvedCwd = cwd === undefined ? this.#baseCwd : await this.#validateCwd(cwd);
		const context = await this.#context(resolvedCwd);
		if (!getKnownRoleIds(context.settings).includes(role)) throw new ModelControlError("not-found", `no model role ${role}`);
		this.#validateSelector(selector, context, false);
		await this.#write(settings => {
			cfgModelRoles.setEntry(settings, role, selector);
		});
		this.#invalidate();
	}

	/** omp's `providers.cacheWarming` at the agent dir (what new sessions get). */
	async cacheWarming(): Promise<"off" | "streaming" | "idle"> {
		const context = await this.#context(this.#baseCwd);
		return cfgProvidersCacheWarming.get(context.settings);
	}

	async setCacheWarming(mode: "off" | "streaming" | "idle"): Promise<void> {
		await this.#write(settings => {
			cfgProvidersCacheWarming.set(settings, mode);
		});
		this.#contexts.clear();
	}

	/** Effective `modelRoles` (role → selector). */
	async modelRoles(): Promise<Record<string, string>> {
		const context = await this.#context(this.#baseCwd);
		return Object.fromEntries(
			Object.entries(context.settings.getModelRoles()).flatMap(([role, selector]) => (selector ? [[role, selector]] : [])),
		);
	}
	/** Checks only whether an auth source exists; no credential value or model request is exposed. */
	async hasProviderAuth(provider: string): Promise<boolean> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) return false;
		const authStorage = await this.#authStorage();
		return authStorage.keys.source(provider) !== undefined;
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#writeChain;
		const settings = await this.#writeSettingsPromise?.catch(() => undefined);
		settings?.cancelPendingSaves();
		const authStorage = await this.#authStoragePromise?.catch(() => undefined);
		authStorage?.close();
		this.#contexts.clear();
	}

	#validateSelector(selector: string | null, context: ModelContext, allowRoleAliases: boolean): void {
		if (selector === null) return;
		const reject = (): never => {
			throw new ModelControlError("bad-request", `model selector is unavailable or unresolvable: ${selector}`);
		};
		if (allowRoleAliases && selector.startsWith("@")) {
			if (!Object.hasOwn(context.settings.getModelRoles(), selector.slice(1))) reject();
			return;
		}
		// Exact `provider/id` of an available model, with an optional thinking suffix. Fuzzy matching would route an
		// agent to whatever a garbled selector happens to resemble (a probe sent `a: b` and got a different model).
		const concrete = selector.replace(/:(?:off|minimal|low|medium|high|xhigh|max|auto)$/, "");
		const option = context.models.find(candidate => candidate.selector === concrete);
		if (!option?.available) reject();
	}

	async #write(mutate: (settings: Settings) => void): Promise<void> {
		const result = this.#writeChain.then(async () => {
			if (this.#closed) throw new Error("model control is closed");
			const settings = await (this.#writeSettingsPromise ??= Settings.loadIsolated({
				agentDir: this.#agentDir,
				cwd: this.#baseCwd,
			}));
			mutate(settings);
			await settings.flush();
		});
		this.#writeChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #context(cwd: string): Promise<ModelContext> {
		if (this.#closed) throw new Error("model control is closed");
		const key = path.resolve(cwd);
		const cached = this.#contexts.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached;

		const [authStorage, settings] = await Promise.all([
			this.#authStorage(),
			Settings.loadReadOnly({ agentDir: this.#agentDir, cwd: key }),
		]);
		// The storage lives as long as the daemon: re-read credentials so a login (or logout) done elsewhere, for
		// example `omp login` in a terminal, shows in the model list within one cache period instead of after a restart.
		// `revalidate` also fetches a fresh snapshot from an auth broker; on a local store it is a plain reload.
		await authStorage.credentials.revalidate().catch((error: unknown) => {
			logger.warn("model list: credential reload failed; keeping the previous credentials", { error: String(error) });
		});
		const registry = new ModelRegistry(authStorage, path.join(this.#agentDir, "models.yml"), {
			settings,
			cacheDbPath: getModelDbPath(this.#agentDir),
		});
		const availableSelectors = new Set(registry.getAvailable("all").map(modelSelector));
		const models = registry.getAll("all").map(model => ({
			selector: modelSelector(model),
			provider: model.provider,
			label: model.name,
			available: availableSelectors.has(modelSelector(model)),
		}));
		const context: ModelContext = { settings, registry, models, expiresAt: Date.now() + MODEL_CACHE_MS };
		this.#contexts.set(key, context);
		return context;
	}

	#authStorage(): Promise<AuthStorage> {
		this.#authStoragePromise ??= (async () => {
			const settings = await Settings.loadReadOnly({ agentDir: this.#agentDir, cwd: this.#baseCwd });
			return discoverAuthStorage(this.#agentDir, { settings, cwd: this.#baseCwd });
		})();
		return this.#authStoragePromise;
	}

	async #agents(cwd: string, includeProject: boolean): Promise<AgentDefinition[]> {
		const roots: AgentDirectory[] = [];
		if (includeProject) {
			const project = findAllNearestProjectConfigDirs("agents", cwd).find(
				entry => entry.source === TASK_AGENT_CONFIG_SOURCE,
			);
			if (project) roots.push({ dir: project.path, source: "project" });
		}
		roots.push({ dir: path.join(this.#agentDir, "agents"), source: "user" });

		const loaded: AgentDefinition[] = [];
		const seen = new Set<string>();
		for (const root of roots) {
			for (const agent of await loadAgentDirectory(root)) {
				if (seen.has(agent.name)) continue;
				seen.add(agent.name);
				loaded.push(agent);
			}
		}
		for (const agent of loadBundledAgents()) {
			if (seen.has(agent.name)) continue;
			seen.add(agent.name);
			loaded.push(agent);
		}
		return loaded;
	}

	async #validateCwd(cwd: string): Promise<string> {
		if (!path.isAbsolute(cwd)) throw new ModelControlError("bad-request", "cwd must be an absolute path");
		try {
			if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new ModelControlError("bad-request", "cwd must be an existing directory");
		}
		return path.resolve(cwd);
	}

	#invalidate(): void {
		this.#contexts.clear();
	}
}
