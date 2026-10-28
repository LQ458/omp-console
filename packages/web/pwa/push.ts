/**
 * Web Push subscription for the installed deck PWA.
 *
 * `enablePush` must run inside a user-gesture handler (iOS shows its permission prompt only for a
 * tap): it checks transient user activation first and asks for notification permission before any
 * other await. Every function takes an optional `PushEnv` so tests drive it with fakes; the default
 * is the real browser.
 */
import type { PushPublicKeyResponse } from "@omp-console/protocol";
import {
	base64UrlToBytes,
	isPublicKeyResponse,
	PUSH_PUBLIC_KEY_PATH,
	PUSH_SUBSCRIBE_PATH,
	PUSH_TEST_PATH,
	type PushSubscriptionLike,
	toSubscriptionRequest,
} from "./subscription";
import { API_CACHE_DISABLED_HEADER } from "../src/lib/offline-cache/api-cache";
import { offlineCacheEnabled } from "../src/lib/offline-cache/preference";

export type PushErrorKind =
	| "unsupported"
	| "gesture-required"
	| "permission-denied"
	| "no-service-worker"
	| "key-unavailable"
	| "subscribe-failed"
	| "unauthorized"
	| "network"
	| "server"
	| "no-subscription";

export class PushError extends Error {
	readonly kind: PushErrorKind;
	constructor(kind: PushErrorKind, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PushError";
		this.kind = kind;
	}
}

const ERROR_TEXT: Record<PushErrorKind, string> = {
	unsupported: "This browser cannot receive notifications.",
	"gesture-required": "Tap the button again to turn notifications on.",
	"permission-denied": "Notifications are blocked for omp console. Allow them in system settings, then try again.",
	"no-service-worker": "The omp console service worker is not running yet. Reload the app and try again.",
	"key-unavailable": "The daemon did not provide a push key.",
	"subscribe-failed": "The browser could not create a push subscription.",
	unauthorized: "The daemon refused the request. Open omp console from your tailnet address and sign in again.",
	network: "Could not reach the daemon.",
	server: "The daemon rejected the request.",
	"no-subscription": "No device is subscribed yet. Turn notifications on first.",
};

/** Short user-facing sentence for an error kind. */
export function describePushError(error: unknown): string {
	return error instanceof PushError ? ERROR_TEXT[error.kind] : "Something went wrong.";
}

export interface PushRegistrationLike {
	pushManager: {
		getSubscription(): Promise<PushSubscriptionLike | null>;
		subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>;
	};
}

export interface PushEnv {
	/** Service workers, `PushManager` and `Notification` all exist. */
	supported(): boolean;
	standalone(): boolean;
	ios(): boolean;
	/** `navigator.userActivation.isActive`, or null when the browser lacks the API. */
	userActivationActive(): boolean | null;
	permission(): NotificationPermission;
	requestPermission(): Promise<NotificationPermission>;
	/** The active omp console service worker registration; rejects when none is registered or it never activates. */
	registration(): Promise<PushRegistrationLike>;
	fetch(path: string, init?: RequestInit): Promise<Response>;
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
	/** Label stored with the subscription, e.g. "iPhone". */
	label(): string;
}

const STORAGE_KEY = "omp-console.push.subscription";
const REGISTRATION_TIMEOUT_MS = 10_000;

function userAgentLabel(): string {
	const ua = navigator.userAgent;
	if (/iPhone|iPod/.test(ua)) return "iPhone";
	if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Macintosh/.test(ua)) return "Mac";
	return "browser";
}

export function browserEnv(): PushEnv {
	return {
		supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
		standalone: () =>
			(navigator as Navigator & { standalone?: boolean }).standalone === true ||
			window.matchMedia("(display-mode: standalone)").matches,
		ios: () => {
			const label = userAgentLabel();
			return label === "iPhone" || label === "iPad";
		},
		userActivationActive: () => navigator.userActivation?.isActive ?? null,
		permission: () => Notification.permission,
		requestPermission: () => Notification.requestPermission(),
		registration: async () => {
			if (!(await navigator.serviceWorker.getRegistration())) throw new Error("no service worker registered");
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(() => timeout.reject(new Error("service worker did not activate")), REGISTRATION_TIMEOUT_MS);
			try {
				return await Promise.race([navigator.serviceWorker.ready, timeout.promise]);
			} finally {
				clearTimeout(timer);
			}
		},
		fetch: (path, init) => {
			const headers = new Headers(init?.headers);
			if ((init?.method ?? "GET").toUpperCase() === "GET" && !offlineCacheEnabled()) headers.set(API_CACHE_DISABLED_HEADER, "true");
			return fetch(path, { credentials: "same-origin", ...init, headers });
		},
		storage: (() => {
			try {
				return window.localStorage;
			} catch {
				return null;
			}
		})(),
		label: userAgentLabel,
	};
}

/** True when the page runs as an installed Home Screen / dock app. */
export function isStandalone(env: PushEnv = browserEnv()): boolean {
	return env.standalone();
}

export function pushSupported(env: PushEnv = browserEnv()): boolean {
	return env.supported();
}

async function request(env: PushEnv, path: string, init?: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await env.fetch(path, init);
	} catch (cause) {
		throw new PushError("network", `${path}: request failed`, { cause });
	}
	if (response.status === 401 || response.status === 403) {
		throw new PushError("unauthorized", `${path}: HTTP ${response.status}`);
	}
	return response;
}

async function fetchPublicKey(env: PushEnv): Promise<Uint8Array<ArrayBuffer>> {
	const response = await request(env, PUSH_PUBLIC_KEY_PATH);
	if (!response.ok) throw new PushError("key-unavailable", `${PUSH_PUBLIC_KEY_PATH}: HTTP ${response.status}`);
	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		throw new PushError("key-unavailable", "public key response is not JSON", { cause });
	}
	if (!isPublicKeyResponse(body)) throw new PushError("key-unavailable", "public key response has no publicKey");
	const key: PushPublicKeyResponse = body;
	try {
		return base64UrlToBytes(key.publicKey);
	} catch (cause) {
		throw new PushError("key-unavailable", "publicKey is not base64url", { cause });
	}
}

async function registerWithDaemon(env: PushEnv, subscription: PushSubscriptionLike): Promise<void> {
	const body = toSubscriptionRequest(subscription, env.label());
	if (!body) throw new PushError("subscribe-failed", "subscription carries no encryption keys");
	const response = await request(env, PUSH_SUBSCRIBE_PATH, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new PushError("server", `${PUSH_SUBSCRIBE_PATH}: HTTP ${response.status}`);
	env.storage?.setItem(STORAGE_KEY, JSON.stringify({ endpoint: subscription.endpoint }));
}

function sameKey(subscription: PushSubscriptionLike, key: Uint8Array): boolean {
	const existing = subscription.options?.applicationServerKey;
	if (!existing) return false;
	const bytes = new Uint8Array(existing);
	return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

async function requireRegistration(env: PushEnv): Promise<PushRegistrationLike> {
	try {
		return await env.registration();
	} catch (cause) {
		throw new PushError("no-service-worker", "no active service worker", { cause });
	}
}

/** Turns notifications on for this device. Call it directly from a click/tap handler. */
export async function enablePush(env: PushEnv = browserEnv()): Promise<{ endpoint: string }> {
	if (!env.supported()) throw new PushError("unsupported", "Push is not supported here");
	if (env.userActivationActive() === false) throw new PushError("gesture-required", "enablePush needs a user gesture");

	// Must be the first await so the permission prompt is still tied to the tap.
	let permission = env.permission();
	if (permission === "default") permission = await env.requestPermission();
	if (permission !== "granted") throw new PushError("permission-denied", `notification permission is ${permission}`);

	const registration = await requireRegistration(env);
	const key = await fetchPublicKey(env);

	let subscription = await registration.pushManager.getSubscription();
	let created = false;
	if (subscription && !sameKey(subscription, key)) {
		// A subscription made with another application server key cannot be reused (the daemon's VAPID key changed).
		await subscription.unsubscribe();
		subscription = null;
	}
	if (!subscription) {
		try {
			subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		} catch (cause) {
			throw new PushError("subscribe-failed", "PushManager.subscribe failed", { cause });
		}
		created = true;
	}

	try {
		await registerWithDaemon(env, subscription);
	} catch (error) {
		// Keep browser and daemon in agreement: a subscription the daemon never heard of is dropped again.
		if (created) await subscription.unsubscribe().catch(() => false);
		throw error;
	}
	return { endpoint: subscription.endpoint };
}

/** Removes this device's subscription from the daemon and the browser. */
export async function disablePush(env: PushEnv = browserEnv()): Promise<void> {
	const registration = await requireRegistration(env);
	const subscription = await registration.pushManager.getSubscription();
	if (subscription) {
		const response = await request(env, PUSH_SUBSCRIBE_PATH, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ endpoint: subscription.endpoint }),
		});
		// 404: the daemon no longer knows the endpoint, which is the state we want anyway.
		if (!response.ok && response.status !== 404) throw new PushError("server", `${PUSH_SUBSCRIBE_PATH}: HTTP ${response.status}`);
		await subscription.unsubscribe();
	}
	env.storage?.removeItem(STORAGE_KEY);
}

/** Asks the daemon to push a test notification to every stored subscription. */
export async function sendTestPush(env: PushEnv = browserEnv()): Promise<void> {
	const response = await request(env, PUSH_TEST_PATH, { method: "POST" });
	if (response.status === 409) throw new PushError("no-subscription", "daemon has no subscriptions");
	if (!response.ok) throw new PushError("server", `${PUSH_TEST_PATH}: HTTP ${response.status}`);
}

export interface PushState {
	supported: boolean;
	standalone: boolean;
	ios: boolean;
	permission: NotificationPermission | "unsupported";
	subscribed: boolean;
}

/** Live state from the browser; `subscribed` is the real `PushManager` subscription, not the stored hint. */
export async function getPushState(env: PushEnv = browserEnv()): Promise<PushState> {
	const supported = env.supported();
	const state: PushState = {
		supported,
		standalone: env.standalone(),
		ios: env.ios(),
		permission: supported ? env.permission() : "unsupported",
		subscribed: false,
	};
	if (supported && state.permission === "granted") {
		try {
			state.subscribed = (await (await env.registration()).pushManager.getSubscription()) !== null;
		} catch {
			state.subscribed = false;
		}
	}
	return state;
}

/**
 * Run once per launch: iOS rarely delivers `pushsubscriptionchange`, so when the browser's subscription
 * differs from the one last confirmed to the daemon, tell the daemon again. Needs no gesture.
 * Returns true when it re-registered.
 */
export async function syncPushSubscription(env: PushEnv = browserEnv()): Promise<boolean> {
	if (!env.supported() || env.permission() !== "granted") return false;
	let subscription: PushSubscriptionLike | null;
	try {
		subscription = await (await env.registration()).pushManager.getSubscription();
	} catch {
		return false;
	}
	if (!subscription) {
		env.storage?.removeItem(STORAGE_KEY);
		return false;
	}
	let stored: string | undefined;
	try {
		stored = (JSON.parse(env.storage?.getItem(STORAGE_KEY) ?? "null") as { endpoint?: string } | null)?.endpoint;
	} catch {
		stored = undefined;
	}
	if (stored === subscription.endpoint) return false;
	await registerWithDaemon(env, subscription);
	return true;
}

export type PushStatus = "unsupported" | "install-required" | "denied" | "off" | "enabled";

/** Which of the component's states a `PushState` is in. */
export function pushStatus(state: PushState): PushStatus {
	// On iOS the Push API only exists inside the installed Home Screen app, so a browser tab (or an app
	// launched with "Open as Web App" off) needs the install hint rather than "unsupported".
	if (state.ios && !state.standalone) return "install-required";
	if (!state.supported) return "unsupported";
	if (state.permission === "denied") return "denied";
	if (state.permission === "granted" && state.subscribed) return "enabled";
	return "off";
}
