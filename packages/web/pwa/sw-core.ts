/**
 * Service worker logic, written against a minimal structural `SwScope` so it type-checks under the
 * DOM lib (the worker lib clashes with it) and runs against a fake scope in tests. `sw.ts` binds it
 * to the real `self`.
 *
 * Policy:
 * - Shell: the hashed assets listed at build time are precached into `omp-console-shell-<version>`. Navigations
 *   are answered with the cached `/`. A new version installs in the background and waits. It activates when
 *   every omp console window is closed, or when a page asks with `omp-console:skip-waiting` (the page does that at launch and
 *   when it returns from the background, then reloads: an iOS home-screen app is suspended, never closed, so a
 *   waiting worker would otherwise pin the old UI indefinitely).
 * - `/api/*` GET: network first; fresh 200 answers refresh a 60-day, 300-entry offline cache.
 * - Never touched: non-GET requests, range requests, cross-origin requests and `/r/*` (relay).
 * - Push: every push shows a notification (iOS revokes a subscription that receives a push without one);
 *   a visible window is additionally told through `postMessage` and gets a silent notification.
 */
import type { PushPayload } from "@omp-console/protocol";
import { API_CACHE_DISABLED_HEADER, API_CACHE_MAX_ENTRIES, API_CACHE_NAME, API_CACHE_STORED_AT_HEADER, API_CACHE_TTL_MS } from "../src/lib/offline-cache/api-cache";
import { type DeckOpenMessage, type DeckPushMessage, isSkipWaitingMessage } from "./messages";
import {
	base64UrlToBytes,
	isPublicKeyResponse,
	PUSH_PUBLIC_KEY_PATH,
	PUSH_SUBSCRIBE_PATH,
	type PushSubscriptionLike,
	toSubscriptionRequest,
} from "./subscription";

export const CACHE_PREFIX = "omp-console-";
export const SHELL_CACHE_PREFIX = "omp-console-shell-";
export const API_CACHE = API_CACHE_NAME;
export const NOTIFICATION_ICON = "/icon-192.png";

export interface SwConfig {
	/** Content hash of the precached files; names the shell cache. */
	version: string;
	/** Absolute paths (`/`, `/abc123.js`, ...) cached at install. */
	precache: string[];
}

export interface ExtendableEventLike {
	waitUntil(promise: Promise<unknown>): void;
}

export interface FetchEventLike extends ExtendableEventLike {
	request: Request;
	respondWith(response: Response | Promise<Response>): void;
}

export interface PushEventLike extends ExtendableEventLike {
	data: { json(): unknown } | null;
}

export interface NotificationLike {
	tag: string;
	data: unknown;
	close(): void;
}

export interface NotificationClickEventLike extends ExtendableEventLike {
	notification: NotificationLike;
	action: string;
}

export interface SubscriptionChangeEventLike extends ExtendableEventLike {
	oldSubscription: PushSubscriptionLike | null;
	newSubscription: PushSubscriptionLike | null;
}

export interface WindowClientLike {
	url: string;
	visibilityState: DocumentVisibilityState;
	focused: boolean;
	focus(): Promise<unknown>;
	navigate(url: string): Promise<unknown>;
	postMessage(message: unknown): void;
}

export type DeckNotificationOptions = NotificationOptions & {
	actions?: Array<{ action: string; title: string; icon?: string }>;
};

export interface SwScope {
	registration: {
		scope: string;
		showNotification(title: string, options: DeckNotificationOptions): Promise<void>;
		pushManager: {
			subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>;
		};
	};
	clients: {
		matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
		openWindow(url: string): Promise<unknown>;
		claim(): Promise<void>;
	};
	caches: Pick<CacheStorage, "open" | "keys" | "delete">;
	fetch(input: Request | string, init?: RequestInit): Promise<Response>;
	skipWaiting(): Promise<void>;
	addEventListener<E>(type: string, listener: (event: E) => void): void;
}

export interface MessageEventLike extends ExtendableEventLike {
	data: unknown;
}

const FALLBACK_PAYLOAD: PushPayload = {
	reason: "turn-finished",
	sessionId: "",
	title: "omp console",
	body: "Open omp console to see what changed.",
	tag: "omp-console:update",
	url: "/",
};

function isReason(value: unknown): value is PushPayload["reason"] {
	return value === "turn-finished" || value === "needs-answer" || value === "needs-approval" || value === "worker-crashed";
}


function isChoiceList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 3 &&
		value.every((choice: unknown) => typeof choice === "string" && choice.trim() !== "")
	);
}

type AnswerablePushPayload = PushPayload & { choices: string[]; reqId: string; answerToken: string };

function hasAnswerActions(payload: PushPayload): payload is AnswerablePushPayload {
	return (
		(payload.reason === "needs-answer" || payload.reason === "needs-approval") &&
		isChoiceList(payload.choices) &&
		typeof payload.reqId === "string" &&
		payload.reqId !== "" &&
		typeof payload.answerToken === "string" &&
		payload.answerToken !== ""
	);
}

/** Parses a push body into a payload; anything malformed degrades to a generic notification, never to none. */
export function parsePushPayload(data: PushEventLike["data"]): PushPayload {
	let raw: unknown;
	try {
		raw = data?.json();
	} catch {
		return FALLBACK_PAYLOAD;
	}
	if (typeof raw !== "object" || raw === null) return FALLBACK_PAYLOAD;
	const o = raw as Record<string, unknown>;
	const sessionId = typeof o.sessionId === "string" ? o.sessionId : "";
	const reason = isReason(o.reason) ? o.reason : FALLBACK_PAYLOAD.reason;
	const payload: PushPayload = {
		reason,
		sessionId,
		title: typeof o.title === "string" && o.title ? o.title : FALLBACK_PAYLOAD.title,
		body: typeof o.body === "string" ? o.body : FALLBACK_PAYLOAD.body,
		tag: typeof o.tag === "string" && o.tag ? o.tag : sessionId ? `${sessionId}:${reason}` : FALLBACK_PAYLOAD.tag,
		url: typeof o.url === "string" && o.url ? o.url : sessionId ? `/#session=${encodeURIComponent(sessionId)}` : "/",
	};
	if (
		(reason === "needs-answer" || reason === "needs-approval") &&
		isChoiceList(o.choices) &&
		typeof o.reqId === "string" &&
		o.reqId !== "" &&
		typeof o.answerToken === "string" &&
		o.answerToken !== ""
	) {
		return { ...payload, choices: o.choices, reqId: o.reqId, answerToken: o.answerToken };
	}
	return payload;
}

export function installServiceWorker(scope: SwScope, config: SwConfig): void {
	const origin = new URL(scope.registration.scope).origin;
	const shellCache = `${SHELL_CACHE_PREFIX}${config.version}`;
	const precacheSet = new Set(config.precache);
	const absolute = (pathname: string): string => new URL(pathname, origin).href;
	const rootUrl = absolute("/");

	/** Resolves a payload/notification url to a same-origin address; anything else opens the app root. */
	function resolveTarget(url: unknown): string {
		if (typeof url !== "string") return rootUrl;
		try {
			const target = new URL(url, origin);
			return target.origin === origin ? target.href : rootUrl;
		} catch {
			return rootUrl;
		}
	}

	async function precacheShell(): Promise<void> {
		const cache = await scope.caches.open(shellCache);
		try {
			await Promise.all(
				config.precache.map(async pathname => {
					const response = await scope.fetch(new Request(absolute(pathname), { cache: "reload" }));
					if (!response.ok) throw new Error(`precache ${pathname}: HTTP ${response.status}`);
					await cache.put(absolute(pathname), response);
				}),
			);
		} catch (error) {
			// A half-filled cache must not be mistaken for a complete one by a later activation.
			await scope.caches.delete(shellCache);
			throw error;
		}
	}

	async function activate(): Promise<void> {
		const keep = new Set([shellCache, API_CACHE]);
		const names = await scope.caches.keys();
		await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && !keep.has(name)).map(name => scope.caches.delete(name)));
		await scope.clients.claim();
	}

	async function shell(request: Request): Promise<Response> {
		const cache = await scope.caches.open(shellCache);
		return (await cache.match(rootUrl, { ignoreSearch: true })) ?? scope.fetch(request);
	}

	async function cachedAsset(request: Request): Promise<Response> {
		const cache = await scope.caches.open(shellCache);
		return (await cache.match(request.url)) ?? scope.fetch(request);
	}

	async function networkFirstApi(request: Request): Promise<Response> {
		if (request.headers.get(API_CACHE_DISABLED_HEADER) === "true") return scope.fetch(request);
		let response: Response;
		try {
			response = await scope.fetch(request);
		} catch (error) {
			try {
				const cache = await scope.caches.open(API_CACHE);
				const cached = await cache.match(request);
				if (cached) {
					const storedAt = Number(cached.headers.get(API_CACHE_STORED_AT_HEADER));
					if (Number.isFinite(storedAt) && Date.now() - storedAt <= API_CACHE_TTL_MS) return cached;
					await cache.delete(request);
				}
			} catch {
				// CacheStorage failures must not replace the original network error.
			}
			throw error;
		}
		if (response.status === 401 || response.status === 403) {
			// Signed out or forbidden: nothing cached for the previous identity may be served offline later.
			try {
				await scope.caches.delete(API_CACHE);
			} catch {
				// A failed delete must not hide the auth response.
			}
			return response;
		}
		if (response.status === 200) {
			try {
				const copy = response.clone();
				const headers = new Headers(copy.headers);
				headers.set(API_CACHE_STORED_AT_HEADER, String(Date.now()));
				const cache = await scope.caches.open(API_CACHE);
				await cache.put(request, new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers }));
				const keys = await cache.keys();
				if (keys.length > API_CACHE_MAX_ENTRIES) {
					const now = Date.now();
					const entries: Array<{ request: Request; storedAt: number }> = [];
					for (const key of keys) {
						const cached = await cache.match(key);
						if (!cached) continue;
						const storedAt = Number(cached.headers.get(API_CACHE_STORED_AT_HEADER));
						if (!Number.isFinite(storedAt) || now - storedAt > API_CACHE_TTL_MS) {
							await cache.delete(key);
							continue;
						}
						entries.push({ request: key, storedAt });
					}
					entries.sort((a, b) => a.storedAt - b.storedAt);
					for (let index = 0; index < entries.length - API_CACHE_MAX_ENTRIES; index++) {
						await cache.delete(entries[index]!.request);
					}
				}
			} catch {
				// A cache write must not replace a successful API response.
			}
		}
		return response;
	}

	scope.addEventListener<ExtendableEventLike>("install", event => event.waitUntil(precacheShell()));
	scope.addEventListener<ExtendableEventLike>("activate", event => event.waitUntil(activate()));
	scope.addEventListener<MessageEventLike>("message", event => {
		if (isSkipWaitingMessage(event.data)) event.waitUntil(scope.skipWaiting());
	});

	scope.addEventListener<FetchEventLike>("fetch", event => {
		const { request } = event;
		if (request.method !== "GET" || request.headers.has("range")) return;
		const url = new URL(request.url);
		if (url.origin !== origin) return;
		if (url.pathname === "/r" || url.pathname.startsWith("/r/")) return;
		// A widget frame is served by the daemon with its own CSP; the app shell must never stand in for it.
		if (url.pathname === "/widget-frame.html") return;
		if (url.pathname.startsWith("/api/")) {
			if (request.mode !== "navigate") event.respondWith(networkFirstApi(request));
			return;
		}
		if (request.mode === "navigate") {
			event.respondWith(shell(request));
			return;
		}
		if (precacheSet.has(url.pathname)) event.respondWith(cachedAsset(request));
	});

	async function showPush(payload: PushPayload): Promise<void> {
		const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
		const visible = windows.filter(client => client.visibilityState === "visible");
		const message: DeckPushMessage = { type: "omp-console:push", payload };
		for (const client of visible) client.postMessage(message);
		const answerPayload = hasAnswerActions(payload) ? payload : undefined;
		await scope.registration.showNotification(payload.title, {
			body: payload.body,
			tag: payload.tag,
			icon: NOTIFICATION_ICON,
			silent: visible.length > 0,
			...(answerPayload
				? { actions: answerPayload.choices.map((choice, index) => ({ action: `answer-${index}`, title: choice })) }
				: {}),
			data: {
				url: payload.url,
				sessionId: payload.sessionId,
				reason: payload.reason,
				...(answerPayload
					? { choices: answerPayload.choices, reqId: answerPayload.reqId, answerToken: answerPayload.answerToken }
					: {}),
			},
		});
	}

	scope.addEventListener<PushEventLike>("push", event => event.waitUntil(showPush(parsePushPayload(event.data))));

	async function openTarget(target: string): Promise<void> {
		const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
		const client = windows.find(c => c.visibilityState === "visible") ?? windows.find(c => c.focused) ?? windows[0];
		if (!client) {
			await scope.clients.openWindow(target);
			return;
		}
		await client.focus().catch(() => undefined);
		// Navigating to the identical address would reload the page for nothing.
		if (client.url === target) return;
		try {
			await client.navigate(target);
		} catch {
			// Uncontrolled windows reject navigate(); hand the address to the page instead.
			const { pathname, search, hash } = new URL(target);
			const message: DeckOpenMessage = { type: "omp-console:open", url: pathname + search + hash };
			client.postMessage(message);
		}
	}
	async function answerNotification(value: string, token: string, tag: string, target: string): Promise<void> {
		try {
			const response = await scope.fetch(absolute("/api/push/answer"), {
				method: "POST",
				credentials: "same-origin",
				redirect: "error",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token, value }),
			});
			if (!response.ok) throw new Error("notification answer was rejected");
			await scope.registration.showNotification("Answer sent", {
				body: "Your answer was sent.",
				tag: `${tag}:answered`,
				icon: NOTIFICATION_ICON,
			});
		} catch {
			await openTarget(target);
		}
	}

	scope.addEventListener<NotificationClickEventLike>("notificationclick", event => {
		event.notification.close();
		const data = event.notification.data as { url?: unknown; tag?: unknown } | null;
		const target = resolveTarget(data?.url);
		if (event.action) {
			const payload = parsePushPayload({ json: () => data });
			if (hasAnswerActions(payload)) {
				const match = /^answer-([0-2])$/.exec(event.action);
				const value = match ? payload.choices[Number(match[1])] : undefined;
				if (value !== undefined) {
					event.waitUntil(answerNotification(value, payload.answerToken, payload.tag, target));
					return;
				}
			}
		}
		event.waitUntil(openTarget(target));
	});

	async function resubscribe(event: SubscriptionChangeEventLike): Promise<void> {
		let subscription = event.newSubscription;
		if (!subscription) {
			let key: Uint8Array<ArrayBuffer> | null = null;
			try {
				const response = await scope.fetch(absolute(PUSH_PUBLIC_KEY_PATH));
				const body: unknown = response.ok ? await response.json() : null;
				if (isPublicKeyResponse(body)) key = base64UrlToBytes(body.publicKey);
			} catch {
				// Fall back to the key the expired subscription used.
			}
			const previous = event.oldSubscription?.options?.applicationServerKey;
			key ??= previous ? new Uint8Array(previous) : null;
			if (!key) throw new Error("no application server key to resubscribe with");
			subscription = await scope.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		}
		const body = toSubscriptionRequest(subscription);
		if (!body) throw new Error("subscription has no keys");
		const response = await scope.fetch(absolute(PUSH_SUBSCRIBE_PATH), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`re-register subscription: HTTP ${response.status}`);
	}

	scope.addEventListener<SubscriptionChangeEventLike>("pushsubscriptionchange", event => event.waitUntil(resubscribe(event)));
}
