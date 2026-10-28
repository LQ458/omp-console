import type { DecisionModel, TextModel } from "./types";
import { createJevDecisionModel, type DecisionFetch } from "./jev";
import { loadOpenRouterKey } from "./keychain";
import { createTextDecisionModel } from "./text-decision";

export interface DecisionModelOptions {
	text: TextModel;
	keyLoader?: () => Promise<string | undefined>;
	fetch?: DecisionFetch;
}

export async function createDecisionModel(options: DecisionModelOptions): Promise<DecisionModel> {
	const apiKey = (await (options.keyLoader ?? loadOpenRouterKey)())?.trim();
	if (!apiKey) return createTextDecisionModel(options.text);
	return createJevDecisionModel({ apiKey, fetch: options.fetch });
}
