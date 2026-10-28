import { afterEach, describe, expect, test } from "bun:test";
import { applyStoredTheme, registerServiceWorker } from "../src/lib/boot";

interface Fakes {
	registered: string[];
	unregistered: number;
	deletedCaches: string[];
	loadListeners: (() => void)[];
	posted: unknown[];
	reloads: number;
	fireControllerChange(): void;
}

const GLOBALS = ["navigator", "location", "caches", "addEventListener", "document", "window", "localStorage", "getComputedStyle"] as const;
const saved = new Map(GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

function define(name: (typeof GLOBALS)[number], value: unknown): void {
	Object.defineProperty(globalThis, name, { value, configurable: true });
}

function install(hostname: string, options: { controlled?: boolean; waiting?: boolean } = {}): Fakes {
	const containerListeners: (() => void)[] = [];
	const fakes: Fakes = {
		registered: [],
		unregistered: 0,
		deletedCaches: [],
		loadListeners: [],
		posted: [],
		reloads: 0,
		fireControllerChange: () => {
			for (const listener of containerListeners) listener();
		},
	};
	define("navigator", {
		serviceWorker: {
			controller: options.controlled ? {} : null,
			addEventListener: (type: string, listener: () => void) => {
				if (type === "controllerchange") containerListeners.push(listener);
			},
			register: async (url: string) => {
				fakes.registered.push(url);
				return {
					update: async () => {},
					installing: null,
					waiting: options.waiting ? { postMessage: (message: unknown) => fakes.posted.push(message) } : null,
					addEventListener: () => {},
				};
			},
			getRegistrations: async () => [
				{
					unregister: async () => {
						fakes.unregistered += 1;
						return true;
					},
				},
			],
		},
	});
	define("location", { hostname, reload: () => (fakes.reloads += 1) });
	define("caches", {
		keys: async () => ["omp-console-shell-abc", "omp-console-api-v1", "deck-shell-legacy", "other-cache"],
		delete: async (name: string) => {
			fakes.deletedCaches.push(name);
			return true;
		},
	});
	define("addEventListener", (type: string, listener: () => void) => {
		if (type === "load") fakes.loadListeners.push(listener);
	});
	define("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
	return fakes;
}

afterEach(() => {
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

describe("registerServiceWorker", () => {
	test("on loopback it registers nothing and removes a stale worker and only omp-console caches", async () => {
		for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
			const fakes = install(host);
			await registerServiceWorker();
			expect(fakes.registered).toEqual([]);
			expect(fakes.loadListeners).toEqual([]);
			expect(fakes.unregistered).toBe(1);
			expect(fakes.deletedCaches).toEqual(["omp-console-shell-abc", "omp-console-api-v1"]);
		}
	});

	test("on a tailnet or public origin it registers the worker on load and removes nothing", async () => {
		const fakes = install("host.tailnet-example.ts.net");
		const settled = registerServiceWorker();
		expect(fakes.loadListeners).toHaveLength(1);
		fakes.loadListeners[0]?.();
		await settled;
		expect(fakes.registered).toEqual(["/sw.js"]);
		expect(fakes.unregistered).toBe(0);
		expect(fakes.deletedCaches).toEqual([]);
	});

	test("at launch a waiting update is activated and the page reloads once on the controller change", async () => {
		const fakes = install("host.tailnet-example.ts.net", { controlled: true, waiting: true });
		const settled = registerServiceWorker();
		fakes.loadListeners[0]?.();
		await settled;
		expect(fakes.posted).toEqual([{ type: "omp-console:skip-waiting" }]);
		fakes.fireControllerChange();
		fakes.fireControllerChange();
		expect(fakes.reloads).toBe(1);
	});

	test("the first install neither asks a worker to skip waiting nor reloads when it claims the page", async () => {
		const fakes = install("host.tailnet-example.ts.net", { controlled: false, waiting: true });
		const settled = registerServiceWorker();
		fakes.loadListeners[0]?.();
		await settled;
		fakes.fireControllerChange();
		expect(fakes.posted).toEqual([]);
		expect(fakes.reloads).toBe(0);
	});

	test("a window that did not ask for the update reloads on its next return to the front, not mid-use", async () => {
		const fakes = install("host.tailnet-example.ts.net", { controlled: true, waiting: false });
		const settled = registerServiceWorker();
		fakes.loadListeners[0]?.();
		await settled;
		fakes.fireControllerChange();
		expect(fakes.reloads).toBe(0);
		document.dispatchEvent(new Event("visibilitychange"));
		expect(document.visibilityState).toBe("visible");
		expect(fakes.reloads).toBe(1);
	});
});

describe("applyStoredTheme", () => {
	test("applies persisted appearance attributes and panel chrome before render", () => {
		const values = new Map<string, string>([
			["omp-console-theme", "light"],
			["omp-console-palette", "sepia"],
			["omp-console-motion", "off"],
			["omp-console-custom-accent", JSON.stringify({ hex: "#aabbcc", hue: 210, chroma: 0.17 })],
		]);
		const customProperties = new Map<string, string>();
		const root = {
			dataset: {} as Record<string, string>,
			style: {
				colorScheme: "",
				setProperty: (name: string, value: string) => customProperties.set(name, value),
			},
		};
		const meta = { content: "#09090a" };
		define("localStorage", {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		});
		define("window", {
			matchMedia: () => ({ matches: false, addEventListener: () => {} }),
		});
		define("document", {
			documentElement: root,
			querySelectorAll: () => [meta],
		});
		define("getComputedStyle", () => ({ getPropertyValue: () => "#fff" }));

		applyStoredTheme();

		expect(root.dataset).toEqual({ theme: "light", palette: "sepia", motion: "off" });
		expect(root.style.colorScheme).toBe("light");
		expect(customProperties).toEqual(new Map([["--accent-custom-h", "210"], ["--accent-custom-c", "0.17"]]));
		expect(meta.content).toBe("#fff");
	});
});
