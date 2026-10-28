import { Check, ChevronDown, Copy, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { GuestClient } from "../../lib/client";
import {
	isMarkdownCommandOutput,
	type CommandResult,
	type UsageLimitView,
	type UsageReportView,
} from "../../lib/command-results";
import { copyText } from "../catalog/clipboard";
import { Markdown } from "../transcript/Markdown";
import { replaceTabs, stripAnsi } from "../../tool-render/util";
import "../quota/quota.css";
import "./command-results.css";

type DeckClient = Pick<GuestClient, "subscribe" | "getSnapshot" | "dismissCommandResult">;

type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

function validDate(value: number | undefined): Date | undefined {
	if (value === undefined) return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

function countdown(ms: number): string {
	const minutes = Math.max(0, Math.ceil(ms / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const remainder = minutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${remainder}m`;
	return `${remainder}m`;
}

function usedFraction(limit: UsageLimitView): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) return amount.used / amount.limit;
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return 1 - amount.remainingFraction;
	return undefined;
}

function usageStatus(limit: UsageLimitView, fraction: number | undefined): UsageStatus {
	if (limit.status !== undefined) return limit.status;
	if (fraction === undefined) return "unknown";
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.8) return "warning";
	return "ok";
}

function amountText(value: number, unit: string): string {
	const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 1 });
	if (unit === "percent") return `${formatted}%`;
	return unit === "unknown" || unit === "" ? formatted : `${formatted} ${unit}`;
}

/** "37%", "0.4%": one decimal only below 10%, where it still says something. */
function formatPercent(fraction: number): string {
	const value = fraction * 100;
	return `${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function usageSummary(limit: UsageLimitView, fraction: number | undefined): string {
	const amount = limit.amount;
	const summary: string[] = [];
	// A percent-unit limit is fully said by "N% used · M% left"; absolute units also show the amounts.
	const absolute = amount.unit !== "percent";
	if (fraction !== undefined) summary.push(`${formatPercent(fraction)} used`);
	if (absolute && amount.used !== undefined && amount.limit !== undefined) {
		summary.push(`${amountText(amount.used, amount.unit)} of ${amountText(amount.limit, amount.unit)}`);
	} else if (absolute && amount.used !== undefined) {
		summary.push(`${amountText(amount.used, amount.unit)} used`);
	}
	if (absolute && amount.remaining !== undefined) {
		summary.push(`${amountText(amount.remaining, amount.unit)} left`);
	} else if (amount.remainingFraction !== undefined) {
		summary.push(`${formatPercent(amount.remainingFraction)} left`);
	} else if (fraction !== undefined) {
		summary.push(`${formatPercent(Math.max(0, 1 - fraction))} left`);
	}
	return summary.length > 0 ? summary.join(" · ") : "Usage data unavailable";
}

function limitAccount(report: UsageReportView, limit: UsageLimitView): string {
	return report.metadata?.email ?? report.metadata?.accountId ?? limit.scope.accountId ?? limit.scope.projectId ?? "Account";
}

function UsageLimit({ limit, report, now }: { limit: UsageLimitView; report: UsageReportView; now: number }): ReactNode {
	const fraction = usedFraction(limit);
	const status = usageStatus(limit, fraction);
	const percentage = fraction === undefined ? undefined : Math.min(100, Math.max(0, fraction * 100));
	const resetAt = validDate(limit.window?.resetsAt);
	const resetText = resetAt
		? resetAt.getTime() > now
			? `${limit.window?.resetLabel ?? "resets"} in ${countdown(resetAt.getTime() - now)}`
			: "reset time passed"
		: undefined;
	const title = limit.window?.label ?? limit.window?.id ?? limit.scope.windowId;
	return (
		<div className={`cr-usage-limit cr-usage-${status}`} data-status={status}>
			<div className="cr-usage-limit-head">
				<strong>{limit.label || limit.id || "Usage"}</strong>
				{title !== undefined && title !== (limit.label || limit.id) && <span>{title}</span>}
				<span className="cr-usage-account">{limitAccount(report, limit)}</span>
			</div>
			{percentage !== undefined ? (
				<div
					className={`q-meter cr-usage-meter cr-usage-meter-${status}`}
					role="progressbar"
					aria-label={`${report.provider} ${limit.label} usage`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percentage}
					aria-valuetext={usageSummary(limit, fraction)}
				>
					<span className="q-meter-fill cr-usage-meter-fill" style={{ width: `${percentage}%` }} />
				</div>
			) : (
				<div className="cr-usage-meter-empty" aria-label={`${report.provider} ${limit.label} usage unavailable`} />
			)}
			<div className="cr-usage-limit-details">
				<span>{usageSummary(limit, fraction)}</span>
				{resetText && resetAt ? (
					<time dateTime={resetAt.toISOString()} title={resetAt.toLocaleString()}>
						{resetText}
					</time>
				) : null}
			</div>
			{limit.notes?.map((note, index) => <p className="cr-usage-note" key={`${limit.id}:note:${index}`}>{note}</p>)}
		</div>
	);
}

function ResetCredits({ report, now }: { report: UsageReportView; now: number }): ReactNode {
	const credits = report.resetCredits;
	if (!credits) return null;
	const count = credits.availableCount;
	const cooldown = credits.cooldownUntil ? new Date(credits.cooldownUntil) : undefined;
	const cooldownText = cooldown && Number.isFinite(cooldown.getTime())
		? cooldown.getTime() > now
			? `available in ${countdown(cooldown.getTime() - now)}`
			: "cooldown ended"
		: undefined;
	return (
		<div className="cr-reset-credits">
			<span>{count === undefined ? "Saved resets unavailable" : `${count} saved rate-limit ${count === 1 ? "reset" : "resets"}`}</span>
			{credits.redeemableCount !== undefined ? <span>{credits.redeemableCount} redeemable</span> : null}
			{credits.eligible === false ? <span>not eligible</span> : null}
			{cooldownText && cooldown && Number.isFinite(cooldown.getTime()) ? (
				<time dateTime={cooldown.toISOString()} title={cooldown.toLocaleString()}>{cooldownText}</time>
			) : null}
		</div>
	);
}

function UsageReports({ reports, now }: { reports: readonly UsageReportView[]; now: number }): ReactNode {
	return (
		<div className="cr-usage-reports">
			{reports.map((report, index) => (
				<section className="q-account cr-usage-report" key={`${report.provider}:${report.fetchedAt ?? index}:${index}`}>
					<div className="cr-usage-report-head">
						<strong>{report.provider}</strong>
						{report.fetchedAt !== undefined ? <time title={new Date(report.fetchedAt).toLocaleString()}>Updated {new Date(report.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time> : null}
					</div>
					{report.notes?.map((note, noteIndex) => <p className="cr-usage-note" key={`${report.provider}:note:${noteIndex}`}>{note}</p>)}
					{report.limits.length > 0
						? report.limits.map((limit, limitIndex) => <UsageLimit key={`${limit.id}:${limitIndex}`} limit={limit} report={report} now={now} />)
						: <p className="cr-usage-empty">No usage limits reported.</p>}
					<ResetCredits report={report} now={now} />
				</section>
			))}
		</div>
	);
}

function shouldOfferExpand(result: CommandResult): boolean {
	if (result.message.length > 1800 || result.message.split("\n").length > 24) return true;
	return result.usageReports?.some(report => report.limits.length > 6) ?? false;
}

function CommandResultCard({ result, client, now }: { result: CommandResult; client: DeckClient; now: number }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const offerExpand = shouldOfferExpand(result);
	// Escape codes never reach either renderer (and would hide Markdown structure from detection).
	const text = stripAnsi(result.message);
	const markdown = isMarkdownCommandOutput(text);
	const timestamp = new Date(result.at);
	const onCopy = (): void => {
		void copyText(result.message).then(ok => setCopied(ok));
	};
	return (
		<article className={`cr-result-card cr-result-${result.level}`} role={result.level === "error" ? "alert" : "status"}>
			<header className="cr-result-header">
				<div className="cr-result-title">
					<strong>/{result.name}</strong>
					<time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString()}>{timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
				</div>
				<div className="cr-result-actions">
					{offerExpand ? (
						<button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} /${result.name} output`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
							<ChevronDown size={14} aria-hidden />{expanded ? "Collapse" : "Expand"}
						</button>
					) : null}
					<button type="button" aria-label={`Copy /${result.name} output`} title="Copy output" onClick={onCopy}>
						{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
						{copied ? "Copied" : "Copy"}
					</button>
					<button type="button" aria-label={`Dismiss /${result.name} output`} title="Dismiss" onClick={() => client.dismissCommandResult(result.id)}>
						<X size={14} aria-hidden />
					</button>
				</div>
			</header>
			<div className={`cr-result-body${expanded ? " cr-result-body-expanded" : ""}`}>
				{result.usageReports && result.usageReports.length > 0 ? (
					<UsageReports reports={result.usageReports} now={now} />
				) : markdown ? (
					<Markdown text={text} />
				) : (
					<pre className="cr-plain">{replaceTabs(text)}</pre>
				)}
			</div>
		</article>
	);
}

export function CommandResults(props: { client: DeckClient; sessionId?: string }): ReactNode {
	const { client, sessionId } = props;
	const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
	const getSnapshot = useCallback(() => client.getSnapshot().commandResults, [client]);
	const results = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const [, setTick] = useState(0);

	// The interval only re-renders; the clock is read at render. Keeping `now` in state from mount made a /usage result
	// that arrived later count down from the mount time until the first tick (6h 55m for a 5h window).
	useEffect(() => {
		if (!results.some(result => result.usageReports && result.usageReports.length > 0)) return;
		const timer = window.setInterval(() => setTick(tick => tick + 1), 60_000);
		return () => window.clearInterval(timer);
	}, [results]);
	const now = Date.now();

	if (results.length === 0) return null;
	return (
		<section className="cr-command-results" aria-label="Command results" data-session-id={sessionId}>
			{results.map(result => <CommandResultCard key={result.id} result={result} client={client} now={now} />)}
		</section>
	);
}
