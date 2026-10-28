import type { PushPayload } from "@omp-console/protocol";

/** Posted by the service worker to every visible omp console window when a push arrives. */
export interface DeckPushMessage {
	type: "omp-console:push";
	payload: PushPayload;
}

/**
 * Posted to a window the worker could not navigate itself (for example one that is not controlled
 * yet) after a notification tap. `url` is same-origin, e.g. `/#session=<id>`.
 */
export interface DeckOpenMessage {
	type: "omp-console:open";
	url: string;
}

export type DeckServiceWorkerMessage = DeckPushMessage | DeckOpenMessage;

export function isDeckServiceWorkerMessage(value: unknown): value is DeckServiceWorkerMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "omp-console:push" || type === "omp-console:open";
}

/** Posted by a page to a waiting service worker: activate now (the page reloads on `controllerchange`). */
export interface DeckSkipWaitingMessage {
	type: "omp-console:skip-waiting";
}

export const SKIP_WAITING_MESSAGE: DeckSkipWaitingMessage = { type: "omp-console:skip-waiting" };

export function isSkipWaitingMessage(value: unknown): value is DeckSkipWaitingMessage {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "omp-console:skip-waiting";
}
