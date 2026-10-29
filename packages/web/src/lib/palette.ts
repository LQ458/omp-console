/**
 * Command palette and `^model` logic, spec 5.2, 5.3: fuzzy ranking over the live catalog, routing of one command to
 * "run remotely", "fill the composer", "open an omp console panel" or "terminal only", and the two window events other panels
 * use to talk to the shell and the composer.
 */
import type { CatalogCommand, CatalogCommandSource, ModelOption } from "@omp-console/protocol";
import { ompEquivalent } from "./equivalents";

const OVERNIGHT_COMMAND: CatalogCommand = {
	name: "overnight",
	description: "Start or manage an Overnight run for this session.",
	source: "builtin",
	remote: false,
	deckControl: "overnight",
};

/** Adds the web-owned overnight panel command only when the feature is enabled. */
export function withOvernightCommand(commands: readonly CatalogCommand[], enabled: boolean): CatalogCommand[] {
	const available = commands.filter(command => command.name !== OVERNIGHT_COMMAND.name);
	return enabled ? [...available, OVERNIGHT_COMMAND] : available;
}

const TOUR_COMMAND: CatalogCommand = {
	name: "tour",
	description: "Show the first-visit tour.",
	source: "builtin",
	remote: false,
	deckControl: "tour",
};

/** Replaces a daemon `/tour` command with the web-owned first-visit tour. */
export function withTourCommand(commands: readonly CatalogCommand[]): CatalogCommand[] {
	return [...commands.filter(command => command.name !== TOUR_COMMAND.name), TOUR_COMMAND];
}

// ---- window events -----------------------------------------------------------------------------

/** `omp-console:open-panel`: the shell listens and opens the panel named `detail.panel` (e.g. `status`, `spawn`, `catalog`). */
export const OPEN_PANEL_EVENT = "omp-console:open-panel";

export interface OpenPanelDetail {
	panel: string;
	/** Panel-specific preselection, e.g. the profile for `spawn`. */
	profile?: string;
	/** The omp slash command that opened the panel (without `/`), when a command did. */
	command?: string;
	/** Existing session whose overnight state should open. */
	sessionId?: string;
	/** Working directory for a new overnight session. */
	cwd?: string;
	/** Optional task prefill. */
	task?: string;
	/** What followed the command name, trimmed (`/queue fix tests` → `fix tests`). */
	args?: string;
}

/** `omp-console:composer-insert`: insert at the caret, at the draft start, or replace the draft. */
export const COMPOSER_INSERT_EVENT = "omp-console:composer-insert";

export interface ComposerInsertDetail {
	text: string;
	atStart?: boolean;
	replace?: boolean;
}

export function openPanel(detail: OpenPanelDetail, target: EventTarget = globalThis): void {
	target.dispatchEvent(new CustomEvent<OpenPanelDetail>(OPEN_PANEL_EVENT, { detail }));
}

export function insertIntoComposer(detail: ComposerInsertDetail, target: EventTarget = globalThis): void {
	target.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail }));
}

// ---- fuzzy ranking -----------------------------------------------------------------------------

const WORD_BREAK = /[\s\-_:/.]/;

/** Higher is better; null when `query` does not match `text`. Empty query matches everything with 0. */
export function fuzzyScore(query: string, text: string): number | null {
	const q = query.trim().toLowerCase();
	if (q === "") return 0;
	const t = text.toLowerCase();
	if (t === q) return 1000;
	if (t.startsWith(q)) return 800 - Math.min(t.length - q.length, 100);
	const index = t.indexOf(q);
	if (index >= 0) {
		const atWord = index === 0 || WORD_BREAK.test(t[index - 1] ?? "");
		return (atWord ? 600 : 500) - Math.min(index, 100);
	}
	let score = 100;
	let from = 0;
	let previous = -2;
	for (const ch of q) {
		const found = t.indexOf(ch, from);
		if (found < 0) return null;
		if (found === previous + 1) score += 8;
		if (found === 0 || WORD_BREAK.test(t[found - 1] ?? "")) score += 6;
		score -= Math.min(found - from, 5);
		previous = found;
		from = found + 1;
	}
	return Math.max(score, 1);
}

export const SOURCE_ORDER: readonly CatalogCommandSource[] = [
	"builtin",
	"user",
	"project",
	"extension",
	"skill",
	"template",
	"mcp",
];

export const SOURCE_LABEL: Record<CatalogCommandSource, string> = {
	builtin: "Built-in",
	user: "User commands",
	project: "Project commands",
	extension: "Extensions",
	skill: "Skills",
	template: "Prompt templates",
	mcp: "MCP prompts",
};

export interface RankedCommand {
	command: CatalogCommand;
	score: number;
}

function sourceRank(source: CatalogCommandSource): number {
	const rank = SOURCE_ORDER.indexOf(source);
	return rank < 0 ? SOURCE_ORDER.length : rank;
}

function commandScore(command: CatalogCommand, query: string): number | null {
	let best = fuzzyScore(query, command.name);
	for (const alias of command.aliases ?? []) {
		const score = fuzzyScore(query, alias);
		if (score !== null) best = Math.max(best ?? 0, score * 0.95);
	}
	const q = query.trim().toLowerCase();
	if (best === null && q !== "" && command.description?.toLowerCase().includes(q)) best = 150;
	return best;
}

/**
 * Commands matching `query` (a leading `/` is ignored), best first. An empty query lists everything grouped by source
 * order, alphabetical inside a group.
 */
export function rankCommands(commands: readonly CatalogCommand[], query: string): RankedCommand[] {
	const q = query.trim().replace(/^\//, "");
	const ranked: RankedCommand[] = [];
	for (const command of commands) {
		const score = commandScore(command, q);
		if (score !== null) ranked.push({ command, score });
	}
	ranked.sort((a, b) => {
		if (q === "") {
			return (
				sourceRank(a.command.source) - sourceRank(b.command.source) || a.command.name.localeCompare(b.command.name)
			);
		}
		return (
			b.score - a.score ||
			a.command.name.length - b.command.name.length ||
			sourceRank(a.command.source) - sourceRank(b.command.source) ||
			a.command.name.localeCompare(b.command.name)
		);
	});
	return ranked;
}

export interface CommandGroup {
	source: CatalogCommandSource;
	label: string;
	items: RankedCommand[];
}

/** Consecutive runs of one source (the empty-query ordering keeps each source contiguous). */
export function groupBySource(items: readonly RankedCommand[]): CommandGroup[] {
	const groups: CommandGroup[] = [];
	for (const item of items) {
		const last = groups[groups.length - 1];
		if (last && last.source === item.command.source) last.items.push(item);
		else groups.push({ source: item.command.source, label: SOURCE_LABEL[item.command.source], items: [item] });
	}
	return groups;
}

/** Splits `compact soft` into the name to search (`compact`) and the arguments typed after it (`soft`). */
export function splitPaletteQuery(raw: string): { search: string; args: string } {
	const text = raw.replace(/^\s*\//, "").trimStart();
	const space = text.search(/\s/);
	if (space < 0) return { search: text, args: "" };
	return { search: text.slice(0, space), args: text.slice(space).trim() };
}

// ---- routing -----------------------------------------------------------------------------------

export type CommandRoute =
	/** Run through `POST /api/sessions/:id/command`. */
	| { kind: "remote"; text: string }
	/** Remote command that needs an argument: put `text` in the composer and let the user finish it. */
	| { kind: "fill"; text: string }
	/** TUI-only command covered by an omp console panel. */
	| { kind: "panel"; panel: string; text: string }
	/** TUI-only with no console control: show the text to copy. */
	| { kind: "terminal"; text: string };

export function commandText(command: CatalogCommand, args = ""): string {
	const trimmed = args.trim();
	return trimmed === "" ? `/${command.name}` : `/${command.name} ${trimmed}`;
}

/** The omp text for a catalog command invocation, via the shared equivalents table. */
export function commandEquivalent(command: CatalogCommand, args = ""): string {
	return ompEquivalent(`command:${command.name}`, { arg: args }) ?? commandText(command, args);
}

export function routeCommand(command: CatalogCommand, args = ""): CommandRoute {
	const text = commandText(command, args);
	if (command.remote) {
		if (args.trim() === "" && command.usage !== undefined && command.usage.includes("<")) return { kind: "fill", text: `${text} ` };
		return { kind: "remote", text };
	}
	if (command.deckControl !== undefined && command.deckControl !== "") {
		return { kind: "panel", panel: command.deckControl, text };
	}
	return { kind: "terminal", text };
}

// ---- ^model ------------------------------------------------------------------------------------

const MODEL_LIMIT = 30;

/** Models matching `query` over selector and label; usable ones first on equal score. */
export function rankModels(models: readonly ModelOption[], query: string): ModelOption[] {
	const scored: { model: ModelOption; score: number }[] = [];
	for (const model of models) {
		const a = fuzzyScore(query, model.selector);
		const b = fuzzyScore(query, model.label);
		const score = a === null ? b : b === null ? a : Math.max(a, b);
		if (score !== null) scored.push({ model, score });
	}
	scored.sort(
		(x, y) =>
			y.score - x.score ||
			Number(y.model.available) - Number(x.model.available) ||
			x.model.selector.localeCompare(y.model.selector),
	);
	return scored.slice(0, MODEL_LIMIT).map(entry => entry.model);
}
