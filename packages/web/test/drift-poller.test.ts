import { describe, expect, it } from "bun:test";
import type { DriftSuggestion } from "@omp-console/protocol";
import { DriftPoller, shouldPollDrift } from "../src/components/safety/drift-poller";

const SUGGESTION: DriftSuggestion = {
	id: "d1",
	sessionId: "s1",
	sourceRoot: "/work/app",
	markers: ["package.json"],
	suggestedSlug: "app",
	files: 3,
	bytes: 30,
	excluded: [],
};

interface Harness {
	poller: DriftPoller;
	calls: string[];
	results: Array<DriftSuggestion | null>;
	errors: unknown[];
	timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
	resolveNext(value: DriftSuggestion | null): void;
	state: { visible: boolean };
}

function harness(options: { reject?: boolean } = {}): Harness {
	const calls: string[] = [];
	const results: Array<DriftSuggestion | null> = [];
	const errors: unknown[] = [];
	const timers: Harness["timers"] = [];
	const pending: Array<(value: DriftSuggestion | null) => void> = [];
	const state = { visible: true };
	const poller = new DriftPoller({
		api: {
			drift(sessionId) {
				calls.push(sessionId);
				if (options.reject) return Promise.reject(new Error("daemon down"));
				const { promise, resolve } = Promise.withResolvers<DriftSuggestion | null>();
				pending.push(resolve);
				return promise;
			},
		},
		sessionId: "s1",
		intervalMs: 4_000,
		isVisible: () => state.visible,
		onResult: value => results.push(value),
		onError: err => errors.push(err),
		schedule(fn, ms) {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	});
	return { poller, calls, results, errors, timers, resolveNext: value => pending.shift()?.(value), state };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("shouldPollDrift", () => {
	it("polls knowledge sessions only", () => {
		expect(shouldPollDrift("knowledge")).toBe(true);
		for (const kind of ["project", "scratch", undefined] as const) expect(shouldPollDrift(kind)).toBe(false);
	});
});

describe("DriftPoller", () => {
	it("asks at once, waits for the answer before arming the next tick, then repeats on the interval", async () => {
		const h = harness();
		h.poller.start();
		h.poller.start();
		expect(h.calls).toEqual(["s1"]);
		expect(h.timers).toHaveLength(0);
		h.resolveNext(SUGGESTION);
		await settle();
		expect(h.results).toEqual([SUGGESTION]);
		expect(h.timers).toHaveLength(1);
		expect(h.timers[0]!.ms).toBe(4_000);
		h.timers[0]!.fn();
		await settle();
		expect(h.calls).toEqual(["s1", "s1"]);
		h.resolveNext(null);
		await settle();
		expect(h.results).toEqual([SUGGESTION, null]);
	});

	it("sends no request while the page is hidden but keeps the schedule alive", async () => {
		const h = harness();
		h.state.visible = false;
		h.poller.start();
		await settle();
		expect(h.calls).toEqual([]);
		expect(h.timers).toHaveLength(1);
		h.state.visible = true;
		h.timers[0]!.fn();
		await settle();
		expect(h.calls).toEqual(["s1"]);
	});

	it("drops an answer that arrives after stop and leaves no timer behind", async () => {
		const h = harness();
		h.poller.start();
		h.poller.stop();
		h.resolveNext(SUGGESTION);
		await settle();
		expect(h.results).toEqual([]);
		expect(h.timers.every(t => t.cancelled) || h.timers.length === 0).toBe(true);
		expect(h.poller.running).toBe(false);
	});

	it("reports a failing daemon and keeps polling", async () => {
		const h = harness({ reject: true });
		h.poller.start();
		await settle();
		expect(h.errors).toHaveLength(1);
		expect(h.timers).toHaveLength(1);
		expect(h.results).toEqual([]);
	});
});
