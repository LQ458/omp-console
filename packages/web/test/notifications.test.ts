import { describe, expect, it } from "bun:test";
import type { SessionSummary } from "@omp-console/protocol";
import {
	type OmpConsoleAndroidBridge,
	type GuestView,
	NotificationSignals,
	type NotifyEnv,
	type NotifySignal,
} from "../src/lib/notifications";

interface Harness {
	signals: NotificationSignals;
	seen: NotifySignal[];
	bridged: { title: string; body: string; tag: string | undefined }[];
	env: { hidden: boolean; bridge: OmpConsoleAndroidBridge | undefined };
}

function harness(options: { bridge?: boolean; hidden?: boolean } = {}): Harness {
	const bridged: Harness["bridged"] = [];
	const env = {
		hidden: options.hidden ?? true,
		bridge:
			options.bridge === false
				? undefined
				: ({
						available: true,
						version: 1,
						notify(title: string, body: string, tag?: string): boolean {
							bridged.push({ title, body, tag });
							return true;
						},
					} satisfies OmpConsoleAndroidBridge),
	};
	const notifyEnv: NotifyEnv = { isHidden: () => env.hidden, bridge: () => env.bridge };
	const signals = new NotificationSignals(notifyEnv);
	const seen: NotifySignal[] = [];
	signals.subscribe(signal => seen.push(signal));
	return { signals, seen, bridged, env };
}

const live = (working: boolean, ask: GuestView["ask"] = null): GuestView => ({ phase: "live", working, ask });

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		title: `session ${id}`,
		cwd: "/work",
		state: "idle",
		createdAt: 0,
		lastActivityAt: 0,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...overrides,
	};
}

describe("turn-finished from the connected guest", () => {
	it("notifies the Android bridge once, with a per-session tag, only while the page is hidden", () => {
		const h = harness({ hidden: false });
		h.signals.observeGuest("s1", "Refactor", live(false));
		h.signals.observeGuest("s1", "Refactor", live(true));
		h.signals.observeGuest("s1", "Refactor", live(false)); // finished while the page is visible
		expect(h.seen.map(s => [s.reason, s.hidden, s.deliveredToAndroid])).toEqual([["turn-finished", false, false]]);
		expect(h.bridged).toEqual([]);

		h.env.hidden = true;
		h.signals.observeGuest("s1", "Refactor", live(true));
		h.signals.observeGuest("s1", "Refactor", live(false));
		expect(h.bridged).toEqual([{ title: "Refactor", body: "Turn finished", tag: "s1:turn-finished" }]);
		expect(h.seen.at(-1)).toMatchObject({ tag: "s1:turn-finished", hidden: true, deliveredToAndroid: true });
	});

	it("does not repeat while idle, and does not fire for a session that was already idle when first seen", () => {
		const h = harness();
		h.signals.observeGuest("s1", "A", live(false));
		h.signals.observeGuest("s1", "A", live(false));
		h.signals.observeGuest("s1", "A", live(true));
		h.signals.observeGuest("s1", "A", live(false));
		h.signals.observeGuest("s1", "A", live(false));
		expect(h.seen).toHaveLength(1);
	});

	it("catches a turn that ended during a reconnect, and ignores states seen before the connection is live", () => {
		const h = harness();
		h.signals.observeGuest("s1", "A", live(true));
		h.signals.observeGuest("s1", "A", { phase: "reconnecting", working: false, ask: null });
		expect(h.seen).toHaveLength(0);
		h.signals.observeGuest("s1", "A", live(false));
		expect(h.seen).toHaveLength(1);
	});

	it("works without an Android bridge and survives a throwing bridge or subscriber", () => {
		const none = harness({ bridge: false });
		none.signals.observeGuest("s1", "A", live(true));
		none.signals.observeGuest("s1", "A", live(false));
		expect(none.seen[0]?.deliveredToAndroid).toBe(false);

		const broken = harness();
		broken.env.bridge = {
			available: true,
			version: 1,
			notify() {
				throw new Error("bridge gone");
			},
		};
		broken.signals.subscribe(() => {
			throw new Error("listener bug");
		});
		broken.signals.observeGuest("s1", "A", live(true));
		broken.signals.observeGuest("s1", "A", live(false));
		expect(broken.seen).toHaveLength(1);
		expect(broken.seen[0]?.deliveredToAndroid).toBe(false);
	});
});

describe("needs-answer", () => {
	it("fires per pending ask: once while it is pending, again for a replacement ask or after it was answered", () => {
		const h = harness();
		h.signals.observeGuest("s1", "A", live(true));
		h.signals.observeGuest("s1", "A", live(true, { reqId: 7, title: "Overwrite config?" }));
		h.signals.observeGuest("s1", "A", live(true, { reqId: 7, title: "Overwrite config?" }));
		expect(h.seen.map(s => s.body)).toEqual(["Overwrite config?"]);

		h.signals.observeGuest("s1", "A", live(true, { reqId: 8, title: "Which branch?" }));
		expect(h.seen.map(s => s.body)).toEqual(["Overwrite config?", "Which branch?"]);

		h.signals.observeGuest("s1", "A", live(true)); // answered
		h.signals.observeGuest("s1", "A", live(true, { reqId: 9, title: "Which branch?" }));
		expect(h.seen).toHaveLength(3);
		expect(h.bridged.map(b => b.tag)).toEqual(["s1:needs-answer", "s1:needs-answer", "s1:needs-answer"]);
	});

	it("stays quiet for an ask that was already pending when the session was opened", () => {
		const h = harness();
		h.signals.observeGuest("s1", "A", live(true, { reqId: 3, title: "Proceed?" }));
		h.signals.observeGuest("s1", "A", live(true, { reqId: 3, title: "Proceed?" }));
		expect(h.seen).toHaveLength(0);
	});

	it("re-posts a one-tap question with answer buttons on Android, and drops them once the question changed", async () => {
		const posted: { tag?: string; actions?: Array<{ title: string; value: string; token: string }> }[] = [];
		let resolveOptions: (value: { choices: string[]; answerToken: string } | null) => void = () => {};
		const env: NotifyEnv = {
			isHidden: () => true,
			bridge: () => ({
				available: true,
				version: 1,
				notify(_title, _body, tag, actions) {
					posted.push({ tag, actions });
					return true;
				},
			}),
			answerOptions: () => {
				const { promise, resolve } = Promise.withResolvers<{ choices: string[]; answerToken: string } | null>();
				resolveOptions = resolve;
				return promise;
			},
		};
		const globals = globalThis as { window?: unknown };
		const hadWindow = "window" in globals;
		const savedWindow = globals.window;
		if (!hadWindow) globals.window = { location: { origin: "https://deck.test" } };
		try {
			const signals = new NotificationSignals(env);
			signals.observeGuest("s1", "A", live(true));
			signals.observeGuest("s1", "A", live(true, { reqId: 7, title: "Overwrite config?" }));
			expect(posted).toEqual([{ tag: "s1:needs-answer", actions: undefined }]);
			resolveOptions({ choices: ["Approve", "Deny"], answerToken: "tok" });
			await Promise.resolve();
			await Promise.resolve();
			expect(posted.at(-1)?.actions?.map(action => [action.title, action.token])).toEqual([
				["Approve", "tok"],
				["Deny", "tok"],
			]);

			// A newer question replaced it before its options arrived: the stale buttons are never shown.
			signals.observeGuest("s1", "A", live(true, { reqId: 8, title: "Which branch?" }));
			const before = posted.length;
			const stale = resolveOptions;
			signals.observeGuest("s1", "A", live(true, { reqId: 9, title: "Which file?" }));
			stale({ choices: ["a"], answerToken: "old" });
			await Promise.resolve();
			await Promise.resolve();
			expect(posted.slice(before).every(entry => entry.actions === undefined)).toBe(true);
		} finally {
			if (!hadWindow) delete globals.window;
			else globals.window = savedWindow;
		}
	});
});

describe("signals for sessions without a live guest (daemon poll)", () => {
	it("derives both reasons from state transitions and ignores a stopped session", () => {
		const h = harness();
		h.signals.observeSummaries([summary("a"), summary("b", { state: "streaming" })]);
		h.signals.observeSummaries([summary("a", { state: "asking", awaitingAnswer: true }), summary("b")]);
		expect(h.seen.map(s => `${s.sessionId}:${s.reason}`).sort()).toEqual(["a:needs-answer", "b:turn-finished"]);

		h.signals.observeSummaries([summary("a", { state: "asking", awaitingAnswer: true }), summary("b")]);
		expect(h.seen).toHaveLength(2); // repeated polls do not repeat

		h.signals.observeSummaries([summary("a", { state: "stopped" }), summary("b", { state: "streaming" })]);
		h.signals.observeSummaries([summary("a", { state: "stopped" }), summary("b", { state: "stopped" })]);
		expect(h.seen).toHaveLength(2); // a user stopping a session is not a finished turn
	});

	it("does not double-notify for the session the live guest already reported", () => {
		const h = harness();
		h.signals.observeSummaries([summary("a", { state: "streaming" })]);
		h.signals.observeGuest("a", "A", live(true));
		h.signals.observeGuest("a", "A", live(false));
		expect(h.seen).toHaveLength(1);
		// the poll still says streaming (it lags the socket), then idle: both are ignored for "a"
		h.signals.observeSummaries([summary("a", { state: "streaming" })]);
		h.signals.observeSummaries([summary("a")]);
		expect(h.seen).toHaveLength(1);
	});

	it("hands a session back to the poll once its guest view is released", () => {
		const h = harness();
		h.signals.observeGuest("a", "A", live(false));
		h.signals.releaseGuest("a");
		h.signals.observeSummaries([summary("a", { state: "streaming" })]);
		h.signals.observeSummaries([summary("a")]);
		expect(h.seen.map(s => s.reason)).toEqual(["turn-finished"]);
	});
});
