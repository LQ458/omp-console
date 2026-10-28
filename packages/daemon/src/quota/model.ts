import type { UsageAccountView, UsageWindowView } from "@omp-console/protocol";

export const QUOTA_STALE_AFTER_MS = 10 * 60_000;
export const RESERVE_FULL_PCT = 10;
export const RESERVE_FLOOR_PCT = 2;
export const RESERVE_DECAY_MS = 20 * 60_000;

interface UsageWindowSnapshot {
	view: UsageWindowView;
	fetchedAt: number;
}

export interface UsageAccountSnapshot {
	/** Internal identity; never serialize this value to the API or quota log. */
	key: string;
	view: UsageAccountView;
	windowFetchedAt: ReadonlyMap<string, number>;
}

interface UsageReport {
	provider: string;
	fetchedAt: number;
	limits: unknown[];
	metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function reportsFrom(rawReports: readonly unknown[]): UsageReport[] {
	const reports: UsageReport[] = [];
	for (const raw of rawReports) {
		if (!isRecord(raw) || !finite(raw.fetchedAt) || raw.fetchedAt < 0 || !Array.isArray(raw.limits)) {
			continue;
		}
		const provider = text(raw.provider);
		if (!provider) continue;
		reports.push({
			provider,
			fetchedAt: raw.fetchedAt,
			limits: raw.limits,
			...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
		});
	}
	return reports;
}

function accountIdentity(report: UsageReport, index: number): { key: string; label: string } {
	const metadata = report.metadata;
	const firstLimit = report.limits.find(isRecord);
	const scope = firstLimit && isRecord(firstLimit.scope) ? firstLimit.scope : undefined;
	const identity =
		text(metadata?.accountId) ??
		text(metadata?.email) ??
		text(metadata?.username) ??
		text(metadata?.user) ??
		text(metadata?.account) ??
		text(metadata?.orgId) ??
		text(scope?.accountId);
	const label =
		text(metadata?.email) ??
		text(metadata?.account) ??
		text(metadata?.username) ??
		text(metadata?.user) ??
		text(metadata?.orgName) ??
		`Account ${index + 1}`;
	return { key: `${report.provider}:${identity ?? `unidentified-${index}`}`, label };
}

function usedPct(amount: Record<string, unknown>): number | undefined {
	const usedFraction = amount.usedFraction;
	if (finite(usedFraction)) return usedFraction * 100;
	const used = amount.used;
	const limit = amount.limit;
	if (finite(used) && finite(limit) && limit > 0) return (used / limit) * 100;
	if (amount.unit === "percent" && finite(used)) return used;
	const remainingFraction = amount.remainingFraction;
	if (finite(remainingFraction)) return (1 - remainingFraction) * 100;
	return undefined;
}

function parseWindow(raw: unknown, fetchedAt: number): UsageWindowSnapshot | undefined {
	if (!isRecord(raw) || !isRecord(raw.amount)) return undefined;
	const used = usedPct(raw.amount);
	if (!finite(used)) return undefined;
	const scope = isRecord(raw.scope) ? raw.scope : undefined;
	const window = isRecord(raw.window) ? raw.window : undefined;
	const baseId = text(window?.id) ?? text(scope?.windowId) ?? text(raw.id);
	if (!baseId) return undefined;
	const modelId = text(scope?.modelId);
	const id = modelId ? `${baseId}:${modelId}` : baseId;
	const resetsAt = finite(window?.resetsAt) && window.resetsAt >= 0 ? window.resetsAt : undefined;
	return {
		view: { id, usedPct: used, ...(resetsAt === undefined ? {} : { resetsAt }), reservePct: RESERVE_FULL_PCT },
		fetchedAt,
	};
}

/** Parse raw omp UsageReports into display-safe account views, merging duplicate account reports. */
export function parseUsageReports(rawReports: readonly unknown[], wallNow: number): UsageAccountSnapshot[] {
	const reports = reportsFrom(rawReports);
	const groups = new Map<string, { label: string; provider: string; fetchedAt: number; windows: Map<string, UsageWindowSnapshot> }>();
	for (let index = 0; index < reports.length; index++) {
		const report = reports[index]!;
		const identity = accountIdentity(report, index);
		let group = groups.get(identity.key);
		if (!group) {
			group = { label: identity.label, provider: report.provider, fetchedAt: report.fetchedAt, windows: new Map() };
			groups.set(identity.key, group);
		}
		group.fetchedAt = Math.max(group.fetchedAt, report.fetchedAt);
		for (const rawLimit of report.limits) {
			const parsed = parseWindow(rawLimit, report.fetchedAt);
			if (!parsed) continue;
			const prior = group.windows.get(parsed.view.id);
			if (!prior || parsed.fetchedAt >= prior.fetchedAt) group.windows.set(parsed.view.id, parsed);
		}
	}
	const usedLabels = new Set<string>();
	return [...groups.entries()]
		.sort(([leftKey, left], [rightKey, right]) => left.provider.localeCompare(right.provider) || leftKey.localeCompare(rightKey))
		.map(([key, group]) => {
			let account = group.label;
			for (let suffix = 2; usedLabels.has(`${group.provider}\u0000${account}`); suffix++) {
				account = `${group.label} (${suffix})`;
			}
			usedLabels.add(`${group.provider}\u0000${account}`);
			return {
				key,
				view: {
					provider: group.provider,
					account,
					windows: [...group.windows.values()].map(snapshot => snapshot.view).sort((a, b) => a.id.localeCompare(b.id)),
					fetchedAt: group.fetchedAt,
					stale: wallNow - group.fetchedAt > QUOTA_STALE_AFTER_MS,
				},
				windowFetchedAt: new Map([...group.windows].map(([id, snapshot]) => [id, snapshot.fetchedAt])),
			};
		});
}

export function accountHeadroom(account: UsageAccountView): number | null {
	if (account.windows.length === 0) return null;
	return Math.min(...account.windows.map(window => 100 - window.usedPct));
}

/** Omp rotates accounts; the provider has the headroom of its least-used available account. */
export function providerHeadroom(accounts: readonly UsageAccountView[]): number | null {
	const available = accounts.filter(account => !account.stale).map(accountHeadroom).filter((value): value is number => value !== null);
	return available.length > 0 ? Math.max(...available) : null;
}

export function reservePct(resetsAt: number | undefined, wallNow: number): number {
	if (resetsAt === undefined) return RESERVE_FULL_PCT;
	const timeToReset = Math.max(0, resetsAt - wallNow);
	if (timeToReset >= RESERVE_DECAY_MS) return RESERVE_FULL_PCT;
	return RESERVE_FLOOR_PCT + ((RESERVE_FULL_PCT - RESERVE_FLOOR_PCT) * timeToReset) / RESERVE_DECAY_MS;
}

export function projectUsedPct(usedPct: number, burnPctPerMin: number, resetsAt: number | undefined, wallNow: number): number | undefined {
	if (resetsAt === undefined) return undefined;
	const minutes = Math.max(0, resetsAt - wallNow) / 60_000;
	return usedPct + burnPctPerMin * minutes;
}

export function withProjections(
	accounts: readonly UsageAccountView[],
	burnRates: ReadonlyMap<string, { pctPerMin: number; samples: number }>,
	wallNow: number,
): UsageAccountView[] {
	return accounts.map(account => ({
		...account,
		windows: account.windows.map(window => {
			const rate = burnRates.get(`${account.provider}\u0000${account.account}\u0000${window.id}`);
			const projected = rate && rate.samples >= 3
				? projectUsedPct(window.usedPct, rate.pctPerMin, window.resetsAt, wallNow)
				: undefined;
			return {
				...window,
				reservePct: reservePct(window.resetsAt, wallNow),
				...(projected === undefined ? {} : { projectedPct: projected }),
			};
		}),
	}));
}
