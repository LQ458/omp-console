import { MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { FEEDBACK_MAX_CHARS, feedbackApi, submitFeedback } from "../../lib/feedback";
import { recordUsage } from "../../lib/journal";
import "./catalog.css";

export interface FeedbackButtonProps {
	/** Panel the button sits on, stored with the entry (`catalog`, `agents`, ...). */
	screen: string;
	/** Spec id or feature key the feedback is about, when the panel has one. */
	feature?: string;
	/** Defaults to the API bound by the shell (`bindFeedback`). */
	api?: Pick<DeckApi, "recordFeedback">;
}

type Phase = "closed" | "editing" | "sending" | "sent";

/** "This was confusing / I wanted X": one tap from any panel, stored with the screen and feature it refers to (0.6). */
export function FeedbackButton({ screen, feature, api }: FeedbackButtonProps): ReactNode {
	const [phase, setPhase] = useState<Phase>("closed");
	const [text, setText] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const areaRef = useRef<HTMLTextAreaElement | null>(null);
	const resolved = api ?? feedbackApi();

	useEffect(() => {
		if (phase === "editing") areaRef.current?.focus();
		if (phase !== "sent") return;
		const timer = window.setTimeout(() => setPhase("closed"), 2000);
		return () => window.clearTimeout(timer);
	}, [phase]);

	if (resolved === null) return null;

	const open = (): void => {
		recordUsage({ feature: "0.6.feedback", action: "open", outcome: "ok", via: "direct", screen, detail: feature });
		setError(undefined);
		setPhase("editing");
	};

	const cancel = (): void => {
		recordUsage({ feature: "0.6.feedback", action: "cancel", outcome: "abandoned", via: "direct", screen, detail: feature });
		setText("");
		setPhase("closed");
	};

	const send = async (): Promise<void> => {
		setPhase("sending");
		try {
			const sent = await submitFeedback(resolved, { screen, feature, text });
			if (!sent) {
				setPhase("editing");
				return;
			}
			setText("");
			setPhase("sent");
		} catch (err) {
			setError(err instanceof Error ? err.message : "could not save feedback");
			setPhase("editing");
		}
	};

	if (phase === "closed") {
		return (
			<button type="button" className="ct-feedback-btn" onClick={open} title="tell the app maker what was confusing or missing">
				<MessageSquareText size={13} /> Feedback
			</button>
		);
	}
	if (phase === "sent") return <span className="ct-feedback-done">Saved locally. Thanks.</span>;

	return (
		<form
			className="ct-feedback"
			onSubmit={event => {
				event.preventDefault();
				void send();
			}}
		>
			<label className="ct-feedback-label" htmlFor="ct-feedback-text">
				What was confusing, or what did you want here?
			</label>
			<textarea
				id="ct-feedback-text"
				ref={areaRef}
				className="ct-feedback-area"
				value={text}
				maxLength={FEEDBACK_MAX_CHARS}
				rows={3}
				onChange={event => setText(event.target.value)}
				disabled={phase === "sending"}
			/>
			{error !== undefined && (
				<p className="ct-error" role="alert">
					{error}
				</p>
			)}
			<div className="ct-feedback-actions">
				<button type="button" className="sh-btn" onClick={cancel} disabled={phase === "sending"}>
					Cancel
				</button>
				<button type="submit" className="sh-btn sh-btn-primary" disabled={phase === "sending" || text.trim() === ""}>
					Send
				</button>
			</div>
		</form>
	);
}
