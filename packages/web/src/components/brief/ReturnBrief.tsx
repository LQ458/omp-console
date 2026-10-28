import type { BriefLine, ReturnBrief as ReturnBriefData } from "@omp-console/protocol";
import { Check, CircleHelp, Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { browserStorage } from "../../lib/storage";
import { relTime } from "../../lib/format";
import { briefGroups, emptyBriefText, orderedBriefLines, remainingBriefCount, visibleBriefLines } from "./brief-model";
import { markHomeSeen, readHomeSeen } from "./brief-storage";
import "./brief.css";

export interface ReturnBriefProps {
	api: Pick<DeckApi, "brief">;
	canOpenSession(sessionId: string, line?: BriefLine): boolean;
	/** `line` lets the caller resume a session that is in neither its live nor its recent list. */
	onOpenSession(sessionId: string, line?: BriefLine): void;
	/** Sidebar form: at most three rows total. */
	compact?: boolean;
	/** Records a local seen cursor while the home screen is visible. */
	homeVisible?: boolean;
}

const GROUP_LIMIT = 5;
const COMPACT_LIMIT = 3;
const HOME_SEEN_AFTER_MS = 30_000;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "The request failed.";
}

export function ReturnBrief({
	api,
	canOpenSession,
	onOpenSession,
	compact = false,
	homeVisible = false,
}: ReturnBriefProps): ReactNode {
	const [brief, setBrief] = useState<ReturnBriefData | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [request, setRequest] = useState(0);
	const [showAll, setShowAll] = useState(false);
	const [expandedGroups, setExpandedGroups] = useState<Partial<Record<BriefLine["kind"], boolean>>>({});

	useEffect(() => {
		const controller = new AbortController();
		const since = readHomeSeen(browserStorage(), window.location.origin);
		void api
			.brief(controller.signal, since)
			.then(result => {
				setBrief(result);
				setDismissed(false);
				setError(null);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(errorText(reason));
			});
		return () => controller.abort();
	}, [api, request]);

	useEffect(() => {
		if (!homeVisible) return;
		const storage = browserStorage();
		const origin = window.location.origin;
		let elapsed = 0;
		let visibleSince: number | undefined;
		let timer: number | undefined;
		let marked = false;

		const pause = (): void => {
			if (visibleSince === undefined) return;
			elapsed += Date.now() - visibleSince;
			visibleSince = undefined;
			if (timer !== undefined) window.clearTimeout(timer);
			timer = undefined;
		};
		const markSeen = (): void => {
			if (marked) return;
			pause();
			marked = true;
			markHomeSeen(storage, origin, Date.now());
		};
		const resume = (): void => {
			if (marked || visibleSince !== undefined) return;
			visibleSince = Date.now();
			timer = window.setTimeout(markSeen, Math.max(0, HOME_SEEN_AFTER_MS - elapsed));
		};
		const visibilityChanged = (): void => {
			if (document.visibilityState === "visible") resume();
			else pause();
		};

		if (document.visibilityState === "visible") resume();
		document.addEventListener("visibilitychange", visibilityChanged);
		return () => {
			pause();
			document.removeEventListener("visibilitychange", visibilityChanged);
			markHomeSeen(storage, origin, Date.now());
		};
	}, [homeVisible]);

	if (dismissed) return null;
	if (error !== null) {
		return (
			<section className="dk-brief dk-brief-error dk-content-enter" aria-label="Return brief">
				<p role="alert">Could not load your return brief: {error}</p>
				<button type="button" className="sh-btn" onClick={() => setRequest(value => value + 1)}>Retry</button>
			</section>
		);
	}
	if (brief === null) {
		if (compact) return null;
		return (
			<section className="dk-brief dk-brief-skeleton dk-content-enter" role="status" aria-label="Loading return brief" aria-busy="true">
				<strong>While you were away</strong>
				<div className="dk-brief-skeleton-lines" aria-hidden="true">
					<span className="dk-skeleton" />
					<span className="dk-skeleton" />
				</div>
			</section>
		);
	}
	if (compact && brief.lines.length === 0) return null;

	const dismiss = (): void => {
		markHomeSeen(browserStorage(), window.location.origin, Date.now());
		setDismissed(true);
	};
	const groups = briefGroups(brief.lines);
	const compactLines = orderedBriefLines(brief.lines);

	return (
		<section className="dk-brief dk-content-enter" aria-label="Return brief">
			<header className="dk-brief-head">
				<strong>While you were away</strong>
				<button type="button" className="sh-btn" onClick={dismiss}>Mark all seen</button>
			</header>
			{compact ? (
				<>
					<ul className="dk-brief-lines is-compact">
						{visibleBriefLines(compactLines, showAll, COMPACT_LIMIT).map(line => (
							<BriefLineRow
								key={line.sessionId}
								line={line}
								canOpen={canOpenSession(line.sessionId, line)}
								onOpen={() => onOpenSession(line.sessionId, line)}
							/>
						))}
					</ul>
					{remainingBriefCount(compactLines, showAll, COMPACT_LIMIT) > 0 && (
						<button type="button" className="dk-brief-more" onClick={() => setShowAll(true)}>
							{remainingBriefCount(compactLines, showAll, COMPACT_LIMIT)} more
						</button>
					)}
				</>
			) : brief.lines.length === 0 ? (
				<p className="dk-brief-empty" role="status">{emptyBriefText(brief.since)}</p>
			) : (
				<div className="dk-brief-groups">
					{groups.map(group => {
						const expanded = expandedGroups[group.kind] ?? false;
						const more = remainingBriefCount(group.lines, expanded, GROUP_LIMIT);
						return (
							<div className="dk-brief-group" key={group.kind}>
								<h2>{group.heading}</h2>
								<ul className="dk-brief-lines">
									{visibleBriefLines(group.lines, expanded, GROUP_LIMIT).map(line => (
										<BriefLineRow
											key={line.sessionId}
											line={line}
											canOpen={canOpenSession(line.sessionId, line)}
											onOpen={() => onOpenSession(line.sessionId, line)}
										/>
									))}
								</ul>
								{more > 0 && (
									<button
										type="button"
										className="dk-brief-more"
										onClick={() => setExpandedGroups(current => ({ ...current, [group.kind]: true }))}
									>
										{more} more
									</button>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

function BriefLineRow({ line, canOpen, onOpen }: { line: BriefLine; canOpen: boolean; onOpen(): void }): ReactNode {
	const Icon = line.kind === "needs-you" ? CircleHelp : line.kind === "finished" ? Check : Clock3;
	return (
		<li>
			<button type="button" disabled={!canOpen} onClick={onOpen} title={`${line.title}: ${line.text}`}>
				<Icon size={13} aria-hidden="true" />
				<span className="dk-brief-line-content">
					<strong>{line.title}</strong>
					<span className="dk-brief-line-text">{line.text}</span>
				</span>
				<time className="dk-brief-time">{relTime(line.changedAt)}</time>
			</button>
		</li>
	);
}
