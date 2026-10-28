import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Notice } from "../../lib/client";
import { commandResultNeedsCard } from "../../lib/command-results";
import { motionLevel } from "../../lib/motion";

const TOAST_TTL_MS = 4000;
const MAX_VISIBLE = 3;
const TOAST_EXIT_MS = 200;

const MEMBERSHIP_NOTICE = /\b(?:joined|left) the collab session\b/;
const MCP_MOUNT_NOTICE = /^xd:\/\/[^:]*:\s*mounted\s+mcp__/i;

/** Long command output belongs in a persistent card; only brief confirmations stay as toasts. */
export function shouldShowToast(message: string, source?: string, level: Notice["level"] = "info"): boolean {
	return !commandResultNeedsCard(source, level, message) && !MEMBERSHIP_NOTICE.test(message) && !MCP_MOUNT_NOTICE.test(message);
}

const OMP_CONSOLE_TOAST_EVENT = "omp-console:toast";

interface ToastEventDetail {
	sessionId: string;
	level: Notice["level"];
	message: string;
	action?: ToastAction;
}

export interface ToastAction {
	label: string;
	onAction(): void;
}

/** Runs the optional action and closes its toast even when the action fails. */
export function runToastAction(action: ToastAction, close: () => void): void {
	try {
		action.onAction();
	} finally {
		close();
	}
}

/** Sends a one-off action result to the toast surface belonging to its session. */
export function notifyToast(
	sessionId: string,
	message: string,
	level: Notice["level"] = "info",
	action?: ToastAction,
): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<ToastEventDetail>(OMP_CONSOLE_TOAST_EVENT, {
		detail: { sessionId, message, level, ...(action === undefined ? {} : { action }) },
	}));
}

export function toastAutoDismissMs(level: Notice["level"]): number | null {
	return level === "error" ? null : TOAST_TTL_MS;
}

function visibleNotices(
	notices: readonly Notice[],
	dismissed: ReadonlySet<number>,
	leaving: ReadonlyMap<number, Notice>,
): Notice[] {
	const active = [
		...notices.filter(notice => !dismissed.has(notice.id) && !leaving.has(notice.id) && shouldShowToast(notice.message, notice.source, notice.level)),
		...leaving.values(),
	].sort((a, b) => a.at - b.at);
	const errors = active.filter(notice => notice.level === "error");
	if (errors.length >= MAX_VISIBLE) return errors.slice(-MAX_VISIBLE);
	const transient = active.filter(notice => notice.level !== "error");
	return [...errors, ...transient.slice(-(MAX_VISIBLE - errors.length))].sort((a, b) => a.at - b.at);
}

export function Toasts({
	notices,
	sessionId,
	actions,
}: {
	notices: readonly Notice[];
	sessionId?: string;
	actions?: ReadonlyMap<number, ToastAction>;
}): ReactNode {
	const [localNotices, setLocalNotices] = useState<Notice[]>([]);
	const [localActions, setLocalActions] = useState<Map<number, ToastAction>>(() => new Map());
	const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());
	const [leaving, setLeaving] = useState<Map<number, Notice>>(() => new Map());
	const dismissalTimers = useRef(new Map<number, number>());
	const nextLocalNoticeId = useRef(0);
	const allNotices = useMemo(() => [...notices, ...localNotices], [notices, localNotices]);
	const previousNotices = useRef(allNotices);

	useEffect(() => {
		if (sessionId === undefined) return;
		const onToast = (event: Event): void => {
			const detail = (event as CustomEvent<ToastEventDetail>).detail;
			if (detail.sessionId !== sessionId) return;
			const id = --nextLocalNoticeId.current;
			const notice: Notice = { id, level: detail.level, message: detail.message, at: Date.now() };
			setLocalNotices(current => [...current, notice].slice(-50));
			const action = detail.action;
			if (action !== undefined) setLocalActions(current => new Map(current).set(id, action));
		};
		window.addEventListener(OMP_CONSOLE_TOAST_EVENT, onToast);
		return () => window.removeEventListener(OMP_CONSOLE_TOAST_EVENT, onToast);
	}, [sessionId]);
	const dismiss = useCallback((notice: Notice): void => {
		if (dismissalTimers.current.has(notice.id)) return;
		setLocalActions(current => {
			if (!current.has(notice.id)) return current;
			const next = new Map(current);
			next.delete(notice.id);
			return next;
		});
		if (motionLevel() === "off") {
			setDismissed(current => new Set(current).add(notice.id));
			return;
		}
		setLeaving(current => new Map(current).set(notice.id, notice));
		const timer = window.setTimeout(() => {
			dismissalTimers.current.delete(notice.id);
			setLeaving(current => {
				const next = new Map(current);
				next.delete(notice.id);
				return next;
			});
			setDismissed(current => new Set(current).add(notice.id));
		}, TOAST_EXIT_MS);
		dismissalTimers.current.set(notice.id, timer);
	}, []);

	const surfaceRef = useRef<HTMLDivElement>(null);
	const [bottom, setBottom] = useState(96);
	const [hasRoom, setHasRoom] = useState(true);

	useEffect(
		() => () => {
			for (const timer of dismissalTimers.current.values()) window.clearTimeout(timer);
			dismissalTimers.current.clear();
		},
		[],
	);

	useEffect(() => {
		const currentIds = new Set(allNotices.map(notice => notice.id));
		for (const notice of previousNotices.current) {
			if (!currentIds.has(notice.id) && !dismissed.has(notice.id) && shouldShowToast(notice.message, notice.source, notice.level)) {
				dismiss(notice);
			}
		}
		previousNotices.current = allNotices;
	}, [allNotices, dismissed, dismiss]);
	useEffect(() => {
		const timers: number[] = [];
		for (const notice of allNotices) {
			const ttl = toastAutoDismissMs(notice.level);
			if (ttl === null || dismissed.has(notice.id) || leaving.has(notice.id) || !shouldShowToast(notice.message, notice.source, notice.level)) continue;
			const remaining = notice.at + ttl - Date.now();
			timers.push(window.setTimeout(() => dismiss(notice), Math.max(0, remaining)));
		}
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [allNotices, dismissed, leaving, dismiss]);

	const visible = visibleNotices(allNotices, dismissed, leaving);

	useEffect(() => {
		const surface = surfaceRef.current;
		const app = surface?.closest(".sh-app");
		const layout = app?.closest(".dk-layout");
		const composer = app?.querySelector<HTMLElement>(".sh-composer");
		const header = app?.querySelector<HTMLElement>(".sh-header");
		if (surface === null || app === null || app === undefined || composer === null || composer === undefined) return;

		let observedAlerts: HTMLElement | null = null;
		const update = (): void => {
			const alertSurface = layout?.querySelector<HTMLElement>(".dk-alerts") ?? null;
			if (alertSurface !== observedAlerts) {
				if (observedAlerts !== null) observer.unobserve(observedAlerts);
				observedAlerts = alertSurface;
				if (observedAlerts !== null) observer.observe(observedAlerts);
			}
			const appBottom = app.getBoundingClientRect().bottom;
			const composerTop = composer.getBoundingClientRect().top;
			const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
			const surfaceRect = surface.getBoundingClientRect();
			const alertRect = alertSurface?.getBoundingClientRect();
			const sharesRight = alertRect !== undefined && alertRect.width > 0 && alertRect.right > surfaceRect.left && alertRect.left < surfaceRect.right;
			const alertClearance = sharesRight && alertRect !== undefined ? alertRect.height + 8 : 0;
			const nextBottom = Math.max(16, appBottom - composerTop + 12 + alertClearance);
			const top = appBottom - nextBottom - surfaceRect.height;
			setBottom(current => (current === nextBottom ? current : nextBottom));
			setHasRoom(top >= headerBottom + 8);
		};

		const observer = new ResizeObserver(update);
		observer.observe(surface);
		observer.observe(composer);
		if (header !== null && header !== undefined) observer.observe(header);
		const childObserver = layout === null || layout === undefined ? null : new MutationObserver(update);
		if (layout !== null && layout !== undefined) childObserver?.observe(layout, { childList: true });
		window.addEventListener("resize", update);
		const viewport = window.visualViewport;
		viewport?.addEventListener("resize", update);
		viewport?.addEventListener("scroll", update);
		update();
		return () => {
			observer.disconnect();
			childObserver?.disconnect();
			window.removeEventListener("resize", update);
			viewport?.removeEventListener("resize", update);
			viewport?.removeEventListener("scroll", update);
		};
	}, [visible.length]);
	if (visible.length === 0) return null;

	const close = (id: number): void => {
		const notice = allNotices.find(item => item.id === id) ?? leaving.get(id);
		if (notice) dismiss(notice);
	};

	return (
		<div ref={surfaceRef} className="sh-toasts" style={{ bottom, visibility: hasRoom ? "visible" : "hidden" }} aria-hidden={!hasRoom}>
			{visible.map(notice => {
				const action = actions?.get(notice.id) ?? localActions.get(notice.id);
				return (
					<div
						key={notice.id}
						className={leaving.has(notice.id) ? `sh-toast sh-toast-${notice.level} is-exiting` : `sh-toast sh-toast-${notice.level}`}
						role={notice.level === "error" ? "alert" : "status"}
					>
						<span className="sh-toast-msg" title={notice.message}>{notice.message}</span>
						{action !== undefined && (
							<button
								type="button"
								className="sh-toast-action"
								onClick={() => runToastAction(action, () => close(notice.id))}
							>
								{action.label}
							</button>
						)}
						{notice.level === "error" && (
							<button type="button" className="sh-toast-close" onClick={() => close(notice.id)} aria-label={`Dismiss ${notice.level} notice`} title="dismiss">
								<X size={12} />
							</button>
						)}
					</div>
				);
			})}
		</div>
	);
}
