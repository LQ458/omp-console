/**
 * Shell side of omp's keybindings (wave 3, B1): the keymap (`lib/keymap.ts`) emits `omp-console:keymap-action`; the composer
 * and transcript handle their own actions, the focused session view hands the rest to {@link runShellKeyAction}, which
 * calls the same controls the header and sheets use. Each mapping mirrors what the omp TUI does for that key.
 */
import type { ListModelsResponse, SessionOp } from "@omp-console/protocol";
import type { DeckKeyAction } from "./keymap";
import { THINKING_LEVELS, type ThinkingLevel } from "./session-model";

/** Opens the header's model and thinking popover of one session (Alt+M / Alt+P). */
export const OPEN_SESSION_CONTROLS_EVENT = "omp-console:open-session-controls";

/** omp's `app.model.cycleForward` order: the role models slow, default, smol. */
const ROLE_CYCLE = ["slow", "default", "smol"] as const;

export interface ShellKeyContext {
	rootAgentId: string | undefined;
	/** Host's current thinking level and model id (`provider/id` or `id`). */
	thinkingLevel: string | undefined;
	modelId: string | undefined;
	planModeEnabled: boolean | null;
	listModels(): Promise<ListModelsResponse>;
	setThinking(agentId: string, level: ThinkingLevel): Promise<void>;
	setModel(agentId: string, selector: string): Promise<void>;
	sessionOp(op: SessionOp): Promise<unknown>;
	setPlanMode(enabled: boolean): Promise<void>;
	runCommand(text: string): Promise<void>;
	openControls(): void;
	openAgents(): void;
	openTree(): void;
}

export function nextThinkingLevel(current: string | undefined): ThinkingLevel {
	const index = THINKING_LEVELS.findIndex(level => level === current);
	return THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]!;
}

/**
 * The next distinct role model after the current one, in `direction`. Roles that are unset or name the same model
 * as a neighbour are skipped; null when fewer than two distinct role models exist.
 */
export function nextRoleModel(roles: Record<string, string>, current: string | undefined, direction: 1 | -1): string | null {
	const ordered: string[] = [];
	for (const role of ROLE_CYCLE) {
		const model = roles[role];
		if (model && !ordered.includes(model)) ordered.push(model);
	}
	if (ordered.length < 2) return null;
	const matches = (model: string): boolean =>
		current !== undefined && (model === current || model.endsWith(`/${current}`) || current.endsWith(`/${model}`));
	const index = ordered.findIndex(matches);
	if (index === -1) return ordered[direction === 1 ? 0 : ordered.length - 1]!;
	return ordered[(index + direction + ordered.length) % ordered.length]!;
}

/** Runs one shell-owned action; returns false for actions this layer does not own (composer, transcript). */
export async function runShellKeyAction(action: DeckKeyAction, ctx: ShellKeyContext): Promise<boolean> {
	switch (action) {
		case "cycleThinking":
			if (ctx.rootAgentId === undefined) return true;
			await ctx.setThinking(ctx.rootAgentId, nextThinkingLevel(ctx.thinkingLevel));
			return true;
		case "cycleModelForward":
		case "cycleModelBackward": {
			if (ctx.rootAgentId === undefined) return true;
			const { roles } = await ctx.listModels();
			const next = nextRoleModel(roles, ctx.modelId, action === "cycleModelForward" ? 1 : -1);
			if (next !== null) await ctx.setModel(ctx.rootAgentId, next);
			return true;
		}
		case "selectModel":
		case "selectTemporaryModel":
			ctx.openControls();
			return true;
		case "togglePlan":
			await ctx.setPlanMode(!(ctx.planModeEnabled ?? false));
			return true;
		case "dequeueMessage":
			await ctx.sessionOp({ op: "dequeue" });
			return true;
		case "retry":
			await ctx.runCommand("/retry");
			return true;
		case "openAgentsHub":
			ctx.openAgents();
			return true;
		case "openSessionTree":
			ctx.openTree();
			return true;
		default:
			return false;
	}
}
