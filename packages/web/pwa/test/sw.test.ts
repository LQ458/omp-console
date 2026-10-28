import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { PushPayload } from "@omp-console/protocol";
import { API_CACHE_STORED_AT_HEADER, API_CACHE_TTL_MS } from "../../src/lib/offline-cache/api-cache";
import { DeckApi } from "../../src/lib/api";
import * as offlineCachePreference from "../../src/lib/offline-cache/preference";
import { API_CACHE, installServiceWorker, parsePushPayload, type SwConfig } from "../sw-core";
import { asScope, FakeClient, FakeScope, FakeSubscription, fakeRequest, ORIGIN } from "./fake-scope";

const CONFIG: SwConfig = { version: "v1", precache: ["/", "/app.abc.js", "/app.abc.css", "/manifest.webmanifest"] };
const SHELL = "omp-console-shell-v1";

const PAYLOAD: PushPayload = {
	reason: "needs-answer",
	sessionId: "s1",
	title: "Docs sweep needs an answer",
	body: "Delete the old fixtures?",
	tag: "s1:needs-answer",
	url: "/#session=s1",
};
const ACTIONABLE_PAYLOAD: PushPayload = {
	...PAYLOAD,
	choices: ["Approve", "Deny"],
	reqId: "request-1",
	answerToken: "A".repeat(43),
};

function pushEvent(data: unknown): Record<string, unknown> {
	return { data: { json: () => data } };
}

let scope: FakeScope;

beforeEach(() => {
	scope = new FakeScope();
	scope.network = request => new Response(`net:${new URL(request.url).pathname}`);
	installServiceWorker(asScope(scope), CONFIG);
});

async function install(): Promise<void> {
	scope.network = request => new Response(`net:${new URL(request.url).pathname}`);
	await scope.dispatch("install");
}

describe("install and activate", () => {
	it("precaches the whole shell into a versioned cache, bypassing the HTTP cache", async () => {
		await install();
		const cache = scope.caches.stores.get(SHELL)!;
		expect([...cache.entries.keys()].sort()).toEqual(CONFIG.precache.map(p => `${ORIGIN}${p}`).sort());
		expect(scope.networkLog.every(entry => entry.cache === "reload")).toBe(true);
		expect(await (await cache.match(`${ORIGIN}/app.abc.js`))!.text()).toBe("net:/app.abc.js");
	});

	it("fails the install and leaves no half-filled cache when an asset is missing", async () => {
		scope.network = request => (request.url.endsWith("app.abc.css") ? new Response("gone", { status: 404 }) : new Response("ok"));
		await expect(scope.dispatch("install")).rejects.toThrow("app.abc.css");
		expect(scope.caches.names()).toEqual([]);
	});

	it("deletes older omp-console caches on activate while keeping this shell and foreign caches", async () => {
		await scope.caches.open("omp-console-shell-v0");
		await scope.caches.open("deck-shell-v0");
		await scope.caches.open(SHELL);
		await scope.caches.open(API_CACHE);
		await scope.caches.open("someone-elses-cache");
		await scope.dispatch("activate");
		expect(scope.caches.names()).toEqual([API_CACHE, SHELL, "deck-shell-v0", "someone-elses-cache"].sort());
		expect(scope.claimed).toBe(true);
	});

	it("activates a waiting update only when a page asks with omp-console:skip-waiting", async () => {
		await scope.dispatch("message", { data: { type: "omp-console:push" } });
		await scope.dispatch("message", { data: "omp-console:skip-waiting" });
		expect(scope.skippedWaiting).toBe(0);
		await scope.dispatch("message", { data: { type: "omp-console:skip-waiting" } });
		expect(scope.skippedWaiting).toBe(1);
	});
});

describe("fetch routing", () => {
	beforeEach(install);

	it("never intercepts the relay, even for requests the shell would otherwise answer", () => {
		for (const path of ["/r/room-1?role=guest", "/r/room-1", "/r"]) {
			expect(scope.dispatchFetch(fakeRequest(path)).handled).toBe(false);
			// A navigation to a relay url would get the app shell if the worker took it.
			expect(scope.dispatchFetch(fakeRequest(path, { mode: "navigate" })).handled).toBe(false);
		}
		expect(scope.dispatchFetch(fakeRequest("/r/room-1", { method: "POST" })).handled).toBe(false);
	});

	it("never intercepts POST, DELETE, range or cross-origin requests", () => {
		expect(scope.dispatchFetch(fakeRequest("/api/sessions", { method: "POST" })).handled).toBe(false);
		expect(scope.dispatchFetch(fakeRequest("/api/push/subscribe", { method: "DELETE" })).handled).toBe(false);
		expect(scope.dispatchFetch(fakeRequest("/app.abc.js", { headers: { range: "bytes=0-9" } })).handled).toBe(false);
		expect(scope.dispatchFetch(fakeRequest("https://elsewhere.example/app.abc.js")).handled).toBe(false);
	});

	it("serves navigations from the cached shell without touching the network", async () => {
		scope.network = () => {
			throw new TypeError("offline");
		};
		const root = scope.dispatchFetch(fakeRequest("/", { mode: "navigate" }));
		const deepLink = scope.dispatchFetch(fakeRequest("/?utm=1", { mode: "navigate" }));
		expect(await (await root.response!).text()).toBe("net:/");
		expect(await (await deepLink.response!).text()).toBe("net:/");
	});

	it("serves precached assets from the cache and leaves unknown assets to the network", async () => {
		scope.network = () => {
			throw new TypeError("offline");
		};
		const asset = scope.dispatchFetch(fakeRequest("/app.abc.js"));
		expect(await (await asset.response!).text()).toBe("net:/app.abc.js");
		expect(scope.dispatchFetch(fakeRequest("/not-in-shell.js")).handled).toBe(false);
	});

	it("does not intercept a navigation to an API url", () => {
		expect(scope.dispatchFetch(fakeRequest("/api/health", { mode: "navigate" })).handled).toBe(false);
	});

	it("answers /api GETs network first and falls back to the last good answer when offline", async () => {
		scope.network = () => new Response('{"sessions":[1]}', { status: 200 });
		const online = scope.dispatchFetch(fakeRequest("/api/sessions"));
		expect(await (await online.response!).text()).toBe('{"sessions":[1]}');

		scope.network = () => {
			throw new TypeError("offline");
		};
		const offline = scope.dispatchFetch(fakeRequest("/api/sessions"));
		expect(await (await offline.response!).text()).toBe('{"sessions":[1]}');

		await expect(scope.dispatchFetch(fakeRequest("/api/health")).response).rejects.toThrow("offline");
	});

	it("passes a fresh 401 through and forgets what the previous identity had cached", async () => {
		scope.network = () => new Response("authorized", { status: 200 });
		await scope.dispatchFetch(fakeRequest("/api/sessions")).response;

		scope.network = () => new Response("unauthorized", { status: 401 });
		const denied = scope.dispatchFetch(fakeRequest("/api/sessions"));
		expect((await denied.response!).status).toBe(401);

		// Offline afterwards: the old 200 is not served.
		scope.network = () => {
			throw new TypeError("offline");
		};
		await expect(scope.dispatchFetch(fakeRequest("/api/sessions")).response).rejects.toThrow("offline");
	});

	it("does not serve API cache entries older than sixty days", async () => {
		const url = `${ORIGIN}/api/sessions`;
		const cache = await scope.caches.open(API_CACHE);
		await cache.put(
			url,
			new Response("stale", {
				headers: { [API_CACHE_STORED_AT_HEADER]: String(Date.now() - API_CACHE_TTL_MS - 1) },
			}),
		);
		scope.network = () => {
			throw new TypeError("offline");
		};

		await expect(scope.dispatchFetch(fakeRequest("/api/sessions")).response).rejects.toThrow("offline");
		expect(await cache.match(url)).toBeUndefined();
	});

	it("hydrates a cold-start session list from fresh CacheStorage when offline caching is enabled and rejects an expired one", async () => {
		const url = `${ORIGIN}/api/sessions`;
		const cache = await scope.caches.open(API_CACHE);
		const sessions = { live: [{ id: "cached-session" }], recent: [] };
		const response = (storedAt: number): Response => new Response(JSON.stringify(sessions), {
			headers: {
				"content-type": "application/json",
				[API_CACHE_STORED_AT_HEADER]: String(storedAt),
			},
		});
		await cache.put(url, response(Date.now()));
		const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
		const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		};
		Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(`${ORIGIN}/`) });
		Object.defineProperty(globalThis, "caches", { configurable: true, value: scope.caches });
		Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
		offlineCachePreference.setOfflineCacheEnabled(true);

		try {
			const api = new DeckApi();
			expect(await api.cachedGet<typeof sessions>("/sessions")).toEqual(sessions);

			await cache.put(url, response(Date.now() - API_CACHE_TTL_MS - 1));
			expect(await api.cachedGet("/sessions")).toBeNull();
			expect(await cache.match(url)).toBeUndefined();
		} finally {
			offlineCachePreference.setOfflineCacheEnabled(false);
			if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
			else Reflect.deleteProperty(globalThis, "location");
			if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
			else Reflect.deleteProperty(globalThis, "caches");
			if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
			else Reflect.deleteProperty(globalThis, "localStorage");
		}
	});

	it("caps API cache entries at 300 and evicts the oldest response", async () => {
		scope.network = request => new Response(new URL(request.url).pathname);
		for (let index = 0; index <= 300; index++) {
			const result = scope.dispatchFetch(fakeRequest(`/api/item/${index}`));
			await (await result.response!).text();
		}

		const cache = scope.caches.stores.get(API_CACHE)!;
		expect(cache.entries.size).toBe(300);
		expect(await cache.match(`${ORIGIN}/api/item/0`)).toBeUndefined();
		expect((await cache.match(`${ORIGIN}/api/item/300`))?.status).toBe(200);
	});

	it("bypasses stored API responses when offline caching is disabled", async () => {
		const url = `${ORIGIN}/api/sessions`;
		const cached = await scope.caches.open(API_CACHE);
		await cached.put(url, new Response("saved", { headers: { [API_CACHE_STORED_AT_HEADER]: String(Date.now()) } }));
		const preference = vi.spyOn(offlineCachePreference, "offlineCacheEnabled").mockReturnValue(false);
		const api = new DeckApi({
			fetch: async (input, init) => {
				const request = new Request(new URL(input, ORIGIN), init);
				const outcome = scope.dispatchFetch(request);
				if (outcome.handled && outcome.response) return outcome.response;
				return scope.fetch(request);
			},
		});

		try {
			const fresh = { live: [], recent: [] };
			scope.network = () => new Response(JSON.stringify(fresh), { headers: { "content-type": "application/json" } });
			expect(await api.listSessions()).toEqual(fresh);
			expect(await (await cached.match(url))?.text()).toBe("saved");

			scope.network = () => {
				throw new TypeError("offline");
			};
			await expect(api.listSessions()).rejects.toMatchObject({ kind: "network" });
			expect(await (await cached.match(url))?.text()).toBe("saved");
		} finally {
			preference.mockRestore();
		}
	});

});

describe("push", () => {
	it("shows a notification for every push, replacing a same-tag one instead of stacking", async () => {
		await scope.dispatch("push", pushEvent(PAYLOAD));
		await scope.dispatch("push", pushEvent({ ...PAYLOAD, body: "Still waiting for you" }));
		expect(scope.shown.size).toBe(1);
		const shown = scope.shown.get("s1:needs-answer")!;
		expect(shown.title).toBe(PAYLOAD.title);
		expect(shown.options.body).toBe("Still waiting for you");
		expect(shown.options.data).toEqual({ url: "/#session=s1", sessionId: "s1", reason: "needs-answer" });
	});
	it("shows one notification action per supplied answer choice", async () => {
		await scope.dispatch("push", pushEvent(ACTIONABLE_PAYLOAD));
		const shown = scope.shown.get(ACTIONABLE_PAYLOAD.tag)!;
		expect(shown.options.actions).toEqual([
			{ action: "answer-0", title: "Approve" },
			{ action: "answer-1", title: "Deny" },
		]);
		expect(shown.options.data).toMatchObject({
			choices: ACTIONABLE_PAYLOAD.choices,
			reqId: ACTIONABLE_PAYLOAD.reqId,
			answerToken: ACTIONABLE_PAYLOAD.answerToken,
		});
	});


	it("tells a visible window about the push and shows the notification silently", async () => {
		const visible = new FakeClient(`${ORIGIN}/`, "visible");
		const hidden = new FakeClient(`${ORIGIN}/`, "hidden");
		scope.clientList.push(visible, hidden);
		await scope.dispatch("push", pushEvent(PAYLOAD));
		expect(visible.messages).toEqual([{ type: "omp-console:push", payload: PAYLOAD }]);
		expect(hidden.messages).toEqual([]);
		expect(scope.shown.get(PAYLOAD.tag)!.options.silent).toBe(true);
	});

	it("shows an audible notification and posts nothing when no window is visible", async () => {
		const hidden = new FakeClient(`${ORIGIN}/`, "hidden");
		scope.clientList.push(hidden);
		await scope.dispatch("push", pushEvent(PAYLOAD));
		expect(hidden.messages).toEqual([]);
		expect(scope.shown.get(PAYLOAD.tag)!.options.silent).toBe(false);
	});

	it("still shows a generic notification for an empty, malformed or non-object payload", async () => {
		for (const data of [null, "not json", 42, { title: 7 }]) {
			scope.shown.clear();
			await scope.dispatch("push", {
				data: data === null ? null : { json: () => (data === "not json" ? JSON.parse("{") : data) },
			});
			expect(scope.shown.size).toBe(1);
		}
	});

	it("derives the tag and url from the session when the daemon omits them", () => {
		const parsed = parsePushPayload({ json: () => ({ reason: "worker-crashed", sessionId: "a b", title: "t", body: "b" }) });
		expect(parsed.tag).toBe("a b:worker-crashed");
		expect(parsed.url).toBe("/#session=a%20b");
	});
});

describe("notificationclick", () => {
	function click(url: unknown): Promise<void> {
		let closed = false;
		const done = scope.dispatch("notificationclick", {
			notification: { tag: "t", data: { url }, close: () => (closed = true) },
			action: "",
		});
		return done.then(() => expect(closed).toBe(true));
	}

	it("focuses an open window and navigates it to the session", async () => {
		const client = new FakeClient(`${ORIGIN}/#session=other`, "hidden");
		scope.clientList.push(client);
		await click("/#session=s1");
		expect(client.calls).toEqual(["focus", `navigate ${ORIGIN}/#session=s1`]);
		expect(scope.opened).toEqual([]);
	});

	it("does not reload a window that is already on the target", async () => {
		const client = new FakeClient(`${ORIGIN}/#session=s1`);
		scope.clientList.push(client);
		await click("/#session=s1");
		expect(client.calls).toEqual(["focus"]);
	});

	it("prefers the visible window when several are open", async () => {
		const background = new FakeClient(`${ORIGIN}/`, "hidden");
		const front = new FakeClient(`${ORIGIN}/`, "visible");
		scope.clientList.push(background, front);
		await click("/#session=s1");
		expect(background.calls).toEqual([]);
		expect(front.calls).toContain(`navigate ${ORIGIN}/#session=s1`);
	});

	it("hands the address to the page when the window cannot be navigated", async () => {
		const client = new FakeClient(`${ORIGIN}/`);
		client.navigateError = new TypeError("not controlled");
		scope.clientList.push(client);
		await click("/#session=s1");
		expect(client.messages).toEqual([{ type: "omp-console:open", url: "/#session=s1" }]);
	});

	it("opens a window when none exists", async () => {
		await click("/#session=s1");
		expect(scope.opened).toEqual([`${ORIGIN}/#session=s1`]);
	});
	it("posts the selected value with same-origin credentials and confirms a successful answer", async () => {
		let sent: Request | undefined;
		let sentInit: RequestInit | undefined;
		const fetch = scope.fetch;
		scope.fetch = (input, init) => {
			sentInit = init;
			return fetch(input, init);
		};
		scope.network = request => {
			sent = request;
			return new Response(null, { status: 204 });
		};
		await scope.dispatch("notificationclick", {
			notification: { tag: ACTIONABLE_PAYLOAD.tag, data: ACTIONABLE_PAYLOAD, close: () => {} },
			action: "answer-1",
		});

		expect(sent?.url).toBe(`${ORIGIN}/api/push/answer`);
		expect(sent?.method).toBe("POST");
		expect(sentInit?.credentials).toBe("same-origin");
		expect(await sent!.json()).toEqual({ token: ACTIONABLE_PAYLOAD.answerToken, value: "Deny" });
		expect(scope.shown.get(`${ACTIONABLE_PAYLOAD.tag}:answered`)?.title).toBe("Answer sent");
		expect(scope.opened).toEqual([]);
	});

	it("opens the session when an answer action is rejected", async () => {
		const client = new FakeClient(`${ORIGIN}/`);
		scope.clientList.push(client);
		scope.network = () => new Response(null, { status: 409 });
		await scope.dispatch("notificationclick", {
			notification: { tag: ACTIONABLE_PAYLOAD.tag, data: ACTIONABLE_PAYLOAD, close: () => {} },
			action: "answer-0",
		});
		expect(client.calls).toEqual(["focus", `navigate ${ORIGIN}/#session=s1`]);
	});


	it("never opens a cross-origin or malformed target; falls back to the app root", async () => {
		await click("https://evil.example/phish");
		await click(undefined);
		expect(scope.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
	});
});

describe("pushsubscriptionchange", () => {
	const publicKey = "AQID"; // bytes 1,2,3

	function subscribeBodies(): unknown[] {
		return scope.networkLog.filter(e => e.method === "POST" && e.url.endsWith("/api/push/subscribe")).map(e => JSON.parse(e.body!));
	}

	it("re-posts the browser-provided new subscription", async () => {
		const next = new FakeSubscription("https://push.example/fresh", { applicationServerKey: null });
		await scope.dispatch("pushsubscriptionchange", { oldSubscription: null, newSubscription: next });
		expect(subscribeBodies()).toEqual([
			{ endpoint: "https://push.example/fresh", keys: { p256dh: "p256dh-key", auth: "auth-secret" } },
		]);
		expect(scope.subscribeCalls).toEqual([]);
	});

	it("subscribes with the daemon's current key when the browser dropped the subscription", async () => {
		scope.network = request =>
			request.url.endsWith("/api/push/public-key") ? Response.json({ publicKey }) : new Response(null, { status: 204 });
		scope.nextSubscription = new FakeSubscription("https://push.example/resub", { applicationServerKey: null });
		await scope.dispatch("pushsubscriptionchange", { oldSubscription: null, newSubscription: null });
		expect(scope.subscribeCalls).toHaveLength(1);
		expect(scope.subscribeCalls[0]!.userVisibleOnly).toBe(true);
		expect([...scope.subscribeCalls[0]!.applicationServerKey]).toEqual([1, 2, 3]);
		expect((subscribeBodies()[0] as { endpoint: string }).endpoint).toBe("https://push.example/resub");
	});

	it("falls back to the expired subscription's key when the key endpoint is unreachable", async () => {
		scope.network = request => {
			if (request.url.endsWith("/api/push/public-key")) throw new TypeError("offline");
			return new Response(null, { status: 204 });
		};
		const old = new FakeSubscription("https://push.example/old", { applicationServerKey: Uint8Array.of(9, 8, 7).buffer });
		await scope.dispatch("pushsubscriptionchange", { oldSubscription: old, newSubscription: null });
		expect([...scope.subscribeCalls[0]!.applicationServerKey]).toEqual([9, 8, 7]);
	});

	it("surfaces a daemon refusal instead of swallowing it", async () => {
		scope.network = () => new Response("no", { status: 500 });
		const next = new FakeSubscription("https://push.example/fresh", { applicationServerKey: null });
		await expect(scope.dispatch("pushsubscriptionchange", { oldSubscription: null, newSubscription: next })).rejects.toThrow("HTTP 500");
	});
});
