import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Tour } from "../src/components/tour/Tour";
import {
	finishTour,
	handleTourEscape,
	hasSeenTour,
	nextTourStep,
	positionTourCard,
	previousTourStep,
	requestTourReplay,
	resolveTourTarget,
	resolveTourStepTarget,
	shouldAutoShowTour,
	TOUR_SEEN_KEY,
	TOUR_STEPS,
	type TourStorage,
} from "../src/lib/tour";
import { OPEN_PANEL_EVENT } from "../src/lib/palette";

class MemoryStorage implements TourStorage {
	readonly values = new Map<string, string>();
	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

function targetWithRects(rectCount: number): HTMLElement {
	return {
		isConnected: true,
		hidden: false,
		inert: false,
		getClientRects: () => ({ length: rectCount }) as DOMRectList,
		getAttribute: () => null,
		parentElement: null,
		ownerDocument: { defaultView: null },
	} as unknown as HTMLElement;
}

describe("first-visit tour", () => {
	it("defines five short steps with one plain sentence each", () => {
		expect(TOUR_STEPS).toHaveLength(5);
		for (const step of TOUR_STEPS) {
			expect(step.title.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
			expect(step.title.trim().split(/\s+/).length).toBeLessThanOrEqual(4);
			expect(step.body).toMatch(/^[^\n]+\.$/);
		}
	});

	it("renders an accessible, keyboard-operable first step", () => {
		const html = renderToStaticMarkup(<Tour onClose={() => {}} />);
		expect(html).toContain('role="dialog" aria-modal="true"');
		expect(html).toContain('aria-label="Tour steps"');
		expect(html).toContain("1 of 5");
		expect(html).toContain("Your sessions");
		expect(html).toContain(">Back</button>");
		expect(html).toContain(">Next</button>");
		expect(html).toContain(">Skip</button>");
	});

	it("centers the card without a spotlight when a target is missing", () => {
		const layout = positionTourCard(null, { width: 1280, height: 820 }, { width: 380, height: 280 }, false);
		expect(layout.card).toEqual({ left: 450, top: 270 });
		expect(layout.spotlight).toBeNull();
		expect(resolveTourTarget("not-present", { querySelectorAll: () => [] } as unknown as Pick<Document, "querySelectorAll">)).toBeNull();
	});

	it("positions a desktop card beside a visible target without leaving the viewport", () => {
		const target = { left: 20, top: 200, width: 60, height: 50 };
		const layout = positionTourCard(target, { width: 800, height: 600 }, { width: 300, height: 220 }, false);

		expect(layout.card.left).toBeGreaterThanOrEqual(target.left + target.width);
		expect(layout.card.left + 300).toBeLessThanOrEqual(784);
		expect(layout.card.top).toBeGreaterThanOrEqual(16);
		expect(layout.card.top + 220).toBeLessThanOrEqual(584);
		expect(layout.spotlight).not.toBeNull();
	});

	it("places a centered home target above the card when a vertical slot is available", () => {
		const target = { left: 566, top: 383, width: 419, height: 122 };
		const layout = positionTourCard(target, { width: 1280, height: 820 }, { width: 380, height: 220 }, false);

		expect(layout.card.left).toBe(585.5);
		expect(layout.card.top).toBe(521);
		expect(layout.spotlight).not.toBeNull();
	});

	it("uses only visible matching targets and keeps phone cards centered", () => {
		const hidden = targetWithRects(0);
		const visible = targetWithRects(1);
		const root = { querySelectorAll: () => [hidden, visible] } as unknown as Pick<Document, "querySelectorAll">;
		expect(resolveTourTarget("sessions", root)).toBe(visible);

		const layout = positionTourCard({ left: 24, top: 20, width: 40, height: 40 }, { width: 390, height: 844 }, { width: 360, height: 300 }, true);
		expect(layout.card).toEqual({ left: 16, top: 272 });
		expect(layout.spotlight).toEqual({ left: 16, top: 12, width: 56, height: 56 });
	});

	it("uses the help entry when Settings is unavailable for phone pairing", () => {
		const hiddenSettings = targetWithRects(0);
		const help = targetWithRects(1);
		const targets = new Map([
			['[data-tour="settings"]', [hiddenSettings]],
			['[data-tour="help"]', [help]],
		]);
		const root = {
			querySelectorAll: (selector: string): HTMLElement[] => targets.get(selector) ?? [],
		} as unknown as Pick<Document, "querySelectorAll">;

		expect(resolveTourStepTarget(TOUR_STEPS[4]!, root)).toBe(help);
	});

	it("does not auto-show before pairing, while setup is open, or after the seen flag", () => {
		const ready = { paired: true, seen: false, surfaceReady: true, checklistOpen: false, modalOpen: false };
		const storage = new MemoryStorage();
		storage.setItem(TOUR_SEEN_KEY, "1");
		expect(shouldAutoShowTour({ ...ready, paired: false })).toBe(false);
		expect(shouldAutoShowTour({ ...ready, checklistOpen: true })).toBe(false);
		expect(shouldAutoShowTour({ ...ready, modalOpen: true })).toBe(false);
		expect(shouldAutoShowTour({ ...ready, seen: hasSeenTour(storage) })).toBe(false);
		expect(shouldAutoShowTour(ready)).toBe(true);
		expect(shouldAutoShowTour({ ...ready, surfaceReady: false })).toBe(false);
	});

	it("persists Skip and Escape completion, and Escape leaves other keys alone", () => {
		const skipped = new MemoryStorage();
		finishTour(() => {}, skipped);
		expect(hasSeenTour(skipped)).toBe(true);

		const escaped = new MemoryStorage();
		let prevented = 0;
		let stopped = 0;
		let closed = 0;
		const finish = (): void => finishTour(() => closed++, escaped);
		expect(handleTourEscape({ key: "Escape", preventDefault: () => prevented++, stopPropagation: () => stopped++ }, finish)).toBe(true);
		expect([hasSeenTour(escaped), prevented, stopped, closed]).toEqual([true, 1, 1, 1]);
		expect(handleTourEscape({ key: "Enter", preventDefault: () => prevented++, stopPropagation: () => stopped++ }, finish)).toBe(false);
		expect([prevented, stopped, closed]).toEqual([1, 1, 1]);
	});

	it("keeps Back and Next within the five-step tour", () => {
		expect(previousTourStep(0)).toBe(0);
		expect(previousTourStep(4)).toBe(3);
		expect(nextTourStep(0)).toBe(1);
		expect(nextTourStep(4)).toBe(4);
		expect(nextTourStep(0, 0)).toBe(0);
		expect(nextTourStep(99)).toBe(4);
		expect(previousTourStep(-1)).toBe(0);
	});

	it("replays from Settings without resetting stored preferences or the seen flag", () => {
		const storage = new MemoryStorage();
		storage.setItem(TOUR_SEEN_KEY, "1");
		storage.setItem("omp-console:theme", "dark");
		const target = new EventTarget();
		let detail: { panel: string } | undefined;
		target.addEventListener(OPEN_PANEL_EVENT, event => {
			detail = (event as CustomEvent<{ panel: string }>).detail;
		});

		requestTourReplay(target);

		expect(detail).toEqual({ panel: "tour" });
		expect(storage.values).toEqual(new Map([[TOUR_SEEN_KEY, "1"], ["omp-console:theme", "dark"]]));
	});
});
