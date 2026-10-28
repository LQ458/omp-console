import { describe, expect, it } from "bun:test";
import type { PushPayload } from "@omp-console/protocol";
import { type AlertInput, AlertStore, alertFromPush, alertFromSignal, MAX_ALERTS } from "../src/lib/alerts";
import { alertDisplayText } from "../src/components/shell/Alerts";
import type { NotifySignal } from "../src/lib/notifications";
import { handleServiceWorkerMessage } from "../src/lib/sw-messages";

function input(tag: string, extra: Partial<AlertInput> = {}): AlertInput {
	return { tag, sessionId: tag.split(":")[0]!, title: "t", body: "b", level: "info", ttlMs: 1000, ...extra };
}

function signal(sessionId: string, reason: NotifySignal["reason"]): NotifySignal {
	return { sessionId, reason, title: `title-${sessionId}`, body: "", tag: `${sessionId}:${reason}`, hidden: false, deliveredToAndroid: false };
}

function push(sessionId: string, reason: PushPayload["reason"]): PushPayload {
	return { reason, sessionId, title: `title-${sessionId}`, body: "body", tag: `${sessionId}:${reason}`, url: `/#session=${sessionId}` };
}

describe("AlertStore", () => {
	it("shows one alert per tag: a signal and the push for the same event do not stack", () => {
		const store = new AlertStore();
		store.push(input("a:turn-finished", { body: "from the poll" }));
		store.push(input("a:turn-finished", { body: "from the push" }));
		expect(store.getSnapshot().map(a => a.body)).toEqual(["from the push"]);
	});

	it("keeps the newest few and notifies on dismiss only when something was removed", () => {
		const store = new AlertStore();
		let notified = 0;
		store.subscribe(() => notified++);
		const ids = Array.from({ length: MAX_ALERTS + 2 }, (_, i) => store.push(input(`s${i}:turn-finished`)).id);
		expect(store.getSnapshot()).toHaveLength(MAX_ALERTS);
		expect(store.getSnapshot().map(a => a.id)).toEqual(ids.slice(-MAX_ALERTS));
		const before = notified;
		store.dismiss(ids[0]!); // already evicted
		expect(notified).toBe(before);
		store.dismiss(ids.at(-1)!);
		expect(store.getSnapshot()).toHaveLength(MAX_ALERTS - 1);
		expect(notified).toBe(before + 1);
	});
});

describe("alert sources", () => {
	it("a background session's finished turn and ask become alerts; the open session's do not", () => {
		expect(alertFromSignal(signal("bg", "turn-finished"), "open")).toMatchObject({ body: "Turn finished", level: "info", sessionId: "bg" });
		expect(alertFromSignal(signal("bg", "needs-answer"), "open")).toMatchObject({ body: "Needs your answer", level: "warning" });
		expect(alertFromSignal(signal("open", "turn-finished"), "open")).toBeNull();
	});

	it("a push for the open session stays quiet, except a crash", () => {
		expect(alertFromPush(push("open", "turn-finished"), "open")).toBeNull();
		expect(alertFromPush(push("open", "needs-approval"), "open")).toBeNull();
		expect(alertFromPush(push("open", "worker-crashed"), "open")).toMatchObject({ level: "error" });
		expect(alertFromPush(push("bg", "needs-approval"), "open")).toMatchObject({ level: "warning", body: "body" });
	});
});

describe("handleServiceWorkerMessage", () => {
	const origin = "https://omp-console.example";
	function harness(openSessionId: string | null = null) {
		const hashes: string[] = [];
		const alerts: AlertInput[] = [];
		return {
			hashes,
			alerts,
			handle: (data: unknown) =>
				handleServiceWorkerMessage(data, {
					origin,
					openSessionId: () => openSessionId,
					setHash: hash => hashes.push(hash),
					showAlert: alert => alerts.push(alert),
				}),
		};
	}

	it("omp-console:open applies only the hash of a same-origin address, so the session deep link fires without a reload", () => {
		const h = harness();
		expect(h.handle({ type: "omp-console:open", url: "/#session=abc" })).toBe(true);
		expect(h.handle({ type: "omp-console:open", url: `${origin}/?x=1#session=def` })).toBe(true);
		expect(h.hashes).toEqual(["#session=abc", "#session=def"]);
	});

	it("omp-console:open ignores another origin, a missing hash and garbage", () => {
		const h = harness();
		h.handle({ type: "omp-console:open", url: "https://evil.example/#session=abc" });
		h.handle({ type: "omp-console:open", url: "/" });
		h.handle({ type: "omp-console:open", url: "http://[" });
		expect(h.hashes).toEqual([]);
	});

	it("omp-console:push shows an alert for a background session and ignores unrelated messages", () => {
		const h = harness("open");
		expect(h.handle({ type: "omp-console:push", payload: push("bg", "turn-finished") })).toBe(true);
		expect(h.alerts.map(a => a.sessionId)).toEqual(["bg"]);
		expect(h.handle({ type: "something-else" })).toBe(false);
		expect(h.handle(null)).toBe(false);
		expect(h.alerts).toHaveLength(1);
	});
});

describe("finished alert presentation", () => {
	it("names the session without repeating the generic body and keeps an available result", () => {
		expect(alertDisplayText({ tag: "parallel-2:turn-finished", title: "parallel-2", body: "Turn finished" })).toEqual({
			title: "parallel-2 finished",
			body: "",
		});
		expect(alertDisplayText({ tag: "parallel-2:turn-finished", title: "parallel-2", body: "1 test, OK" })).toEqual({
			title: "parallel-2 finished",
			body: "1 test, OK",
		});
	});

	it("leaves non-finished alert titles and bodies unchanged", () => {
		expect(alertDisplayText({ tag: "parallel-2:needs-answer", title: "parallel-2", body: "Needs your answer" })).toEqual({
			title: "parallel-2",
			body: "Needs your answer",
		});
	});
});
