import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import "./graph-tools.css";

const COPIED_MS = 1400;

/**
 * "omp: ..." line: the omp command, tool call or syntax behind a control (spec 0.2), with a copy button.
 * `copy` is what lands on the clipboard when it differs from the text shown.
 */
export function OmpEquivalent(props: { text: string; copy?: string }): ReactNode {
	const { text, copy } = props;
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);
	const onCopy = (): void => {
		const write = globalThis.navigator?.clipboard?.writeText(copy ?? text);
		if (!write) return;
		void write.then(
			() => {
				setCopied(true);
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), COPIED_MS);
			},
			() => {},
		);
	};
	return (
		<div className="ag-omp">
			<span className="ag-omp-label">omp:</span>
			<code className="ag-omp-text" title={text}>
				{text}
			</code>
			<button type="button" className="ag-omp-copy" aria-label="copy the omp equivalent" onClick={onCopy}>
				{copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
			</button>
		</div>
	);
}
