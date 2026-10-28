/**
 * Model and thinking changes for one agent of this session's tree (root or subagent).
 *
 * The upstream collab `agent-cmd` path covers chat, kill, revive and transcript for subagents but has no
 * model command. The deck supervisor's `set-agent-model` / `set-agent-thinking` worker commands call these
 * resolvers for a registry agent id and apply the result with `setModelTemporary` / `setThinkingLevel`
 * (persist = false), which change the live session without rewriting persisted defaults.
 */
import type { SetAgentThinkingRequest } from "@omp-console/protocol";
import { getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export class AgentModelError extends Error {
	override readonly name = "AgentModelError";
}

export interface FocusedModelResult {
	agentId: string;
	/** `provider/id` now active on the agent. */
	model: string;
	thinkingLevel: string | undefined;
}

/** The live session of a root or subagent id; the messages are matched by the daemon to HTTP statuses. */
function focusedSession(registry: AgentRegistry, agentId: string, action: string): AgentSession {
	const ref = registry.get(agentId);
	if (!ref) throw new AgentModelError(`unknown agent ${agentId}`);
	const session = ref.session;
	if (!session) throw new AgentModelError(`agent ${agentId} is ${ref.status} and has no live session`);
	if (ref.kind === "advisor") throw new AgentModelError(`agent ${agentId} is an advisor and cannot be ${action}`);
	return session;
}

function describeActive(session: AgentSession, agentId: string, fallbackModel?: { provider: string; id: string }): FocusedModelResult {
	const active = session.model ?? fallbackModel;
	return {
		agentId,
		model: active ? `${active.provider}/${active.id}` : "unknown",
		// `auto` stays `auto`: the selector is what the user configured, not the level it resolved to this turn.
		thinkingLevel: session.configuredThinkingLevel() ?? session.thinkingLevel,
	};
}

export async function setFocusedAgentModel(
	registry: AgentRegistry,
	agentId: string,
	selector: string,
): Promise<FocusedModelResult> {
	const session = focusedSession(registry, agentId, "re-modelled");
	const resolved = resolveCliModel({
		cliModel: selector,
		modelRegistry: session.modelRegistry,
		availableModels: session.modelRegistry.getAvailable(),
		settings: session.settings,
		preferences: getModelMatchPreferences(session.settings),
	});
	if (resolved.error) throw new AgentModelError(resolved.error);
	if (!resolved.model) throw new AgentModelError(`no model matches "${selector}"`);

	await session.setModelTemporary(resolved.model, resolved.thinkingLevel);
	const result = describeActive(session, agentId, resolved.model);
	return { ...result, thinkingLevel: session.thinkingLevel };
}

/**
 * Session-only thinking level for the root agent or a running subagent. The level is clamped to what the active
 * model supports (a non-reasoning model stays `off`); the reply carries what is in effect afterwards.
 */
export function setFocusedAgentThinking(
	registry: AgentRegistry,
	agentId: string,
	level: SetAgentThinkingRequest["level"],
): FocusedModelResult {
	if (!CLI_THINKING_LEVELS.includes(level as ConfiguredThinkingLevel)) {
		throw new AgentModelError(`unknown thinking level "${String(level)}"`);
	}
	const session = focusedSession(registry, agentId, "given a thinking level");
	session.setThinkingLevel(level as ConfiguredThinkingLevel, false);
	return describeActive(session, agentId);
}
