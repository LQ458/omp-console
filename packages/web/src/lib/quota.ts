import type { EquivalenceTable, QuotaResponse, SpawnEstimate, UsageAccountView, UsageWindowView } from "@omp-console/protocol";
import { fmtPercent, fmtTokens } from "./format";

export type QuotaTone = "ok" | "warn" | "danger" | "unknown";

/** Headroom thresholds used by the header chip and quota rows. */
export function quotaTone(headroomPct: number | null): QuotaTone {
	if (headroomPct === null || !Number.isFinite(headroomPct)) return "unknown";
	if (headroomPct < 15) return "danger";
	if (headroomPct < 40) return "warn";
	return "ok";
}

export function quotaStateLabel(state: "ok" | "throttled" | "paused" | "rate-limited" | "unknown"): string {
	switch (state) {
		case "rate-limited":
			return "rate limited";
		case "unknown":
			return "unknown";
		default:
			return state;
	}
}

/** Formats a reset countdown without making the UI depend on a wall-clock locale. */
export function formatResetCountdown(resetsAt: number | undefined, now = Date.now()): string {
	if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "reset unknown";
	const seconds = Math.max(0, Math.ceil((resetsAt - now) / 1000));
	if (seconds === 0) return "reset now";
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	// Views re-render every QUOTA_POLL_MS, so seconds would sit still and then jump; show them only in the last minute.
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

/** How often quota views refetch `/quota` and re-render their countdowns. */
export const QUOTA_POLL_MS = 30_000;
/** A snapshot this old means refetches have been failing; its countdowns are no longer shown as live. */
export const QUOTA_SNAPSHOT_MAX_AGE_MS = 2 * 60_000;

/** Whether a quota snapshot received at `receivedAt` (this device's clock) is recent enough to present its reset
 * countdowns as current. */
export function quotaSnapshotCurrent(receivedAt: number, now = Date.now()): boolean {
	return now - receivedAt <= QUOTA_SNAPSHOT_MAX_AGE_MS;
}

export function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** A reserve is a used-meter marker at 100 - reserve headroom. */
export function reserveMarkerPct(reservePct: number): number {
	return clampPercent(100 - reservePct);
}

export function estimateIsReady(estimate: SpawnEstimate | null | undefined): estimate is SpawnEstimate & { tokens: number; windowPct: number } {
	return Boolean(
		estimate &&
		estimate.samples >= 10 &&
		estimate.tokens !== undefined &&
		estimate.windowPct !== undefined &&
		Number.isFinite(estimate.tokens) &&
		Number.isFinite(estimate.windowPct),
	);
}

export function formatSpawnEstimate(estimate: SpawnEstimate, windowLabel = "window"): string | null {
	if (!estimateIsReady(estimate)) return null;
	const pct = estimate.windowPct < 10 ? estimate.windowPct.toFixed(1) : Math.round(estimate.windowPct).toString();
	return `≈ ${fmtTokens(estimate.tokens)} tokens · ~${pct}% of ${windowLabel}`;
}

/** Validates only invariants the client can know without inventing model tiers. */
export function validateEquivalenceTable(table: EquivalenceTable): string | null {
	if (!Array.isArray(table.tiers) || table.tiers.length === 0) return "Add at least one equivalence tier.";
	const roles = new Set<string>();
	for (const tier of table.tiers) {
		if (tier.tier.trim() === "") return "Every tier needs a name.";
		if (tier.roles.length === 0) return `Tier “${tier.tier}” needs at least one role.`;
		for (const role of tier.roles) {
			if (roles.has(role)) return `Role “${role}” appears in more than one tier.`;
			roles.add(role);
		}
		if (tier.models.some(model => model.trim() === "")) return `Tier “${tier.tier}” contains an empty model.`;
		if (new Set(tier.models).size !== tier.models.length) return `Tier “${tier.tier}” repeats a model.`;
	}
	return null;
}

export function addEquivalentModel(table: EquivalenceTable, tier: string, model: string): EquivalenceTable {
	return {
		tiers: table.tiers.map(item =>
			item.tier === tier && !item.models.includes(model) ? { ...item, models: [...item.models, model] } : item,
		),
	};
}

export function removeEquivalentModel(table: EquivalenceTable, tier: string, model: string): EquivalenceTable {
	return {
		tiers: table.tiers.map(item => (item.tier === tier ? { ...item, models: item.models.filter(value => value !== model) } : item)),
	};
}

export function moveEquivalentModel(table: EquivalenceTable, tier: string, model: string, direction: "up" | "down"): EquivalenceTable {
	return {
		tiers: table.tiers.map(item => {
			if (item.tier !== tier) return item;
			const index = item.models.indexOf(model);
			const nextIndex = direction === "up" ? index - 1 : index + 1;
			if (index < 0 || nextIndex < 0 || nextIndex >= item.models.length) return item;
			const models = item.models.slice();
			[models[index], models[nextIndex]] = [models[nextIndex]!, models[index]!];
			return { ...item, models };
		}),
	};
}

export interface ProviderReset {
	/** The window that frees headroom next: the provider's binding window, else any window. */
	window: string;
	resetsAt: number;
	/** One line per fresh account window: "alice@example.com 5h: 37% used, resets in 3h 18m". */
	details: string[];
}

/** When the provider's quota next resets, from its fresh accounts (stale readings are skipped). */
export function providerReset(quota: QuotaResponse, provider: string, now = Date.now()): ProviderReset | undefined {
	const key = provider.toLowerCase();
	const flow = quota.providers.find(item => item.provider.toLowerCase() === key);
	const windows = quota.accounts
		.filter(account => account.provider.toLowerCase() === key && !account.stale)
		.flatMap(account => account.windows.map(window => ({ account: account.account, window })));
	const upcoming = windows.filter(({ window }) => window.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt > now);
	const soonest = (candidates: typeof upcoming) =>
		candidates.reduce<(typeof upcoming)[number] | undefined>((best, item) => (best === undefined || item.window.resetsAt! < best.window.resetsAt! ? item : best), undefined);
	const binding = flow?.bindingWindow;
	// The binding window's soonest reset among accounts that have used it; an untouched account frees nothing.
	const next =
		soonest(upcoming.filter(({ window }) => window.id === binding && window.usedPct > 0)) ??
		soonest(upcoming.filter(({ window }) => window.id === binding)) ??
		soonest(upcoming);
	if (next === undefined) return undefined;
	return {
		window: next.window.id,
		resetsAt: next.window.resetsAt!,
		details: windows.map(({ account, window }) => {
			const countdown = formatResetCountdown(window.resetsAt, now);
			const when = countdown === "reset unknown" ? "reset time unknown" : countdown === "reset now" ? "resets now" : `resets in ${countdown}`;
			return `${account} ${window.id}: ${Math.round(window.usedPct)}% used, ${when}`;
		}),
	};
}
function validUsageWindow(window: UsageWindowView): boolean {
	return Number.isFinite(window.usedPct) && Number.isFinite(window.reservePct);
}

export function reserveThreshold(window: UsageWindowView): number {
	return clampPercent(100 - window.reservePct);
}

function projectedUsage(window: UsageWindowView): number {
	return Math.max(window.usedPct, window.projectedPct !== undefined && Number.isFinite(window.projectedPct) ? window.projectedPct : window.usedPct);
}

function windowPressure(window: UsageWindowView): number {
	const threshold = reserveThreshold(window);
	const used = projectedUsage(window);
	return threshold === 0 ? (used > 0 ? Number.POSITIVE_INFINITY : 0) : used / threshold;
}

export function primaryUsageWindow(account: UsageAccountView): UsageWindowView | undefined {
	let selected: UsageWindowView | undefined;
	let selectedPressure = Number.NEGATIVE_INFINITY;
	for (const window of account.windows) {
		if (!validUsageWindow(window)) continue;
		const pressure = windowPressure(window);
		if (selected === undefined || pressure > selectedPressure) {
			selected = window;
			selectedPressure = pressure;
		}
	}
	return selected;
}

/** Gives one next-step sentence from the most constrained fresh account window. */
export function quotaAdvice(accounts: readonly UsageAccountView[]): string {
	let selected: UsageWindowView | undefined;
	let selectedPressure = Number.NEGATIVE_INFINITY;
	for (const account of accounts) {
		if (account.stale) return "Quota data is stale; refresh before starting a large task.";
		for (const window of account.windows) {
			if (!validUsageWindow(window)) continue;
			const pressure = windowPressure(window);
			if (selected === undefined || pressure > selectedPressure) {
				selected = window;
				selectedPressure = pressure;
			}
		}
	}
	if (!selected) return "Quota window data is unavailable.";
	const threshold = reserveThreshold(selected);
	const remaining = threshold - projectedUsage(selected);
	if (remaining <= 0) return `At the reserve: omp console will switch to Luna at ${fmtPercent(threshold)}.`;
	if (remaining <= 15) return `Near the reserve: omp console will switch to Luna at ${fmtPercent(threshold)}.`;
	return "Large tasks can run now.";
}

export type QuotaHealth = "healthy" | "near-reserve" | "at-reserve" | "limited" | "stale" | "unknown";

export function quotaHealth(quota: QuotaResponse | null): QuotaHealth {
	if (!quota) return "unknown";
	for (const account of quota.accounts) {
		if (account.stale) return "stale";
	}
	for (const provider of quota.providers) {
		if (provider.state === "paused" || provider.state === "rate-limited") return "limited";
	}
	let hasWindow = false;
	let nearReserve = false;
	let atReserve = false;
	for (const account of quota.accounts) {
		for (const window of account.windows) {
			if (!validUsageWindow(window)) continue;
			hasWindow = true;
			const remaining = reserveThreshold(window) - projectedUsage(window);
			if (remaining <= 0) atReserve = true;
			else if (remaining <= 15) nearReserve = true;
		}
	}
	if (atReserve) return "at-reserve";
	if (nearReserve || quota.providers.some(provider => provider.state === "throttled")) return "near-reserve";
	if (hasWindow || quota.providers.some(provider => provider.state === "ok")) return "healthy";
	return "unknown";
}
