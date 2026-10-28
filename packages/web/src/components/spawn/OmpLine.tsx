import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./spawn.css";

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Fall through: clipboard API missing or denied (non-secure context).
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		area.remove();
	}
}

/**
 * "omp: <what to type>" with a copy button: the same action in omp's own words, so using the GUI teaches the TUI
 * (spec 0.2). `onCopy` lets the caller journal the copy.
 */
export function OmpLine(props: { text: string; label?: string; onCopy?(): void }): ReactNode {
	const { text, label = "omp:", onCopy } = props;
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);
	const copy = async (): Promise<void> => {
		const ok = await copyText(text);
		if (!ok) return;
		onCopy?.();
		setCopied(true);
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1500);
	};
	const multiline = text.includes("\n");
	return (
		<div className="sp-omp" data-multiline={multiline ? "true" : "false"}>
			<span className="sp-omp-label">{label}</span>
			<code className="sp-omp-code" title={text}>
				{text}
			</code>
			<button
				type="button"
				className="sp-omp-copy"
				onClick={() => void copy()}
				aria-label={copied ? "copied" : `copy: ${text.split("\n")[0]}`}
				title={copied ? "copied" : "copy"}
			>
				{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
			</button>
		</div>
	);
}

/**
 * Renders children above every other surface (including the Settings sheet) in a fixed, full-viewport layer, so a
 * dialog opened from inside another sheet or from the header is never clipped by its parent.
 */
export function OverlayLayer({ children }: { children: ReactNode }): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const layer = ref.current;
		if (layer === null || typeof layer.showPopover !== "function") return;
		try {
			layer.showPopover();
		} catch {
			layer.removeAttribute("popover");
			return;
		}
		return () => {
			try {
				if (layer.matches(":popover-open")) layer.hidePopover();
			} catch {
				// Older engines keep the portal in its existing fixed layer.
			}
		};
	}, []);
	return createPortal(
		<div ref={ref} className="sp-portal" popover="manual">
			{children}
		</div>,
		document.body,
	);
}
