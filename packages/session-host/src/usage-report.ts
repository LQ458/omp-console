/**
 * `usage`: omp's `AgentSession.fetchUsageReports()` passed through as JSON, minus anything that could carry a
 * credential. omp's `UsageReport` keeps the provider's raw response (`raw`) and free-form `metadata` (endpoint URLs,
 * identity fields, whatever a provider adapter added), and credit entries carry opaque grant ids; none of that is
 * needed to show a quota meter. The projection below is an allow-list: only provider, window ids, amounts, resets,
 * statuses and account display labels survive, and every surviving string that looks like a secret is replaced.
 */
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";

const REDACTED = "[redacted]";
/** Metadata keys that are account display labels, not secrets. */
const METADATA_LABEL_KEYS = ["email", "accountId", "orgId", "source", "plan", "tier"] as const;
const MAX_STRING = 200;

/** Token-shaped strings: provider key prefixes, JWTs, bearer headers, long unbroken base64/hex runs. */
const SECRET_PATTERNS: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{8,}/,
	/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{8,}/,
	/\bAIza[0-9A-Za-z_-]{20,}/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
	/\bBearer\s+\S{8,}/i,
	/[?&](?:access_token|api[_-]?key|token|key|secret|signature|sig)=/i,
	/\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/,
];

/** True when `value` is a string that could be a credential. */
export function looksLikeSecret(value: string): boolean {
	return SECRET_PATTERNS.some(pattern => pattern.test(value));
}

function safeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (looksLikeSecret(value)) return REDACTED;
	return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value;
}

function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defined<T extends Record<string, unknown>>(record: T): T {
	for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
	return record;
}

function sanitizeLimit(limit: UsageLimit): Record<string, unknown> {
	const { scope, window, amount } = limit;
	return defined({
		id: safeString(limit.id),
		label: safeString(limit.label),
		scope: defined({
			provider: safeString(scope.provider),
			accountId: safeString(scope.accountId),
			orgId: safeString(scope.orgId),
			projectId: safeString(scope.projectId),
			modelId: safeString(scope.modelId),
			tier: safeString(scope.tier),
			windowId: safeString(scope.windowId),
			shared: typeof scope.shared === "boolean" ? scope.shared : undefined,
			sharedGroup: safeString(scope.sharedGroup),
		}),
		window: window
			? defined({
					id: safeString(window.id),
					label: safeString(window.label),
					durationMs: safeNumber(window.durationMs),
					resetsAt: safeNumber(window.resetsAt),
					resetLabel: safeString(window.resetLabel),
				})
			: undefined,
		amount: defined({
			used: safeNumber(amount.used),
			limit: safeNumber(amount.limit),
			remaining: safeNumber(amount.remaining),
			usedFraction: safeNumber(amount.usedFraction),
			remainingFraction: safeNumber(amount.remainingFraction),
			unit: safeString(amount.unit),
		}),
		status: safeString(limit.status),
		notes: limit.notes?.map(note => safeString(note) ?? REDACTED),
	});
}

function sanitizeMetadata(metadata: UsageReport["metadata"]): Record<string, unknown> | undefined {
	if (!metadata) return undefined;
	const kept: Record<string, unknown> = {};
	for (const key of METADATA_LABEL_KEYS) {
		const value = safeString(metadata[key]);
		if (value !== undefined) kept[key] = value;
	}
	return Object.keys(kept).length > 0 ? kept : undefined;
}

/** One report reduced to the allow-listed fields. Reports whose provider is not a string are dropped by the caller. */
export function sanitizeUsageReport(report: UsageReport): Record<string, unknown> {
	const credits = report.resetCredits;
	return defined({
		provider: safeString(report.provider),
		fetchedAt: safeNumber(report.fetchedAt),
		limits: report.limits.map(sanitizeLimit),
		resetCredits: credits
			? defined({
					availableCount: safeNumber(credits.availableCount),
					redeemableCount: safeNumber(credits.redeemableCount),
					eligible: typeof credits.eligible === "boolean" ? credits.eligible : undefined,
					cooldownUntil: safeString(credits.cooldownUntil),
				})
			: undefined,
		notes: report.notes?.map(note => safeString(note) ?? REDACTED),
		metadata: sanitizeMetadata(report.metadata),
	});
}

/** `fetchUsageReports()` result (null when the auth store has no usage support) as credential-free JSON. */
export function sanitizeUsageReports(reports: readonly UsageReport[] | null): unknown[] {
	return (reports ?? []).filter(report => typeof report.provider === "string").map(sanitizeUsageReport);
}
