import { Lightbulb, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import "./tips.css";

export const TIP_SEEN_STORAGE_KEY = "omp-console-tips-seen";
export const TIP_RESET_EVENT = "omp-console:tips-reset";

export interface TipStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface Tip {
	id: string;
	text: string;
}

function browserStorage(): TipStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

export function readSeenTips(storage: TipStorage | undefined = browserStorage()): Set<string> {
	try {
		const raw = storage?.getItem(TIP_SEEN_STORAGE_KEY);
		if (raw === null || raw === undefined) return new Set();
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? new Set(value.filter((id): id is string => typeof id === "string")) : new Set();
	} catch {
		return new Set();
	}
}

export function markTipSeen(id: string, storage: TipStorage | undefined = browserStorage()): void {
	if (storage === undefined) return;
	const seen = readSeenTips(storage);
	seen.add(id);
	try {
		storage.setItem(TIP_SEEN_STORAGE_KEY, JSON.stringify([...seen]));
	} catch {
		// Tips still work for the current render when storage is blocked.
	}
}

export function clearSeenTips(storage: TipStorage | undefined = browserStorage()): void {
	try {
		storage?.removeItem(TIP_SEEN_STORAGE_KEY);
	} catch {
		// The reset remains available for the current page when storage is blocked.
	}
}

export function nextTip(tips: readonly Tip[], seen: ReadonlySet<string>): Tip | undefined {
	return tips.find(tip => !seen.has(tip.id));
}

export function TipCard({ tips }: { tips: readonly Tip[] }): ReactNode {
	const [activeId, setActiveId] = useState(() => nextTip(tips, readSeenTips())?.id ?? null);
	const active = tips.find(tip => tip.id === activeId);

	useEffect(() => {
		if (activeId !== null) markTipSeen(activeId);
	}, [activeId]);

	useEffect(() => {
		const reset = (): void => {
			clearSeenTips();
			setActiveId(tips[0]?.id ?? null);
		};
		window.addEventListener(TIP_RESET_EVENT, reset);
		return () => window.removeEventListener(TIP_RESET_EVENT, reset);
	}, [tips]);

	if (active === undefined) return null;

	const dismiss = (): void => {
		markTipSeen(active.id);
		setActiveId(nextTip(tips, readSeenTips())?.id ?? null);
	};

	return (
		<aside className="dk-tip dk-content-enter" role="note" aria-label="Tip">
			<Lightbulb size={14} aria-hidden="true" />
			<span>{active.text}</span>
			<button type="button" className="dk-tip-dismiss" aria-label="Dismiss tip" onClick={dismiss}>
				<X size={13} aria-hidden="true" />
			</button>
		</aside>
	);
}
