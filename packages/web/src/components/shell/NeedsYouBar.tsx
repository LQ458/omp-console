import { CircleHelp, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { NeedsYouItem } from "../../lib/needs-you";
import { InlineUiRequest, type UiRequestTarget } from "./InlineUiRequest";

export interface NeedsYouBarProps {
	items: readonly NeedsYouItem[];
	/** Opens the session; its ask form is then one tap from an answer. */
	onOpen(sessionId: string): void;
	touch?: boolean;
	uiTargetForSession?(sessionId: string): UiRequestTarget | null;
	refreshKey?: unknown;
}

const MAX_ROWS = 3;

/** Waiting sessions remain openable while simple select answers are available inline on touch. */
export function NeedsYouBar({ items, onOpen, touch = false, uiTargetForSession, refreshKey }: NeedsYouBarProps): ReactNode {
	if (items.length === 0) return null;
	const shown = items.slice(0, MAX_ROWS);
	const hidden = items.length - shown.length;
	return (
		<div className="dk-needs" role="region" aria-label="needs you">
			{shown.map(item => {
				const target = touch && item.kind === "ask" ? uiTargetForSession?.(item.sessionId) : null;
				return (
					<div className="dk-needs-item" key={item.sessionId}>
						<button
							type="button"
							className="dk-needs-row"
							data-kind={item.kind}
							onClick={() => onOpen(item.sessionId)}
						>
							{item.kind === "approval" ? <ShieldAlert size={18} /> : <CircleHelp size={18} />}
							<span className="dk-needs-copy">
								<span className="dk-needs-title">{item.title}</span>
								<span className="dk-needs-sub">
									{item.question || (item.kind === "approval" ? "Needs your approval" : "Needs your answer")}
								</span>
							</span>
							<span className="dk-needs-go">{item.kind === "approval" ? "Review" : "Answer"}</span>
						</button>
						{target !== null && target !== undefined && (
							<InlineUiRequest {...target} refreshKey={refreshKey} onOpen={() => onOpen(item.sessionId)} />
						)}
					</div>
				);
			})}
			{hidden > 0 && <div className="dk-needs-more">+{hidden} more waiting</div>}
		</div>
	);
}
