import type {
	ClaudeImportJobResponse,
	ClaudeImportSession,
	ClaudeImportSettingsResponse,
	ClaudeImportSessionsResponse,
	ClaudeImportSource,
	ClaudeImportSummary,
	UpdateClaudeImportSettingsRequest,
} from "@omp-console/protocol";
import { ArrowDownToLine, Check, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { DeckApiError, type DeckApi } from "../../lib/api";
import { Sheet } from "../shell/Sheet";
import "./claude-import.css";

const SOURCES: readonly ClaudeImportSource[] = ["claude", "codex"];
const SOURCE_LABEL: Record<ClaudeImportSource, string> = { claude: "Claude Code", codex: "Codex" };

interface SourceData {
	summary: ClaudeImportSummary | null;
	listing: ClaudeImportSessionsResponse | null;
	loading: boolean;
	error: string | null;
}

interface SourcePanelState extends SourceData {
	job: ClaudeImportJobResponse | null;
}

type SourcePanels = Record<ClaudeImportSource, SourcePanelState>;
type Selections = Record<ClaudeImportSource, Set<string>>;

function initialSource(): SourcePanelState {
	return { summary: null, listing: null, loading: true, error: null, job: null };
}

function errorText(error: unknown): string {
	if (error instanceof DeckApiError && error.kind === "auth") return "This device is no longer paired. Pair it again in the browser.";
	return error instanceof Error ? error.message : "Could not load migration details.";
}

function dateLabel(at: number): string {
	const date = new Date(at);
	return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export interface ClaudeImportPanelProps {
	api: Pick<DeckApi,
		| "getClaudeImportSummary"
		| "listClaudeImportSessions"
		| "startClaudeImport"
		| "getClaudeImportJob"
		| "getClaudeImportSettings"
		| "setClaudeImportSettings"
		| "listSessions"
		| "createSession"
	>;
	onClose(): void;
	onOpenSession(sessionId: string): void;
}

export function ClaudeImportPanel({ api, onClose, onOpenSession }: ClaudeImportPanelProps): ReactNode {
	const [panels, setPanels] = useState<SourcePanels>({ claude: initialSource(), codex: initialSource() });
	const [selections, setSelections] = useState<Selections>({ claude: new Set(), codex: new Set() });
	const [settings, setSettings] = useState<ClaudeImportSettingsResponse | null>(null);
	const [settingsDraft, setSettingsDraft] = useState<UpdateClaudeImportSettingsRequest | null>(null);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [settingsSaving, setSettingsSaving] = useState(false);
	const [settingsSaved, setSettingsSaved] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);

	const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
		setPanels(previous => ({
			claude: { ...previous.claude, loading: true, error: null },
			codex: { ...previous.codex, loading: true, error: null },
		}));
		await Promise.all(SOURCES.map(async source => {
			try {
				const [summary, listing] = await Promise.all([
					api.getClaudeImportSummary(source, signal),
					api.listClaudeImportSessions(source, signal),
				]);
				setPanels(previous => ({ ...previous, [source]: { ...previous[source], summary, listing, loading: false, error: null } }));
			} catch (error) {
				if (signal?.aborted) return;
				setPanels(previous => ({ ...previous, [source]: { ...previous[source], loading: false, error: errorText(error) } }));
			}
		}));
	}, [api]);

	useEffect(() => {
		const controller = new AbortController();
		void refresh(controller.signal);
		void api.getClaudeImportSettings(controller.signal).then(value => {
			if (controller.signal.aborted) return;
			setSettings(value);
			setSettingsDraft({
				userConfigEnabled: value.userConfigEnabled,
				userSkillsEnabled: value.userSkillsEnabled,
				userCommandsEnabled: value.userCommandsEnabled,
			});
		}).catch(error => {
			if (!controller.signal.aborted) setSettingsError(errorText(error));
		});
		return () => controller.abort();
	}, [api, refresh]);

	const updateSelection = (source: ClaudeImportSource, id: string, checked: boolean): void => {
		setSelections(previous => {
			const next = new Set(previous[source]);
			if (checked) next.add(id);
			else next.delete(id);
			return { ...previous, [source]: next };
		});
	};

	const startImport = async (source: ClaudeImportSource): Promise<void> => {
		const ids = [...selections[source]];
		if (ids.length === 0) return;
		setActionError(null);
		setPanels(previous => ({ ...previous, [source]: { ...previous[source], job: null } }));
		try {
			const initial = await api.startClaudeImport(source, { ids });
			setPanels(previous => ({ ...previous, [source]: { ...previous[source], job: initial } }));
			let job = initial;
			while (job.status === "running") {
				await new Promise<void>(resolve => window.setTimeout(resolve, 350));
				job = await api.getClaudeImportJob(initial.jobId);
				setPanels(previous => ({ ...previous, [source]: { ...previous[source], job } }));
			}
			const importedIds = new Set(job.results.filter(result => result.status !== "error").map(result => result.id));
			setSelections(previous => ({ ...previous, [source]: new Set([...previous[source]].filter(id => !importedIds.has(id))) }));
			await refresh();
		} catch (error) {
			setActionError(errorText(error));
		}
	};

	const saveSettings = async (): Promise<void> => {
		if (settingsDraft === null) return;
		setSettingsSaving(true);
		setSettingsSaved(false);
		setSettingsError(null);
		try {
			const next = await api.setClaudeImportSettings(settingsDraft);
			setSettings(next);
			setSettingsDraft({
				userConfigEnabled: next.userConfigEnabled,
				userSkillsEnabled: next.userSkillsEnabled,
				userCommandsEnabled: next.userCommandsEnabled,
			});
			setSettingsSaved(true);
		} catch (error) {
			setSettingsError(errorText(error));
		} finally {
			setSettingsSaving(false);
		}
	};

	const openImportedSession = async (sessionId: string): Promise<void> => {
		setOpeningSessionId(sessionId);
		setActionError(null);
		try {
			const listed = await api.listSessions();
			const live = listed.live.find(session => session.id === sessionId);
			if (live) {
				onClose();
				onOpenSession(live.id);
				return;
			}
			const imported = listed.recent.find(session => session.id === sessionId);
			if (!imported?.sessionFile) throw new Error("The imported session is no longer in the session list. Refresh the migration panel and try again.");
			// An imported session is omp console's own copy, so it continues in place.
			const opened = await api.createSession({ cwd: imported.cwd, resumeSessionFile: imported.sessionFile });
			onClose();
			onOpenSession(opened.id);
		} catch (error) {
			setActionError(errorText(error));
		} finally {
			setOpeningSessionId(null);
		}
	};

	return (
		<Sheet title="Import from Claude Code or Codex" windowKind="claude-import" onClose={onClose}>
			<div className="dk-claude-import">
				<p className="dk-ci-intro">Bring your Claude Code conversations and setup into omp console. Imports create omp copies; your source transcripts stay unchanged.</p>
				{actionError && <p className="dk-ci-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{actionError}</p>}
				{SOURCES.map(source => {
					const panel = panels[source];
					const sessions = panel.listing?.projects.flatMap(project => project.sessions) ?? [];
					const selectable = sessions.filter(session => !session.alreadyImported);
					const selected = selections[source];
					const allSelected = selectable.length > 0 && selectable.every(session => selected.has(session.id));
					const toggleAll = (): void => setSelections(previous => ({
						...previous,
						[source]: allSelected ? new Set() : new Set(selectable.map(session => session.id)),
					}));
					return (
						<section className="dk-ci-source" key={source} aria-labelledby={`dk-ci-${source}-heading`}>
							<header className="dk-ci-source-head">
								<div><h2 id={`dk-ci-${source}-heading`}>{SOURCE_LABEL[source]}</h2>
									{panel.summary?.found && <p>
										{panel.summary.sessionCount} {panel.summary.sessionCount === 1 ? "conversation" : "conversations"} in{" "}
										{panel.summary.projectCount} {panel.summary.projectCount === 1 ? "project folder" : "project folders"}
									</p>}</div>
								<button type="button" className="dk-ci-icon-button" aria-label={`Refresh ${SOURCE_LABEL[source]} sessions`} disabled={panel.loading} onClick={() => void refresh()}>
									<RefreshCw size={14} aria-hidden="true" className={panel.loading ? "dk-ci-spin" : undefined} />
								</button>
							</header>
							{panel.loading && !panel.listing ? <p className="dk-ci-note" role="status">Checking for {SOURCE_LABEL[source]} sessions…</p> : null}
							{panel.error && <p className="dk-ci-error" role="alert">{panel.error}</p>}
							{panel.listing && !panel.listing.found ? <p className="dk-ci-note">No data folder was found at <code>{panel.listing.dir}</code>. Use {SOURCE_LABEL[source]} on this computer, then refresh.</p> : null}
							{panel.listing?.found && sessions.length === 0 ? <p className="dk-ci-note">No conversations were found in <code>{panel.listing.dir}</code>.</p> : null}
							{selectable.length > 0 && (
								<div className="dk-ci-actions">
									<label><input type="checkbox" checked={allSelected} onChange={toggleAll} />Select all</label>
									<button type="button" className="dk-ci-primary" disabled={selected.size === 0 || panel.job?.status === "running"} onClick={() => void startImport(source)}>
										<ArrowDownToLine size={14} aria-hidden="true" />Import {selected.size > 0 ? `${selected.size} selected` : "selected"}
									</button>
								</div>
							)}
							{panel.job?.status === "running" && <div className="dk-ci-progress" role="status"><progress value={panel.job.completed} max={panel.job.total} />Importing {panel.job.completed} of {panel.job.total}…</div>}
							{panel.job?.status === "complete" && <p className="dk-ci-note" role="status">Import finished: {panel.job.results.filter(result => result.status !== "error").length} imported, {panel.job.results.filter(result => result.status === "error").length} failed.</p>}
							{panel.job?.results.some(result => result.status === "error" || result.warning !== undefined) && (
								<ul className="dk-ci-results" aria-label={`${SOURCE_LABEL[source]} import results`}>
									{panel.job.results.filter(result => result.status === "error" || result.warning !== undefined).map(result => <li key={result.id}><strong>{result.id}</strong>: {result.error ?? result.warning}</li>)}
								</ul>
							)}
							{panel.listing?.projects.map(project => (
								<div className="dk-ci-project" key={project.path}>
									<h3>{project.path}</h3>
									<ul>
										{project.sessions.map(session => <SessionRow
											key={session.id}
											session={session}
											checked={selected.has(session.id)}
											opening={openingSessionId === session.importedSessionId}
											onChecked={checked => updateSelection(source, session.id, checked)}
											onOpen={() => session.importedSessionId && void openImportedSession(session.importedSessionId)}
										/>) }
									</ul>
								</div>
							))}
							{panel.job?.results.map(result => result.status !== "error" && !sessions.some(session => session.id === result.id) ? (
								<div className="dk-ci-imported-result" key={result.id}>
									<Check size={14} aria-hidden="true" /><span>{result.id} imported</span>
									<button type="button" disabled={!result.sessionId || openingSessionId !== null} title="Opens the imported session; the Claude Code transcript is unchanged." onClick={() => result.sessionId && void openImportedSession(result.sessionId)}>Open</button>
								</div>
							) : null)}
						</section>
					);
				})}
				<section className="dk-ci-setup" aria-labelledby="dk-ci-setup-heading">
					<header><h2 id="dk-ci-setup-heading">Use your Claude Code setup</h2><p>Project instructions and tools are already read from the project folder.</p></header>
					<ul className="dk-ci-scope-list">
						<li><strong>Project files — automatic:</strong> <code>CLAUDE.md</code>, <code>.claude/commands</code>, <code>.claude/skills</code>, <code>.mcp.json</code>, and project Claude plugins.</li>
						<li><strong>User setup — opt in below:</strong> <code>~/.claude.json</code> MCP servers and Claude user configuration/plugins; the toggles also control user-level commands and skills.</li>
					</ul>
					{settingsError && <p className="dk-ci-error" role="alert">{settingsError}</p>}
					{settingsDraft === null ? <p className="dk-ci-note" role="status">Loading omp settings…</p> : (
						<div className="dk-ci-toggles">
							<SettingToggle label="Claude user configuration, MCP servers, and plugins" checked={settingsDraft.userConfigEnabled || (settings?.claudeConfigDirOverride ?? false)} disabled={settings?.claudeConfigDirOverride ?? false} onChange={value => setSettingsDraft({ ...settingsDraft, userConfigEnabled: value })} />
							{settings?.claudeConfigDirOverride && <p className="dk-ci-note">On because <code>CLAUDE_CONFIG_DIR</code> is set to <code>{panels.claude.summary?.dir}</code>.</p>}
							<SettingToggle label="Claude user skills" checked={settingsDraft.userSkillsEnabled} onChange={value => setSettingsDraft({ ...settingsDraft, userSkillsEnabled: value })} />
							<SettingToggle label="Claude user commands" checked={settingsDraft.userCommandsEnabled} onChange={value => setSettingsDraft({ ...settingsDraft, userCommandsEnabled: value })} />
							<div className="dk-ci-settings-footer">
								<button type="button" className="dk-ci-primary" disabled={settingsSaving} onClick={() => void saveSettings()}>{settingsSaving ? "Saving…" : "Save setup choices"}</button>
								{settingsSaved && <span role="status">Saved to omp's global settings. Other settings are retained; running sessions need a restart.</span>}
							</div>
							<p className="dk-ci-note">This updates omp’s <code>enabledProviders</code>, <code>skills.enableClaudeUser</code>, and <code>commands.enableClaudeUser</code> settings only. It does not change Claude Code files.</p>
						</div>
					)}
				</section>
				<section className="dk-ci-not-migrated" aria-labelledby="dk-ci-not-migrated-heading">
					<h2 id="dk-ci-not-migrated-heading">Not migrated</h2>
					<ul>
						<li><code>.claude/settings.json</code> hooks: omp does not run Claude Code lifecycle hooks.</li>
						<li><code>.claude/agents</code>: omp uses its own agent profiles and does not load Claude Code agent definitions.</li>
					</ul>
				</section>
			</div>
		</Sheet>
	);
}

function SessionRow({ session, checked, opening, onChecked, onOpen }: {
	session: ClaudeImportSession;
	checked: boolean;
	opening: boolean;
	onChecked(checked: boolean): void;
	onOpen(): void;
}): ReactNode {
	return (
		<li className="dk-ci-session">
			<input type="checkbox" aria-label={`Select ${session.title}`} checked={checked} disabled={session.alreadyImported} onChange={event => onChecked(event.currentTarget.checked)} />
			<div className="dk-ci-session-copy">
				<strong>{session.title}</strong>
				<p>{session.firstMessage ?? "No first-message preview is available."}</p>
				<small>{session.messageCount} messages · Last activity {dateLabel(session.lastActivityAt)}</small>
			</div>
			{session.alreadyImported ? <button type="button" disabled={opening} title="Opens the imported session; the Claude Code transcript is unchanged." onClick={onOpen}>{opening ? <LoaderCircle size={14} className="dk-ci-spin" aria-label="Opening" /> : "Open"}</button> : null}
		</li>
	);
}

function SettingToggle({ label, checked, disabled = false, onChange }: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange(value: boolean): void;
}): ReactNode {
	return <label className="dk-ci-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} /><span>{label}</span></label>;
}
