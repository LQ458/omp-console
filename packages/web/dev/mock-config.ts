/**
 * Mock of the omp configuration the real daemon exposes: model catalog, model roles and task-agent profiles
 * (`GET /api/models`, `GET /api/profiles`, `PUT /api/profiles/:name/model`, `PUT /api/model-roles/:role`).
 * Selector resolution follows the protocol comment: `provider/id`, a role alias, or a unique fuzzy name.
 */
import type { AgentProfileSummary, ListModelsResponse, ListProfilesResponse, ModelOption } from "@omp-console/protocol";

const MODELS: ModelOption[] = [
	{ selector: "anthropic/claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", available: true },
	{ selector: "anthropic/claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", available: true },
	{ selector: "anthropic/claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", available: true },
	{ selector: "openai-codex/gpt-6-luna", provider: "openai-codex", label: "GPT-6 Luna", available: true },
	{ selector: "openai-codex/gpt-5.6-luna", provider: "openai-codex", label: "GPT-5.6 Luna", available: true },
	{ selector: "google/gemini-3-pro", provider: "google", label: "Gemini 3 Pro", available: false },
	{ selector: "xai/grok-5", provider: "xai", label: "Grok 5", available: false },
];

interface MockProfile {
	name: string;
	source: AgentProfileSummary["source"];
	description?: string;
	definitionModels: string[];
	override?: string;
}

export type SelectorResolution =
	| { ok: true; model: string }
	| { ok: false; reason: "unknown" | "unavailable"; message: string };

export class MockConfig {
	readonly #roles: Record<string, string> = {
		default: "anthropic/claude-sonnet-5-5",
		smol: "openai-codex/gpt-6-luna",
		plan: "anthropic/claude-opus-5-5",
		slow: "anthropic/claude-opus-5-5",
		commit: "openai-codex/gpt-6-luna",
	};
	readonly #profiles: MockProfile[] = [
		{
			name: "task",
			source: "bundled",
			description: "General-purpose subagent for delegated implementation work.",
			definitionModels: ["default"],
		},
		{
			name: "explore",
			source: "bundled",
			description: "Read-only codebase scout; returns findings with file locations.",
			definitionModels: ["smol", "default"],
			override: "openai-codex/gpt-6-luna",
		},
		{
			name: "reviewer",
			source: "user",
			description: "Reviews a finished change and runs throwaway probes; ends with a verdict.",
			definitionModels: ["plan"],
		},
		{
			name: "librarian",
			source: "user",
			description: "Looks up one external fact or document.",
			definitionModels: ["anthropic/claude-haiku-5-5"],
		},
	];

	models(): ListModelsResponse {
		return { models: MODELS.map(model => ({ ...model })), roles: { ...this.#roles } };
	}

	profiles(): ListProfilesResponse {
		return {
			profiles: this.#profiles.map(profile => ({
				...profile,
				definitionModels: [...profile.definitionModels],
				effectiveModel: this.#effective(profile),
			})),
			roles: { ...this.#roles },
		};
	}

	hasProfile(name: string): boolean {
		return this.#profiles.some(profile => profile.name === name);
	}

	hasRole(role: string): boolean {
		return role in this.#roles;
	}

	setProfileOverride(name: string, selector: string | null): void {
		const profile = this.#profiles.find(candidate => candidate.name === name);
		if (!profile) return;
		if (selector === null) delete profile.override;
		else profile.override = selector;
	}

	setRole(role: string, selector: string): void {
		this.#roles[role] = selector;
	}

	#effective(profile: MockProfile): string | undefined {
		for (const candidate of [profile.override, ...profile.definitionModels]) {
			if (candidate === undefined) continue;
			const resolved = this.resolve(candidate);
			if (resolved.ok) return resolved.model;
		}
		return undefined;
	}

	/** Resolves a selector to `provider/id` and refuses models the shared login cannot use. */
	resolve(selector: string): SelectorResolution {
		const wanted = selector.trim();
		if (wanted === "") return { ok: false, reason: "unknown", message: "empty selector" };
		const target = this.#roles[wanted] ?? wanted;
		const exact = MODELS.find(model => model.selector === target);
		const lower = target.toLowerCase();
		const fuzzy = exact
			? []
			: MODELS.filter(model => model.selector.toLowerCase().includes(lower) || model.label.toLowerCase().includes(lower));
		const found = exact ?? (fuzzy.length === 1 ? fuzzy[0] : undefined);
		if (!found) {
			return {
				ok: false,
				reason: "unknown",
				message: fuzzy.length > 1 ? `selector "${wanted}" is ambiguous` : `no model matches "${wanted}"`,
			};
		}
		if (!found.available) {
			return { ok: false, reason: "unavailable", message: `${found.selector} is not available with the shared login` };
		}
		return { ok: true, model: found.selector };
	}
}
