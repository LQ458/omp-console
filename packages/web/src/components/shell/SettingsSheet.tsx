import { Check, LogOut, Monitor, Moon, Sun } from "lucide-react";
import type { DaemonCapabilities, DaemonHealth, QuotaResponse } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { EnableNotifications } from "../../../pwa/EnableNotifications";
import { AutoSleepSettings } from "./AutoSleepSettings";
import { getPushState, pushStatus, type PushStatus } from "../../../pwa/push";
import type { DeckApi, PairedDevice } from "../../lib/api";
import { offlineCacheEnabled, setOfflineCacheEnabled, subscribeOfflineCachePreference } from "../../lib/offline-cache/preference";
import { offlineTranscriptCache } from "../../lib/offline-cache/cache";
import type { OfflineCacheStats } from "../../lib/offline-cache/types";
import { nativeInvoke } from "../../lib/move";
import {
	customAccentFromHex,
	useCustomAccent,
	useMotionPreference,
	usePalettePreference,
	useThemePreference,
	type ThemePreference,
} from "../../lib/theme";
import type { MotionLevel, Palette } from "../../lib/storage";
import { lazyWithRecovery } from "../../lib/lazy";
import { quotaHealth, type QuotaHealth } from "../../lib/quota";
import { LazyRegion } from "./LazyRegion";
import { PluginsPanel } from "../plugins/PluginsPanel";
import { ProcessesPanel } from "../processes/ProcessesPanel";
import { ProfilesPanel } from "../profiles/ProfilesPanel";
import { ImproveDeckSection } from "../session-ops/ImproveDeckSection";
import { QuickRepliesSettings } from "./QuickRepliesSettings";
import { OvernightSettings } from "../overnight/OvernightSettings";
import { FeaturesSettings } from "./FeaturesSettings";
import { openPanel } from "../../lib/palette";
import { Sheet } from "./Sheet";
import "./global-settings.css";
const HistoryPanel = lazyWithRecovery(() => import("../history/HistoryPanel").then(({ HistoryPanel: component }) => ({ default: component })));
const QuotaPanel = lazyWithRecovery(() => import("../quota/QuotaPanel").then(({ QuotaPanel: component }) => ({ default: component })));


const THEMES: ReadonlyArray<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
	{ value: "system", label: "System", Icon: Monitor },
	{ value: "light", label: "Light", Icon: Sun },
	{ value: "dark", label: "Dark", Icon: Moon },
];

const PALETTE_OPTIONS: readonly { value: Palette; label: string }[] = [
	{ value: "deck", label: "omp console" },
	{ value: "graphite", label: "Graphite" },
	{ value: "ocean", label: "Ocean" },
	{ value: "forest", label: "Forest" },
	{ value: "sepia", label: "Sepia" },
	{ value: "contrast", label: "High contrast" },
	{ value: "custom", label: "Custom accent" },
];

const MOTION_OPTIONS: readonly { value: MotionLevel; label: string; description: string }[] = [
	{ value: "off", label: "Off", description: "No transitions or animations." },
	{ value: "calm", label: "Calm", description: "Short fades and subtle shifts, 120–250 ms." },
	{ value: "lively", label: "Lively", description: "Springy transitions with a slight overshoot." },
];

export type SettingsScope = "global" | "session";

export interface SettingsSheetProps {
	scope: SettingsScope;
	onClose(): void;
	canLeave: boolean;
	onLeave(): void;
	api: DeckApi;
	onCapabilitiesChanged?: (capabilities: DaemonCapabilities) => void;
	capabilities?: DaemonCapabilities;
	/** Only present when the session panel is showing a session with a daemon id. */
	sessionId?: string;
	onOpenSession?(sessionId: string): void;
	onOpenGlobalSettings?(): void;
	/** Phone: the header gear opens the app-wide panel first; this leads on to the open session's own settings. */
	onOpenSessionSettings?(): void;
	/** Opens the existing session Plugins panel directly for `/extensions`. */
	initialSection?: "session" | "plugins";
}

export function SettingsSheet(props: SettingsSheetProps): ReactNode {
	return props.scope === "global" ? <GlobalSettingsSheet {...props} /> : <SessionSettingsSheet {...props} />;
}

function GlobalSettingsSheet({
	onClose,
	api,
	onOpenSession,
	onOpenSessionSettings,
	onCapabilitiesChanged,
	capabilities,
}: SettingsSheetProps): ReactNode {
	const { preference, resolved, setPreference } = useThemePreference();
	const { palette, setPalette } = usePalettePreference();
	const { motion, setMotion } = useMotionPreference();
	const { customAccent, setCustomAccent } = useCustomAccent();
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [offlineCacheOn, setOfflineCacheOn] = useState(() => offlineCacheEnabled());
	const [offlineCacheStats, setOfflineCacheStats] = useState<OfflineCacheStats>({ sessions: 0, bytes: 0 });
	const [clearingOfflineCache, setClearingOfflineCache] = useState(false);
	useEffect(() => {
		if (!advancedOpen) return;
		const refresh = (): void => {
			void offlineTranscriptCache.stats().then(setOfflineCacheStats);
		};
		const unsubscribe = offlineTranscriptCache.subscribe(refresh);
		refresh();
		return unsubscribe;
	}, [advancedOpen]);
	useEffect(() => {
		if (!advancedOpen) return;
		return subscribeOfflineCachePreference(() => setOfflineCacheOn(offlineCacheEnabled()));
	}, [advancedOpen]);
	const clearOfflineCache = async (): Promise<void> => {
		if (clearingOfflineCache) return;
		setClearingOfflineCache(true);
		try {
			await offlineTranscriptCache.clear();
			setOfflineCacheStats(await offlineTranscriptCache.stats());
		} finally {
			setClearingOfflineCache(false);
		}
	};
	return (
		<Sheet title="Settings" onClose={onClose}>
			<div className="dk-global-settings">
				<section className="dk-settings-section" aria-label="Basics">
					<h3 className="dk-section-title">Basics</h3>
					<section className="dk-settings-section dk-settings-appearance" aria-label="Appearance">
						<h3 className="dk-section-title">Appearance</h3>
						<div className="dk-segment" role="radiogroup" aria-label="Appearance">
							{THEMES.map(({ value, label, Icon }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={preference === value}
									className="dk-segment-btn"
									data-on={preference === value ? "true" : "false"}
									onClick={() => setPreference(value)}
								>
									<Icon size={16} />
									{label}
								</button>
							))}
						</div>
						<h4 className="dk-appearance-subtitle">Color theme</h4>
						<div className="dk-palette-grid" role="radiogroup" aria-label="Color theme">
							{PALETTE_OPTIONS.map(({ value, label }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-label={label}
									aria-checked={palette === value}
									className="dk-palette-choice"
									data-on={palette === value ? "true" : "false"}
									data-theme={resolved}
									data-palette={value}
									onClick={() => setPalette(value)}
								>
									<span className="dk-palette-preview" aria-hidden="true">
										<span className="dk-palette-swatch-bg" />
										<span className="dk-palette-swatch-panel" />
										<span className="dk-palette-swatch-accent" />
										<span className="dk-palette-swatch-text" />
									</span>
									<span className="dk-palette-label">{label}</span>
									{palette === value && <Check size={15} aria-hidden="true" />}
								</button>
							))}
						</div>
						{palette === "custom" && (
							<label className="dk-custom-accent">
								<span>Accent color</span>
								<input
									type="color"
									aria-label="Custom accent color"
									value={customAccent.hex}
									onChange={event => setCustomAccent(customAccentFromHex(event.currentTarget.value))}
								/>
								<output>{customAccent.hex.toUpperCase()}</output>
							</label>
						)}
						<h4 className="dk-appearance-subtitle">Motion</h4>
						<div className="dk-segment dk-motion-level" role="radiogroup" aria-label="Motion">
							{MOTION_OPTIONS.map(({ value, label }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={motion === value}
									className="dk-segment-btn"
									data-on={motion === value ? "true" : "false"}
									onClick={() => setMotion(value)}
								>
									{label}
								</button>
							))}
						</div>
						<p className="dk-motion-description" aria-live="polite">
							{MOTION_OPTIONS.find(option => option.value === motion)?.description}
						</p>
					</section>
					<section className="dk-settings-section dk-settings-notify" aria-label="Notifications">
						<h3 className="dk-section-title">Notifications</h3>
						<EnableNotifications />
					</section>
					<DevicesPanel api={api} />
					<section className="dk-settings-section" aria-label="Model roles">
						<h3 className="dk-section-title">Model roles</h3>
						<ProfilesPanel api={api} />
					</section>
					<section className="dk-settings-section" aria-label="Help">
						<h3 className="dk-section-title">Help</h3>
						{onOpenSessionSettings && (
							<button type="button" className="dk-wide-btn" onClick={onOpenSessionSettings}>
								Session settings
							</button>
						)}
						<button type="button" className="dk-wide-btn" onClick={() => openPanel({ panel: "setup" })}>
							Get started
						</button>
						<button type="button" className="dk-wide-btn" onClick={() => openPanel({ panel: "claude-import" })}>
							Import from Claude Code
						</button>
					</section>
				</section>
				<details className="dk-settings-advanced" onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
					<summary>Advanced</summary>
					{advancedOpen && (
						<div className="dk-settings-advanced-content">
							<SettingsStatusLine api={api} />
							<FeaturesSettings api={api} onCapabilitiesChanged={onCapabilitiesChanged} />
							{capabilities?.features.overnight === true && <OvernightSettings api={api} />}
							<QuickRepliesSettings />
							<section className="dk-settings-section" aria-label="Offline cache">
								<h3 className="dk-section-title">Offline cache</h3>
								<button
									type="button"
									role="switch"
									aria-label="Offline cache"
									aria-checked={offlineCacheOn}
									className="dk-wide-btn"
									onClick={() => {
										const enabled = !offlineCacheOn;
										setOfflineCacheOn(enabled);
										setOfflineCacheEnabled(enabled);
									}}
								>
									<span>Cache transcripts and API lists</span>
									<span>{offlineCacheOn ? "On" : "Off"}</span>
								</button>
								<p className="dk-hint" aria-live="polite">
									{offlineCacheStats.sessions} sessions · {(offlineCacheStats.bytes / (1024 * 1024)).toFixed(1)} MB
								</p>
								<button type="button" className="dk-wide-btn" disabled={clearingOfflineCache} onClick={() => void clearOfflineCache()}>
									{clearingOfflineCache ? "Clearing…" : "Clear offline cache"}
								</button>
								<p className="dk-hint">Clearing also removes cached API responses from this device.</p>
							</section>
							<AutoSleepSettings api={api} />
							<ImproveDeckSection api={api} />
							<LazyRegion fallback={<div className="pn-note" role="status" aria-busy="true"><p className="pn-note-body">Loading quota…</p></div>}>
								<QuotaPanel api={api} />
							</LazyRegion>
							<ProcessesPanel api={api} />
							<LazyRegion fallback={<div className="pn-note" role="status" aria-busy="true"><p className="pn-note-body">Loading history…</p></div>}>
								<HistoryPanel
									api={api}
									onOpenSession={id => {
										onClose();
										onOpenSession?.(id);
									}}
								/>
							</LazyRegion>
							<section className="dk-settings-section" aria-label="About">
								<h3 className="dk-section-title">About</h3>
								<a className="dk-wide-btn" href="/licenses.txt" target="_blank" rel="noreferrer">
									Open-source licenses
								</a>
							</section>
						</div>
					)}
				</details>
			</div>
		</Sheet>
	);
}


type SessionSection = "session" | "plugins";

function DevicesPanel({ api }: { api: DeckApi }): ReactNode {
	const [devices, setDevices] = useState<PairedDevice[]>([]);
	const [currentDeviceId, setCurrentDeviceId] = useState("");
	const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: number }>();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [busyDevice, setBusyDevice] = useState("");
	const [issuingCode, setIssuingCode] = useState(false);

	useEffect(() => {
		let active = true;
		void api.devices().then(result => {
			if (!active) return;
			setDevices(result.devices);
			setCurrentDeviceId(result.currentDeviceId);
		}).catch(reason => {
			if (active) setError(reason instanceof Error ? reason.message : "Could not load paired devices.");
		}).finally(() => {
			if (active) setLoading(false);
		});
		return () => {
			active = false;
		};
	}, [api]);

	const revoke = async (device: PairedDevice): Promise<void> => {
		setBusyDevice(device.id);
		setError("");
		try {
			const result = await api.revokeDevice(device.id);
			setDevices(current => current.filter(item => item.id !== result.revoked));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not revoke this device.");
		} finally {
			setBusyDevice("");
		}
	};

	const issueCode = async (): Promise<void> => {
		setIssuingCode(true);
		setError("");
		try {
			setPairingCode(await api.issuePairingCode());
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not create a pairing code.");
		} finally {
			setIssuingCode(false);
		}
	};

	return (
		<section className="dk-settings-section dk-devices" aria-label="Devices">
			<h3 className="dk-section-title">Paired devices</h3>
			{loading && <p className="dk-hint" role="status">Loading devices…</p>}
			{!loading && devices.length === 0 && <p className="dk-hint">No paired devices.</p>}
			<ul className="dk-device-list">
				{devices.map(device => {
					const current = device.id === currentDeviceId;
					return (
						<li className="dk-device-card" key={device.id}>
							<div className="dk-device-heading">
								<strong>{device.label}</strong>
								{current && <span className="dk-device-current">This device</span>}
							</div>
							<p className="dk-hint">Last seen {new Date(device.lastSeenAt).toLocaleString()}</p>
							<button
								aria-label={`Revoke ${device.label}`}
								className="dk-wide-btn"
								disabled={busyDevice === device.id}
								onClick={() => void revoke(device)}
								type="button"
							>
								{busyDevice === device.id ? "Revoking…" : "Revoke"}
							</button>
						</li>
					);
				})}
			</ul>
			{error && <p className="dk-device-error" role="alert">{error}</p>}
			<button className="dk-wide-btn" disabled={issuingCode} onClick={() => void issueCode()} type="button">
				{issuingCode ? "Creating code…" : "Pair another device"}
			</button>
			{pairingCode && (
				<div className="dk-device-code" role="status">
					<p>Enter this one-time code on the new device:</p>
					<code>{pairingCode.code}</code>
					<p className="dk-hint">Expires {new Date(pairingCode.expiresAt).toLocaleTimeString()}.</p>
				</div>
			)}
		</section>
	);
}

function SessionSettingsSheet({
	onClose,
	canLeave,
	onLeave,
	api,
	sessionId,
	onOpenGlobalSettings,
	initialSection = "session",
}: SettingsSheetProps): ReactNode {
	const [section, setSection] = useState<SessionSection>(initialSection);
	useEffect(() => setSection(initialSection), [initialSection]);
	return (
		<Sheet title="Session settings" onClose={onClose}>
			<div className="dk-segment dk-settings-nav" role="tablist" aria-label="session settings sections">
				<button
					type="button"
					role="tab"
					aria-selected={section === "session"}
					data-on={section === "session" ? "true" : "false"}
					className="dk-segment-btn"
					onClick={() => setSection("session")}
				>
					Session
				</button>
				{sessionId !== undefined && (
					<button
						type="button"
						role="tab"
						aria-selected={section === "plugins"}
						data-on={section === "plugins" ? "true" : "false"}
						className="dk-segment-btn"
						onClick={() => setSection("plugins")}
					>
						Plugins
					</button>
				)}
			</div>
			{section === "session" && (
				<>
					{onOpenGlobalSettings && (
						<section className="dk-settings-section">
							<button type="button" className="dk-wide-btn" onClick={onOpenGlobalSettings}>
								Global settings
							</button>
						</section>
					)}
					{canLeave && (
						<section className="dk-settings-section" aria-label="Session">
							<h3 className="dk-section-title">Session</h3>
							<button
								type="button"
								className="dk-wide-btn"
								onClick={() => {
									onClose();
									onLeave();
								}}
							>
								<LogOut size={16} />
								Leave this session
							</button>
							<p className="dk-hint">The session keeps running on the daemon; you can open it again from the session list.</p>
						</section>
					)}
				</>
			)}
			{section === "plugins" && sessionId !== undefined && <PluginsPanel api={api} sessionId={sessionId} />}
		</Sheet>
	);
}

export type NotificationSummary = "on" | "off" | "blocked" | "install-required" | "managed" | "unavailable";

const PUSH_STATUS_SUMMARY: Record<PushStatus, NotificationSummary> = {
	unsupported: "unavailable",
	"install-required": "install-required",
	denied: "blocked",
	off: "off",
	enabled: "on",
};

export function summarizeNotificationStatus(status: PushStatus): NotificationSummary {
	return PUSH_STATUS_SUMMARY[status];
}

export interface SettingsStatusSummary {
	runningSessions: number | null;
	notifications: NotificationSummary;
	quota: QuotaHealth;
	decisionBackend: "jev" | "luna" | null;
}

export function summarizeSettingsStatus(
	health: DaemonHealth | null,
	notifications: NotificationSummary,
	quota: QuotaResponse | null,
	decisionBackend: "jev" | "luna" | null,
): SettingsStatusSummary {
	let runningSessions: number | null = null;
	if (health !== null) {
		runningSessions = 0;
		for (const worker of health.workers) {
			if (worker.state !== "stopped" && worker.state !== "crashed") runningSessions++;
		}
	}
	return { runningSessions, notifications, quota: quotaHealth(quota), decisionBackend };
}

export function formatSettingsStatus(summary: SettingsStatusSummary): string {
	const sessions = summary.runningSessions === null
		? "Sessions unavailable"
		: `${summary.runningSessions} session${summary.runningSessions === 1 ? "" : "s"} running`;
	const notifications: Record<NotificationSummary, string> = {
		on: "Notifications on",
		off: "Notifications off",
		blocked: "Notifications blocked",
		"install-required": "Install omp console for notifications",
		managed: "Notifications managed by macOS",
		unavailable: "Notifications unavailable",
	};
	const quotaLabels: Record<QuotaHealth, string> = {
		healthy: "healthy",
		"near-reserve": "near reserve",
		"at-reserve": "at reserve",
		limited: "limited",
		stale: "stale",
		unknown: "unknown",
	};
	const backend = summary.decisionBackend === null
		? "Decision backend unknown"
		: `Decision backend ${summary.decisionBackend === "jev" ? "Jev" : "Luna"}`;
	return `${sessions} · ${notifications[summary.notifications]} · Quota ${quotaLabels[summary.quota]} · ${backend}`;
}

export function SettingsStatusView({ summary }: { summary: SettingsStatusSummary | null }): ReactNode {
	return (
		<div className="dk-settings-status" aria-label="Settings status" role="status">
			<strong>Status</strong>
			<span>{summary === null ? "Checking status…" : formatSettingsStatus(summary)}</span>
		</div>
	);
}

function SettingsStatusLine({ api }: { api: DeckApi }): ReactNode {
	const [summary, setSummary] = useState<SettingsStatusSummary | null>(null);
	useEffect(() => {
		let live = true;
		let inFlight = false;
		let controller: AbortController | null = null;
		const load = async (): Promise<void> => {
			if (inFlight || document.visibilityState === "hidden") return;
			inFlight = true;
			controller = new AbortController();
			const current = controller;
			const nativeNotifications = nativeInvoke() !== null;
			try {
				const [healthResult, quotaResult, cardsResult, pushResult] = await Promise.allSettled([
					api.health(current.signal),
					api.quota(current.signal),
					api.cards({ limit: 1 }, current.signal),
					nativeNotifications ? Promise.resolve(null) : getPushState(),
				]);
				if (!live || current.signal.aborted) return;
				const health = healthResult.status === "fulfilled" ? healthResult.value : null;
				const notifications: NotificationSummary = nativeNotifications
					? "managed"
					: pushResult.status !== "fulfilled" || pushResult.value === null
						? "unavailable"
						: summarizeNotificationStatus(pushStatus(pushResult.value));
				setSummary(summarizeSettingsStatus(
					health,
					notifications,
					quotaResult.status === "fulfilled" ? quotaResult.value : null,
					cardsResult.status === "fulfilled" ? cardsResult.value.decisionBackend : null,
				));
			} finally {
				inFlight = false;
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), 30_000);
		return () => {
			live = false;
			controller?.abort();
			window.clearInterval(timer);
		};
	}, [api]);

	return <SettingsStatusView summary={summary} />;
}
