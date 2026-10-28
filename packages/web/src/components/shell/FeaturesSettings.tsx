import { Plus, RotateCw, Save, Trash2 } from "lucide-react";
import type {
	DaemonCapabilities,
	DaemonConfigFeatureStatus,
	DaemonConfigFile,
	DaemonConfigResponse,
	OptionalFeatureName,
	QuickAskSource,
} from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { DeckApi, DeckApiError } from "../../lib/api";
import "./features-settings.css";

export interface FeaturePeerDraft {
	id: string;
	name: string;
	url: string;
	tokenFile: string;
}

export type FeatureConfigDraft = Omit<DaemonConfigFile, "features" | "quickAsk" | "projectRoots" | "peers"> & {
	features: Record<OptionalFeatureName, boolean>;
	quickAsk: { sources: QuickAskSource[] };
	projectRoots: string[];
	peers: FeaturePeerDraft[];
};

interface FeaturesSettingsProps {
	api: Pick<DeckApi, "getDaemonConfig" | "setDaemonConfig" | "restartDaemon" | "capabilities">;
	onCapabilitiesChanged?: (capabilities: DaemonCapabilities) => void;
}

const FEATURE_ROWS: readonly { name: OptionalFeatureName; title: string; description: string }[] = [
	{ name: "librarian", title: "Project search", description: "Builds session summaries and project suggestions. Needs a Notes folder, at least one Project folder, and a model set up and signed in to omp." },
	{ name: "quickAsk", title: "Ask your notes", description: "Searches the sources you choose. Needs a Notes folder, at least one source, and a model set up and signed in to omp." },
	{ name: "agenda", title: "Task board", description: "Connects a local task board with omp sessions. Needs a folder with the task board app's files." },
	{ name: "peers", title: "Other computers", description: "Connects to another omp-console computer. Needs its URL and a token file from pairing." },
	{ name: "openrouterDecisions", title: "OpenRouter model choices", description: "Chooses models for Project search automatically. Needs Project search and an OpenRouter API key saved in omp." },
	{ name: "computerUse", title: "Computer use", description: "Lets an agent control your Mac. Needs macOS Accessibility and Screen Recording permissions." },
	{ name: "overnight", title: "Overnight run", description: "Keeps a session working until its deadline. Needs the daemon to stay running." },
];
const QUICK_ASK_SOURCES: readonly { value: QuickAskSource; label: string }[] = [
	{ value: "siyuan", label: "SiYuan" },
	{ value: "repo", label: "Notes folder" },
	{ value: "web", label: "Web" },
	{ value: "history", label: "Session history" },
];
const DEFAULT_FEATURES: Record<OptionalFeatureName, boolean> = {
	librarian: false,
	agenda: false,
	quickAsk: false,
	peers: false,
	openrouterDecisions: false,
	computerUse: false,
	overnight: false,
};
const MANUAL_RESTART = "bun packages/daemon/src/main.ts --port 7490 --state-dir ~/.omp-console --web-dir packages/web/dist";

function draftFromFile(file: DaemonConfigFile): FeatureConfigDraft {
	return {
		...file,
		features: { ...DEFAULT_FEATURES, ...file.features },
		quickAsk: { sources: [...(file.quickAsk?.sources ?? [])] },
		projectRoots: [...(file.projectRoots ?? [])],
		peers: (file.peers ?? []).map(peer => ({ ...peer, tokenFile: peer.tokenFile ?? "" })),
	};
}

export function buildFeatureConfig(draft: FeatureConfigDraft): DaemonConfigFile {
	const config: DaemonConfigFile = {
		...draft,
		features: { ...draft.features },
		quickAsk: { sources: [...draft.quickAsk.sources] },
		projectRoots: draft.projectRoots.map(root => root.trim()).filter(Boolean),
		peers: draft.peers
			.filter(peer => peer.id.trim() || peer.name.trim() || peer.url.trim() || peer.tokenFile.trim())
			.map(peer => ({
				id: peer.id.trim(),
				name: peer.name.trim() || peer.id.trim(),
				url: peer.url.trim(),
				...(peer.tokenFile.trim() ? { tokenFile: peer.tokenFile.trim() } : {}),
			})),
	};
	const knowledgeRoot = draft.knowledgeRoot?.trim();
	if (knowledgeRoot) config.knowledgeRoot = knowledgeRoot;
	else delete config.knowledgeRoot;
	const agendaHub = draft.agendaHub?.trim();
	if (agendaHub) config.agendaHub = agendaHub;
	else delete config.agendaHub;
	return config;
}

function featureStatus(status: DaemonConfigFeatureStatus): string {
	if (status.overriddenByFlag) return "Set by a startup flag";
	if (status.effective) return "On";
	if (status.configured) return `Enabled but missing: ${status.missing.join(", ") || "restart required"}`;
	return "Off";
}

export function FeatureStatusLabel({ status }: { status: DaemonConfigFeatureStatus }): ReactNode {
	return <p className="dk-feature-status" role="status">{featureStatus(status)}</p>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "The daemon settings request failed.";
}

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForRestart(api: FeaturesSettingsProps["api"]): Promise<DaemonCapabilities> {
	const deadline = Date.now() + 120_000;
	let observedOffline = false;
	while (Date.now() < deadline) {
		await wait(250);
		try {
			const capabilities = await api.capabilities();
			if (observedOffline) return capabilities;
		} catch (error) {
			if (error instanceof DeckApiError && error.status !== 0 && error.status !== 502 && error.status !== 503 && error.status !== 504) throw error;
			observedOffline = true;
		}
	}
	throw new Error(observedOffline ? "The daemon stopped but did not return within two minutes." : "The daemon did not go offline for its restart.");
}

export function FeaturesSettings({ api, onCapabilitiesChanged }: FeaturesSettingsProps): ReactNode {
	const [settings, setSettings] = useState<DaemonConfigResponse | null>(null);
	const [draft, setDraft] = useState<FeatureConfigDraft | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [restartRequired, setRestartRequired] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = async (signal?: AbortSignal): Promise<void> => {
		setLoading(true);
		setLoadError(null);
		try {
			const next = await api.getDaemonConfig(signal);
			if (signal?.aborted) return;
			setSettings(next);
			setDraft(draftFromFile(next.file));
		} catch (reason) {
			if (!signal?.aborted) setLoadError(errorText(reason));
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	};

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [api]);

	const update = (next: (current: FeatureConfigDraft) => FeatureConfigDraft): void => {
		setDraft(current => current === null ? current : next(current));
		setRestartRequired(false);
		setMessage(null);
		setError(null);
	};

	const save = async (): Promise<void> => {
		if (draft === null || saving) return;
		setSaving(true);
		setMessage(null);
		setError(null);
		const next = buildFeatureConfig(draft);
		try {
			await api.setDaemonConfig(next);
			setSettings(current => current === null ? current : {
				...current,
				file: next,
				features: Object.fromEntries(FEATURE_ROWS.map(({ name }) => [name, {
					...current.features[name],
					configured: next.features?.[name] === true,
				}])) as DaemonConfigResponse["features"],
			});
			setDraft(draftFromFile(next));
			setRestartRequired(true);
			setMessage("Saved. Restart to apply the changes.");
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setSaving(false);
		}
	};

	const restart = async (): Promise<void> => {
		if (restarting) return;
		setRestarting(true);
		setMessage(null);
		setError(null);
		try {
			try {
				await api.restartDaemon();
			} catch (reason) {
				if (!(reason instanceof DeckApiError) || reason.status !== 409 || !reason.busySessions?.length) throw reason;
				const busy = reason.busySessions.map(session => `${session.title ?? session.id} (${session.id}) — ${session.cwd}`).join("\n");
				if (!window.confirm(`These sessions are active or waiting for an answer:\n\n${busy}\n\nForce the daemon restart? Their current turns will stop.`)) {
					setMessage("Restart cancelled; active sessions are unchanged.");
					return;
				}
				await api.restartDaemon(true);
			}
			setMessage("Restarting the daemon…");
			const capabilities = await waitForRestart(api);
			const next = await api.getDaemonConfig();
			setSettings(next);
			setDraft(draftFromFile(next.file));
			setRestartRequired(false);
			setMessage("Daemon restarted. Feature capabilities reloaded.");
			onCapabilitiesChanged?.(capabilities);
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setRestarting(false);
		}
	};

	return (
		<section className="dk-settings-section dk-features-settings" aria-label="Optional features">
			<h3 className="dk-section-title">Optional features</h3>
			<p className="dk-hint">Turn on only what you need. Add the listed paths or permissions, save, then restart the daemon.</p>
			{loading && <p role="status">Loading feature settings…</p>}
			{loadError && <div className="dk-feature-error" role="alert">Could not load feature settings: {loadError}<button type="button" className="sh-btn" onClick={() => void load()}>Retry</button></div>}
			{!loading && !loadError && draft && settings && (
				<>
					<div className="dk-feature-list">
						{FEATURE_ROWS.map(({ name, title, description }) => {
							const status = settings.features[name];
							return (
								<article className="dk-feature-card" key={name}>
									<div className="dk-feature-heading">
										<div><h4>{title}</h4><p>{description}</p></div>
										<label className="dk-feature-switch">
											<span className="dk-visually-hidden">Enable {title}</span>
											<input type="checkbox" checked={draft.features[name]} onChange={event => { const checked = event.currentTarget.checked; update(current => ({ ...current, features: { ...current.features, [name]: checked } })); }} />
											<span aria-hidden="true" />
										</label>
									</div>
									<FeatureStatusLabel status={status} />
									{!status.effective && status.missing.length > 0 && <p className="dk-feature-missing">Still needs: {status.missing.join(", ")}.</p>}
									{(name === "librarian" || name === "quickAsk") && (
										<label className="dk-feature-field">
											<span>Notes folder (shared with Ask your notes)</span>
											<input type="text" value={draft.knowledgeRoot ?? ""} placeholder="/absolute/path/to/notes" autoCapitalize="none" spellCheck={false} onChange={event => { const value = event.currentTarget.value; update(current => ({ ...current, knowledgeRoot: value })); }} />
										</label>
									)}
									{name === "librarian" && (
										<div className="dk-feature-fields">
											<div className="dk-feature-field-list">
												<span>Project folders</span>
												{draft.projectRoots.map((root, index) => (
													<div className="dk-feature-input-row" key={`project-${index}`}>
														<input aria-label={`Project folder ${index + 1}`} type="text" value={root} placeholder="/absolute/path/to/repository" autoCapitalize="none" spellCheck={false} onChange={event => { const value = event.currentTarget.value; update(current => ({ ...current, projectRoots: current.projectRoots.map((_, row) => row === index ? value : current.projectRoots[row]!) })); }} />
														<button type="button" className="dk-feature-icon-button" aria-label={`Remove project folder ${index + 1}`} onClick={() => update(current => ({ ...current, projectRoots: current.projectRoots.filter((_, row) => row !== index) }))}><Trash2 size={15} aria-hidden="true" /></button>
													</div>
												))}
											</div>
											<button type="button" className="dk-feature-add" onClick={() => update(current => ({ ...current, projectRoots: [...current.projectRoots, ""] }))}><Plus size={15} aria-hidden="true" />Add project folder</button>
										</div>
									)}
									{name === "quickAsk" && (
										<fieldset className="dk-feature-sources">
											<legend>Ask your notes sources</legend>
											{QUICK_ASK_SOURCES.map(source => (
												<label key={source.value}><input type="checkbox" checked={draft.quickAsk.sources.includes(source.value)} onChange={event => { const checked = event.currentTarget.checked; update(current => ({ ...current, quickAsk: { sources: checked ? [...current.quickAsk.sources, source.value] : current.quickAsk.sources.filter(value => value !== source.value) } })); }} /><span>{source.label}</span></label>
											))}
										</fieldset>
									)}
									{name === "agenda" && (
										<label className="dk-feature-field"><span>Task board folder</span><input type="text" value={draft.agendaHub ?? ""} placeholder="/absolute/path/to/task-board" autoCapitalize="none" spellCheck={false} onChange={event => { const value = event.currentTarget.value; update(current => ({ ...current, agendaHub: value })); }} /></label>
									)}
									{name === "peers" && (
										<div className="dk-feature-fields">
											<div className="dk-feature-field-list">
												<div className="dk-feature-field-label">Other computers</div>
												{draft.peers.map((peer, index) => (
													<fieldset className="dk-feature-peer" key={`peer-${index}`}>
														<legend>Other computer {index + 1}</legend>
														<label className="dk-feature-field"><span>Computer ID</span><input type="text" value={peer.id} placeholder="studio" autoCapitalize="none" spellCheck={false} onChange={event => { const value = event.currentTarget.value; update(current => ({ ...current, peers: current.peers.map((item, row) => row === index ? { ...item, id: value } : item) })); }} /></label>
														<label className="dk-feature-field"><span>Computer name</span><input type="text" value={peer.name} placeholder="Studio Mac" onChange={event => { const value = event.currentTarget.value; update(current => ({ ...current, peers: current.peers.map((item, row) => row === index ? { ...item, name: value } : item) })); }} /></label>
														<label className="dk-feature-field"><span>Computer URL</span><input type="url" value={peer.url} placeholder="https://studio.example.ts.net" autoCapitalize="none" spellCheck={false} onChange={event => { const value = event.currentTarget.value; update(current => ({ ...current, peers: current.peers.map((item, row) => row === index ? { ...item, url: value } : item) })); }} /></label>
														<label className="dk-feature-field"><span>Token file from pairing</span><input type="text" value={peer.tokenFile} placeholder="/absolute/path/to/other-computer-token" autoCapitalize="none" spellCheck={false} onChange={event => { const value = event.currentTarget.value; update(current => ({ ...current, peers: current.peers.map((item, row) => row === index ? { ...item, tokenFile: value } : item) })); }} /></label>
														<button type="button" className="dk-feature-remove" onClick={() => update(current => ({ ...current, peers: current.peers.filter((_, row) => row !== index) }))}>Remove computer</button>
													</fieldset>
												))}
											</div>
											<div className="dk-feature-peer-actions">
												<button type="button" className="dk-feature-add" onClick={() => update(current => ({ ...current, peers: [...current.peers, { id: "", name: "", url: "", tokenFile: "" }] }))}><Plus size={15} aria-hidden="true" />Add computer</button>
												<a href="/peer-token-setup.html" target="_blank" rel="noreferrer">Connect another computer</a>
											</div>
										</div>
									)}
									{name === "computerUse" && <p className="dk-feature-warning">The daemon needs Accessibility and Screen Recording permission in macOS Privacy &amp; Security before an agent can control the host Mac.</p>}
								</article>
							);
						})}
					</div>
					{error && <p className="dk-feature-error" role="alert">{error}</p>}
					{message && <p className="dk-feature-message" role="status">{message}</p>}
					<div className="dk-feature-actions"><button type="button" className="sh-btn" disabled={saving || restarting} onClick={() => void save()}><Save size={15} aria-hidden="true" />{saving ? "Saving…" : "Save changes"}</button></div>
					{restartRequired && (
						<section className="dk-feature-restart" aria-label="Restart to apply">
							<h4>Restart to apply</h4>
							{settings.restart.supported ? (
								<button type="button" className="sh-btn" disabled={restarting} onClick={() => void restart()}><RotateCw size={15} aria-hidden="true" />{restarting ? "Restarting…" : "Restart daemon"}</button>
							) : (
								<p>Restart this daemon manually with its usual start command. Default install: <code>{MANUAL_RESTART}</code></p>
							)}
						</section>
					)}
				</>
			)}
		</section>
	);
}

