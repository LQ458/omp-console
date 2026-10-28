import type { RewindPoint } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { ActionFeedbackMark, ActionFeedbackMessage } from "../shell/ActionFeedback";
import { useActionFeedback } from "../../lib/action-feedback";
import { Sheet } from "../shell/Sheet";
import "./rewind.css";

/** What a finished rewind did, so the composer can mirror it. */
export type RewindOutcome =
	/** Back to just before a user message: it and everything after it left the branch; `text` goes back to the composer. */
	| { kind: "user"; entryId: string; text: string }
	/** Back to an agent answer: `keptThrough` (the answer, or the last result of its tool calls) is the new last entry. */
	| { kind: "agent"; keptThrough: string };

export interface RewindSheetProps {
	api: Pick<DeckApi, "sessionOpV3">;
	sessionId: string;
	open: boolean;
	onClose(): void;
	onRewind(outcome: RewindOutcome): void;
}

const REWIND_SUCCESS_MS = 700;
export function RewindSheet({ api, sessionId, open, onClose, onRewind }: RewindSheetProps): ReactNode {
	const [points, setPoints] = useState<RewindPoint[]>([]);
	const [loading, setLoading] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [feedbackTargetId, setFeedbackTargetId] = useState<string | null>(null);
	const [closeRequested, setCloseRequested] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const actionFeedback = useActionFeedback();
	const closeTimer = useRef<number | null>(null);

	useEffect(() => {
		if (!open) return;
		setCloseRequested(false);
		let live = true;
		setPoints([]);
		setError(null);
		setLoading(true);
		void api.sessionOpV3(sessionId, { op: "rewind-points" }).then(
			result => {
				if (!live) return;
				if ("points" in result) setPoints(result.points);
				else setError("The session did not return rewind points.");
			},
			cause => {
				if (live) setError(cause instanceof Error ? cause.message : "Could not load rewind points.");
			},
		).finally(() => {
			if (live) setLoading(false);
		});
		return () => {
			live = false;
			if (closeTimer.current !== null) {
				window.clearTimeout(closeTimer.current);
				closeTimer.current = null;
			}
		};
	}, [api, open, sessionId]);

	const rewind = async (point: RewindPoint): Promise<void> => {
		if (busyId !== null || closeRequested || actionFeedback.state === "success" || !actionFeedback.begin()) return;
		setFeedbackTargetId(point.entryId);
		setBusyId(point.entryId);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "rewind", entryId: point.entryId });
			if (!("text" in result)) throw new Error("The session did not return the selected message.");
			onRewind(
				result.keptThrough !== undefined
					? { kind: "agent", keptThrough: result.keptThrough }
					: { kind: "user", entryId: point.entryId, text: result.text },
			);
			actionFeedback.succeed();
			closeTimer.current = window.setTimeout(() => {
				closeTimer.current = null;
				setCloseRequested(true);
			}, REWIND_SUCCESS_MS);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not rewind the session.");
			actionFeedback.fail(cause);
		} finally {
			setBusyId(null);
		}
	};

	const close = (): void => {
		if (closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		setCloseRequested(false);
		actionFeedback.reset();
		setFeedbackTargetId(null);
		onClose();
	};

	if (!open) return null;
	return (
		<Sheet title="Rewind to a message" windowKind="rewind" onClose={close} closeRequested={closeRequested}>
			<p className="dk-hint rw-help">
				A <strong>you</strong> message goes back to just before it and puts its text in the composer to edit. An <strong>agent</strong> answer stays; everything after it is dropped.
			</p>
			{error !== null && actionFeedback.state !== "failure" && <p className="rw-error" role="alert">{error}</p>}
			{!loading && points.length === 0 && error === null && <p className="dk-hint">No earlier messages on this branch.</p>}
			<ul className="rw-points">
				{points.map(point => (
					<li key={point.entryId}>
						<button
							type="button"
							className="rw-point"
							data-kind={point.kind}
							disabled={busyId !== null || closeRequested || actionFeedback.state === "success"}
							onClick={() => void rewind(point)}
							aria-label={`${point.kind === "agent" ? "Keep agent answer" : "Edit your message"}: ${point.preview}`}
						>
							<span className="rw-kind">{point.kind === "agent" ? "agent" : "you"}</span>
							<ActionFeedbackMark state={feedbackTargetId === point.entryId ? actionFeedback.state : "idle"} />
							<span className="rw-preview">{point.preview}</span>
							<time className="rw-time" dateTime={new Date(point.at).toISOString()}>{new Date(point.at).toLocaleString()}</time>
						</button>
					</li>
				))}
			</ul>
			{actionFeedback.state !== "idle" && (
				<ActionFeedbackMessage
					state={actionFeedback.state}
					error={actionFeedback.error}
					pendingLabel="Rewinding…"
					successLabel="Rewound"
				/>
			)}
		</Sheet>
	);
}
