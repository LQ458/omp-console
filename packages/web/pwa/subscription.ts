import type { PushPublicKeyResponse, PushSubscriptionRequest } from "@omp-console/protocol";

export const PUSH_PUBLIC_KEY_PATH = "/api/push/public-key";
export const PUSH_SUBSCRIBE_PATH = "/api/push/subscribe";
export const PUSH_TEST_PATH = "/api/push/test";

/** Decodes a base64url string (the VAPID application server key) into raw bytes for `PushManager.subscribe`. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The subset of `PushSubscription` this module reads; satisfied by the DOM type and by test fakes. */
export interface PushSubscriptionLike {
	endpoint: string;
	options?: { applicationServerKey: ArrayBuffer | null };
	toJSON(): { endpoint?: string; keys?: Record<string, string> };
	unsubscribe(): Promise<boolean>;
}

/** Builds the daemon's subscribe body; null when the browser handed back a subscription without keys. */
export function toSubscriptionRequest(subscription: PushSubscriptionLike, label?: string): PushSubscriptionRequest | null {
	const json = subscription.toJSON();
	const endpoint = json.endpoint ?? subscription.endpoint;
	const p256dh = json.keys?.p256dh;
	const auth = json.keys?.auth;
	if (!endpoint || !p256dh || !auth) return null;
	return { endpoint, keys: { p256dh, auth }, ...(label ? { label } : {}) };
}

export function isPublicKeyResponse(value: unknown): value is PushPublicKeyResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { publicKey?: unknown }).publicKey === "string" &&
		(value as { publicKey: string }).publicKey.length > 0
	);
}
