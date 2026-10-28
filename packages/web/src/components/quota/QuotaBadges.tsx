import type { QuotaResponse, SpawnEstimate } from "@omp-console/protocol";
import { Clock3, Gauge, PauseCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { fmtPercent } from "../../lib/format";
import { estimateIsReady, formatResetCountdown, formatSpawnEstimate, providerReset, QUOTA_POLL_MS, quotaSnapshotCurrent, quotaStateLabel, quotaTone } from "../../lib/quota";
import { useNow } from "../agents/use-agent-graph";
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

/** Small provider-aware header meter. It deliberately polls slowly; quota is not transcript state. The countdown
 * re-renders on its own clock, so a failed refetch never freezes it, and a snapshot that stopped refreshing drops it. */
export function QuotaHeaderChip({ api, provider }: QuotaHeaderChipProps): ReactNode {
	const [quota, setQuota] = useState<QuotaResponse | null>(null);
	// Staleness is measured on this device's clock: the daemon's `updatedAt` can be skewed (WSL after sleep, a phone).
	const [receivedAt, setReceivedAt] = useState(0);
	useEffect(() => {
		if (!provider) {
			setQuota(null);
			return;
		}
		let live = true;
		const controller = new AbortController();
		const load = (): void => {
			void api.quota(controller.signal).then(value => {
				if (live) {
					setQuota(value);
					setReceivedAt(Date.now());
				}
			}).catch(() => {
				// The full panel owns the actionable error; the header stays quiet when quota is unavailable.
			});
		};
		load();
		const timer = window.setInterval(load, QUOTA_POLL_MS);
		// Timers are throttled or suspended while the page is hidden; refetch as soon as it is shown again.
		const onVisible = (): void => {
			if (document.visibilityState === "visible") load();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			live = false;
			controller.abort();
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [api, provider]);
	useNow(QUOTA_POLL_MS);
	const now = Date.now();

	const flow = quota?.providers.find(item => item.provider === provider) ?? quota?.providers.find(item => item.provider.toLowerCase() === provider?.toLowerCase());
	if (!quota || !flow) return null;
	const tone = quotaTone(flow.headroomPct);
	const current = quotaSnapshotCurrent(receivedAt, now);
	const reset = current ? providerReset(quota, flow.provider, now) : undefined;
	const title = [
		`${flow.provider} · ${quotaStateLabel(flow.state)}`,
		...(current ? reset?.details ?? [] : [`usage last updated ${new Date(receivedAt).toLocaleTimeString()}; refresh is failing`]),
	].join("\n");
	const Icon = flow.state === "paused" ? PauseCircle : flow.state === "rate-limited" ? TriangleAlert : flow.state === "throttled" ? Clock3 : Gauge;
	return (
		<span className={`q-header-chip q-tone-${tone}`} title={title}>
			<Icon size={12} aria-hidden />
			<span>{flow.provider}</span>
			<strong>{flow.headroomPct === null ? "—" : fmtPercent(flow.headroomPct)}</strong>
			{reset && (
				<span className="q-header-reset" aria-label={`${reset.window} window resets in ${formatResetCountdown(reset.resetsAt, now)}`}>
					{reset.window} resets in {formatResetCountdown(reset.resetsAt, now)}
				</span>
			)}
		</span>
	);
}
