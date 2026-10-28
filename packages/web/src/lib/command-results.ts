export type CommandResultLevel = "info" | "warning" | "error";

export interface UsageLimitView {
	id: string;
	label: string;
	scope: { accountId?: string; projectId?: string; tier?: string; windowId?: string };
	window?: { id?: string; label?: string; resetsAt?: number; resetLabel?: string };
	amount: {
		used?: number;
		limit?: number;
		remaining?: number;
		usedFraction?: number;
		remainingFraction?: number;
		unit: string;
	};
	status?: "ok" | "warning" | "exhausted" | "unknown";
	notes?: string[];
}

export interface UsageReportView {
	provider: string;
	fetchedAt?: number;
	limits: UsageLimitView[];
	resetCredits?: { availableCount?: number; redeemableCount?: number; eligible?: boolean; cooldownUntil?: string };
	notes?: string[];
	metadata?: { email?: string; accountId?: string; orgId?: string };
}

export interface CommandResult {
	id: number;
	name: string;
	source: string;
	level: CommandResultLevel;
	message: string;
	at: number;
	usageReports?: readonly UsageReportView[];
}

export interface DecodedCommandResultMessage {
	text: string;
	usageReports?: UsageReportView[];
}

const COMMAND_SOURCE_PREFIX = "deck-command:";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

function parseUsageLimit(value: unknown): UsageLimitView | undefined {
	if (!isRecord(value) || !isRecord(value.amount)) return undefined;
	const amount = value.amount;
	const scope = isRecord(value.scope) ? value.scope : {};
	const rawWindow = isRecord(value.window) ? value.window : undefined;
	const rawStatus = text(value.status);
	const status = rawStatus === "ok" || rawStatus === "warning" || rawStatus === "exhausted" || rawStatus === "unknown"
		? rawStatus
		: undefined;
	return {
		id: text(value.id) ?? "",
		label: text(value.label) ?? "Usage",
		scope: {
			accountId: text(scope.accountId),
			projectId: text(scope.projectId),
			tier: text(scope.tier),
			windowId: text(scope.windowId),
		},
		window: rawWindow
			? {
					id: text(rawWindow.id),
					label: text(rawWindow.label),
					resetsAt: number(rawWindow.resetsAt),
					resetLabel: text(rawWindow.resetLabel),
				}
			: undefined,
		amount: {
			used: number(amount.used),
			limit: number(amount.limit),
			remaining: number(amount.remaining),
			usedFraction: number(amount.usedFraction),
			remainingFraction: number(amount.remainingFraction),
			unit: text(amount.unit) ?? "unknown",
		},
		status,
		notes: textList(value.notes),
	};
}

function parseUsageReport(value: unknown): UsageReportView | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || !Array.isArray(value.limits)) return undefined;
	const rawCredits = isRecord(value.resetCredits) ? value.resetCredits : undefined;
	const rawMetadata = isRecord(value.metadata) ? value.metadata : undefined;
	return {
		provider: value.provider,
		fetchedAt: number(value.fetchedAt),
		limits: value.limits.flatMap(limit => {
			const parsed = parseUsageLimit(limit);
			return parsed ? [parsed] : [];
		}),
		resetCredits: rawCredits
			? {
					availableCount: number(rawCredits.availableCount),
					redeemableCount: number(rawCredits.redeemableCount),
					eligible: typeof rawCredits.eligible === "boolean" ? rawCredits.eligible : undefined,
					cooldownUntil: text(rawCredits.cooldownUntil),
				}
			: undefined,
		notes: textList(value.notes),
		metadata: rawMetadata
			? {
					email: text(rawMetadata.email),
					accountId: text(rawMetadata.accountId),
					orgId: text(rawMetadata.orgId),
				}
			: undefined,
	};
}

export function commandNameFromSource(source: string | undefined): string | undefined {
	if (!source?.startsWith(COMMAND_SOURCE_PREFIX)) return undefined;
	const name = source.slice(COMMAND_SOURCE_PREFIX.length);
	return name || undefined;
}

/**
 * Commands this page ran and has not seen the result of. The host broadcasts a command's output to every guest of the
 * session, but the result card belongs to the client that asked: other devices watching the session only get the toast.
 */
const expectedResults = new Map<string, number>();
const EXPECT_RESULT_MS = 120_000;

/** Called just before a command is sent from this page. */
export function expectCommandResult(name: string, now: number = Date.now()): void {
	expectedResults.set(name, now + EXPECT_RESULT_MS);
}

/** True (once) when this page ran `name` within the last two minutes. */
export function takeExpectedCommandResult(name: string, now: number = Date.now()): boolean {
	const until = expectedResults.get(name);
	expectedResults.delete(name);
	return until !== undefined && until >= now;
}

/** Short one-line confirmations stay in the toast; reports, errors, and multiline output become cards. */
export function commandResultNeedsCard(source: string | undefined, level: CommandResultLevel, message: string): boolean {
	const name = commandNameFromSource(source);
	if (name === undefined) return false;
	return level === "error" || name === "usage" || message.length >= 120 || /[\r\n]/.test(message);
}

/** Recognize the Markdown structures emitted by remote built-ins without treating ordinary prose as markup. */
export function isMarkdownCommandOutput(message: string): boolean {
	return (
		/(?:^|\n)\s{0,3}(?:#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s|\|[^\n]*\|)/.test(message) ||
		// `__bold__` only as a whole word: `a_b__d__e.txt` in a path is not emphasis.
		/(?:\*\*[^*\n]+\*\*|(?<![\w/])__[^_\n]+__(?!\w)|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/.test(message)
	);
}

/** The session host uses this envelope only for `/usage`; malformed or unrelated notices remain plain text. */
export function decodeCommandResultMessage(message: string): DecodedCommandResultMessage {
	try {
		const payload: unknown = JSON.parse(message);
		if (!isRecord(payload) || payload.type !== "deck-command-result" || typeof payload.text !== "string") {
			return { text: message };
		}
		const usageReports = Array.isArray(payload.usageReports)
			? payload.usageReports.flatMap(report => {
					const parsed = parseUsageReport(report);
					return parsed ? [parsed] : [];
				})
			: undefined;
		return { text: payload.text, ...(usageReports ? { usageReports } : {}) };
	} catch {
		return { text: message };
	}
}
