/**
 * Start-up work that used to be inline `<script>` blocks in index.html. The daemon serves a Content-Security-Policy
 * with `script-src 'self'`, which refuses inline scripts, so it lives in the bundle instead.
 */

import { SKIP_WAITING_MESSAGE } from "../../pwa/messages";

import { applyStoredThemeSettings } from "./theme";
/** Applies every persisted appearance preference before the first React render. */
export function applyStoredTheme(): void {
	applyStoredThemeSettings();
}

const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

/** Removes a service worker and its omp-console caches left by an earlier visit to this origin. */
async function dropServiceWorker(): Promise<void> {
	const registrations = await navigator.serviceWorker.getRegistrations();
	await Promise.all(registrations.map(registration => registration.unregister()));
	for (const name of await caches.keys()) {
		if (name.startsWith("omp-console-")) await caches.delete(name);
	}
}

/** A freshly installed update is applied only this soon after launch or a return from the background. */
const APPLY_UPDATE_WINDOW_MS = 15_000;

/**
 * Registers the service worker, which precaches the shell and handles Web Push.
 *
 * Updates: a new worker installs in the background and waits. The page activates it (and reloads once) at launch and
 * when it returns from the background, the moments a reload costs nothing: an iOS home-screen app is suspended rather
 * than closed, so waiting for every window to close would keep the old UI forever. A worker that finishes installing
 * while the page is in use waits for the next return to the foreground; drafts are kept in storage across the reload.
 *
 * Not on loopback: the Mac app and a local browser neither need an offline shell nor push, and a cached shell would pin
 * an old UI after the daemon serves a new build (a stale worker is also removed there).
 * Resolves once the work has settled (after the `load` event when it registers).
 */
export function registerServiceWorker(): Promise<void> {
	if (!("serviceWorker" in navigator)) return Promise.resolve();
	if (Object.hasOwn(LOOPBACK_HOSTS, location.hostname)) return dropServiceWorker().catch(() => {});
	const settled = Promise.withResolvers<void>();
	addEventListener("load", () => {
		const container = navigator.serviceWorker;
		// The first install claims this page too; only a replaced controller means new assets.
		const hadController = container.controller !== null;
		let freshSince = Date.now();
		let requested = false;
		let stale = false;
		let reloading = false;
		const reload = (): void => {
			if (reloading) return;
			reloading = true;
			location.reload();
		};
		// The page that asked reloads now (it is at launch or just back in front). Another open window (a second tab, an
		// iPad window) may be mid-use: it only notes that its assets are old and reloads on its next return to the front.
		container.addEventListener("controllerchange", () => {
			if (!hadController) return;
			if (requested) reload();
			else stale = true;
		});
		container
			.register("/sw.js", { scope: "/", updateViaCache: "none" })
			.then(registration => {
				const applyWaiting = (): void => {
					if (!hadController || Date.now() - freshSince > APPLY_UPDATE_WINDOW_MS) return;
					const waiting = registration.waiting;
					if (!waiting) return;
					requested = true;
					waiting.postMessage(SKIP_WAITING_MESSAGE);
				};
				registration.addEventListener("updatefound", () => {
					const worker = registration.installing;
					worker?.addEventListener("statechange", () => {
						if (worker.state === "installed") applyWaiting();
					});
				});
				applyWaiting();
				document.addEventListener("visibilitychange", () => {
					if (document.visibilityState !== "visible") return;
					if (stale) {
						reload();
						return;
					}
					freshSince = Date.now();
					applyWaiting();
					registration.update().catch(() => {});
				});
			})
			.catch(() => {})
			.finally(settled.resolve);
	});
	return settled.promise;
}
