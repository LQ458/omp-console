import type {
	EquivalenceTable,
	ListModelsResponse,
	ProviderFlowView,
	QuotaResponse,
	UsageAccountView,
	UsageWindowView,
} from "@omp-console/protocol";
import { ChevronDown, ChevronUp, Clock3, Gauge, PauseCircle, RefreshCw, Save, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { fmtPercent } from "../../lib/format";
import { recordUsage } from "../../lib/journal";
import {
	addEquivalentModel,
	clampPercent,
	formatResetCountdown,
	moveEquivalentModel,
	primaryUsageWindow,
	quotaAdvice,
	quotaStateLabel,
	quotaTone,
	removeEquivalentModel,
	reserveMarkerPct,
	reserveThreshold,
	validateEquivalenceTable,
} from "../../lib/quota";
import { OmpLine } from "../spawn/OmpLine";
import "./quota.css";


export interface QuotaPanelProps {
	api: DeckApi;
	initial?: QuotaResponse;
}

export function QuotaPanel({ api, initial }: QuotaPanelProps): ReactNode {
	const [quota, setQuota] = useState<QuotaResponse | null>(initial ?? null);
	const [models, setModels] = useState<ListModelsResponse | null>(null);
	const [table, setTable] = useState<EquivalenceTable>(initial?.equivalence ?? { tiers: [] });
	const [loading, setLoading] = useState(initial === undefined);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [warming, setWarming] = useState<QuotaResponse["cacheWarming"]>(initial?.cacheWarming ?? "off");
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
		setLoading(true);
		setError(null);
		try {
			const [nextQuota, nextModels] = await Promise.all([api.quota(signal), api.listModels(signal)]);
			setQuota(nextQuota);
			setModels(nextModels);
			setTable(nextQuota.equivalence);
			setWarming(nextQuota.cacheWarming);
		} catch (err) {
			if (signal?.aborted) return;
			setError(err instanceof Error ? err.message : "Quota data could not be loaded.");
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, [api]);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		recordUsage({ feature: "8.quota", action: "open", outcome: "ok", via: "direct", screen: "quota" });
		return () => controller.abort();
	}, [load]);

	const validationError = useMemo(() => validateEquivalenceTable(table), [table]);
	const availableModels = models?.models ?? [];
	const saveTable = async (): Promise<void> => {
		if (validationError || saving) return;
		setSaving(true);
		try {
			await api.setEquivalence(table);
			setMessage("Equivalence table saved.");
			recordUsage({ feature: "8.quota", action: "save-equivalence", outcome: "ok", via: "direct", screen: "quota" });
		} catch (err) {
			setMessage(err instanceof Error ? err.message : "Equivalence table could not be saved.");
			recordUsage({ feature: "8.quota", action: "save-equivalence", outcome: "error", via: "direct", screen: "quota" });
		} finally {
			setSaving(false);
		}
	};

	const setWarmingMode = async (mode: QuotaResponse["cacheWarming"]): Promise<void> => {
		if (mode === warming) return;
		const previous = warming;
		setWarming(mode);
		try {
			await api.setCacheWarming(mode);
			setMessage(`Cache warming: ${mode}.`);
			recordUsage({ feature: "8.quota", action: "cache-warming", outcome: "ok", via: "direct", screen: "quota", detail: mode });
		} catch (err) {
			setWarming(previous);
			setMessage(err instanceof Error ? err.message : "Cache warming could not be changed.");
			recordUsage({ feature: "8.quota", action: "cache-warming", outcome: "error", via: "direct", screen: "quota", detail: mode });
		}
	};

	return (
		<div className="q-panel">
			<div className="q-panel-head">
				<div>
					<div className="q-kicker"><Gauge size={13} aria-hidden /> Usage and pacing</div>
					<h3>Quota</h3>
					<p className="q-subtitle">Paces each provider independently. No provider is substituted without an explicit equivalence row.</p>
				</div>
				<button type="button" className="q-icon-btn" onClick={() => void load()} disabled={loading} title="refresh quota" aria-label="refresh quota">
					<RefreshCw size={14} className={loading ? "q-spin" : undefined} aria-hidden />
				</button>
			</div>
			<OmpLine text="/usage" onCopy={() => recordUsage({ feature: "0.2.equivalent", action: "copy-usage", outcome: "ok", via: "direct", screen: "quota" })} />
			{message ? <div className="q-message" role="status">{message}</div> : null}
			{error ? <div className="q-error" role="alert">{error}</div> : null}
			{loading && quota === null ? <div className="q-loading">Loading quota…</div> : null}
			{quota ? (
				<>
					<section className="q-section" aria-label="account quota summary">
						<div className="q-section-title">Accounts</div>
						<div className="q-account-summaries">
							{quota.accounts.map(account => <AccountSummary key={`${account.provider}:${account.account}`} account={account} />)}
						</div>
						<p className="q-advice" role="status">{quotaAdvice(quota.accounts)}</p>
					</section>
					<details className="q-details">
						<summary>Details <span>full windows, flow control, equivalence and cache warming</span></summary>
						<section className="q-section" aria-label="usage accounts">
							<div className="q-section-title">Accounts and windows <span className="q-updated">updated {formatResetCountdown(quota.updatedAt, Date.now()) === "reset now" ? "just now" : new Date(quota.updatedAt).toLocaleTimeString()}</span></div>
							<div className="q-accounts">{quota.accounts.map(account => <AccountView key={`${account.provider}:${account.account}`} account={account} />)}</div>
						</section>
						<section className="q-section" aria-label="provider flow control">
							<div className="q-section-title">Flow control</div>
							<div className="q-providers">{quota.providers.map(provider => <ProviderView key={provider.provider} provider={provider} />)}</div>
						</section>
						<section className="q-section" aria-label="equivalence editor">
							<div className="q-section-heading">
								<div>
									<div className="q-section-title">Equivalence table</div>
									<p className="q-help">Roles use models in order. Judgment roles pause when their list is empty instead of downgrading.</p>
								</div>
								<button type="button" className="q-btn q-btn-primary" disabled={saving || validationError !== null} onClick={() => void saveTable()}><Save size={13} aria-hidden /> {saving ? "Saving…" : "Save"}</button>
							</div>
							<div className="q-equivalence">
								{table.tiers.map(tier => (
									<TierEditor
										key={tier.tier}
										tier={tier}
										models={availableModels}
										onAdd={model => setTable(current => addEquivalentModel(current, tier.tier, model))}
										onRemove={model => setTable(current => removeEquivalentModel(current, tier.tier, model))}
										onMove={(model, direction) => setTable(current => moveEquivalentModel(current, tier.tier, model, direction))}
									/>
								))}
							</div>
							{validationError ? <div className="q-validation" role="alert">{validationError}</div> : null}
						</section>
						<section className="q-section" aria-label="cache warming">
							<div className="q-section-title">Cache warming</div>
							<p className="q-help">While paused, warming is allowed only close to reset and still counts as burn.</p>
							<div className="q-segment" role="radiogroup" aria-label="cache warming mode">
								{(["off", "streaming", "idle"] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={warming === mode} data-on={warming === mode} onClick={() => void setWarmingMode(mode)}>{mode}</button>)}
							</div>
						</section>
					</details>
				</>
			) : null}
			</div>
	);
}

function AccountSummary({ account }: { account: UsageAccountView }): ReactNode {
	const window = primaryUsageWindow(account);
	if (!window) {
		return (
			<div className="q-account-summary q-tone-unknown" data-stale={account.stale ? "true" : "false"}>
				<div className="q-account-summary-name"><strong>{account.provider}</strong><span>{account.account}</span>{account.stale ? <span className="q-stale">stale</span> : null}</div>
				<span className="q-account-summary-window">—</span>
				<span className="q-account-summary-empty">Window data unavailable</span>
			</div>
		);
	}
	const threshold = reserveThreshold(window);
	const remaining = threshold - window.usedPct;
	const tone = quotaTone(remaining);
	const reset = formatResetCountdown(window.resetsAt);
	return (
		<div className={`q-account-summary q-tone-${tone}`} data-stale={account.stale ? "true" : "false"}>
			<div className="q-account-summary-name"><strong>{account.provider}</strong><span>{account.account}</span>{account.stale ? <span className="q-stale">stale</span> : null}</div>
			<span className="q-account-summary-window">{window.id}</span>
			<div className="q-summary-meter" role="progressbar" aria-label={`${account.provider} ${account.account} ${window.id} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clampPercent(window.usedPct)} aria-valuetext={`${fmtPercent(window.usedPct)} used; resets ${reset}`}>
				<span className="q-meter-fill" style={{ width: `${clampPercent(window.usedPct)}%` }} />
				<span className="q-meter-marker q-meter-reserve" style={{ left: `${threshold}%` }} title={`${window.reservePct}% headroom reserve`} />
			</div>
			<strong className="q-account-summary-percent">{fmtPercent(window.usedPct)}</strong>
			<span className="q-account-summary-reset">resets {reset}</span>
		</div>
	);
}


function AccountView({ account }: { account: UsageAccountView }): ReactNode {
	return (
		<div className="q-account">
			<div className="q-account-head"><strong>{account.provider}</strong><span>{account.account}</span>{account.stale ? <span className="q-stale">stale · cap held</span> : null}</div>
			{account.windows.map(window => <WindowView key={window.id} window={window} />)}
		</div>
	);
}

function WindowView({ window }: { window: UsageWindowView }): ReactNode {
	const used = clampPercent(window.usedPct);
	const reserve = reserveMarkerPct(window.reservePct);
	return (
		<div className="q-window">
			<div className="q-window-head"><span>{window.id}</span><span>{fmtPercent(window.usedPct)} used</span><span>resets {formatResetCountdown(window.resetsAt)}</span></div>
			<div className="q-meter" aria-label={`${window.id}: ${fmtPercent(window.usedPct)} used`}>
				<span className="q-meter-fill" style={{ width: `${used}%` }} />
				<span className="q-meter-marker q-meter-reserve" style={{ left: `${reserve}%` }} title={`${window.reservePct}% headroom reserve`} />
				{window.projectedPct !== undefined ? <span className="q-meter-marker q-meter-project" style={{ left: `${clampPercent(window.projectedPct)}%` }} title={`projected ${fmtPercent(window.projectedPct)} at reset`} /> : null}
			</div>
			<div className="q-meter-legend"><span><i className="q-legend-used" /> used</span><span><i className="q-legend-reserve" /> reserve</span>{window.projectedPct !== undefined ? <span><i className="q-legend-project" /> projected</span> : <span>projection needs 3 fresh samples</span>}</div>
		</div>
	);
}

function ProviderView({ provider }: { provider: ProviderFlowView }): ReactNode {
	const tone = quotaTone(provider.headroomPct);
	const Icon = provider.state === "paused" ? PauseCircle : provider.state === "rate-limited" ? TriangleAlert : provider.state === "throttled" ? Clock3 : provider.state === "ok" ? ShieldCheck : Gauge;
	return (
		<div className={`q-provider q-tone-${tone}`}>
			<div className="q-provider-head"><Icon size={15} aria-hidden /><strong>{provider.provider}</strong><span className="q-state">{quotaStateLabel(provider.state)}</span><span className="q-headroom">{provider.headroomPct === null ? "headroom unknown" : `${fmtPercent(provider.headroomPct)} headroom`}</span></div>
			<div className="q-provider-stats"><span>cap <b>{provider.cap}</b></span><span>running <b>{provider.running}</b></span><span>queued <b>{provider.queued}</b> <small>held by flow control</small></span></div>
			<div className="q-provider-burn"><span>local {provider.burnLocalPctPerMin === undefined ? "—" : `${provider.burnLocalPctPerMin.toFixed(2)}%/min`}</span><span>external {provider.burnExternalPctPerMin === undefined ? "—" : `${provider.burnExternalPctPerMin.toFixed(2)}%/min`}</span>{provider.resumesAt ? <span>backoff {formatResetCountdown(provider.resumesAt)}</span> : null}</div>
			{provider.reason ? <p className="q-help">{provider.reason}</p> : null}
		</div>
	);
}

function TierEditor({ tier, models, onAdd, onRemove, onMove }: { tier: EquivalenceTable["tiers"][number]; models: ListModelsResponse["models"]; onAdd(model: string): void; onRemove(model: string): void; onMove(model: string, direction: "up" | "down"): void }): ReactNode {
	const choices = models.filter(model => model.available && !tier.models.includes(model.selector));
	return (
		<div className="q-tier">
			<div className="q-tier-head"><div><strong>{tier.tier}</strong>{tier.tier.toLowerCase().includes("judg") && tier.models.length === 0 ? <span className="q-pause-note">pause instead of substitute</span> : null}</div><span>{tier.roles.join(" · ")}</span></div>
			<div className="q-tier-models">
				{tier.models.map((model, index) => (
					<span key={model} className="q-model-chip">
						<code>{model}</code>
						<span className="q-model-order">
							<button type="button" disabled={index === 0} onClick={() => onMove(model, "up")} aria-label={`move ${model} up`}><ChevronUp size={11} aria-hidden /></button>
							<button type="button" disabled={index === tier.models.length - 1} onClick={() => onMove(model, "down")} aria-label={`move ${model} down`}><ChevronDown size={11} aria-hidden /></button>
						</span>
						<button type="button" onClick={() => onRemove(model)} aria-label={`remove ${model}`}><X size={12} aria-hidden /></button>
					</span>
				))}
				<select aria-label={`add model to ${tier.tier}`} value="" onChange={event => { if (event.target.value) onAdd(event.target.value); }}>
					<option value="">Add model…</option>
					{choices.map(model => <option key={model.selector} value={model.selector}>{model.label} · {model.provider}</option>)}
				</select>
				{choices.length === 0 && tier.models.length === 0 ? <span className="q-help">No substitute selected.</span> : null}
			</div>
		</div>
	);
}
