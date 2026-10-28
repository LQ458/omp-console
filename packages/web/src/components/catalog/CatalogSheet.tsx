import type { AgentProfileDetail, CatalogCommand, CatalogMcpServer, CatalogSkill, CatalogTool } from "@omp-console/protocol";
import { RefreshCw, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { CATALOG_TABS, type CatalogTab, filterCatalog, tabCounts } from "../../lib/catalog";
import { ompEquivalent } from "../../lib/equivalents";
import { recordUsage } from "../../lib/journal";
import { commandEquivalent, insertIntoComposer, openPanel, routeCommand, withOvernightCommand } from "../../lib/palette";
import { Sheet } from "../shell/Sheet";
import { executeCommand } from "./actions";
import { FeedbackButton } from "./FeedbackButton";
import { OmpEquivalent } from "./OmpEquivalent";
import { useCatalog } from "./use-catalog";
import "./catalog.css";

export interface CatalogSheetProps {
	api: Pick<DeckApi, "catalog" | "runCommand"> | undefined;
	sessionId: string | undefined;
	onClose(): void;
	overnightEnabled?: boolean;
}

function tried(kind: string, detail: string | undefined, outcome: "ok" | "error" = "ok"): void {
	recordUsage({ feature: "0.1.catalog", action: `try:${kind}`, outcome, via: "catalog", detail });
}

interface RowProps {
	title: string;
	badges?: string[];
	description?: string;
	meta?: ReactNode;
	action?: { label: string; run(): void };
	status?: { tone: "ok" | "error"; text: string };
	equivalent?: { text: string; hint?: string; actionId: string };
}

function Row({ title, badges = [], description, meta, action, status, equivalent }: RowProps): ReactNode {
	return (
		<li className="ct-row">
			<div className="ct-row-head">
				<span className="ct-row-title">{title}</span>
				{badges.map(badge => (
					<span key={badge} className="ct-badge">
						{badge}
					</span>
				))}
				{action && (
					<button type="button" className="sh-btn ct-try" onClick={action.run}>
						{action.label}
					</button>
				)}
			</div>
			{description && <p className="ct-row-desc">{description}</p>}
			{meta && <div className="ct-row-meta">{meta}</div>}
			{status && (
				<p className={status.tone === "error" ? "ct-error" : "ct-status"} role={status.tone === "error" ? "alert" : "status"}>
					{status.text}
				</p>
			)}
			{equivalent && <OmpEquivalent {...equivalent} via="catalog" />}
		</li>
	);
}

/** "What omp can do": everything the live session's registries offer, searchable, each with a Try action (spec 0.1). */
export function CatalogSheet({ api, sessionId, onClose, overnightEnabled = false }: CatalogSheetProps): ReactNode {
	const { catalog, loading, error, reload } = useCatalog(api, sessionId, true, true);
	const [tab, setTab] = useState<CatalogTab>("commands");
	const [query, setQuery] = useState("");
	const [statuses, setStatuses] = useState<Record<string, { tone: "ok" | "error"; text: string }>>({});

	const view = useMemo(() => catalog ? filterCatalog({ ...catalog, commands: withOvernightCommand(catalog.commands, overnightEnabled) }, query) : undefined, [catalog, query, overnightEnabled]);
	const counts = view ? tabCounts(view) : undefined;

	const setStatus = (key: string, tone: "ok" | "error", text: string): void =>
		setStatuses(prev => ({ ...prev, [key]: { tone, text } }));

	const commandRow = (command: CatalogCommand): ReactNode => {
		const route = routeCommand(command);
		const key = `command:${command.name}`;
		const label =
			route.kind === "remote" ? "Run" : route.kind === "fill" ? "Insert" : route.kind === "panel" ? "Open" : undefined;
		const badges: string[] = [command.source];
		if (route.kind === "terminal") badges.push("terminal only");
		return (
			<Row
				key={`${command.source}:${command.name}`}
				title={`/${command.name}`}
				badges={badges}
				description={command.description}
				action={
					label
						? {
								label,
								run: () => {
									void executeCommand(command, "", { api, sessionId, via: "catalog" }).then(outcome => {
										if (outcome.kind === "ran") setStatus(key, "ok", `Ran ${outcome.text}`);
										else if (outcome.kind === "error") setStatus(key, "error", outcome.message);
										else if (outcome.kind === "panel") {
											setStatus(key, "ok", `Opened ${outcome.panel}`);
											onClose();
										} else if (outcome.kind === "filled") onClose();
									});
								},
							}
						: undefined
				}
				status={statuses[key]}
				equivalent={{ text: commandEquivalent(command), hint: command.usage, actionId: key }}
			/>
		);
	};

	const toolRow = (tool: CatalogTool): ReactNode => (
		<Row
			key={tool.name}
			title={tool.name}
			badges={["called by the agent"]}
			description={tool.description}
		/>
	);

	const profileRow = (profile: AgentProfileDetail): ReactNode => (
		<Row
			key={`${profile.source}:${profile.name}`}
			title={profile.name}
			badges={[profile.source]}
			description={profile.description}
			meta={
				<>
					{profile.effectiveModel && <span>model: {profile.effectiveModel}</span>}
					{profile.thinking && <span>thinking: {profile.thinking}</span>}
					{profile.tools && profile.tools.length > 0 && <span>tools: {profile.tools.join(", ")}</span>}
					{profile.spawns !== undefined && (
						<span>Can start: {profile.spawns === "*" ? "any agent" : profile.spawns.join(", ") || "none"}</span>
					)}
				</>
			}
			action={{
				label: "Use this agent profile…",
				run: () => {
					tried("profile", profile.name);
					openPanel({ panel: "spawn", profile: profile.name });
					onClose();
				},
			}}
			equivalent={{
				text: ompEquivalent("agent.spawn", { arg: profile.name }) ?? "",
				actionId: "agent.spawn",
			}}
		/>
	);

	const skillRow = (skill: CatalogSkill): ReactNode => (
		<Row
			key={skill.name}
			title={skill.name}
			badges={skill.source ? [skill.source] : []}
			description={skill.description}
			action={{
				label: "Insert",
				run: () => {
					tried("skill", skill.name);
					insertIntoComposer({ text: `/skill:${skill.name} `, atStart: true });
					onClose();
				},
			}}
			equivalent={{ text: ompEquivalent("skill.run", { arg: skill.name }) ?? "", actionId: "skill.run" }}
		/>
	);

	const roleRow = ([role, selector]: [string, string]): ReactNode => (
		<Row
			key={role}
			title={role}
			description={selector}
			action={{
				label: "Use next turn",
				run: () => {
					tried("role", role);
					insertIntoComposer({ text: `^${selector} ` });
					onClose();
				},
			}}
			equivalent={{ text: ompEquivalent("model.mention", { arg: selector }) ?? "", actionId: "model.mention" }}
		/>
	);

	const mcpRow = (server: CatalogMcpServer): ReactNode => (
		<Row
			key={server.name}
			title={server.name}
			badges={[server.connected ? "connected" : "not connected"]}
			meta={server.toolCount !== undefined ? <span>{server.toolCount} tools</span> : undefined}
			equivalent={{ text: ompEquivalent("mcp.list") ?? "", actionId: "mcp.list" }}
		/>
	);

	let rows: ReactNode[] = [];
	if (view) {
		if (tab === "commands") rows = view.commands.map(item => commandRow(item.command));
		else if (tab === "tools") rows = view.tools.map(toolRow);
		else if (tab === "profiles") rows = view.profiles.map(profileRow);
		else if (tab === "skills") rows = view.skills.map(skillRow);
		else if (tab === "roles") rows = view.roles.map(roleRow);
		else rows = view.mcp.map(mcpRow);
	}

	return (
		<Sheet title="What omp can do" windowKind="catalog" onClose={onClose}>
			<div className="ct-sheet">
				<div className="ct-sheet-bar">
					<label className="ct-search">
						<Search size={14} />
						<input
							className="ct-search-input"
							aria-label="Search everything omp offers"
							placeholder="Search commands, tools, agent profiles, skills…"
							value={query}
							spellCheck={false}
							autoComplete="off"
							onChange={event => setQuery(event.target.value)}
						/>
					</label>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => {
							recordUsage({ feature: "0.1.catalog", action: "reload", outcome: "ok", via: "catalog" });
							reload();
						}}
						title="Refresh the list from omp"
						aria-label="Refresh list"
						disabled={loading}
					>
						<RefreshCw size={14} />
					</button>
				</div>
				<div className="ct-tabs" role="tablist" aria-label="Catalog sections">
					{CATALOG_TABS.map(entry => (
						<button
							key={entry.id}
							type="button"
							role="tab"
							aria-selected={tab === entry.id}
							className="ct-tab"
							data-active={tab === entry.id ? "true" : "false"}
							onClick={() => {
								setTab(entry.id);
								recordUsage({ feature: "0.1.catalog", action: `tab:${entry.id}`, outcome: "ok", via: "catalog" });
							}}
						>
							{entry.label}
							{counts && <span className="ct-tab-count">{counts[entry.id]}</span>}
						</button>
					))}
				</div>
				{sessionId === undefined && (
					<p className="ct-empty">Open a session to see its commands, tools, agent profiles, and more.</p>
				)}
				{error !== undefined && (
					<p className="ct-error" role="alert">
						{error}
					</p>
				)}
				{sessionId !== undefined && loading && !catalog && <p className="ct-empty">Loading…</p>}
				{view && rows.length === 0 && <p className="ct-empty">Nothing in this section matches “{query}”.</p>}
				{rows.length > 0 && (
					<ul className="ct-rows" role="tabpanel" aria-label={CATALOG_TABS.find(entry => entry.id === tab)?.label}>
						{rows}
					</ul>
				)}
				<div className="ct-sheet-foot">
					{catalog && <span className="ct-stamp">read from omp {new Date(catalog.generatedAt).toLocaleTimeString()}</span>}
					<FeedbackButton screen="catalog" feature="0.1.catalog" />
				</div>
			</div>
		</Sheet>
	);
}
