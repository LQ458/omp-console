import { CircleCheck, CircleHelp, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Alert, AlertStore } from "../../lib/alerts";

export interface AlertsProps {
	store: AlertStore;
	/** Tapping an alert opens its session. */
	onOpen(sessionId: string): void;
}

const ICON = { info: CircleCheck, warning: CircleHelp, error: TriangleAlert } as const;

export function alertDisplayText(alert: Pick<Alert, "tag" | "title" | "body">): { title: string; body: string } {
	const finished = alert.tag.endsWith(":turn-finished");
	const title = finished && !alert.title.toLowerCase().endsWith(" finished") ? `${alert.title} finished` : alert.title;
	const body = finished && alert.body === "Turn finished" ? "" : alert.body;
	return { title, body };
}

/** Toasts for sessions other than the open one; each expires by its own TTL. */
export function Alerts({ store, onOpen }: AlertsProps): ReactNode {
	const alerts = useSyncExternalStore(
		listener => store.subscribe(listener),
		() => store.getSnapshot(),
		() => store.getSnapshot(),
	);

	const surfaceRef = useRef<HTMLDivElement>(null);
	const [bottom, setBottom] = useState(96);
	const [hasRoom, setHasRoom] = useState(true);
	useEffect(() => {
		const surface = surfaceRef.current;
		const layout = surface?.closest(".dk-layout");
		if (surface === null || layout === null || surface === undefined || layout === undefined) return;

		const update = (): void => {
			const activePane = layout.querySelector<HTMLElement>(".pn-frame[data-focused='true']");
			const scope = activePane ?? layout;
			const composer = scope.querySelector<HTMLElement>(".sh-composer") ?? layout.querySelector<HTMLElement>(".sh-composer");
			const header = scope.querySelector<HTMLElement>(".sh-header") ?? layout.querySelector<HTMLElement>(".sh-header");
			const composerTop = composer?.getBoundingClientRect().top ?? null;
			const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
			const surfaceHeight = surface.getBoundingClientRect().height;
			const nextBottom = composerTop === null ? 16 : Math.max(16, window.innerHeight - composerTop + 12);
			const top = window.innerHeight - nextBottom - surfaceHeight;
			setBottom(current => (current === nextBottom ? current : nextBottom));
			setHasRoom(top >= headerBottom + 8 && (composerTop === null || top + surfaceHeight <= composerTop - 8));
		};

		update();
		const observer = new ResizeObserver(update);
		observer.observe(surface);
		for (const target of layout.querySelectorAll(".sh-composer, .sh-header")) observer.observe(target);
		const focusObserver = new MutationObserver(update);
		focusObserver.observe(layout, { attributes: true, subtree: true, attributeFilter: ["data-focused"] });
		window.addEventListener("resize", update);
		const viewport = window.visualViewport;
		viewport?.addEventListener("resize", update);
		viewport?.addEventListener("scroll", update);
		return () => {
			observer.disconnect();
			focusObserver.disconnect();
			window.removeEventListener("resize", update);
			viewport?.removeEventListener("resize", update);
			viewport?.removeEventListener("scroll", update);
		};
	}, [alerts.length]);
	return alerts.length === 0 ? null : (
		<div ref={surfaceRef} className="dk-alerts" role="status" aria-live="polite" style={{ bottom, visibility: hasRoom ? "visible" : "hidden" }} aria-hidden={!hasRoom}>
			{alerts.map(alert => (
				<AlertToast
					key={alert.id}
					alert={alert}
					onOpen={() => {
						store.dismiss(alert.id);
						onOpen(alert.sessionId);
					}}
					onDismiss={() => store.dismiss(alert.id)}
				/>
			))}
		</div>
	);
}

interface AlertToastProps {
	alert: Alert;
	onOpen(): void;
	onDismiss(): void;
}

function AlertToast({ alert, onOpen, onDismiss }: AlertToastProps): ReactNode {
	const dismissRef = useRef(onDismiss);
	dismissRef.current = onDismiss;
	useEffect(() => {
		const timer = window.setTimeout(() => dismissRef.current(), alert.ttlMs);
		return () => window.clearTimeout(timer);
	}, [alert.id, alert.ttlMs]);
	const Icon = ICON[alert.level];
	const display = alertDisplayText(alert);
	return (
		<div className="dk-alert" data-level={alert.level}>
			<button type="button" className="dk-alert-main" onClick={onOpen}>
				<Icon size={18} />
				<span className="dk-alert-copy">
					<span className="dk-alert-title">{display.title}</span>
					{display.body !== "" && <span className="dk-alert-body">{display.body}</span>}
				</span>
			</button>
			<button type="button" className="dk-tap dk-alert-close" onClick={onDismiss} aria-label="dismiss">
				<X size={16} />
			</button>
		</div>
	);
}
