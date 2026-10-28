import type { QuotaResponse, SpawnEstimate } from "@omp-console/protocol";
import { Clock3, Gauge, PauseCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { fmtPercent } from "../../lib/format";
import { estimateIsReady, formatResetCountdown, formatSpawnEstimate, providerReset, quotaStateLabel, quotaTone } from "../../lib/quota";
import "./quota-badges.css";

export interface SpawnEstimateBadgeProps {
	estimate: SpawnEstimate | null | undefined;
	windowLabel?: string;
}

/** Shared by the spawn dialog and draft graph; estimates stay hidden until the daemon has ten samples. */
export function SpawnEstimateBadge({ estimate, windowLabel = "window" }: SpawnEstimateBadgeProps): ReactNode {
	if (!estimate || !estimateIsReady(estimate)) return null;
	const text = formatSpawnEstimate(estimate, windowLabel);
	if (text === null) return null;
	return <span className="q-estimate" title={`${estimate.samples} samples`}>{text}</span>;
}

export interface QuotaHeaderChipProps {
	api: DeckApi;
	provider: string | undefined;
}

/** Small provider-aware header meter. It deliberately polls slowly; quota is not transcript state. */
export function QuotaHeaderChip({ api, provider }: QuotaHeaderChipProps): ReactNode {
	const [quota, setQuota] = useState<QuotaResponse | null>(null);
	useEffect(() => {
		if (!provider) {
			setQuota(null);
			return;
		}
		let live = true;
		const controller = new AbortController();
		const load = (): void => {
			void api.quota(controller.signal).then(value => {
				if (live) setQuota(value);
			}).catch(() => {
				// The full panel owns the actionable error; the header stays quiet when quota is unavailable.
			});
		};
		load();
		const timer = window.setInterval(load, 30_000);
		return () => {
			live = false;
			controller.abort();
			window.clearInterval(timer);
		};
	}, [api, provider]);

	const flow = quota?.providers.find(item => item.provider === provider) ?? quota?.providers.find(item => item.provider.toLowerCase() === provider?.toLowerCase());
	if (!flow) return null;
	const tone = quotaTone(flow.headroomPct);
	const reset = quota ? providerReset(quota, flow.provider) : undefined;
	const title = [`${flow.provider} · ${quotaStateLabel(flow.state)}`, ...(reset?.details ?? [])].join("\n");
	const Icon = flow.state === "paused" ? PauseCircle : flow.state === "rate-limited" ? TriangleAlert : flow.state === "throttled" ? Clock3 : Gauge;
	return (
		<span className={`q-header-chip q-tone-${tone}`} title={title}>
			<Icon size={12} aria-hidden />
			<span>{flow.provider}</span>
			<strong>{flow.headroomPct === null ? "—" : fmtPercent(flow.headroomPct)}</strong>
			{reset && (
				<span className="q-header-reset" aria-label={`${reset.window} window resets in ${formatResetCountdown(reset.resetsAt)}`}>
					{reset.window} resets in {formatResetCountdown(reset.resetsAt)}
				</span>
			)}
		</span>
	);
}
