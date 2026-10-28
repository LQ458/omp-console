import type { PendingUiRequest } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { DeckApiError, type DeckApi } from "../../lib/api";
import "./inline-ui-request.css";
import { ActionFeedbackMark, ActionFeedbackMessage } from "./ActionFeedback";

export interface UiRequestTarget {
	api: Pick<DeckApi, "sessionOpV3">;
	sessionId: string;
}

export interface InlineUiRequestProps extends UiRequestTarget {
	/** Changes with the daemon's existing session-list poll. */
	refreshKey: unknown;
	onOpen(): void;
}

interface PendingUiRequestViewProps {
	request: PendingUiRequest;
	error: string | null;
	sent: boolean;
	pending: boolean;
	disabled: boolean;
	successFeedback?: boolean;
	onAnswer(value: string): void;
	onOpen(): void;
}

export function PendingUiRequestView({
	request,
	error,
	sent,
	pending,
	disabled,
	successFeedback = true,
	onAnswer,
	onOpen,
}: PendingUiRequestViewProps): ReactNode {
	if (sent) {
		return <span className="ui-request-sent" role="status"><ActionFeedbackMark state={successFeedback ? "success" : "idle"} />Sent</span>;
	}
	const simpleSelect = request.kind === "select" && request.markableCount === undefined && request.checkedIndices === undefined && (request.options?.length ?? 0) > 0;
	return (
		<div className="ui-request-inline" role="group" aria-label="Answer choices">
			{error !== null && <span className="ui-request-error" role="alert"><ActionFeedbackMark state="failure" />{error}</span>}
			{simpleSelect ? (
				<>
					{request.options!.slice(0, 3).map((option, index) => (
						<button
							key={`${request.reqId}-${index}`}
							type="button"
							className={index === request.initialIndex ? "ui-request-choice ui-request-choice-recommended" : "ui-request-choice"}
							aria-label={index === request.initialIndex ? `${option.label}, recommended` : option.label}
							data-recommended={index === request.initialIndex ? "true" : undefined}
							disabled={disabled}
							onClick={() => onAnswer(option.label)}
						>
							{option.label}
							{index === request.initialIndex && <span className="ui-request-recommended-label">Recommended</span>}
						</button>
					))}
					{request.options!.length > 3 && (
						<button type="button" className="ui-request-open" onClick={onOpen}>
							More…
						</button>
					)}
				</>
			) : (
				<button type="button" className="ui-request-open" onClick={onOpen}>
					Open to answer
				</button>
			)}
			<ActionFeedbackMessage state={pending ? "pending" : "idle"} error={null} pendingLabel="Sending answer…" />
		</div>
	);
}

function unsupported(error: unknown): boolean {
	return error instanceof DeckApiError && error.kind === "bad-request";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Could not load answer choices.";
}

/** Fetches an open host request on the existing session-list poll, then answers it without joining that room. */
export function InlineUiRequest({ api, sessionId, refreshKey, onOpen }: InlineUiRequestProps): ReactNode {
	const [request, setRequest] = useState<PendingUiRequest | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sentReqId, setSentReqId] = useState<string | null>(null);
	const [answeringReqId, setAnsweringReqId] = useState<string | null>(null);
	const [unsupportedForSession, setUnsupportedForSession] = useState(false);
	const [retry, setRetry] = useState(0);
	const [sentFeedbackReqId, setSentFeedbackReqId] = useState<string | null>(null);
	useEffect(() => {
		if (sentFeedbackReqId === null) return;
		const reqId = sentFeedbackReqId;
		const timer = window.setTimeout(() => {
			setSentFeedbackReqId(current => current === reqId ? null : current);
		}, 700);
		return () => window.clearTimeout(timer);
	}, [sentFeedbackReqId]);

	useEffect(() => {
		setUnsupportedForSession(false);
		setRequest(null);
		setError(null);
		setSentReqId(null);
		setAnsweringReqId(null);
		setSentFeedbackReqId(null);
	}, [api, sessionId]);

	useEffect(() => {
		if (unsupportedForSession) return;
		let current = true;
		void api.sessionOpV3(sessionId, { op: "ui-requests" }).then(
			result => {
				if (!current) return;
				const next = "uiRequests" in result ? result.uiRequests[0] ?? null : null;
				setRequest(next);
				setError(null);
				setSentReqId(previous => previous === next?.reqId ? previous : null);
				setAnsweringReqId(previous => previous === next?.reqId ? previous : null);
				setSentFeedbackReqId(previous => previous === next?.reqId ? previous : null);
			},
			cause => {
				if (!current) return;
				if (unsupported(cause)) {
					setUnsupportedForSession(true);
					setRequest(null);
					setError(null);
					return;
				}
				setRequest(null);
				setError(errorMessage(cause));
			},
		);
		return () => {
			current = false;
		};
	}, [api, sessionId, refreshKey, retry, unsupportedForSession]);

	if (unsupportedForSession) return null;
	if (request === null) {
		return error === null ? null : (
			<div className="ui-request-inline" role="group" aria-label="Answer choices">
				<span className="ui-request-error" role="alert">{error}</span>
				<button type="button" className="ui-request-open" onClick={() => setRetry(value => value + 1)}>Retry</button>
			</div>
		);
	}

	const answer = async (value: string): Promise<void> => {
		if (sentReqId === request.reqId || answeringReqId === request.reqId) return;
		setAnsweringReqId(request.reqId);
		setError(null);
		try {
			await api.sessionOpV3(sessionId, { op: "ui-answer", reqId: request.reqId, value });
			setSentReqId(request.reqId);
			setSentFeedbackReqId(request.reqId);
		} catch (cause) {
			if (unsupported(cause)) {
				setUnsupportedForSession(true);
				setRequest(null);
				setError(null);
				return;
			}
			setError(errorMessage(cause));
		} finally {
			setAnsweringReqId(null);
		}
	};

	return (
		<PendingUiRequestView
			request={request}
			error={error}
			sent={sentReqId === request.reqId}
			pending={answeringReqId === request.reqId}
			disabled={answeringReqId === request.reqId || sentReqId === request.reqId}
			onAnswer={value => void answer(value)}
			successFeedback={sentFeedbackReqId === request.reqId}
			onOpen={onOpen}
		/>
	);
}
