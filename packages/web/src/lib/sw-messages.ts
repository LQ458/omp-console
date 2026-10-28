/**
 * Messages from the service worker (`pwa/messages.ts`): `omp-console:push` and `omp-console:open`.
 *
 * `omp-console:open` carries a same-origin path such as `/#session=<id>`; only its hash is applied, so the
 * page is never reloaded and `watchSessionDeepLink` selects the session exactly as a cold start
 * with that hash would. `omp-console:push` becomes an in-app alert (the OS notification is already shown).
 */
import { isDeckServiceWorkerMessage } from "../../pwa/messages";
import { type AlertInput, alertFromPush } from "./alerts";

export interface ServiceWorkerMessageHandlers {
	origin: string;
	openSessionId(): string | null;
	setHash(hash: string): void;
	showAlert(alert: AlertInput): void;
}

/** Returns true when the message was an omp-console message (handled or deliberately ignored). */
export function handleServiceWorkerMessage(data: unknown, handlers: ServiceWorkerMessageHandlers): boolean {
	if (!isDeckServiceWorkerMessage(data)) return false;
	if (data.type === "omp-console:open") {
		const hash = hashOf(data.url, handlers.origin);
		if (hash !== null) handlers.setHash(hash);
		return true;
	}
	const alert = alertFromPush(data.payload, handlers.openSessionId());
	if (alert) handlers.showAlert(alert);
	return true;
}

/** Hash of a same-origin URL; null for another origin, an unparsable URL, or no hash. */
function hashOf(url: string, origin: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url, origin);
	} catch {
		return null;
	}
	if (parsed.origin !== origin || parsed.hash.length <= 1) return null;
	return parsed.hash;
}
