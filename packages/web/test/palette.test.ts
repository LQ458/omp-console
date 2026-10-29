import { describe, expect, it } from "bun:test";
import type { CatalogCommand, ModelOption } from "@omp-console/protocol";
import { ompEquivalent } from "../src/lib/equivalents";
import {
	commandEquivalent,
	groupBySource,
	rankCommands,
	rankModels,
	routeCommand,
	withOvernightCommand,
	withTourCommand,
	splitPaletteQuery,
} from "../src/lib/palette";

function cmd(name: string, extra: Partial<CatalogCommand> = {}): CatalogCommand {
	return { name, source: "builtin", remote: true, ...extra };
}

const COMMANDS: CatalogCommand[] = [
	cmd("compact", { description: "Compact the conversation", usage: "[soft|remote|snap]" }),
	cmd("context", { description: "Show context usage" }),
	cmd("copy", { description: "Copy the last reply" }),
	cmd("model", { description: "Switch model", aliases: ["models"], remote: false, deckControl: "model" }),
	cmd("tree", { description: "Browse the session tree", remote: false }),
	cmd("goal", { description: "Set the session goal", usage: "<objective>" }),
	cmd("release-notes", { source: "user", description: "Summarize the release" }),
	cmd("skill:visual-review", { source: "skill", description: "Review an artifact" }),
	cmd("review-pr", { source: "template", description: "Review a pull request", usage: "<number>" }),
];

const names = (query: string): string[] => rankCommands(COMMANDS, query).map(r => r.command.name);

describe("palette ranking", () => {
	it("ranks an exact name above a prefix above a later substring above a loose subsequence", () => {
		const order = names("co");
		expect(order.slice(0, 3)).toEqual(["copy", "compact", "context"]);
		expect(names("model")[0]).toBe("model");
		expect(names("rev")[0]).toBe("review-pr");
		const cp = names("cpt");
		expect(cp[0]).toBe("compact");
	});

	it("finds a command through its alias, and through its description only as a last resort", () => {
		expect(names("models")[0]).toBe("model");
		const viaDescription = names("conversation");
		expect(viaDescription).toEqual(["compact"]);
	});

	it("matches skills after the colon boundary and ignores a typed leading slash", () => {
		expect(names("/visual")[0]).toBe("skill:visual-review");
		expect(names("skill:")[0]).toBe("skill:visual-review");
	});

	it("returns nothing for a query that matches no name, alias or description", () => {
		expect(names("zzzz")).toEqual([]);
	});

	it("lists everything grouped by source in a fixed order when the query is empty", () => {
		const groups = groupBySource(rankCommands(COMMANDS, ""));
		expect(groups.map(g => g.source)).toEqual(["builtin", "user", "skill", "template"]);
		expect(groups[0]?.items.map(i => i.command.name)).toEqual(["compact", "context", "copy", "goal", "model", "tree"]);
	});

	it("splits the typed query into the name to search and the arguments to run it with", () => {
		expect(splitPaletteQuery("compact soft")).toEqual({ search: "compact", args: "soft" });
		expect(splitPaletteQuery("/goal  ship the beta ")).toEqual({ search: "goal", args: "ship the beta" });
		expect(splitPaletteQuery("com")).toEqual({ search: "com", args: "" });
	});
});

describe("palette routing", () => {
	it("runs a remote command remotely with its arguments", () => {
		expect(routeCommand(COMMANDS[0]!, "soft")).toEqual({ kind: "remote", text: "/compact soft" });
		expect(routeCommand(COMMANDS[0]!)).toEqual({ kind: "remote", text: "/compact" });
	});

	it("fills the composer for a remote command that requires an argument and none was given", () => {
		const goal = COMMANDS.find(c => c.name === "goal")!;
		expect(routeCommand(goal)).toEqual({ kind: "fill", text: "/goal " });
		expect(routeCommand(goal, "ship it")).toEqual({ kind: "remote", text: "/goal ship it" });
	});

	it("opens the matching omp console panel for a TUI-only command that has a control", () => {
		expect(routeCommand(COMMANDS.find(c => c.name === "model")!)).toEqual({
			kind: "panel",
			panel: "model",
			text: "/model",
		});
	});

	it("adds the overnight command only when enabled and replaces a conflicting daemon command", () => {
		const conflictingDaemonCommand = cmd("overnight", { remote: true, deckControl: "commands" });
		const commands = withOvernightCommand([...COMMANDS, conflictingDaemonCommand], true);
		const matches = commands.filter(command => command.name === "overnight");
		expect(matches).toHaveLength(1);
		expect(routeCommand(matches[0]!)).toEqual({ kind: "panel", panel: "overnight", text: "/overnight" });
		expect(withOvernightCommand([...COMMANDS, conflictingDaemonCommand], false).some(command => command.name === "overnight")).toBe(false);
	});

	it("routes the web-owned /tour command and replaces a daemon command with the same name", () => {
		const commands = withTourCommand([...COMMANDS, cmd("tour", { description: "Daemon tour" })]);
		const tour = commands.filter(command => command.name === "tour");
		expect(tour).toHaveLength(1);
		expect(routeCommand(tour[0]!)).toEqual({ kind: "panel", panel: "tour", text: "/tour" });
	});

	it("opens the terminal command panels with their typed arguments", () => {
		const commands = [
			{ command: cmd("tan", { remote: false, deckControl: "tan" }), args: "inspect parser" },
			{ command: cmd("omfg", { remote: false, deckControl: "omfg" }), args: "avoid repeated output" },
			{ command: cmd("cleanse", { remote: false, deckControl: "cleanse" }), args: "--tests" },
		];
		expect(commands.map(({ command, args }) => routeCommand(command, args))).toEqual([
			{ kind: "panel", panel: "tan", text: "/tan inspect parser" },
			{ kind: "panel", panel: "omfg", text: "/omfg avoid repeated output" },
			{ kind: "panel", panel: "cleanse", text: "/cleanse --tests" },
		]);
	});

	it("falls back to terminal-only for a TUI-only command with no console control", () => {
		expect(routeCommand(COMMANDS.find(c => c.name === "tree")!)).toEqual({ kind: "terminal", text: "/tree" });
	});

	it("shows the equivalent as the exact omp text that would be typed", () => {
		expect(commandEquivalent(COMMANDS[0]!, "soft")).toBe("/compact soft");
		expect(commandEquivalent(COMMANDS[0]!)).toBe("/compact");
	});
});

describe("^model suggestions", () => {
	const MODELS: ModelOption[] = [
		{ selector: "anthropic/claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", available: true },
		{ selector: "anthropic/claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", available: true },
		{ selector: "google/gemini-3-pro", provider: "google", label: "Gemini 3 Pro", available: false },
		{ selector: "openai-codex/gpt-6-luna", provider: "openai-codex", label: "GPT-6 Luna", available: true },
	];

	it("matches the selector or the label, best first", () => {
		expect(rankModels(MODELS, "opus")[0]?.selector).toBe("anthropic/claude-opus-5-5");
		expect(rankModels(MODELS, "luna")[0]?.selector).toBe("openai-codex/gpt-6-luna");
		expect(rankModels(MODELS, "anthropic/").map(m => m.provider)).toEqual(["anthropic", "anthropic"]);
	});

	it("keeps an unavailable model in the list so it can be shown disabled, behind usable ones on a tie", () => {
		const all = rankModels(MODELS, "");
		expect(all).toHaveLength(4);
		expect(all[all.length - 1]?.available).toBe(false);
	});
});

describe("omp equivalents", () => {
	it("gives real omp syntax for omp console actions and for any catalog command", () => {
		expect(ompEquivalent("context.compact")).toBe("/compact soft");
		expect(ompEquivalent("context.compact", { arg: "remote" })).toBe("/compact remote");
		expect(ompEquivalent("agent.spawn", { arg: "reviewer", extra: "check the diff" })).toBe(
			'task({ agent: "reviewer", task: "check the diff" })',
		);
		expect(ompEquivalent("model.mention", { arg: "anthropic/claude-opus-5-5" })).toBe("^anthropic/claude-opus-5-5");
		expect(ompEquivalent("command:skill:research", { arg: "topic" })).toBe("/skill:research topic");
	});

	it("returns undefined for an action with no TUI equivalent instead of guessing", () => {
		expect(ompEquivalent("graph.pan")).toBeUndefined();
		expect(ompEquivalent("command:")).toBeUndefined();
	});
});
