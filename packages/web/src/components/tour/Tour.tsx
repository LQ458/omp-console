import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
	finishTour,
	nextTourStep,
	positionTourCard,
	previousTourStep,
	resolveTourTarget,
	resolveTourStepTarget,
	TOUR_STEPS,
	type TourLayout,
	handleTourEscape,
} from "../../lib/tour";
import "./tour.css";

const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function sameLayout(a: TourLayout | null, b: TourLayout): boolean {
	return a !== null && a.card.left === b.card.left && a.card.top === b.card.top &&
		a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height &&
		a.spotlight?.left === b.spotlight?.left && a.spotlight?.top === b.spotlight?.top &&
		a.spotlight?.width === b.spotlight?.width && a.spotlight?.height === b.spotlight?.height;
}

function getScrims(layout: TourLayout): readonly { key: string; style: CSSProperties }[] {
	const { width, height } = layout.viewport;
	const spotlight = layout.spotlight;
	if (spotlight === null) return [{ key: "full", style: { top: 0, left: 0, width, height } }];
	const right = spotlight.left + spotlight.width;
	const bottom = spotlight.top + spotlight.height;
	return [
		{ key: "top", style: { top: 0, left: 0, width, height: spotlight.top } },
		{ key: "left", style: { top: spotlight.top, left: 0, width: spotlight.left, height: spotlight.height } },
		{ key: "right", style: { top: spotlight.top, left: right, width: Math.max(0, width - right), height: spotlight.height } },
		{ key: "bottom", style: { top: bottom, left: 0, width, height: Math.max(0, height - bottom) } },
	].filter(({ style }) => Number(style.width) > 0 && Number(style.height) > 0);
}

function restoreFocus(previous: HTMLElement | null): void {
	if (previous?.isConnected && previous !== document.body) {
		previous.focus({ preventScroll: true });
		return;
	}
	for (const id of ["settings", "new-session", "sessions"]) {
		const target = resolveTourTarget(id);
		if (target === null) continue;
		if (target.matches(FOCUSABLE_SELECTOR)) {
			target.focus({ preventScroll: true });
			return;
		}
		const child = target.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
		if (child !== null) {
			child.focus({ preventScroll: true });
			return;
		}
	}
	const fallback = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(element =>
		element.isConnected && element.getClientRects().length > 0 && !element.closest("[aria-hidden='true'], [inert]"),
	);
	fallback?.focus({ preventScroll: true });
}

export function Tour({ onClose }: { onClose(): void }): ReactNode {
	const [stepIndex, setStepIndex] = useState(0);
	const [layout, setLayout] = useState<TourLayout | null>(null);
	const cardRef = useRef<HTMLElement | null>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const step = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0]!;

	const finish = useCallback((): void => finishTour(() => onCloseRef.current()), []);

	useClientLayoutEffect(() => {
		const active = document.activeElement;
		previousFocus.current = active instanceof HTMLElement ? active : null;
		cardRef.current?.focus({ preventScroll: true });
		return () => restoreFocus(previousFocus.current);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			handleTourEscape(event, finish);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [finish]);

	useClientLayoutEffect(() => {
		let target: HTMLElement | null = null;
		let sizeObserver: ResizeObserver | undefined;
		let observedTarget: HTMLElement | null = null;
		const update = (): void => {
			target = resolveTourStepTarget(step);
			if (sizeObserver && observedTarget !== target) {
				if (observedTarget !== null) sizeObserver.unobserve(observedTarget);
				if (target !== null) sizeObserver.observe(target);
				observedTarget = target;
			}
			const targetRect = target?.getBoundingClientRect() ?? null;
			const cardRect = cardRef.current?.getBoundingClientRect();
			const next = positionTourCard(
				targetRect === null ? null : { left: targetRect.left, top: targetRect.top, width: targetRect.width, height: targetRect.height },
				{ width: window.innerWidth, height: window.innerHeight },
				{ width: cardRect?.width || Math.min(380, window.innerWidth - 32), height: cardRect?.height || 280 },
				window.innerWidth <= 760,
			);
			setLayout(current => sameLayout(current, next) ? current : next);
		};
		if (typeof ResizeObserver !== "undefined") sizeObserver = new ResizeObserver(update);
		if (cardRef.current !== null) sizeObserver?.observe(cardRef.current);
		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		const mutationObserver = new MutationObserver(update);
		mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "aria-expanded", "class", "style", "data-tour", "data-mode"] });
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
			mutationObserver.disconnect();
			sizeObserver?.disconnect();
		};
	}, [step.target, step.fallbackTarget]);

	const advance = (): void => {
		if (nextTourStep(stepIndex) === stepIndex) finish();
		else setStepIndex(index => nextTourStep(index));
	};
	const back = (): void => setStepIndex(index => previousTourStep(index));
	const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
		if (event.key !== "Tab") return;
		const card = cardRef.current;
		if (card === null) return;
		const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (first === undefined || last === undefined) {
			event.preventDefault();
			card.focus();
		} else if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const scrims = layout === null
		? [{ key: "full", style: { top: 0, left: 0, right: 0, bottom: 0 } satisfies CSSProperties }]
		: getScrims(layout);
	const cardStyle: CSSProperties | undefined = layout === null
		? undefined
		: { left: layout.card.left, top: layout.card.top, transform: "none" };
	const spotlightStyle: CSSProperties | undefined = layout?.spotlight === null || layout?.spotlight === undefined
		? undefined
		: { left: layout.spotlight.left, top: layout.spotlight.top, width: layout.spotlight.width, height: layout.spotlight.height };

	return (
		<div className="tour-root">
			<div className="tour-overlay" aria-hidden="true">
				{scrims.map(({ key, style }) => <div key={key} className="tour-scrim" style={style} />)}
				{spotlightStyle !== undefined && <div className="tour-spotlight" style={spotlightStyle} />}
			</div>
			<section
				ref={cardRef}
				className="tour-card"
				role="dialog"
				aria-modal="true"
				aria-labelledby="tour-title"
				aria-describedby="tour-description"
				tabIndex={-1}
				style={cardStyle}
				onKeyDown={trapFocus}
			>
				<header className="tour-card-head">
					<p className="tour-counter" aria-live="polite">{stepIndex + 1} of {TOUR_STEPS.length}</p>
					<button type="button" className="tour-close" aria-label="Close tour" onClick={finish}>
						<X size={18} aria-hidden="true" />
					</button>
				</header>
				<h2 id="tour-title">{step.title}</h2>
				<p id="tour-description">{step.body}</p>
				<nav className="tour-actions" aria-label="Tour steps">
					<button type="button" className="tour-back" onClick={back} disabled={stepIndex === 0}>Back</button>
					<button type="button" className="tour-next" onClick={advance}>Next</button>
					<button type="button" className="tour-skip" onClick={finish}>Skip</button>
				</nav>
			</section>
		</div>
	);
}
