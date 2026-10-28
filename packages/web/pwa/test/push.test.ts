import { beforeEach, describe, expect, it } from "bun:test";
import {
	disablePush,
	enablePush,
	getPushState,
	PushError,
	type PushEnv,
	type PushErrorKind,
	type PushState,
	pushStatus,
	sendTestPush,
	syncPushSubscription,
} from "../push";
import { base64UrlToBytes } from "../subscription";
import { FakeSubscription } from "./fake-scope";

const KEY_B64 = "AQID"; // bytes 1,2,3
const KEY_BYTES = [1, 2, 3];

interface Harness {
	env: PushEnv;
	/** Ordered record of the browser and network calls enablePush made. */
	log: string[];
	storage: Map<string, string>;
	requests: { method: string; path: string; body?: unknown }[];
	state: { subscription: FakeSubscription | null; permission: NotificationPermission; activation: boolean | null };
	subscribeOptions: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }[];
	created: FakeSubscription[];
	/** Per-path HTTP status or thrown error. */
	routes: Map<string, number | Error>;
	registrationError: Error | null;
	subscribeError: Error | null;
	requestPermissionResult: NotificationPermission;
}

function harness(): Harness {
	const h: Harness = {
		log: [],
		storage: new Map(),
		requests: [],
		state: { subscription: null, permission: "default", activation: true },
		subscribeOptions: [],
		created: [],
		routes: new Map(),
		registrationError: null,
		subscribeError: null,
		requestPermissionResult: "granted",
		env: undefined as unknown as PushEnv,
	};
	h.env = {
		supported: () => true,
		standalone: () => true,
		ios: () => true,
		userActivationActive: () => h.state.activation,
		permission: () => h.state.permission,
		requestPermission: async () => {
			h.log.push("requestPermission");
			h.state.permission = h.requestPermissionResult;
			return h.requestPermissionResult;
		},
		registration: async () => {
			h.log.push("registration");
			if (h.registrationError) throw h.registrationError;
			return {
				pushManager: {
					getSubscription: async () => h.state.subscription,
					subscribe: async options => {
						h.log.push("subscribe");
						h.subscribeOptions.push(options);
						if (h.subscribeError) throw h.subscribeError;
						const sub = new FakeSubscription(`https://push.example/${h.created.length}`, {
							applicationServerKey: options.applicationServerKey.buffer,
						});
						h.created.push(sub);
						h.state.subscription = sub;
						return sub;
					},
				},
			};
		},
		fetch: async (path, init) => {
			const method = init?.method ?? "GET";
			h.log.push(`${method} ${path}`);
			h.requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			const route = h.routes.get(`${method} ${path}`);
			if (route instanceof Error) throw route;
			if (route !== undefined) return new Response(route === 204 ? null : "x", { status: route });
			if (path === "/api/push/public-key") return Response.json({ publicKey: KEY_B64 });
			return new Response(null, { status: 204 });
		},
		storage: {
			getItem: key => h.storage.get(key) ?? null,
			setItem: (key, value) => void h.storage.set(key, value),
			removeItem: key => void h.storage.delete(key),
		},
		label: () => "iPhone",
	};
	return h;
}

let h: Harness;
beforeEach(() => {
	h = harness();
});

async function kindOf(promise: Promise<unknown>): Promise<PushErrorKind> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof PushError) return error.kind;
		throw error;
	}
	throw new Error("expected a PushError");
}

describe("enablePush", () => {
	it("refuses without a user gesture and neither prompts nor calls the daemon", async () => {
		h.state.activation = false;
		expect(await kindOf(enablePush(h.env))).toBe("gesture-required");
		expect(h.log).toEqual([]);
	});

	it("asks for permission before any other await, then subscribes and registers with the daemon", async () => {
		const result = await enablePush(h.env);
		expect(h.log).toEqual([
			"requestPermission",
			"registration",
			"GET /api/push/public-key",
			"subscribe",
			"POST /api/push/subscribe",
		]);
		expect(h.subscribeOptions[0]!.userVisibleOnly).toBe(true);
		expect([...h.subscribeOptions[0]!.applicationServerKey]).toEqual(KEY_BYTES);
		expect(h.requests.at(-1)!.body).toEqual({
			endpoint: "https://push.example/0",
			keys: { p256dh: "p256dh-key", auth: "auth-secret" },
			label: "iPhone",
		});
		expect(result.endpoint).toBe("https://push.example/0");
		expect(JSON.parse(h.storage.get("omp-console.push.subscription")!)).toEqual({ endpoint: "https://push.example/0" });
	});

	it("works when the browser has no user-activation API", async () => {
		h.state.activation = null;
		await enablePush(h.env);
		expect(h.created).toHaveLength(1);
	});

	it("stops at a denied permission without touching the service worker or the daemon", async () => {
		h.requestPermissionResult = "denied";
		expect(await kindOf(enablePush(h.env))).toBe("permission-denied");
		expect(h.log).toEqual(["requestPermission"]);
	});

	it("does not prompt again when permission is already granted", async () => {
		h.state.permission = "granted";
		await enablePush(h.env);
		expect(h.log).not.toContain("requestPermission");
	});

	it("reuses a subscription made with the daemon's current key and still re-registers it", async () => {
		h.state.permission = "granted";
		h.state.subscription = new FakeSubscription("https://push.example/existing", {
			applicationServerKey: Uint8Array.from(KEY_BYTES).buffer,
		});
		await enablePush(h.env);
		expect(h.created).toHaveLength(0);
		expect(h.requests.at(-1)).toMatchObject({ method: "POST", body: { endpoint: "https://push.example/existing" } });
	});

	it("replaces a subscription made with a stale key (the daemon's VAPID key changed)", async () => {
		h.state.permission = "granted";
		const stale = new FakeSubscription("https://push.example/stale", { applicationServerKey: Uint8Array.of(9, 9).buffer });
		h.state.subscription = stale;
		await enablePush(h.env);
		expect(stale.unsubscribed).toBe(true);
		expect(h.created).toHaveLength(1);
	});

	it("resubscribes on a later call after the browser dropped the subscription", async () => {
		await enablePush(h.env);
		h.state.subscription = null;
		await enablePush(h.env);
		expect(h.created).toHaveLength(2);
	});

	const failures: [string, (x: Harness) => void, PushErrorKind][] = [
		["no service worker registered", x => void (x.registrationError = new Error("none")), "no-service-worker"],
		["key endpoint answers 503", x => void x.routes.set("GET /api/push/public-key", 503), "key-unavailable"],
		["key endpoint answers 401", x => void x.routes.set("GET /api/push/public-key", 401), "unauthorized"],
		["daemon unreachable", x => void x.routes.set("GET /api/push/public-key", new TypeError("offline")), "network"],
		["PushManager.subscribe rejects", x => void (x.subscribeError = new Error("blocked")), "subscribe-failed"],
		["daemon rejects the subscription", x => void x.routes.set("POST /api/push/subscribe", 400), "server"],
		["daemon refuses auth on subscribe", x => void x.routes.set("POST /api/push/subscribe", 403), "unauthorized"],
	];
	for (const [name, arrange, kind] of failures) {
		it(`maps '${name}' to ${kind}`, async () => {
			arrange(h);
			expect(await kindOf(enablePush(h.env))).toBe(kind);
		});
	}

	it("drops the new browser subscription when the daemon never accepted it", async () => {
		h.routes.set("POST /api/push/subscribe", 500);
		await kindOf(enablePush(h.env));
		expect(h.created[0]!.unsubscribed).toBe(true);
		expect(h.storage.size).toBe(0);
	});

	it("reports unsupported browsers without side effects", async () => {
		h.env.supported = () => false;
		expect(await kindOf(enablePush(h.env))).toBe("unsupported");
		expect(h.log).toEqual([]);
	});
});

describe("disablePush", () => {
	beforeEach(async () => {
		await enablePush(h.env);
		h.log.length = 0;
		h.requests.length = 0;
	});

	it("deletes the endpoint at the daemon, then unsubscribes the browser and clears the stored hint", async () => {
		await disablePush(h.env);
		expect(h.requests).toEqual([{ method: "DELETE", path: "/api/push/subscribe", body: { endpoint: "https://push.example/0" } }]);
		expect(h.created[0]!.unsubscribed).toBe(true);
		expect(h.storage.size).toBe(0);
	});

	it("keeps the subscription when the daemon refuses, so the UI stays truthful", async () => {
		h.routes.set("DELETE /api/push/subscribe", 500);
		expect(await kindOf(disablePush(h.env))).toBe("server");
		expect(h.created[0]!.unsubscribed).toBe(false);
	});

	it("treats a daemon that never knew the endpoint (404) as done", async () => {
		h.routes.set("DELETE /api/push/subscribe", 404);
		await disablePush(h.env);
		expect(h.created[0]!.unsubscribed).toBe(true);
	});
});

describe("sendTestPush", () => {
	it("posts to the test endpoint", async () => {
		await sendTestPush(h.env);
		expect(h.requests).toEqual([{ method: "POST", path: "/api/push/test", body: undefined }]);
	});

	it("tells the user nothing is subscribed on 409", async () => {
		h.routes.set("POST /api/push/test", 409);
		expect(await kindOf(sendTestPush(h.env))).toBe("no-subscription");
	});

	it("maps a daemon failure and an unreachable daemon distinctly", async () => {
		h.routes.set("POST /api/push/test", 500);
		expect(await kindOf(sendTestPush(h.env))).toBe("server");
		h.routes.set("POST /api/push/test", new TypeError("offline"));
		expect(await kindOf(sendTestPush(h.env))).toBe("network");
	});
});

describe("syncPushSubscription", () => {
	beforeEach(() => {
		h.state.permission = "granted";
	});

	it("re-registers a subscription the daemon was never told about (missed pushsubscriptionchange)", async () => {
		h.state.subscription = new FakeSubscription("https://push.example/rotated", { applicationServerKey: null });
		h.storage.set("omp-console.push.subscription", JSON.stringify({ endpoint: "https://push.example/old" }));
		expect(await syncPushSubscription(h.env)).toBe(true);
		expect(h.requests).toMatchObject([{ method: "POST", body: { endpoint: "https://push.example/rotated" } }]);
	});

	it("does nothing when the daemon already has the current endpoint", async () => {
		h.state.subscription = new FakeSubscription("https://push.example/same", { applicationServerKey: null });
		h.storage.set("omp-console.push.subscription", JSON.stringify({ endpoint: "https://push.example/same" }));
		expect(await syncPushSubscription(h.env)).toBe(false);
		expect(h.requests).toEqual([]);
	});

	it("forgets the stored endpoint when the browser lost its subscription", async () => {
		h.storage.set("omp-console.push.subscription", JSON.stringify({ endpoint: "https://push.example/gone" }));
		expect(await syncPushSubscription(h.env)).toBe(false);
		expect(h.storage.size).toBe(0);
	});

	it("does nothing until permission is granted", async () => {
		h.state.permission = "default";
		expect(await syncPushSubscription(h.env)).toBe(false);
		expect(h.log).toEqual([]);
	});
});

describe("state", () => {
	const base: PushState = { supported: true, standalone: true, ios: true, permission: "default", subscribed: false };

	it("derives the UI status, sending iOS browser tabs to the install hint rather than 'unsupported'", () => {
		expect(pushStatus({ ...base, standalone: false, supported: false })).toBe("install-required");
		expect(pushStatus({ ...base, ios: false, standalone: false, supported: false })).toBe("unsupported");
		expect(pushStatus({ ...base, permission: "denied" })).toBe("denied");
		expect(pushStatus(base)).toBe("off");
		expect(pushStatus({ ...base, permission: "granted", subscribed: false })).toBe("off");
		expect(pushStatus({ ...base, permission: "granted", subscribed: true })).toBe("enabled");
	});

	it("reports a live subscription only when permission is granted and the browser holds one", async () => {
		h.state.permission = "granted";
		h.state.subscription = new FakeSubscription("https://push.example/x", { applicationServerKey: null });
		expect(await getPushState(h.env)).toMatchObject({ permission: "granted", subscribed: true });
		h.registrationError = new Error("none");
		expect(await getPushState(h.env)).toMatchObject({ subscribed: false });
	});
});

describe("base64UrlToBytes", () => {
	it("decodes url-safe characters and missing padding", () => {
		expect([...base64UrlToBytes("-_8")]).toEqual([0xfb, 0xff]);
		expect([...base64UrlToBytes(KEY_B64)]).toEqual(KEY_BYTES);
	});
});
