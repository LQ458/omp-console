/**
 * Capability catalog (spec 0.1): everything omp offers to this session right now, read from the live session's own
 * registries and omp's own discovery. Nothing here is a hand-written list:
 *
 *  - slash commands: the unified built-in registry (a command is `remote` when it has a text-mode `handle`, the same
 *    rule the ACP/RPC dispatcher applies), plus `buildAvailableSlashCommands` for skills, extension, custom/MCP and
 *    file commands, plus the session's prompt templates;
 *  - tools: the session's active and `xd://`-mounted tools;
 *  - profiles: omp's agent discovery for the session cwd and extension roots;
 *  - skills, model roles and MCP servers from the session and its MCP manager.
 *
 * The result is cached for `CATALOG_TTL_MS`. A cache miss while the session is idle first reloads skills and file
 * commands from disk (`refreshSkillsAndCommands`, the call RPC mode makes on a plugin reload; the system prompt
 * keeps its frozen skill listing), so a command, skill or agent added under the agent dir shows up on the next
 * reload without restarting the worker.
 */
import * as os from "node:os";
import type {
	AgentProfileDetail,
	CatalogCommand,
	CatalogMcpServer,
	CatalogResponse,
	CatalogSkill,
	CatalogTool,
} from "@omp-console/protocol";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveAgentModelSelection, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getSkillSlashCommandName } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

export const CATALOG_TTL_MS = 10_000;
const DESCRIPTION_LIMIT = 200;

/**
 * omp console panel that covers a command omp only offers in its TUI. Which panel replaces which command is an omp console
 * decision (the panels are omp console's, not omp's); a command absent here has no omp console equivalent yet.
 */
const OMP_CONSOLE_CONTROL_BY_COMMAND: Readonly<Record<string, string>> = {
	settings: "settings",
	setup: "settings",
	login: "settings",
	logout: "settings",
	plan: "plan",
	"plan-review": "plan",
	agents: "agents",
	hub: "agents",
	tree: "tree",
	branch: "tree",
	new: "sessions",
	resume: "sessions",
	fork: "sessions",
	delete: "sessions",
	clear: "sessions",
	seance: "sessions",
	btw: "btw",
	goal: "status",
	"guided-goal": "status",
	tan: "tan",
	omfg: "omfg",
	cleanse: "cleanse",
	skills: "skills",
	git: "git",
	record: "record",
	pause: "pause",
	queue: "queue",
	restart: "restart",
	collab: "collab",
	join: "join",
	leave: "leave",
	open: "open",
	copy: "copy",
	hotkeys: "hotkeys",
	extensions: "extensions",
	exit: "leave",
	quit: "leave",
	loop: "session-modes",
	vibe: "session-modes",
	live: "live",
	debug: "debug",
};

/** First non-empty line of a possibly long (prompt-sized) description. */
function shortDescription(text: string | undefined): string | undefined {
	const line = text
		?.split("\n")
		.map(candidate => candidate.trim())
		.find(candidate => candidate.length > 0);
	if (!line) return undefined;
	return line.length > DESCRIPTION_LIMIT ? `${line.slice(0, DESCRIPTION_LIMIT - 1)}…` : line;
}

function commandName(name: string): string {
	return name.startsWith("/") ? name.slice(1) : name;
}

function builtinCommands(): CatalogCommand[] {
	return BUILTIN_SLASH_COMMANDS_INTERNAL.map(spec => {
		const subcommands = spec.subcommands?.map(sub => sub.name) ?? [];
		const usage = spec.acpInputHint ?? spec.inlineHint ?? (subcommands.length > 0 ? `[${subcommands.join("|")}]` : undefined);
		const remote = spec.handle !== undefined;
		const command: CatalogCommand = {
			name: spec.name,
			source: "builtin",
			remote,
		};
		const description = shortDescription(spec.acpDescription ?? spec.description);
		if (description) command.description = description;
		if (usage) command.usage = usage;
		if (spec.aliases && spec.aliases.length > 0) command.aliases = [...spec.aliases];
		const control = remote ? undefined : OMP_CONSOLE_CONTROL_BY_COMMAND[spec.name];
		if (control) command.deckControl = control;
		return command;
	});
}

async function buildCommands(session: AgentSession): Promise<CatalogCommand[]> {
	const commands = builtinCommands();
	// A name taken by a built-in (primary or alias) belongs to it: omp dispatches built-ins first.
	const taken = new Set(commands.flatMap(command => [command.name, ...(command.aliases ?? [])]));
	const append = (command: CatalogCommand): void => {
		if (taken.has(command.name)) return;
		taken.add(command.name);
		commands.push(command);
	};

	const skillsRunnable = session.skillsSettings?.enableSkillCommands === true;
	for (const skill of session.skills) {
		const command: CatalogCommand = {
			name: getSkillSlashCommandName(skill),
			source: "skill",
			usage: "[arguments]",
			remote: skillsRunnable,
		};
		const description = shortDescription(skill.description);
		if (description) command.description = description;
		append(command);
	}

	const available = await buildAvailableSlashCommands(session);
	for (const entry of available) {
		if (entry.source === "builtin" || entry.source === "skill") continue;
		const name = commandName(entry.name);
		const command: CatalogCommand = { name, source: "extension", remote: true };
		const description = shortDescription(entry.description);
		if (description) command.description = description;
		if (entry.input?.hint) command.usage = entry.input.hint;
		if (entry.source === "mcp_prompt") command.source = "mcp";
		else if (entry.source === "custom") {
			const loaded = session.customCommands.find(candidate => candidate.command.name === name);
			command.source = loaded?.source === "project" ? "project" : loaded?.source === "bundled" ? "builtin" : "user";
		} else if (entry.source === "file") {
			const level = session.slashCommands.find(candidate => candidate.name === name)?._source?.level;
			command.source = level === "project" ? "project" : level === undefined ? "builtin" : "user";
		}
		append(command);
	}

	for (const template of session.promptTemplates) {
		const command: CatalogCommand = { name: template.name, source: "template", remote: true };
		const description = shortDescription(template.description);
		if (description) command.description = description;
		append(command);
	}
	return commands;
}

function buildTools(session: AgentSession): CatalogTool[] {
	const names = [...new Set([...session.getActiveToolNames(), ...session.getMountedXdevToolNames()])];
	return names.map(name => {
		const tool: CatalogTool = { name };
		const description = shortDescription(session.getToolByName(name)?.description);
		if (description) tool.description = description;
		return tool;
	});
}

/** Every agent definition omp would offer to the `task` tool for this session, before policy and settings filters. */
export async function discoverSessionAgents(session: AgentSession): Promise<AgentDefinition[]> {
	const { agents } = await discoverAgents(session.sessionManager.getCwd(), os.homedir(), session.effectiveExtensionRoots);
	return agents;
}

function profileDetail(session: AgentSession, agent: AgentDefinition): AgentProfileDetail {
	const definitionModels = agent.model === undefined ? [] : Array.isArray(agent.model) ? [...agent.model] : [agent.model];
	const profile: AgentProfileDetail = {
		name: agent.name,
		source: agent.source === "bundled" || agent.source === "project" ? agent.source : "user",
		definitionModels,
	};
	if (agent.description) profile.description = agent.description;
	const overrides = cfgTaskAgentModelOverrides.get(session.settings);
	const override = Object.hasOwn(overrides, agent.name) ? overrides[agent.name] : undefined;
	if (typeof override === "string") profile.override = override;
	else if (Array.isArray(override) && override[0]) profile.override = override[0];
	// Without a declared model or saved override a spawn inherits the live session model: nothing to resolve.
	if (override !== undefined || agent.model !== undefined) {
		const selection = resolveAgentModelSelection({ settingsOverride: override, agentModel: agent.model, settings: session.settings });
		const resolved = resolveModelOverride(selection.patterns, session.modelRegistry, session.settings).model;
		if (resolved) profile.effectiveModel = `${resolved.provider}/${resolved.id}`;
	}
	if (agent.tools) profile.tools = [...agent.tools];
	if (agent.spawns !== undefined) profile.spawns = agent.spawns === "*" ? "*" : [...agent.spawns];
	if (agent.thinkingLevel) profile.thinking = String(agent.thinkingLevel);
	if (agent.autoloadSkills && agent.autoloadSkills.length > 0) profile.skills = [...agent.autoloadSkills];
	if (agent.filePath) profile.file = agent.filePath;
	return profile;
}

/** Profiles the session's `task` tool will accept: those not disabled in `task.disabledAgents` (a worker's root session has no spawn restriction). */
async function buildProfiles(session: AgentSession): Promise<AgentProfileDetail[]> {
	const disabled = new Set(cfgTaskDisabledAgents.get(session.settings));
	const agents = await discoverSessionAgents(session);
	return agents.filter(agent => !disabled.has(agent.name)).map(agent => profileDetail(session, agent));
}

function buildSkills(session: AgentSession): CatalogSkill[] {
	return session.skills.map(skill => {
		const entry: CatalogSkill = { name: skill.name, source: skill.source };
		const description = shortDescription(skill.description);
		if (description) entry.description = description;
		return entry;
	});
}

function buildRoles(session: AgentSession): Record<string, string> {
	const roles: Record<string, string> = Object.create(null);
	for (const [role, selector] of Object.entries(session.settings.getModelRoles())) {
		if (typeof selector === "string") roles[role] = selector;
	}
	return roles;
}

function buildMcp(manager: MCPManager | undefined): CatalogMcpServer[] {
	if (!manager) return [];
	const tools = manager.getTools();
	return manager.getAllServerNames().map(name => ({
		name,
		connected: manager.getConnectionStatus(name) === "connected",
		toolCount: tools.filter(tool => tool.mcpServerName === name).length,
	}));
}

export class CatalogProvider {
	readonly #session: AgentSession;
	readonly #mcpManager: MCPManager | undefined;
	readonly #now: () => number;
	#cached: CatalogResponse | undefined;
	#inFlight: Promise<CatalogResponse> | undefined;

	constructor(session: AgentSession, mcpManager: MCPManager | undefined, now: () => number = Date.now) {
		this.#session = session;
		this.#mcpManager = mcpManager;
		this.#now = now;
	}

	/** The catalog, at most `CATALOG_TTL_MS` old; concurrent callers share one build. */
	get(): Promise<CatalogResponse> {
		const cached = this.#cached;
		if (cached && this.#now() - cached.generatedAt < CATALOG_TTL_MS) return Promise.resolve(cached);
		this.#inFlight ??= this.#build().finally(() => {
			this.#inFlight = undefined;
		});
		return this.#inFlight;
	}

	/** Drop the cached catalog (a plugin toggle changed what the registries hold); the next `get` rebuilds it. */
	invalidate(): void {
		this.#cached = undefined;
	}

	async #build(): Promise<CatalogResponse> {
		const session = this.#session;
		// Mid-turn reloads would churn the live prompt for a read-only question; serve the current registries.
		if (!session.isStreaming) {
			try {
				await session.refreshSkillsAndCommands();
			} catch (error) {
				logger.warn("catalog: skill and command reload failed", { error: String(error) });
			}
		}
		const [commands, profiles] = await Promise.all([buildCommands(session), buildProfiles(session)]);
		const catalog: CatalogResponse = {
			commands,
			tools: buildTools(session),
			profiles,
			skills: buildSkills(session),
			roles: buildRoles(session),
			mcp: buildMcp(this.#mcpManager),
			generatedAt: this.#now(),
		};
		this.#cached = catalog;
		return catalog;
	}
}
