import { limitPhoneSuggestions } from "../../lib/phone-actions";
import { quickReplyDisposition, QUICK_REPLIES_CHANGED_EVENT, readQuickReplies } from "../../lib/quick-replies";
import { PenLine } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import "./quick-replies.css";

export type QuickReplyStatus = "idle" | "loading" | "ready" | "error";

export interface QuickReplyButtonsProps {
	fixed: readonly string[];
	generated: readonly string[];
	tileLayout?: boolean;
	onSend(reply: string): void;
	onEdit(reply: string): void;
}

export function QuickReplyButtons({ fixed, generated, tileLayout = false, onSend, onEdit }: QuickReplyButtonsProps): ReactNode {
	const shownFixed = tileLayout ? [] : fixed;
	const shownGenerated = tileLayout ? limitPhoneSuggestions(generated) : generated.slice(0, 2);
	if (shownFixed.length === 0 && shownGenerated.length === 0) return null;
	const activate = (reply: string, isGenerated: boolean): void => {
		if (quickReplyDisposition(reply, isGenerated, tileLayout) === "send") onSend(reply);
		else onEdit(reply);
	};
	const buttonContents = (reply: string): ReactNode => <span title={tileLayout ? reply : undefined}>{reply}</span>;
	return (
		<div className="tr-quick-replies" role="group" aria-label={tileLayout ? "AI suggestions" : "Quick replies"}>
			{shownFixed.map((reply, index) => (
				<button key={`fixed-${index}-${reply}`} type="button" className="tr-quick-reply" onClick={() => activate(reply, false)}>
					{buttonContents(reply)}
				</button>
			))}
			{shownGenerated.map((reply, index) =>
				tileLayout ? (
					<div key={`generated-${index}-${reply}`} className="tr-quick-reply-card">
						<button type="button" className="tr-quick-reply tr-quick-reply-generated" onClick={() => activate(reply, true)}>
							{buttonContents(reply)}
						</button>
						<button
							type="button"
							className="tr-quick-reply-edit"
							aria-label={`Edit suggestion: ${reply}`}
							title="Edit in composer"
							onClick={() => onEdit(reply)}
						>
							<PenLine size={15} aria-hidden="true" />
						</button>
					</div>
				) : (
					<button key={`generated-${index}-${reply}`} type="button" className="tr-quick-reply tr-quick-reply-generated" onClick={() => activate(reply, true)}>
						{buttonContents(reply)}
					</button>
				),
			)}
		</div>
	);
}

export interface QuickRepliesProps {
	generated: readonly string[];
	tileLayout?: boolean;
	onSend(reply: string): void;
	onEdit(reply: string): void;
}

export function QuickReplies({ generated, tileLayout = false, onSend, onEdit }: QuickRepliesProps): ReactNode {
	const [fixed, setFixed] = useState(readQuickReplies);

	useEffect(() => {
		const refresh = (): void => setFixed(readQuickReplies());
		window.addEventListener("storage", refresh);
		window.addEventListener(QUICK_REPLIES_CHANGED_EVENT, refresh);
		return () => {
			window.removeEventListener("storage", refresh);
			window.removeEventListener(QUICK_REPLIES_CHANGED_EVENT, refresh);
		};
	}, []);

	return <QuickReplyButtons fixed={fixed} generated={generated} tileLayout={tileLayout} onSend={onSend} onEdit={onEdit} />;
}

export { latestAgentAnswerEntryId } from "../../lib/quick-replies";
