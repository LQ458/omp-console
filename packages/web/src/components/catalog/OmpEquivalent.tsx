import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { recordUsage } from "../../lib/journal";
import { copyText } from "./clipboard";
import "./catalog.css";

export interface OmpEquivalentProps {
	/** The omp text to show and copy, e.g. `/compact soft`. */
	text: string;
	/** Muted hint after the text that is not copied (an argument usage such as `[soft|remote|snap]`). */
	hint?: string;
	/** Action id from `lib/equivalents.ts`; journaled as the copy's detail (never the text, which may hold arguments). */
	actionId: string;
	via?: "catalog" | "palette" | "composer";
}

/** "omp: <text>" with a copy button, so using the app teaches the terminal (spec 0.2). */
export function OmpEquivalent({ text, hint, actionId, via }: OmpEquivalentProps): ReactNode {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);

	const copy = async (): Promise<void> => {
		const ok = await copyText(text);
		recordUsage({ feature: "0.2.equivalent", action: "copy", outcome: ok ? "ok" : "error", via, detail: actionId });
		if (!ok) return;
		setCopied(true);
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(false), 1500);
	};

	return (
		<div className="ct-omp">
			<span className="ct-omp-label">omp:</span>
			<code className="ct-omp-text">{text}</code>
			{hint !== undefined && <span className="ct-omp-hint">{hint}</span>}
			<button
				type="button"
				className="ct-omp-copy"
				onClick={copy}
				title={copied ? "copied" : "copy to clipboard"}
				aria-label={`copy ${text}`}
			>
				{copied ? <Check size={12} /> : <Copy size={12} />}
			</button>
		</div>
	);
}
