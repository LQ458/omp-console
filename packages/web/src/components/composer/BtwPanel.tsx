import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../transcript/Markdown";

/** One answered side question in the current topic. */
export interface BtwTurn {
	question: string;
	answer: string;
}

export interface BtwPanelProps {
	/** The input: the first question, or the next follow-up once the topic has turns. */
	question: string;
	turns: readonly BtwTurn[];
	/** The question being answered right now, shown under the earlier turns. */
	pendingQuestion: string | null;
	loading: boolean;
	error: string | null;
	onQuestionChange(value: string): void;
	onSubmit(): void;
	/** Drops the thread; the next question starts a new topic. */
	onNewTopic(): void;
	/** Puts an answer into the prompt (the main session sees it only if you send it). */
	onInsert(answer: string): void;
	onClose(): void;
}

export function BtwPanel(props: BtwPanelProps): ReactNode {
	const { question, turns, pendingQuestion, loading, error, onQuestionChange, onSubmit, onNewTopic, onInsert, onClose } = props;
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const endRef = useRef<HTMLDivElement | null>(null);
	const [copied, setCopied] = useState<number | null>(null);
	const followUp = turns.length > 0;

	useEffect(() => {
		inputRef.current?.focus({ preventScroll: true });
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	// Keep the newest answer (or the pending question) in view, and the cursor in the follow-up box.
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "nearest" });
		if (!loading) inputRef.current?.focus({ preventScroll: true });
	}, [turns.length, pendingQuestion, loading]);

	const copy = (index: number, text: string): void => {
		void navigator.clipboard?.writeText(text).then(() => {
			setCopied(index);
			setTimeout(() => setCopied(current => (current === index ? null : current)), 1500);
		});
	};

	return (
		<aside className="cmp-btw" role="dialog" aria-label="Side question">
			<div className="cmp-btw-head">
				<strong>Ask aside</strong>
				<span className="cmp-btw-head-tools">
					{followUp && (
						<button type="button" className="cmp-btw-link" onClick={onNewTopic} disabled={loading}>
							New topic
						</button>
					)}
					<button type="button" className="cmp-btw-close" onClick={onClose} aria-label="Close side question">×</button>
				</span>
			</div>
			<p className="cmp-btw-hint">Answered from this session's context; nothing here enters the session unless you insert it.</p>
			{(turns.length > 0 || pendingQuestion !== null) && (
				<div className="cmp-btw-thread" aria-live="polite">
					{turns.map((turn, index) => (
						<div className="cmp-btw-turn" key={index}>
							<div className="cmp-btw-q">{turn.question}</div>
							<div className="cmp-btw-answer"><Markdown text={turn.answer} /></div>
							<div className="cmp-btw-turn-actions">
								<button type="button" className="cmp-btw-link" onClick={() => copy(index, turn.answer)}>
									{copied === index ? "Copied" : "Copy"}
								</button>
								<button type="button" className="cmp-btw-link" onClick={() => onInsert(turn.answer)}>
									Insert into prompt
								</button>
							</div>
						</div>
					))}
					{pendingQuestion !== null && (
						<div className="cmp-btw-turn">
							<div className="cmp-btw-q">{pendingQuestion}</div>
							<div className="cmp-btw-answer tr-shimmer">thinking…</div>
						</div>
					)}
					<div ref={endRef} />
				</div>
			)}
			<label className="cmp-btw-label" htmlFor="cmp-btw-question">{followUp ? "Follow up" : "Question"}</label>
			<textarea
				ref={inputRef}
				id="cmp-btw-question"
				className="cmp-btw-input"
				value={question}
				onChange={event => onQuestionChange(event.currentTarget.value)}
				onKeyDown={event => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						onSubmit();
					}
				}}
				rows={followUp ? 2 : 3}
				placeholder={followUp ? "Ask a follow-up… (Enter to send, Shift+Enter for a new line)" : "Ask without adding it to the session… (Enter to send)"}
			/>
			<div className="cmp-btw-actions">
				<span />
				<button type="button" className="sh-btn sh-btn-primary" disabled={loading || question.trim() === ""} onClick={onSubmit}>
					{loading ? "Asking…" : followUp ? "Follow up" : "Ask"}
				</button>
			</div>
			{error !== null && <p className="cmp-btw-error" role="alert">{error}</p>}
		</aside>
	);
}
