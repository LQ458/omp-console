import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { GraphLayout } from "../src/lib/agent-graph";
import {
	aggregateMessageEdges,
	extractIrcEvents,
	IrcTail,
	type IrcEvent,
	mergeIrcEvents,
	placeMessageEdges,
	resolveAgentId,
} from "../src/lib/message-edges";

const T0 = Date.parse("2026-10-23T10:00:00.000Z");
let seq = 0;

function stamp(at: number): string {
	return new Date(at).toISOString();
}

function custom(at: number, customType: string, details: Record<string, unknown>): SessionEntry {
	return { id: `c${++seq}`, parentId: null, timestamp: stamp(at), type: "custom_message", customType, content: "x", details, display: true };
}

function toolResult(at: number, toolName: string, details: unknown, isError = false): SessionEntry {
	return {
		id: `r${++seq}`,
		parentId: null,
		timestamp: stamp(at),
		type: "message",
		message: { role: "toolResult", toolCallId: `t${seq}`, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: at },
	};
}

function send(at: number, from: string, to: string, receipts: Array<{ to: string; outcome: string }>, isError = false): SessionEntry {
	return toolResult(at, "write", { message: { op: "send", from, to, receipts } }, isError);
}

describe("IRC facts in a transcript", () => {
	it("reads incoming messages, relays, sends and consumed waits, each as one directed event", () => {
		const entries = [
			custom(T0, "irc:incoming", { id: "i1", from: "RelayProbe", message: "hi", replyTo: "m0" }),
			custom(T0 + 1000, "irc:relay", { from: "A", to: "B", body: "x" }),
			send(T0 + 2000, "Main", "Planner", [{ to: "Planner", outcome: "injected" }]),
			toolResult(T0 + 3000, "wait", { op: "wait", waited: { id: "w1", from: "DocSweep", to: "Main", body: "b", ts: T0 + 2500 } }),
			toolResult(T0 + 4000, "read", { something: "else" }),
		];
		const events = extractIrcEvents("Main", entries);
		expect(events.map(e => `${e.from}>${e.to}${e.replyTo ? "<" + e.replyTo : ""}${e.id ? "#" + e.id : ""}`)).toEqual([
			"RelayProbe>Main<m0#i1",
			"A>B",
			"Main>Planner",
			"DocSweep>Main#w1",
		]);
		expect(events[3]!.at).toBe(T0 + 2500);
	});

	it("expands a broadcast to the peers that received it and drops failed deliveries", () => {
		const events = extractIrcEvents("Main", [
			send(T0, "Main", "all", [
				{ to: "A", outcome: "injected" },
				{ to: "B", outcome: "failed" },
				{ to: "Main", outcome: "injected" },
				{ to: "C", outcome: "woken" },
			]),
			send(T0 + 1000, "Main", "D", [{ to: "D", outcome: "failed" }]),
			send(T0 + 2000, "Main", "E", [], true),
		]);
		expect(events.map(e => `${e.to}:${e.broadcast}`)).toEqual(["A:true", "C:true"]);
	});
});

describe("one message, several recordings", () => {
	const at = (event: IrcEvent[]): number => event.length;

	it("folds the sender's send, the recipient's delivery and the main UI relay into one event", () => {
		const sent = extractIrcEvents("RelayProbe", [send(T0, "RelayProbe", "DocSweep", [{ to: "DocSweep", outcome: "injected" }])]);
		const got = extractIrcEvents("DocSweep", [custom(T0 + 800, "irc:incoming", { id: "i9", from: "RelayProbe", message: "m", replyTo: "i8" })]);
		const relayed = extractIrcEvents("Main", [custom(T0 + 400, "irc:relay", { from: "RelayProbe", to: "DocSweep", body: "m" })]);
		const merged = mergeIrcEvents([...sent, ...got, ...relayed]);
		expect(at(merged)).toBe(1);
		expect(merged[0]).toMatchObject({ from: "RelayProbe", to: "DocSweep", id: "i9", replyTo: "i8" });
		expect(merged[0]!.origins.sort()).toEqual(["DocSweep:incoming", "Main:relay", "RelayProbe:send"]);
	});

	it("counts two real messages in a row, even within the merge window, because one transcript recorded both", () => {
		const twice = extractIrcEvents("Main", [
			send(T0, "Main", "Planner", [{ to: "Planner", outcome: "injected" }]),
			send(T0 + 3000, "Main", "Planner", [{ to: "Planner", outcome: "injected" }]),
		]);
		expect(mergeIrcEvents(twice)).toHaveLength(2);
	});

	it("keeps same-direction messages apart when they are further apart than the window", () => {
		const a = extractIrcEvents("X", [send(T0, "X", "Y", [{ to: "Y", outcome: "injected" }])]);
		const b = extractIrcEvents("Y", [custom(T0 + 60_000, "irc:incoming", { id: "i2", from: "X", message: "later" })]);
		expect(mergeIrcEvents([...a, ...b])).toHaveLength(2);
	});
});

describe("edges for the graph", () => {
	const ids = new Set(["main", "A", "B"]);

	it("counts per direction and kind, maps Main to the main agent and drops agents the graph does not have", () => {
		const events: IrcEvent[] = [
			{ from: "Main", to: "A", at: T0, broadcast: false, origins: ["m:1"] },
			{ from: "Main", to: "A", at: T0 + 60_000, broadcast: false, origins: ["m:1"] },
			{ from: "A", to: "Main", at: T0 + 90_000, broadcast: false, replyTo: "x", id: "r1", origins: ["m:2"] },
			{ from: "Main", to: "B", at: T0 + 120_000, broadcast: true, origins: ["m:3"] },
			{ from: "Ghost", to: "A", at: T0 + 150_000, broadcast: false, origins: ["m:4"] },
			{ from: "A", to: "all", at: T0 + 180_000, broadcast: false, origins: ["m:5"] },
		];
		const edges = aggregateMessageEdges(events, ids, "main");
		expect(edges.map(e => `${e.from}>${e.to}:${e.kind}x${e.count}`)).toEqual([
			"A>main:replyx1",
			"main>A:messagex2",
			"main>B:broadcastx1",
		]);
		expect(edges.find(e => e.from === "main" && e.to === "A")!.lastAt).toBe(T0 + 60_000);
	});

	it("resolves ids exactly first, then case-insensitively, and refuses unknowns", () => {
		expect(resolveAgentId("A", ids, "main")).toBe("A");
		expect(resolveAgentId("a", ids, "main")).toBe("A");
		expect(resolveAgentId("Main", ids, "main")).toBe("main");
		expect(resolveAgentId("Z", ids, "main")).toBeUndefined();
	});
});

describe("reading a subagent transcript incrementally", () => {
	const line = (entry: SessionEntry): string => `${JSON.stringify(entry)}\n`;

	it("reads IRC facts across chunks that split a line, once each", () => {
		const text =
			line(custom(T0, "irc:incoming", { id: "a", from: "P", message: "1" })) +
			line(custom(T0 + 60_000, "irc:incoming", { id: "b", from: "P", message: "2" }));
		const cut = text.indexOf("\n") + 20;
		const tail = new IrcTail("Q");
		expect(tail.apply({ kind: "rows", text: text.slice(0, cut), newSize: cut })).toBe(true);
		expect(tail.events).toHaveLength(1);
		expect(tail.apply({ kind: "rows", text: text.slice(cut), newSize: text.length })).toBe(true);
		expect(tail.events.map(e => e.id)).toEqual(["a", "b"]);
		expect(tail.cursor).toBe(text.length);
	});

	it("treats a timeout as retryable and a host error as final", () => {
		const tail = new IrcTail("Q");
		expect(tail.apply(null)).toBe(false);
		expect(tail.failed).toBe(false);
		expect(tail.apply({ kind: "error", message: "gone" })).toBe(false);
		expect(tail.failed).toBe(true);
		const more = line(custom(T0, "irc:incoming", { id: "z", from: "P", message: "x" }));
		expect(tail.apply({ kind: "rows", text: more, newSize: more.length })).toBe(false);
		expect(tail.events).toHaveLength(0);
	});
});

describe("message edge geometry", () => {
	const layout: GraphLayout = {
		nodes: [
			{ id: "a", kind: "agent", x: 0, y: 0, width: 100, height: 40 },
			{ id: "b", kind: "agent", x: 300, y: 0, width: 100, height: 40 },
		],
		edges: [],
		width: 400,
		height: 40,
	};
	const parse = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

	it("starts and ends on the node boxes and bows the two directions to opposite sides", () => {
		const placed = placeMessageEdges(layout, [
			{ from: "a", to: "b", kind: "message", count: 1, lastAt: 0 },
			{ from: "b", to: "a", kind: "message", count: 1, lastAt: 0 },
		]);
		expect(placed).toHaveLength(2);
		const [ab, ba] = placed.map(p => parse(p.d)) as [number[], number[]];
		// M x0 y0 Q cx cy x2 y2: the first point leaves box a's right edge, the last enters box b's left edge.
		expect(ab[0]).toBeGreaterThanOrEqual(100);
		expect(ab[0]).toBeLessThan(110);
		expect(ab[4]).toBeLessThanOrEqual(300);
		expect(ab[4]).toBeGreaterThan(290);
		// Control points sit on opposite sides of the chord y = 20.
		expect(Math.sign(ab[3]! - 20)).toBe(-Math.sign(ba[3]! - 20));
	});

	it("fans out two kinds between the same pair instead of drawing them on top of each other", () => {
		const placed = placeMessageEdges(layout, [
			{ from: "a", to: "b", kind: "message", count: 1, lastAt: 0 },
			{ from: "a", to: "b", kind: "reply", count: 1, lastAt: 0 },
		]);
		expect(placed[0]!.d).not.toBe(placed[1]!.d);
		expect(placed[0]!.labelY).not.toBe(placed[1]!.labelY);
	});

	it("skips an edge whose node is not in the layout", () => {
		expect(placeMessageEdges(layout, [{ from: "a", to: "zzz", kind: "message", count: 1, lastAt: 0 }])).toEqual([]);
	});
});
