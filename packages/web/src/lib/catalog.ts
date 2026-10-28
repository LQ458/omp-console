/**
 * Capability catalog (spec 0.1): per-session cache of `GET /api/sessions/:id/catalog` and the search the catalog sheet
 * runs over its six tabs. The data always comes from the daemon's live registries; nothing is listed here by hand.
 */
import type {
	AgentProfileDetail,
	CatalogMcpServer,
	CatalogResponse,
	CatalogSkill,
	CatalogTool,
} from "@omp-console/protocol";
import type { DeckApi } from "./api";
import { fuzzyScore, type RankedCommand, rankCommands } from "./palette";

export type CatalogTab = "commands" | "tools" | "profiles" | "skills" | "roles" | "mcp";

export const CATALOG_TABS: readonly { id: CatalogTab; label: string }[] = [
	{ id: "commands", label: "Commands" },
	{ id: "tools", label: "Tools" },
	{ id: "profiles", label: "Agent profiles" },
	{ id: "skills", label: "Skills" },
	{ id: "roles", label: "Model roles" },
	{ id: "mcp", label: "MCP" },
];

export interface CatalogView {
	commands: RankedCommand[];
	tools: CatalogTool[];
	profiles: AgentProfileDetail[];
	skills: CatalogSkill[];
	roles: [role: string, selector: string][];
	mcp: CatalogMcpServer[];
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
	const q = query.trim().toLowerCase();
	if (q === "") return true;
	return fields.some(field => field !== undefined && (fuzzyScore(q, field) ?? 0) >= 400);
}

/** Every tab filtered by one query (name, description and the tab's own facets); commands come back ranked. */
export function filterCatalog(catalog: CatalogResponse, query: string): CatalogView {
	return {
		commands: rankCommands(catalog.commands, query),
		tools: catalog.tools.filter(tool => matches(query, tool.name, tool.description)),
		profiles: catalog.profiles.filter(profile =>
			matches(query, profile.name, profile.description, profile.source, ...(profile.tools ?? [])),
		),
		skills: catalog.skills.filter(skill => matches(query, skill.name, skill.description)),
		roles: Object.entries(catalog.roles).filter(([role, selector]) => matches(query, role, selector)),
		mcp: catalog.mcp.filter(server => matches(query, server.name)),
	};
}

export function tabCounts(view: CatalogView): Record<CatalogTab, number> {
	return {
		commands: view.commands.length,
		tools: view.tools.length,
		profiles: view.profiles.length,
		skills: view.skills.length,
		roles: view.roles.length,
		mcp: view.mcp.length,
	};
}

export const CATALOG_TTL_MS = 30_000;

type CatalogApi = Pick<DeckApi, "catalog">;

/** One fetch per session at a time; a fresh entry is reused for {@link CATALOG_TTL_MS} unless `force` is set. */
export class CatalogCache {
	readonly #entries = new Map<string, { catalog: CatalogResponse; at: number }>();
	readonly #inflight = new Map<string, Promise<CatalogResponse>>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	peek(sessionId: string): CatalogResponse | undefined {
		return this.#entries.get(sessionId)?.catalog;
	}

	load(api: CatalogApi, sessionId: string, force = false): Promise<CatalogResponse> {
		const cached = this.#entries.get(sessionId);
		if (!force && cached && this.#now() - cached.at < CATALOG_TTL_MS) return Promise.resolve(cached.catalog);
		const pending = this.#inflight.get(sessionId);
		if (pending) return pending;
		const request = api
			.catalog(sessionId)
			.then(catalog => {
				this.#entries.set(sessionId, { catalog, at: this.#now() });
				return catalog;
			})
			.finally(() => {
				this.#inflight.delete(sessionId);
			});
		this.#inflight.set(sessionId, request);
		return request;
	}

	invalidate(sessionId?: string): void {
		if (sessionId === undefined) this.#entries.clear();
		else this.#entries.delete(sessionId);
	}
}

export const catalogCache = new CatalogCache();
