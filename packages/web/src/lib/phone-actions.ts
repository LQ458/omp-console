import type { CatalogCommand, JournalEvent, SessionRecipe } from "@omp-console/protocol";
import { normalizePromptUse, promptUseKey, type PromptUse } from "./prompt-history";
import { routeCommand } from "./palette";

export const PHONE_SUGGESTION_LIMIT = 10;
export const PHONE_USUAL_ACTION_LIMIT = 20;
const JOURNAL_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1_000;
const PROMPT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1_000;
const MIN_REPEATED_PROMPTS = 2;

export type PhoneDeckActionId =
	| "stop"
	| "pause"
	| "retry"
	| "rewind"
	| "aside"
	| "plan"
	| "model"
	| "compact"
	| "last-link"
	| "new-session"
	| "search";

export type PhoneUsualAction =
	| { kind: "action"; id: PhoneDeckActionId; label: string; title: string }
	| { kind: "prompt"; id: string; text: string; label: string; title: string }
	| { kind: "command"; id: string; command: CatalogCommand; label: string; title: string }
	| { kind: "recipe"; id: string; recipe: SessionRecipe; label: string; title: string };

export interface PhoneActionInput {
	events: readonly JournalEvent[];
	prompts: readonly string[];
	promptUses: readonly PromptUse[];
	savedReplies: readonly string[];
	suggestions: readonly string[];
	commands: readonly CatalogCommand[];
	recipes: readonly SessionRecipe[];
	paused?: boolean;
	working: boolean;
	now: number;
}

export interface PhoneActionPanelContent {
	suggestions: string[];
	usualActions: PhoneUsualAction[];
}

const DEFAULT_ACTIONS: readonly { id: Exclude<PhoneDeckActionId, "stop">; label: string; title: string }[] = [
	{ id: "retry", label: "Retry", title: "Retry the last agent turn" },
	{ id: "rewind", label: "Rewind", title: "Choose a message to rewind to" },
	{ id: "aside", label: "Ask aside", title: "Ask a side question without changing the transcript" },
	{ id: "plan", label: "Plan mode", title: "Toggle plan mode" },
	{ id: "pause", label: "Pause", title: "Pause the agent at its next safe boundary" },
	{ id: "model", label: "Model", title: "Choose a model for this session" },
	{ id: "compact", label: "Compact", title: "Open the context compaction controls" },
	{ id: "last-link", label: "Open last link", title: "Open the latest link in the transcript" },
	{ id: "new-session", label: "New session", title: "Open the session picker" },
	{ id: "search", label: "Search prompts", title: "Find a previous prompt in this session" },
];

const DEFAULT_PROMPTS = [
	"Continue",
	"Run the tests",
	"Commit the changes",
	"Verify the result",
	"Explain this further",
	"Summarize what changed",
] as const;

interface PromptCandidate {
	text: string;
	score: number;
	lastUsed: number;
	priority: number;
	order: number;
}

interface RankedAction {
	action: PhoneUsualAction;
	score: number;
	lastUsed: number;
	priority: number;
	order: number;
}

interface UsageScore {
	score: number;
	lastUsed: number;
}

export function normalizePhonePrompt(text: string): string {
	return normalizePromptUse(text);
}

export function limitPhoneSuggestions(replies: readonly string[]): string[] {
	const seen = new Set<string>();
	const limited: string[] = [];
	for (const reply of replies) {
		const text = reply.trim();
		const key = normalizePhonePrompt(text);
		if (key === "" || seen.has(key)) continue;
		seen.add(key);
		limited.push(text);
		if (limited.length === PHONE_SUGGESTION_LIMIT) break;
	}
	return limited;
}

function promptLabel(text: string): string {
	const characters = Array.from(text);
	return characters.length > 80 ? `${characters.slice(0, 79).join("")}…` : text;
}

function usageScore(events: readonly JournalEvent[], now: number, matches: (event: JournalEvent) => boolean): UsageScore {
	let score = 0;
	let lastUsed = Number.NEGATIVE_INFINITY;
	for (const event of events) {
		if (event.outcome === "abandoned" || !Number.isFinite(event.at) || !matches(event)) continue;
		const age = Math.max(0, now - event.at);
		score += 2 ** (-age / JOURNAL_HALF_LIFE_MS);
		lastUsed = Math.max(lastUsed, event.at);
	}
	return { score, lastUsed };
}

function phoneActionUsage(event: JournalEvent, id: PhoneDeckActionId): boolean {
	if (event.feature === "phone-actions" && event.action === "use" && event.detail === `action:${id}`) return true;
	if (id === "compact" && event.feature === "1.10.context" && event.action.startsWith("compact:")) return true;
	if (id === "model" && event.feature === "5.2.palette" && event.detail === "model") return true;
	return false;
}

function commandUsage(event: JournalEvent, name: string): boolean {
	return event.detail === name &&
		(event.feature === "5.2.palette" || event.feature === "0.1.catalog") &&
		(event.action === "run" || event.action === "panel" || event.action === "fill");
}

function recipeUsage(event: JournalEvent, id: string): boolean {
	return event.feature === "phone-actions" && event.action === "use" && event.detail === `recipe:${id}`;
}

function actionLabelKey(action: PhoneUsualAction): string {
	return normalizePhonePrompt(action.kind === "prompt" ? action.text : action.label);
}

function rankedUsualActions(input: PhoneActionInput, suggestions: readonly string[]): PhoneUsualAction[] {
	const suggestionKeys = new Set(suggestions.map(normalizePhonePrompt));
	const recordedUses = new Map(input.promptUses.map(use => [use.key, use]));
	const candidates: RankedAction[] = [];
	const promptCandidates = new Map<string, PromptCandidate>();
	let order = 0;

	const add = (action: PhoneUsualAction, score: UsageScore, priority: number): void => {
		candidates.push({ action, ...score, priority, order: order++ });
	};

	const addPrompt = (rawText: string, score: number, lastUsed: number, priority: number): void => {
		const text = rawText.trim();
		const key = normalizePhonePrompt(text);
		if (key === "" || suggestionKeys.has(key)) return;
		const previous = promptCandidates.get(key);
		if (previous !== undefined && (previous.score > score || (previous.score === score && previous.priority <= priority))) return;
		promptCandidates.set(key, { text, score, lastUsed, priority, order: order++ });
	};

	const promptUsage = new Map<string, { text: string; count: number; score: number; lastUsed: number }>();
	for (let index = 0; index < input.prompts.length; index++) {
		const text = input.prompts[index]!.trim();
		const key = normalizePhonePrompt(text);
		if (key === "") continue;
		const current = promptUsage.get(key) ?? { text, count: 0, score: 0, lastUsed: index };
		current.text = text;
		current.count++;
		current.score += 2 ** ((index - input.prompts.length + 1) / 8);
		current.lastUsed = index;
		promptUsage.set(key, current);
	}
	for (const prompt of promptUsage.values()) {
		const recorded = recordedUses.get(promptUseKey(prompt.text));
		const count = recorded?.count ?? prompt.count;
		if (count < MIN_REPEATED_PROMPTS) continue;
		const score = recorded === undefined
			? prompt.score
			: recorded.count * 2 ** (-Math.max(0, input.now - recorded.at) / PROMPT_HALF_LIFE_MS);
		addPrompt(prompt.text, score, recorded?.at ?? prompt.lastUsed, 0);
	}
	for (const reply of input.savedReplies) addPrompt(reply, 0, Number.NEGATIVE_INFINITY, 1);
	for (const prompt of DEFAULT_PROMPTS) addPrompt(prompt, 0, Number.NEGATIVE_INFINITY, 3);

	const commands = new Map<string, CatalogCommand>();
	for (const command of input.commands) {
		const name = command.name.trim();
		if (name === "" || routeCommand(command).kind === "terminal") continue;
		const key = name.toLowerCase();
		if (!commands.has(key)) commands.set(key, command);
	}

	for (const definition of DEFAULT_ACTIONS) {
		const id: PhoneDeckActionId = definition.id === "retry" && input.working ? "stop" : definition.id;
		const label = id === "stop" ? "Stop" : id === "pause" ? (input.paused ? "Resume" : "Pause") : definition.label;
		const title =
			id === "stop"
				? "Stop the current agent turn"
				: id === "pause"
					? input.paused
						? "Resume the paused agent"
						: "Pause the agent at its next safe boundary"
					: definition.title;
		const action: PhoneUsualAction = { kind: "action", id, label, title };
		const score = usageScore(input.events, input.now, event => phoneActionUsage(event, id));
		add(action, score, 0);
	}

	for (const [name, command] of commands) {
		if (name === "compact" || name === "model") continue;
		const action: PhoneUsualAction = {
			kind: "command",
			id: `command:${name}`,
			command,
			label: `/${command.name}`,
			title: command.description ?? `Run /${command.name}`,
		};
		const score = usageScore(input.events, input.now, event => commandUsage(event, name));
		const priority = ["tan", "omfg", "cleanse"].includes(name) ? 2 : 4;
		add(action, score, priority);
	}

	for (const recipe of input.recipes) {
		const action: PhoneUsualAction = {
			kind: "recipe",
			id: `recipe:${recipe.id}`,
			recipe,
			label: recipe.name,
			title: `Start session template: ${recipe.name}`,
		};
		const score = usageScore(input.events, input.now, event => recipeUsage(event, recipe.id));
		add(action, score, 2);
	}

	for (const prompt of promptCandidates.values()) {
		const action: PhoneUsualAction = {
			kind: "prompt",
			id: `prompt:${normalizePhonePrompt(prompt.text)}`,
			text: prompt.text,
			label: promptLabel(prompt.text),
			title: prompt.text,
		};
		add(action, { score: prompt.score, lastUsed: prompt.lastUsed }, prompt.priority);
	}

	candidates.sort((left, right) =>
		right.score - left.score || right.lastUsed - left.lastUsed || left.priority - right.priority || left.order - right.order,
	);
	const seen = new Set<string>();
	const ranked: PhoneUsualAction[] = [];
	for (const candidate of candidates) {
		const key = actionLabelKey(candidate.action);
		if (key === "" || seen.has(key)) continue;
		seen.add(key);
		ranked.push(candidate.action);
		if (ranked.length === PHONE_USUAL_ACTION_LIMIT) break;
	}
	return ranked;
}


export function buildPhoneActionPanel(input: PhoneActionInput): PhoneActionPanelContent {
	const suggestions = limitPhoneSuggestions(input.suggestions);
	return { suggestions, usualActions: rankedUsualActions(input, suggestions) };
}

