import { describe, expect, it } from "bun:test";
import type { JournalEvent } from "@omp-console/protocol";
import { DeckApi, type FetchLike } from "../src/lib/api";
import { reflectHost, SessionControlStore } from "../src/lib/session-model";

interface Call {
	url: string;
	method: string;
	body: unknown;
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, error: string): Response =>
	json({ error, code: status === 409 ? "conflict" : status === 404 ? "not-found" : status === 400 ? "bad-request" : "internal" }, status);

function harness(responses: Array<Response | Error | Promise<Response>>) {
	const calls: Call[] = [];
	const fetch: FetchLike = async (input, init) => {
		calls.push({ url: input, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		const next = responses.shift();
		if (next === undefined) throw new Error("unexpected request");
		if (next instanceof Error) throw next;
		return next;
	};
	const events: Array<Omit<JournalEvent, "at">> = [];
	const store = new SessionControlStore({
		api: new DeckApi({ fetch, base: "/api" }),
		sessionId: "sess/1",
		agentId: "main",
		record: event => events.push(event),
	});
	return { store, calls, events };
}

describe("reflectHost: what the header shows after a change", () => {
	it("keeps the accepted value while the host has not reported anything new", () => {
		const applied = { value: "high", baseline: "medium" };
		expect(reflectHost("medium", applied, "text")).toBe("high");
	});

	it("lets the host win once it reports a value, even a different one", () => {
		const applied = { value: "high", baseline: "medium" };
		expect(reflectHost("high", applied, "text")).toBe("high");
		expect(reflectHost("low", applied, "text")).toBe("low");
	});

	it("matches a host model id against the provider-qualified selector the daemon returned", () => {
		const applied = { value: "anthropic/claude-opus-5-5", baseline: "claude-sonnet-5-5" };
		expect(reflectHost("claude-sonnet-5-5", applied, "model")).toBe("anthropic/claude-opus-5-5");
		expect(reflectHost("claude-opus-5-5", applied, "model")).toBe("claude-opus-5-5");
		expect(reflectHost("some-other-model", applied, "model")).toBe("some-other-model");
	});

	it("shows the host's value when it had none at apply time, and the accepted one when the host still has none", () => {
		expect(reflectHost("low", { value: "high", baseline: undefined }, "text")).toBe("low");
		expect(reflectHost(undefined, { value: "high", baseline: undefined }, "text")).toBe("high");
		expect(reflectHost("low", null, "text")).toBe("low");
	});
});

describe("SessionControlStore", () => {
	it("sends thinking to the root agent's endpoint and journals the change without any content", async () => {
		const { store, calls, events } = harness([new Response(null, { status: 204 })]);
		await store.setThinking("high", "medium");
		expect(calls).toEqual([{ url: "/api/sessions/sess%2F1/agents/main/thinking", method: "POST", body: { level: "high" } }]);
		const snap = store.getSnapshot();
		expect(snap.thinking).toEqual({ value: "high", baseline: "medium" });
		expect(snap.note).toContain("This session only");
		expect(snap.error).toBeNull();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ feature: "1.9.thinking", outcome: "ok", detail: "high", sessionId: "sess/1" });
	});

	it("keeps the old value and says what went wrong, per failure kind", async () => {
		const cases: Array<[Response | Error, RegExp]> = [
			[apiError(400, "claude-sonnet-5-5 does not support xhigh"), /did not accept that level: claude-sonnet-5-5 does not support xhigh/],
			[apiError(409, "busy"), /no live session/],
			[apiError(404, "gone"), /session or agent is gone/],
			[new TypeError("fetch failed"), /unreachable/],
			[apiError(500, "boom"), /daemon failed: boom/],
		];
		for (const [response, message] of cases) {
			const { store, events } = harness([response]);
			await store.setThinking("xhigh", "medium");
			const snap = store.getSnapshot();
			expect(snap.error?.control).toBe("thinking");
			expect(snap.error?.message).toMatch(message);
			expect(snap.thinking).toBeNull();
			expect(snap.busy).toBeNull();
			expect(events[0]?.outcome).toBe("error");
		}
	});

	it("sends one change at a time: a second pick while one is in flight is ignored", async () => {
		const gate = Promise.withResolvers<Response>();
		const { store, calls } = harness([gate.promise]);
		const first = store.setThinking("low", "medium");
		expect(store.getSnapshot().busy).toBe("thinking");
		expect(await store.setThinking("max", "medium")).toBe(false);
		expect(await store.setModel("anthropic/claude-opus-5-5", "claude-sonnet-5-5", null)).toBe(false);
		gate.resolve(new Response(null, { status: 204 }));
		await first;
		expect(calls).toHaveLength(1);
		expect(store.getSnapshot().thinking?.value).toBe("low");
	});

	it("applies the model the daemon resolved and the thinking level it clamped to", async () => {
		const { store, calls, events } = harness([json({ agentId: "main", model: "anthropic/claude-opus-5-5", thinkingLevel: "high" })]);
		await store.setModel("plan", "claude-sonnet-5-5", null);
		expect(calls[0]).toEqual({ url: "/api/sessions/sess%2F1/agents/main/model", method: "POST", body: { selector: "plan" } });
		const snap = store.getSnapshot();
		expect(snap.model).toEqual({ value: "anthropic/claude-opus-5-5", baseline: "claude-sonnet-5-5" });
		expect(snap.thinking?.value).toBe("high");
		expect(snap.note).toContain("anthropic/claude-opus-5-5");
		expect(events[0]).toMatchObject({ feature: "1.9.model", outcome: "ok", detail: "plan" });
	});

	it("maps a refused model change to the sentence for the model control and leaves thinking alone", async () => {
		const { store } = harness([apiError(400, "google/gemini-3-pro is unavailable")]);
		await store.setModel("google/gemini-3-pro", "claude-sonnet-5-5", null);
		const snap = store.getSnapshot();
		expect(snap.error).toEqual({ control: "model", message: "The daemon did not accept that model: google/gemini-3-pro is unavailable" });
		expect(snap.model).toBeNull();
	});
});
