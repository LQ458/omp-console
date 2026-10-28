import type { ReactNode } from "react";
import { useState } from "react";
import {
	QUICK_REPLIES_CHANGED_EVENT,
	readQuickReplies,
	writeQuickReplies,
} from "../../lib/quick-replies";

export function QuickRepliesSettings(): ReactNode {
	const [draft, setDraft] = useState(() => readQuickReplies().join("\n"));
	const [message, setMessage] = useState<string | null>(null);
	return (
		<section className="dk-settings-section" aria-label="quick replies">
			<h3 className="dk-section-title">Quick replies</h3>
			<p className="dk-hint">One reply per line. Short replies send immediately; longer replies fill the composer.</p>
			<textarea
				className="sh-input sh-quick-replies-input"
				aria-label="Quick replies, one per line"
				value={draft}
				onChange={event => {
					setDraft(event.target.value);
					setMessage(null);
				}}
			/>
			<button
				type="button"
				className="dk-wide-btn sh-quick-replies-save"
				onClick={() => {
					if (!writeQuickReplies(draft)) {
						setMessage("Quick replies could not be saved in this browser.");
						return;
					}
					window.dispatchEvent(new Event(QUICK_REPLIES_CHANGED_EVENT));
					setMessage("Quick replies saved.");
				}}
			>
				Save quick replies
			</button>
			{message !== null && <span role="status" className="dk-hint">{message}</span>}
		</section>
	);
}
