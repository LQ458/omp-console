import type { DeckPanelDescriptor, ExtensionUiState, PluginInfo } from "@omp-console/protocol";
import { Boxes, Check, ExternalLink, Info, RefreshCw, RotateCw, ToggleLeft, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { recordUsage } from "../../lib/journal";
import { openPanel } from "../../lib/palette";
import { descriptorError, extensionStatusText, groupPlugins, isDeckPanelDescriptor } from "../../lib/plugins";
import { Markdown } from "../transcript/Markdown";
import { OmpLine } from "../spawn/OmpLine";
import "./plugins.css";

export interface PluginsPanelProps {
	api: DeckApi;
	sessionId?: string;
	confirmAction?: (message: string) => boolean;
}

function confirmDefault(message: string): boolean {
	return typeof window === "undefined" || window.confirm(message);
}

/** Extension statuses are intentionally small enough to live beside the header controls. */
export function ExtensionStatus({ api, sessionId }: { api: DeckApi; sessionId?: string }): ReactNode {
	const [state, setState] = useState<ExtensionUiState | null>(null);
	useEffect(() => {
		if (!sessionId) {
			setState(null);
			return;
		}
		let live = true;
		const controller = new AbortController();
		const load = (): void => {
			void api.extensionUi(sessionId, controller.signal).then(value => {
				if (live) setState(value);
			}).catch(() => {
				// The dock owns the actionable error; the header remains compact when the bridge is absent.
			});
		};
		load();
		const timer = window.setInterval(load, 2_000);
		return () => {
			live = false;
			controller.abort();
			window.clearInterval(timer);
		};
	}, [api, sessionId]);

	const statuses = extensionStatusText(state);
	if (statuses.length === 0) return null;
	return <span className="pl-header-status" title={statuses.join(" · ")}><Info size={12} aria-hidden /><span>{statuses[0]}</span>{statuses.length > 1 ? <b>+{statuses.length - 1}</b> : null}</span>;
}

export function PluginsPanel({ api, sessionId, confirmAction = confirmDefault }: PluginsPanelProps): ReactNode {
	const [plugins, setPlugins] = useState<PluginInfo[]>([]);
	const [ui, setUi] = useState<ExtensionUiState | null>(null);
	const [loading, setLoading] = useState(Boolean(sessionId));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
		if (!sessionId) return;
		setLoading(true);
		setError(null);
		try {
			const [pluginResponse, extensionState] = await Promise.all([api.plugins(sessionId, signal), api.extensionUi(sessionId, signal)]);
			setPlugins(pluginResponse.plugins);
			setUi(extensionState);
		} catch (err) {
			if (signal?.aborted) return;
			setError(err instanceof Error ? err.message : "Plugin state could not be loaded.");
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		if (!sessionId) {
			setPlugins([]);
			setUi(null);
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		void load(controller.signal);
		const timer = window.setInterval(() => void load(controller.signal), 2_000);
		recordUsage({ feature: "11.plugins", action: "open", outcome: "ok", via: "direct", screen: "plugins", sessionId });
		return () => {
			controller.abort();
			window.clearInterval(timer);
		};
	}, [load, sessionId]);

	const groups = useMemo(() => groupPlugins(plugins), [plugins]);
	const toggle = async (plugin: PluginInfo): Promise<void> => {
		if (!sessionId || busy !== null) return;
		const action = plugin.enabled ? "disable" : "enable";
		if (!confirmAction(`${action === "enable" ? "Enable" : "Disable"} ${plugin.name}? omp will reload plugins.`)) return;
		setBusy(plugin.id);
		try {
			await api.togglePlugin(sessionId, plugin.id, !plugin.enabled);
			await load();
			setMessage(`${plugin.name} reloaded.`);
			recordUsage({ feature: "11.plugins", action: `${action}:${plugin.id}`, outcome: "ok", via: "direct", screen: "plugins", sessionId });
		} catch (err) {
			setMessage(err instanceof Error ? err.message : `Could not ${action} ${plugin.name}.`);
			recordUsage({ feature: "11.plugins", action: `${action}:${plugin.id}`, outcome: "error", via: "direct", screen: "plugins", sessionId });
		} finally {
			setBusy(null);
		}
	};

	const marketplace = async (): Promise<void> => {
		if (!sessionId) return;
		try {
			await api.runCommand(sessionId, "/marketplace");
			setMessage("Marketplace command sent to omp.");
			recordUsage({ feature: "11.plugins", action: "marketplace", outcome: "ok", via: "direct", screen: "plugins", sessionId });
		} catch (err) {
			setMessage(err instanceof Error ? err.message : "Marketplace command could not be sent.");
			recordUsage({ feature: "11.plugins", action: "marketplace", outcome: "error", via: "direct", screen: "plugins", sessionId });
		}
	};

	if (!sessionId) return <div className="pl-empty">Open a session to inspect its plugins and extension UI.</div>;

	return (
		<div className="pl-panel">
			<div className="pl-head">
				<div><div className="pl-kicker"><Boxes size={13} aria-hidden /> Extension surfaces</div><h3>Plugins</h3><p>Installed capabilities are managed by omp, not copied into the web client.</p></div>
				<button type="button" className="pl-icon-btn" onClick={() => void load()} disabled={loading} title="reload plugins" aria-label="reload plugins"><RefreshCw size={14} className={loading ? "pl-spin" : undefined} aria-hidden /></button>
			</div>
			<OmpLine text="/plugins list" onCopy={() => recordUsage({ feature: "0.2.equivalent", action: "copy-plugins", outcome: "ok", via: "direct", screen: "plugins", sessionId })} />
			{message ? <div className="pl-message" role="status">{message}</div> : null}
			{error ? <div className="pl-error" role="alert">{error}</div> : null}
			{loading && plugins.length === 0 ? <div className="pl-loading">Loading plugin registry…</div> : null}
			<section className="pl-section" aria-label="installed plugins">
				{groups.length === 0 && !loading ? <div className="pl-empty">No installed plugins, skills, hooks, tools, or MCP servers were reported.</div> : null}
				{groups.map(group => <PluginGroupView key={group.kind} group={group.plugins} label={group.label} busy={busy} onToggle={plugin => void toggle(plugin)} />)}
			</section>
			<section className="pl-marketplace">
				<div><strong>Registry skills</strong><p>Search, install, and update skillshare packages for this session.</p></div>
				<button type="button" className="pl-btn" onClick={() => openPanel({ panel: "skills" })}>Browse skills</button>
			</section>
			<section className="pl-marketplace">
				<div><strong>Need another capability?</strong><p>Browse omp's marketplace; installation and reload stay in the omp manager.</p></div>
				<button type="button" className="pl-btn" onClick={() => void marketplace()}><ExternalLink size={13} aria-hidden /> Marketplace</button>
			</section>
			<ExtensionUiView api={api} sessionId={sessionId} state={ui} onReload={() => void load()} />
		</div>
	);
}

function PluginGroupView({ group, label, busy, onToggle }: { group: PluginInfo[]; label: string; busy: string | null; onToggle(plugin: PluginInfo): void }): ReactNode {
	return (
		<div className="pl-group">
			<div className="pl-group-title">{label}<span>{group.length}</span></div>
			{group.map(plugin => (
				<div className="pl-row" key={plugin.id}>
					<div className="pl-row-copy"><div><strong>{plugin.name}</strong><span className={`pl-enabled pl-enabled-${plugin.enabled ? "on" : "off"}`}>{plugin.enabled ? "enabled" : "disabled"}</span></div><small>{plugin.description ?? plugin.source ?? plugin.id}</small><code className="pl-command">omp: /plugins {plugin.enabled ? "disable" : "enable"} {plugin.id}</code></div>
					<button type="button" className="pl-btn pl-toggle" disabled={busy !== null} onClick={() => onToggle(plugin)}><ToggleLeft size={13} aria-hidden /> {busy === plugin.id ? "Reloading…" : plugin.enabled ? "Disable" : "Enable"}</button>
				</div>
			))}
		</div>
	);
}

function ExtensionUiView({ api, sessionId, state, onReload }: { api: DeckApi; sessionId: string; state: ExtensionUiState | null; onReload(): void }): ReactNode {
	if (!state || (state.statuses.length === 0 && state.widgets.length === 0 && state.panels.length === 0 && state.notifications.length === 0)) return null;
	return (
		<section className="pl-section pl-extension" aria-label="extension UI">
			<div className="pl-group-title">Extension UI <button type="button" className="pl-refresh-link" onClick={onReload}><RotateCw size={12} aria-hidden /> refresh</button></div>
			{state.statuses.length > 0 ? <div className="pl-statuses">{state.statuses.map(status => <div className="pl-status-line" key={status.key}><Check size={12} aria-hidden /> {status.text}</div>)}</div> : null}
			{state.widgets.map(widget => <div className="pl-widget" key={widget.key}><strong>{widget.key}</strong>{widget.lines.map((line, index) => <div key={`${widget.key}:${index}`}>{line}</div>)}</div>)}
			{state.panels.map(panel => <DeckPanel key={panel.key} api={api} sessionId={sessionId} panelKey={panel.key} descriptor={panel.descriptor} />)}
			{state.notifications.length > 0 ? <div className="pl-notifications" role="status" aria-label="extension notifications">{state.notifications.slice(-4).map(notification => <div className={`pl-notification pl-notification-${notification.level}`} key={`${notification.at}:${notification.message}`}><TriangleAlert size={12} aria-hidden />{notification.message}</div>)}</div> : null}
		</section>
	);
}

export function DeckPanel({ api, sessionId, panelKey, descriptor }: { api: DeckApi; sessionId: string; panelKey: string; descriptor: unknown }): ReactNode {
	const error = descriptorError(descriptor);
	if (error) return <div className="pl-invalid" role="alert"><TriangleAlert size={13} aria-hidden /> {panelKey}: {error}</div>;
	if (!isDeckPanelDescriptor(descriptor)) return null;
	return <DeckPanelContent api={api} sessionId={sessionId} panelKey={panelKey} descriptor={descriptor} />;
}

function DeckPanelContent({ api, sessionId, panelKey, descriptor }: { api: DeckApi; sessionId: string; panelKey: string; descriptor: DeckPanelDescriptor }): ReactNode {
	const run = async (command: string): Promise<void> => {
		try {
			await api.runCommand(sessionId, command);
			recordUsage({ feature: "11.plugins", action: "panel-button", outcome: "ok", via: "direct", screen: "plugins", sessionId, detail: panelKey });
		} catch {
			recordUsage({ feature: "11.plugins", action: "panel-button", outcome: "error", via: "direct", screen: "plugins", sessionId, detail: panelKey });
		}
	};
	return (
		<div className="pl-deck-panel">
			<div className="pl-deck-title">{descriptor.title}</div>
			{descriptor.kind === "list" ? <ul className="pl-list">{descriptor.items.map(item => <li key={`${item.label}:${item.detail ?? ""}`}><strong>{item.label}</strong>{item.detail ? <span>{item.detail}</span> : null}</li>)}</ul> : null}
			{descriptor.kind === "kv" ? <dl className="pl-kv">{descriptor.rows.map(row => <div key={row.key}><dt>{row.key}</dt><dd>{row.value}</dd></div>)}</dl> : null}
			{descriptor.kind === "progress" ? <div className="pl-progress"><div><span>{descriptor.label ?? "Progress"}</span><b>{descriptor.max === 0 ? "—" : `${Math.round((descriptor.value / descriptor.max) * 100)}%`}</b></div><progress value={descriptor.value} max={descriptor.max} /></div> : null}
			{descriptor.kind === "markdown" ? <Markdown text={descriptor.text} /> : null}
			{descriptor.kind === "table" ? <div className="pl-table-wrap"><table><thead><tr>{descriptor.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{descriptor.rows.map((row, index) => <tr key={`${panelKey}:${index}`}>{row.map((cell, cellIndex) => <td key={`${panelKey}:${index}:${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div> : null}
			{descriptor.kind === "buttons" ? <div className="pl-buttons">{descriptor.buttons.map(button => <button type="button" className="pl-btn" key={`${button.label}:${button.command}`} onClick={() => void run(button.command)}>{button.label}</button>)}</div> : null}
		</div>
	);
}
