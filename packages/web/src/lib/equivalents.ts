/**
 * What each deck action is in omp itself (spec 0.2), so using the app teaches the TUI. Every id here names a real omp
 * slash command, tool call or prompt syntax; ids without a TUI equivalent are absent and return `undefined`.
 * `command:<name>` covers every catalog command generically.
 */

export interface EquivalentArgs {
	/** Command arguments, profile name, selector, path, ... depending on the action. */
	arg?: string;
	/** Second value for actions that take two (e.g. profile + task). */
	extra?: string;
}

type Builder = (args: EquivalentArgs) => string;

const withArg = (base: string) => (args: EquivalentArgs) => (args.arg ? `${base} ${args.arg}` : base);

const TABLE: Record<string, Builder> = {
	"context.compact": args => `/compact ${args.arg ?? "soft"}`,
	"context.shake": withArg("/shake"),
	"context.handoff": withArg("/handoff"),
	"context.show": () => "/context",
	"usage.show": () => "/usage",
	"jobs.list": () => "/jobs",
	"goal.set": withArg("/goal"),
	"loop.start": withArg("/loop"),
	"plan.toggle": () => "/plan",
	"todo.show": () => "/todo",
	"model.switch": withArg("/model"),
	"model.mention": args => `^${args.arg ?? "provider/id"}`,
	"thinking.set": withArg("/effort"),
	"file.mention": args => `@${args.arg ?? "path/to/file"}`,
	"shell.run": args => `!${args.arg ?? "command"}`,
	"skill.run": args => `/skill:${args.arg ?? "name"}`,
	"agent.spawn": args => `task({ agent: "${args.arg ?? "task"}", task: "${args.extra ?? "..."}" })`,
	"session.fork": () => "/fork",
	"session.tree": () => "/tree",
	"session.new": () => "/new",
	"mcp.list": () => "/mcp",
	"skills.list": () => "/skills",
	"agents.list": () => "/agents",
};

/** Action ids with a known equivalent, for tests and for writers choosing an id. */
export const EQUIVALENT_ACTIONS: readonly string[] = Object.keys(TABLE);

/**
 * The omp text for a deck action, e.g. `ompEquivalent("context.compact")` is `/compact soft`.
 * `command:<name>` builds `/<name> <arg>` for any slash command.
 */
export function ompEquivalent(actionId: string, args: EquivalentArgs = {}): string | undefined {
	if (actionId.startsWith("command:")) {
		const name = actionId.slice("command:".length);
		if (name === "") return undefined;
		const arg = args.arg?.trim();
		return arg ? `/${name} ${arg}` : `/${name}`;
	}
	return TABLE[actionId]?.(args);
}
