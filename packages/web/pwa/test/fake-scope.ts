import type { PushSubscriptionLike } from "../subscription";
import type { DeckNotificationOptions, SwScope, WindowClientLike } from "../sw-core";

export const ORIGIN = "https://omp-console.test";

export class FakeCache {
	readonly entries = new Map<string, Response>();

	#key(request: Request | string): string {
		return typeof request === "string" ? request : request.url;
	}

	async put(request: Request | string, response: Response): Promise<void> {
		this.entries.set(this.#key(request), response.clone());
	}

	async match(request: Request | string, options?: CacheQueryOptions): Promise<Response | undefined> {
		const wanted = this.#key(request);
		for (const [key, response] of this.entries) {
			const same = options?.ignoreSearch ? stripSearch(key) === stripSearch(wanted) : key === wanted;
			if (same) return response.clone();
		}
		return undefined;
	}
	async keys(): Promise<Request[]> {
		return [...this.entries.keys()].map(key => new Request(key));
	}

	async delete(request: Request | string): Promise<boolean> {
		return this.entries.delete(this.#key(request));
	}
}

function stripSearch(url: string): string {
	const parsed = new URL(url);
	return parsed.origin + parsed.pathname;
}

export class FakeCaches {
	readonly stores = new Map<string, FakeCache>();

	async open(name: string): Promise<Cache> {
		let cache = this.stores.get(name);
		if (!cache) {
			cache = new FakeCache();
			this.stores.set(name, cache);
		}
		return cache as unknown as Cache;
	}

	async keys(): Promise<string[]> {
		return [...this.stores.keys()];
	}

	async delete(name: string): Promise<boolean> {
		return this.stores.delete(name);
	}

	names(): string[] {
		return [...this.stores.keys()].sort();
	}
}

export class FakeClient implements WindowClientLike {
	readonly calls: string[] = [];
	readonly messages: unknown[] = [];
	focused = false;
	navigateError: Error | null = null;

	constructor(
		public url: string,
		public visibilityState: DocumentVisibilityState = "visible",
	) {}

	async focus(): Promise<unknown> {
		this.calls.push("focus");
		return this;
	}

	async navigate(url: string): Promise<unknown> {
		this.calls.push(`navigate ${url}`);
		if (this.navigateError) throw this.navigateError;
		this.url = url;
		return this;
	}

	postMessage(message: unknown): void {
		this.messages.push(message);
	}
}

export interface ShownNotification {
	title: string;
	options: DeckNotificationOptions;
}

export class FakeSubscription implements PushSubscriptionLike {
	unsubscribed = false;

	constructor(
		public endpoint: string,
		readonly options: { applicationServerKey: ArrayBuffer | null },
	) {}

	toJSON(): { endpoint: string; keys: Record<string, string> } {
		return { endpoint: this.endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } };
	}

	async unsubscribe(): Promise<boolean> {
		this.unsubscribed = true;
		return true;
	}
}

type Listener = (event: unknown) => void;

export interface FetchOutcome {
	handled: boolean;
	response?: Promise<Response>;
}

export class FakeScope {
	readonly caches = new FakeCaches();
	readonly clientList: FakeClient[] = [];
	readonly opened: string[] = [];
	readonly networkLog: { method: string; url: string; body?: string; cache?: string }[] = [];
	/** Notifications currently on screen; a repeated tag replaces its predecessor like a real shell. */
	readonly shown = new Map<string, ShownNotification>();
	readonly subscribeCalls: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }[] = [];
	claimed = false;
	skippedWaiting = 0;
	skipWaiting = async (): Promise<void> => {
		this.skippedWaiting += 1;
	};
	/** Answers every request the worker sends to the network; throws to simulate being offline. */
	network: (request: Request) => Response | Promise<Response> = () => new Response("ok");
	nextSubscription: FakeSubscription = new FakeSubscription("https://push.example/new", { applicationServerKey: null });
	readonly #listeners = new Map<string, Listener>();

	readonly registration = {
		scope: `${ORIGIN}/`,
		showNotification: async (title: string, options: DeckNotificationOptions): Promise<void> => {
			this.shown.set(options.tag ?? `untagged-${this.shown.size}`, { title, options });
		},
		pushManager: {
			subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
				this.subscribeCalls.push(options);
				return this.nextSubscription;
			},
		},
	};

	readonly clients = {
		matchAll: async () => [...this.clientList] as WindowClientLike[],
		openWindow: async (url: string) => {
			this.opened.push(url);
			return null;
		},
		claim: async () => {
			this.claimed = true;
		},
	};

	fetch = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = typeof input === "string" ? new Request(input, init) : input;
		this.networkLog.push({
			method: request.method,
			url: request.url,
			cache: request.cache,
			body: init?.body === undefined ? undefined : String(init.body),
		});
		return this.network(request);
	};

	addEventListener<E>(type: string, listener: (event: E) => void): void {
		this.#listeners.set(type, listener as Listener);
	}

	/** Runs a lifecycle-style handler and resolves/rejects with whatever it passed to waitUntil. */
	async dispatch(type: string, event: Record<string, unknown> = {}): Promise<void> {
		const pending: Promise<unknown>[] = [];
		const listener = this.#listeners.get(type);
		if (!listener) throw new Error(`no ${type} listener registered`);
		listener({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
		await Promise.all(pending);
	}

	/** Dispatches a fetch event; `handled` is whether the worker called respondWith. */
	dispatchFetch(request: Request): FetchOutcome {
		const outcome: FetchOutcome = { handled: false };
		const listener = this.#listeners.get("fetch");
		if (!listener) throw new Error("no fetch listener registered");
		listener({
			request,
			waitUntil: () => {},
			respondWith: (response: Response | Promise<Response>) => {
				outcome.handled = true;
				outcome.response = Promise.resolve(response);
			},
		});
		return outcome;
	}
}

export interface FakeRequestInit {
	method?: string;
	mode?: RequestMode;
	headers?: Record<string, string>;
}

/** A request-shaped object: `new Request(..., { mode: "navigate" })` is rejected outside a real browser. */
export function fakeRequest(path: string, init: FakeRequestInit = {}): Request {
	const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
	return {
		url,
		method: init.method ?? "GET",
		mode: init.mode ?? "same-origin",
		headers: new Headers(init.headers),
		cache: "default",
	} as unknown as Request;
}

export function asScope(scope: FakeScope): SwScope {
	return scope as unknown as SwScope;
}
