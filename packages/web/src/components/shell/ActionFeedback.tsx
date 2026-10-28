import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { ActionFeedbackState } from "../../lib/action-feedback";
import "./action-feedback.css";

export function ActionFeedbackMark({ state }: { state: ActionFeedbackState }): ReactNode {
	if (state === "idle") return null;
	return (
		<span className={`dk-action-mark dk-action-mark-${state}`} aria-hidden="true">
			{state === "pending" ? <LoaderCircle size={13} /> : state === "success" ? <Check size={13} /> : <TriangleAlert size={13} />}
		</span>
	);
}

export function ActionFeedbackMessage({
	state,
	error,
	pendingLabel = "Working…",
	successLabel = "Done",
}: {
	state: ActionFeedbackState;
	error: string | null;
	pendingLabel?: string;
	successLabel?: string;
}): ReactNode {
	if (state === "idle") return null;
	if (state === "failure") return <span className="dk-action-message dk-action-message-failure" role="alert">{error ?? "Action failed."}</span>;
	return (
		<span className={`dk-action-message dk-action-message-${state}`} role="status">
			<ActionFeedbackMark state={state} />
			{state === "pending" ? pendingLabel : successLabel}
		</span>
	);
}
