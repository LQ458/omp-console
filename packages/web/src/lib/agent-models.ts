/** Searchable, provider-grouped view of `GET /api/models` for the model picker. */
import type { ListModelsResponse, ModelOption } from "@omp-console/protocol";
import type { DeckApi } from "./api";
import { describeControlError } from "./agent-api";

export interface ModelPickItem {
	/** What the API accepts: `provider/id` for a model, the alias name for a role. */
	selector: string;
	label: string;
	/** Second line: the provider for a model, the target selector for a role alias. */
	detail: string;
	kind: "model" | "role";
	available: boolean;
}

export interface ModelPickGroup {
	id: string;
	label: string;
	items: ModelPickItem[];
}

export const ROLE_GROUP_ID = "@roles";

function tokens(query: string): string[] {
	return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(haystack: string, needles: readonly string[]): boolean {
	const lower = haystack.toLowerCase();
	return needles.every(needle => lower.includes(needle));
}

const byAvailabilityThenLabel = (a: ModelPickItem, b: ModelPickItem): number => {
	if (a.available !== b.available) return a.available ? -1 : 1;
	return a.label.localeCompare(b.label);
};

/**
 * Role aliases first (they resolve through the person's config), then one group per provider. Every whitespace
 * separated word of the query must occur in the selector, label, provider, or a role's target. Unavailable models
 * stay listed (so the reason they cannot be picked is visible) but sort last in their group.
 */
export function buildModelGroups(response: ListModelsResponse, query: string): ModelPickGroup[] {
	const needles = tokens(query);
	const known = new Map<string, ModelOption>(response.models.map(model => [model.selector, model]));

	const roleItems: ModelPickItem[] = [];
	for (const [role, target] of Object.entries(response.roles)) {
		if (!matches(`${role} ${target}`, needles)) continue;
		roleItems.push({
			selector: role,
			label: role,
			detail: target,
			kind: "role",
			// A target the list does not know is not proven unusable: the daemon resolves it.
			available: known.get(target)?.available ?? true,
		});
	}
	roleItems.sort((a, b) => a.label.localeCompare(b.label));

	const byProvider = new Map<string, ModelPickItem[]>();
	for (const model of response.models) {
		if (!matches(`${model.selector} ${model.label} ${model.provider}`, needles)) continue;
		const item: ModelPickItem = {
			selector: model.selector,
			label: model.label,
			detail: model.provider,
			kind: "model",
			available: model.available,
		};
		const bucket = byProvider.get(model.provider);
		if (bucket) bucket.push(item);
		else byProvider.set(model.provider, [item]);
	}

	const groups: ModelPickGroup[] = [];
	if (roleItems.length > 0) groups.push({ id: ROLE_GROUP_ID, label: "Role aliases", items: roleItems });
	for (const provider of [...byProvider.keys()].sort((a, b) => a.localeCompare(b))) {
		groups.push({ id: provider, label: provider, items: byProvider.get(provider)!.sort(byAvailabilityThenLabel) });
	}
	return groups;
}

/** Human name for a selector in a result line: the model's label when the list knows it. */
export function labelForSelector(response: ListModelsResponse | null, selector: string): string {
	return response?.models.find(model => model.selector === selector)?.label ?? selector;
}

export type ModelChangeResult =
	| { ok: true; model: string; thinkingLevel?: string }
	| { ok: false; message: string };

/** One model change for the root agent or a running subagent; the failure is already a sentence for the inline note. */
export async function changeAgentModel(
	api: DeckApi,
	sessionId: string,
	agentId: string,
	selector: string,
): Promise<ModelChangeResult> {
	try {
		const result = await api.setAgentModel(sessionId, agentId, selector);
		return { ok: true, model: result.model, thinkingLevel: result.thinkingLevel };
	} catch (err) {
		return { ok: false, message: describeControlError(err, "agent-model") };
	}
}
