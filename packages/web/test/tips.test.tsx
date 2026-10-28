import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { clearSeenTips, markTipSeen, nextTip, readSeenTips, TipCard, type Tip, type TipStorage } from "../src/components/tips/TipCard";

const TIPS: readonly Tip[] = [
	{ id: "drag-files", text: "Drag files into the chat to attach them." },
	{ id: "composer-shortcuts", text: "Use @file, /command, or ^model while drafting." },
];

function memoryStorage(): TipStorage {
	const values = new Map<string, string>();
	return {
		getItem: key => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: key => values.delete(key),
	};
}

describe("contextual tips", () => {
	it("shows one contextual tip and advances only after the current tip is seen", () => {
		const storage = memoryStorage();
		expect(nextTip(TIPS, readSeenTips(storage))).toEqual(TIPS[0]);
		markTipSeen(TIPS[0]!.id, storage);
		expect(nextTip(TIPS, readSeenTips(storage))).toEqual(TIPS[1]);
		expect(nextTip(TIPS, new Set(["drag-files", "composer-shortcuts"]))).toBeUndefined();
	});

	it("persists dismissal and lets the settings reset reveal the first tip again", () => {
		const storage = memoryStorage();
		markTipSeen("drag-files", storage);
		markTipSeen("composer-shortcuts", storage);
		expect(nextTip(TIPS, readSeenTips(storage))).toBeUndefined();
		clearSeenTips(storage);
		expect(nextTip(TIPS, readSeenTips(storage))).toEqual(TIPS[0]);
	});

	it("renders a dismissible tip with its accessible label", () => {
		const html = renderToStaticMarkup(<TipCard tips={TIPS} />);
		expect(html).toContain("Drag files into the chat to attach them.");
		expect(html).toContain('aria-label="Dismiss tip"');
	});
});
