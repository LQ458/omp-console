import { describe, expect, it } from "bun:test";
import type { JournalEvent } from "@omp-console/protocol";
import { buildFeedback, submitFeedback } from "../src/lib/feedback";
import {
	daemonTransport,
	installJournalLifecycle,
	journal,
	type JournalTransport,
	MAX_BUFFER,
	sanitizeEvent,
	UsageJournal,
} from "../src/lib/journal";

function harness(options: { failSends?: number } = {}) {
	const sent: JournalEvent[][] = [];
	const hidden: JournalEvent[][] = [];
	let failures = options.failSends ?? 0;
	const transport: JournalTransport = {
		send: async events => {
			if (failures > 0) {
				failures--;
				throw new Error("daemon unreachable");
			}
			sent.push(events);
		},
		sendOnHide: events => {
			hidden.push(events);
		},
	};
	let fire: (() => void) | null = null;
	let clock = 1_000;
	const j = new UsageJournal({
		now: () => clock++,
		schedule: fn => {
			fire = fn;
			return () => {
				if (fire === fn) fire = null;
			};
		},
	});
	j.bind(transport);
	return { j, sent, hidden, tick: () => fire?.(), armed: () => fire !== null };
}

const ev = (action: string) => ({ feature: "5.2.palette", action, outcome: "ok" as const });

describe("usage journal batching", () => {
	it("sends nothing until the 5 s timer fires, then sends everything queued in one batch, in order", async () => {
		const { j, sent, tick } = harness();
		j.record(ev("open"));
		j.record(ev("run"));
		expect(sent).toHaveLength(0);
		tick();
		await j.flush();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.map(e => e.action)).toEqual(["open", "run"]);
		expect(j.pending).toBe(0);
	});

	it("flushes at 50 events without waiting for the timer", async () => {
		const { j, sent } = harness();
		for (let i = 0; i < 50; i++) j.record(ev(`a${i}`));
		await j.flush();
		expect(sent.flat()).toHaveLength(50);
		expect(sent[0]?.[0]?.action).toBe("a0");
	});

	it("keeps events when the daemon is down and delivers them, oldest first, on the next flush", async () => {
		const { j, sent, tick, armed } = harness({ failSends: 1 });
		j.record(ev("one"));
		tick();
		await Bun.sleep(0);
		expect(sent).toHaveLength(0);
		expect(j.pending).toBe(1);
		expect(armed()).toBe(true);
		j.record(ev("two"));
		await j.flush();
		expect(sent.flat().map(e => e.action)).toEqual(["one", "two"]);
	});

	it("bounds the buffer while the daemon stays down, dropping the oldest", async () => {
		const { j } = harness({ failSends: 1_000 });
		for (let i = 0; i < MAX_BUFFER + 25; i++) j.record(ev(`e${i}`));
		await j.flush();
		expect(j.pending).toBe(MAX_BUFFER);
	});

	it("queues events recorded before a transport is bound and sends them once it is", async () => {
		const j = new UsageJournal({ schedule: () => () => {} });
		j.record(ev("early"));
		const sent: JournalEvent[][] = [];
		j.bind({ send: async e => void sent.push(e), sendOnHide: () => {} });
		await j.flush();
		expect(sent.flat().map(e => e.action)).toEqual(["early"]);
	});

	it("hands the whole queue to the keepalive path when the page is hidden, and empties it", () => {
		const { j, sent, hidden } = harness();
		j.record(ev("a"));
		j.record(ev("b"));
		j.flushOnHide();
		expect(hidden.flat().map(e => e.action)).toEqual(["a", "b"]);
		expect(sent).toHaveLength(0);
		expect(j.pending).toBe(0);
	});

	it("flushes on visibilitychange to hidden and on pagehide, but not when the page becomes visible", () => {
		const { j, hidden } = harness();
		const listeners = new Map<string, () => void>();
		const doc = {
			visibilityState: "visible",
			addEventListener: (type: string, fn: () => void) => void listeners.set(`doc:${type}`, fn),
			removeEventListener: () => {},
		};
		const win = {
			addEventListener: (type: string, fn: () => void) => void listeners.set(`win:${type}`, fn),
			removeEventListener: () => {},
		};
		installJournalLifecycle(doc as unknown as Document, win as unknown as Window, j);
		j.record(ev("x"));
		listeners.get("doc:visibilitychange")?.();
		expect(hidden).toHaveLength(0);
		doc.visibilityState = "hidden";
		listeners.get("doc:visibilitychange")?.();
		expect(hidden.flat().map(e => e.action)).toEqual(["x"]);
		j.record(ev("y"));
		listeners.get("win:pagehide")?.();
		expect(hidden.flat().map(e => e.action)).toEqual(["x", "y"]);
	});

	it("applies the session and screen context to events that carry none", async () => {
		const { j, sent } = harness();
		j.setContext({ sessionId: "s1", screen: "session" });
		j.record(ev("a"));
		j.record({ ...ev("b"), screen: "catalog" });
		await j.flush();
		expect(sent[0]?.map(e => [e.sessionId, e.screen])).toEqual([
			["s1", "session"],
			["s1", "catalog"],
		]);
	});
});

describe("journal never carries content", () => {
	it("drops every field the protocol does not define, so prompt text cannot ride along", () => {
		const dirty = {
			...ev("run"),
			text: "please delete my prod database",
			prompt: "secret",
			args: "soft",
		};
		const clean = sanitizeEvent(dirty, 5);
		expect(Object.keys(clean).sort()).toEqual(["action", "at", "feature", "outcome"]);
		expect(JSON.stringify(clean)).not.toContain("prod database");
	});

	it("bounds and flattens detail so a long free-text value cannot be smuggled through it", () => {
		const clean = sanitizeEvent({ ...ev("run"), detail: `compact\n${"x".repeat(500)}` }, 1);
		expect(clean.detail?.includes("\n")).toBe(false);
		expect(clean.detail?.length).toBeLessThanOrEqual(80);
	});

	it("repairs an invalid outcome and via instead of forwarding them", () => {
		const clean = sanitizeEvent({ ...ev("a"), outcome: "weird" as "ok", via: "elsewhere" as "direct" }, 1);
		expect(clean.outcome).toBe("ok");
		expect(clean.via).toBeUndefined();
	});

	it("keeps the feedback text out of the journal event that accompanies it", async () => {
		const captured: JournalEvent[] = [];
		const restore = journal.bind.bind(journal);
		journal.bind({ send: async events => void captured.push(...events), sendOnHide: () => {} });
		const posted: string[] = [];
		await submitFeedback(
			{ recordFeedback: async entry => void posted.push(entry.text) },
			{ screen: "catalog", feature: "0.1.catalog", text: "the Try button did nothing for /compact" },
		);
		await journal.flush();
		restore(null);
		expect(posted).toEqual(["the Try button did nothing for /compact"]);
		expect(captured.map(e => `${e.feature}:${e.action}:${e.outcome}:${e.detail}`)).toContain("0.6.feedback:submit:ok:0.1.catalog");
		expect(JSON.stringify(captured)).not.toContain("Try button");
	});

	it("rejects an empty feedback note without posting", async () => {
		let calls = 0;
		const sent = await submitFeedback({ recordFeedback: async () => void calls++ }, { screen: "catalog", text: "   " });
		expect(sent).toBe(false);
		expect(calls).toBe(0);
		expect(buildFeedback({ screen: "x", text: "  hi  " }, 9)).toEqual({ at: 9, screen: "x", text: "hi" });
	});
});

describe("daemon transport", () => {
	it("sends on hide with fetch keepalive and a JSON body of the events", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const transport = daemonTransport(
			{ recordJournal: async () => {} },
			async (url, init) => {
				calls.push({ url, init });
				return new Response(null, { status: 204 });
			},
		);
		transport.sendOnHide([{ at: 1, feature: "f", action: "a", outcome: "ok" }]);
		await Bun.sleep(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/journal");
		expect(calls[0]?.init?.keepalive).toBe(true);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ events: [{ at: 1, feature: "f", action: "a", outcome: "ok" }] });
	});
});
