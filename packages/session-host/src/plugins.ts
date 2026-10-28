/**
 * `plugins` / `plugin-toggle`: the Extension Control Center of the TUI, without the TUI.
 *
 *  - Listing: installed npm plugins (`PluginManager.list`), installed marketplace plugins
 *    (`MarketplaceManager.listInstalledPlugins`) and, from the dashboard's own loader `loadAllExtensions`, every
 *    discovered skill, custom tool, extension module, MCP server and hook with its enabled state. Rules, prompts,
 *    slash commands and context files have no `PluginInfo` kind and are left out.
 *  - Toggling uses the dashboard's runtime (`createExtensionDashboardRuntime`) and its rules: MCP servers persist
 *    through `mcp.json` and connect/disconnect live; plugins go through `setInstalledPluginEnabled` (the
 *    `/plugins enable|disable` path); everything else is an id in the `disabledExtensions` setting.
 *  - After a toggle the plugin state reloads the way `/reload-plugins` does in RPC/ACP mode, plus the task-agent
 *    discovery and capability caches the TUI handler refreshes, so skills, commands and profiles follow at once.
 *    Extension modules and hooks are loaded when the session starts: their toggle is stored and applies to the next
 *    session of the workspace.
 *
 * Ids are the dashboard's `<kind>:<name>` (`skill:foo`, `mcp:bar`, `extension-module:baz`), `plugin:<name>` for
 * plugins.
 */
import type { ListPluginsResponse, PluginInfo } from "@omp-console/protocol";
import { logger } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath, resolveOrDefaultProjectRegistryPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { setInstalledPluginEnabled } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/toggle";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createExtensionDashboardRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/dashboard-runtime";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { refreshAgentDiscovery } from "@oh-my-pi/pi-coding-agent/task";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { Extension, ExtensionKind } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { RequestError } from "./request-error";

const PLUGIN_PREFIX = "plugin:";
const MCP_PREFIX = "mcp:";

const KIND_BY_EXTENSION_KIND: Partial<Record<ExtensionKind, PluginInfo["kind"]>> = {
	skill: "skill",
	tool: "tool",
	"extension-module": "extension",
	mcp: "mcp",
	hook: "hook",
};

function clip(text: string | undefined, limit = 200): string | undefined {
	const flat = text?.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function infoOf(extension: Extension): PluginInfo | undefined {
	const kind = KIND_BY_EXTENSION_KIND[extension.kind];
	if (kind === undefined) return undefined;
	const info: PluginInfo = {
		id: extension.id,
		kind,
		name: extension.displayName ?? extension.name,
		enabled: extension.state !== "disabled",
	};
	const source = `${extension.source.provider}${extension.source.level ? ` (${extension.source.level})` : ""}`;
	if (source !== "") info.source = source;
	const description = clip(extension.description);
	if (description !== undefined) info.description = description;
	return info;
}

export interface PluginControlOptions {
	session: AgentSession;
	mcpManager?: MCPManager;
	eventBus?: EventBus;
	/** Called after a toggle reloaded the plugin state (the catalog cache must be dropped). */
	onReloaded?: () => void;
}

export class PluginControl {
	readonly #session: AgentSession;
	readonly #mcpManager: MCPManager | undefined;
	readonly #eventBus: EventBus | undefined;
	readonly #onReloaded: (() => void) | undefined;

	constructor(options: PluginControlOptions) {
		this.#session = options.session;
		this.#mcpManager = options.mcpManager;
		this.#eventBus = options.eventBus;
		this.#onReloaded = options.onReloaded;
	}

	#cwd(): string {
		return this.#session.sessionManager.getCwd();
	}

	#runtime(): ReturnType<typeof createExtensionDashboardRuntime> {
		const session = this.#session;
		return createExtensionDashboardRuntime({
			cwd: this.#cwd(),
			settings: session.settings,
			mcpManager: this.#mcpManager,
			eventBus: this.#eventBus,
			onMcpToolsChanged: tools => session.refreshMCPTools(tools),
		});
	}

	async #marketplace(): Promise<MarketplaceManager> {
		return new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(this.#cwd()),
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});
	}

	async list(): Promise<ListPluginsResponse["plugins"]> {
		const runtime = this.#runtime();
		const plugins: PluginInfo[] = [];
		try {
			for (const plugin of await new PluginManager(this.#cwd()).list()) {
				const info: PluginInfo = { id: `${PLUGIN_PREFIX}${plugin.name}`, kind: "plugin", name: plugin.name, enabled: plugin.enabled !== false, source: "npm" };
				const description = clip(plugin.manifest.description);
				if (description !== undefined) info.description = description;
				plugins.push(info);
			}
			for (const plugin of await (await this.#marketplace()).listInstalledPlugins()) {
				const entry = plugin.entries[0];
				plugins.push({
					id: `${PLUGIN_PREFIX}${plugin.id}`,
					kind: "plugin",
					name: plugin.id,
					enabled: entry?.enabled !== false,
					source: `marketplace (${plugin.scope})`,
				});
			}
		} catch (error) {
			logger.warn("plugin listing failed", { error: String(error) });
		}
		const extensions = await runtime.loadExtensions(runtime.getDisabledExtensions());
		for (const extension of extensions) {
			const info = infoOf(extension);
			if (info) plugins.push(info);
		}
		return plugins;
	}

	async toggle(pluginId: string, enabled: boolean): Promise<void> {
		if (typeof pluginId !== "string" || pluginId === "") throw new RequestError("bad-request", "pluginId is required");
		const runtime = this.#runtime();
		const known = (await this.list()).find(plugin => plugin.id === pluginId);
		if (!known) throw new RequestError("not-found", `no plugin, extension, skill, MCP server, hook or tool ${pluginId}`);
		try {
			if (pluginId.startsWith(PLUGIN_PREFIX)) {
				const marketplace = await this.#marketplace();
				const marketplaceIds = new Set((await marketplace.listInstalledPlugins()).map(plugin => plugin.id));
				await setInstalledPluginEnabled(pluginId.slice(PLUGIN_PREFIX.length), {
					enabled,
					marketplaceIds,
					marketplace,
					npm: new PluginManager(this.#cwd()),
				});
			} else if (pluginId.startsWith(MCP_PREFIX)) {
				await this.#toggleMcp(runtime, pluginId, enabled);
			} else {
				const disabled = runtime.getDisabledExtensions().filter(id => id !== pluginId);
				if (!enabled) disabled.push(pluginId);
				runtime.setDisabledExtensions(disabled);
			}
		} catch (error) {
			if (error instanceof RequestError) throw error;
			throw new RequestError("conflict", `could not ${enabled ? "enable" : "disable"} ${pluginId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.#reload();
	}

	/** The dashboard's MCP toggle: persist to `mcp.json`, apply to the live manager, drop a stale legacy disabled id. */
	async #toggleMcp(runtime: ReturnType<typeof createExtensionDashboardRuntime>, pluginId: string, enabled: boolean): Promise<void> {
		const name = pluginId.slice(MCP_PREFIX.length);
		const extension = (await runtime.loadExtensions(runtime.getDisabledExtensions())).find(candidate => candidate.id === pluginId);
		const writable = extension && (extension.source.provider === "native" || extension.source.provider === "mcp-json");
		await runtime.persistMcpToggle(name, enabled, writable ? extension.path : undefined);
		try {
			await runtime.applyMcpToggle(name, enabled);
		} catch (error) {
			logger.warn("MCP toggle was stored but could not be applied to the live manager", { name, enabled, error: String(error) });
		}
		const stored = runtime.getDisabledExtensions();
		if (enabled && stored.includes(pluginId)) runtime.setDisabledExtensions(stored.filter(id => id !== pluginId));
	}

	async #reload(): Promise<void> {
		const session = this.#session;
		const cwd = this.#cwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await refreshAgentDiscovery(cwd, session.effectiveExtensionRoots);
		await session.refreshSkillsAndCommands();
		resetCapabilities();
		this.#onReloaded?.();
	}
}
