import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SleepSettingsSnapshot } from "../src/lib/sleep-settings";
import { renderToStaticMarkup } from "react-dom/server";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";
import { AutoSleepSettingsView } from "../src/components/shell/AutoSleepSettings";
import { DeckApi, DeckApiError, type FetchLike } from "../src/lib/api";
import { SleepSettingsStore } from "../src/lib/sleep-settings";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noop = (): void => {};

describe("Auto-sleep settings control", () => {
	it("loads the live value, keeps failed writes visible, and saves Off as zero", async () => {
		let currentMinutes = 120;
		let failNextWrite = false;
		const calls: Array<{ url: string; method: string; body: unknown }> = [];
		const fetch: FetchLike = async (url, init) => {
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
			calls.push({ url, method, body });
			if (method === "GET") return jsonResponse({ minutes: currentMinutes });
			if (failNextWrite) {
				failNextWrite = false;
				return jsonResponse({ error: "settings file is read-only", code: "server" }, 500);
			}
			const request = body as { minutes: number };
			currentMinutes = request.minutes;
			return jsonResponse({ minutes: currentMinutes });
		};
		const store = new SleepSettingsStore(new DeckApi({ fetch }));
		await store.load();
		expect(store.getSnapshot()).toMatchObject({ load: "ready", minutes: 120, draft: "120", error: null });

		store.setDraft("0");
		failNextWrite = true;
		expect(await store.save()).toBe(false);
		expect(store.getSnapshot()).toMatchObject({ load: "ready", minutes: 120, draft: "0", saving: false, error: "settings file is read-only" });

		expect(await store.save()).toBe(true);
		expect(store.getSnapshot()).toMatchObject({ load: "ready", minutes: 0, draft: "0", message: "Saved.", error: null });
		expect(calls).toEqual([
			{ url: "/api/settings/sleep", method: "GET", body: undefined },
			{ url: "/api/settings/sleep", method: "PUT", body: { minutes: 0 } },
			{ url: "/api/settings/sleep", method: "PUT", body: { minutes: 0 } },
		]);
		store.dispose();
	});

	it("shows a load failure and retries to recover the current daemon value", async () => {
		let reachable = false;
		const fetch: FetchLike = async () =>
			reachable
				? jsonResponse({ minutes: 0 })
				: jsonResponse({ error: "daemon unreachable", code: "server" }, 503);
		const store = new SleepSettingsStore(new DeckApi({ fetch }));
		try {
			await store.load();
			expect(store.getSnapshot()).toMatchObject({ load: "error", error: "daemon unreachable" });
			reachable = true;
			await store.load();
			expect(store.getSnapshot()).toMatchObject({ load: "ready", minutes: 0, draft: "0", error: null });
		} finally {
			store.dispose();
		}
	});

	it("renders Off, the current daemon value, save feedback, and load errors in place", () => {
		const render = (snapshot: SleepSettingsSnapshot): string => renderToStaticMarkup(
			<AutoSleepSettingsView snapshot={snapshot} onDraft={noop} onSave={noop} onRetry={noop} />,
		);
		const ready = render({ load: "ready", minutes: 0, draft: "0", saving: false, message: "Saved.", error: null });
		expect(ready).toContain("Current value: <strong>Off</strong>");
		expect(ready).toContain('aria-pressed="true"');
		expect(ready).toContain("Saved.");

		const failed = render({ load: "error", minutes: null, draft: "", saving: false, message: null, error: "daemon unreachable" });
		expect(failed).toContain("Could not load auto-sleep settings: daemon unreachable");
		expect(failed).toContain(">Retry</button>");
	});
});

describe("sleep settings through the mock daemon", () => {
	let daemon: MockDaemon;
	let api: DeckApi;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0, seed: false });
		api = new DeckApi({ base: `${daemon.url}/api` });
	});

	afterAll(async () => {
		await daemon.stop();
	});

	it("round-trips Off and positive minute values and rejects invalid daemon values", async () => {
		expect(await api.getSleepSettings()).toEqual({ minutes: 120 });
		expect(await api.setSleepSettings(0)).toEqual({ minutes: 0 });
		expect(await api.getSleepSettings()).toEqual({ minutes: 0 });
		expect(await api.setSleepSettings(45)).toEqual({ minutes: 45 });
		expect(await api.getSleepSettings()).toEqual({ minutes: 45 });

		for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
			let failure: DeckApiError | null = null;
			try {
				await api.setSleepSettings(invalid);
			} catch (error) {
				if (error instanceof DeckApiError) failure = error;
				else throw error;
			}
			expect(failure).toMatchObject({ kind: "bad-request", status: 400 });
		}
		expect(await api.getSleepSettings()).toEqual({ minutes: 45 });
	});
});
