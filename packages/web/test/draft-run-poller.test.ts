import { describe, expect, it } from "bun:test";
import type { DraftRun } from "@omp-console/protocol";
import { DraftRunPoller, type PollerTimers } from "../src/components/plan/draft-run-poller";

function run(state: DraftRun["state"]): DraftRun {
	return { runId: "r", sessionId: "s", plan: { name: "p", nodes: [] }, nodes: [], state, startedAt: 0 };
}

/** Hand-cranked interval: `tick()` fires the callback once if the interval is live. */
function manualTimers(): PollerTimers & { live(): number; tick(): void } {
	const handles = new Map<number, () => void>();
	let next = 1;
	return {
		set(fn) {
			handles.set(next, fn);
			return next++;
		},
		clear(handle) {
			handles.delete(handle as number);
		},
		live: () => handles.size,
		tick: () => {
			for (const fn of [...handles.values()]) fn();
		},
	};
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

describe("draft run polling", () => {
	it("polls every tick while a run is active and stops by itself once none is", async () => {
		const timers = manualTimers();
		const answers: DraftRun["state"][] = ["running", "running", "done"];
		let calls = 0;
		const seen: string[] = [];
		const poller = new DraftRunPoller({
			list: async () => [run(answers[Math.min(calls++, answers.length - 1)]!)],
			onRuns: runs => seen.push(runs[0]!.state),
			onError: () => {},
			timers,
		});
		await poller.refresh();
		expect(poller.polling).toBe(true);
		timers.tick();
		await settle();
		timers.tick();
		await settle();
		expect(seen).toEqual(["running", "running", "done"]);
		expect(poller.polling).toBe(false);
		expect(timers.live()).toBe(0);
		timers.tick();
		await settle();
		expect(calls).toBe(3);
	});

	it("does not poll at all when the session has no active run", async () => {
		const timers = manualTimers();
		const poller = new DraftRunPoller({ list: async () => [run("done")], onRuns: () => {}, onError: () => {}, timers });
		await poller.refresh();
		expect(timers.live()).toBe(0);
	});

	it("keeps one request in flight however slow the daemon is", async () => {
		const timers = manualTimers();
		let calls = 0;
		const gate = Promise.withResolvers<void>();
		const poller = new DraftRunPoller({
			list: async () => {
				calls++;
				if (calls === 2) await gate.promise;
				return [run("running")];
			},
			onRuns: () => {},
			onError: () => {},
			timers,
		});
		await poller.refresh();
		timers.tick(); // call 2, stuck
		timers.tick();
		timers.tick();
		await settle();
		expect(calls).toBe(2);
		gate.resolve();
		await settle();
		timers.tick();
		await settle();
		expect(calls).toBe(3);
	});

	it("keeps polling a live run through a failed call and clears the error on the next good one", async () => {
		const timers = manualTimers();
		let calls = 0;
		const errors: unknown[] = [];
		const poller = new DraftRunPoller({
			list: async () => {
				if (++calls === 2) throw new Error("daemon restarting");
				return [run("running")];
			},
			onRuns: () => {},
			onError: e => errors.push(e),
			timers,
		});
		await poller.refresh();
		timers.tick();
		await settle();
		timers.tick();
		await settle();
		expect(errors.map(e => (e instanceof Error ? e.message : e))).toEqual([null, "daemon restarting", null]);
		expect(poller.polling).toBe(true);
	});

	it("leaves no timer and ignores a reply that lands after stop()", async () => {
		const timers = manualTimers();
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		const seen: number[] = [];
		const poller = new DraftRunPoller({
			list: async () => {
				if (++calls === 2) await gate.promise;
				return [run("running")];
			},
			onRuns: runs => seen.push(runs.length),
			onError: () => {},
			timers,
		});
		await poller.refresh();
		timers.tick();
		poller.stop();
		expect(timers.live()).toBe(0);
		gate.resolve();
		await settle();
		expect(seen).toEqual([1]);
		await poller.refresh();
		expect(calls).toBe(2);
	});
});
