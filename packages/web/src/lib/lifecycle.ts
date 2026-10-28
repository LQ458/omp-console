/**
 * Page lifecycle signals the deck UI reacts to. iOS suspends background tabs and their sockets
 * without delivering close events, so "visible" and "online" mean: assume every connection died.
 */

export type LifecycleEvent = "hidden" | "visible" | "online" | "offline";

export interface PageLifecycle {
	isHidden(): boolean;
	subscribe(listener: (event: LifecycleEvent) => void): () => void;
}

export interface VisibilityTarget extends EventTarget {
	readonly hidden: boolean;
}

/** Browser binding; takes the targets as parameters so tests drive it with plain EventTargets. */
export function browserLifecycle(
	doc: VisibilityTarget = document,
	win: EventTarget = window,
	isOnline: () => boolean = () => typeof navigator === "undefined" || navigator.onLine,
): PageLifecycle {
	return {
		isHidden: () => doc.hidden,
		subscribe(listener) {
			let lastResumeAt: number | null = null;
			const resume = (event: "visible" | "online"): void => {
				const online = isOnline();
				const now = Date.now();
				if (online && lastResumeAt !== null && now - lastResumeAt < 100) {
					lastResumeAt = now;
					return;
				}
				lastResumeAt = online ? now : null;
				listener(event);
			};
			const onVisibility = (): void => {
				if (doc.hidden) {
					lastResumeAt = null;
					listener("hidden");
				} else resume("visible");
			};
			const onOnline = (): void => resume("online");
			const onOffline = (): void => {
				lastResumeAt = null;
				listener("offline");
			};
			doc.addEventListener("visibilitychange", onVisibility);
			win.addEventListener("online", onOnline);
			win.addEventListener("offline", onOffline);
			return () => {
				doc.removeEventListener("visibilitychange", onVisibility);
				win.removeEventListener("online", onOnline);
				win.removeEventListener("offline", onOffline);
			};
		},
	};
}
