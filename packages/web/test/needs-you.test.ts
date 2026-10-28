import { describe, expect, it } from "bun:test";
import type { SessionSummary } from "@omp-console/protocol";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { classifyAsk, type OpenSessionView, selectNeedsYou } from "../src/lib/needs-you";

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		title: `title-${id}`,
		cwd: `/work/${id}`,
		state: "idle",
		createdAt: 1,
		lastActivityAt: 100,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

const NOT_OPEN: OpenSessionView = { sessionId: null, live: false, canAnswer: true, ask: null };

function select(title: string, ...options: string[]): CollabUiRequest {
	return { reqId: 7, kind: "select", title, options };
}

describe("selectNeedsYou", () => {
	it("lists every session that waits, from any session, longest-waiting first", () => {
		const items = selectNeedsYou(
			[
				session("fresh", { awaitingAnswer: true, lastActivityAt: 300 }),
				session("idle"),
				session("old", { state: "asking", lastActivityAt: 100 }),
				session("streaming", { state: "streaming" }),
			],
			NOT_OPEN,
		);
		expect(items.map(i => i.sessionId)).toEqual(["old", "fresh"]);
	});

	it("uses daemon pending question and kind for a background dialog", () => {
		const pending = session("approval", {
			state: "asking",
			awaitingAnswer: true,
			pendingQuestion: "Allow this command?",
			pendingKind: "approval",
		});
		expect(selectNeedsYou([pending], NOT_OPEN)).toMatchObject([
			{ sessionId: "approval", kind: "approval", question: "Allow this command?" },
		]);
	});

	it("leaves out the open session whose ask form the composer already shows", () => {
		const live = [session("open", { awaitingAnswer: true }), session("other", { awaitingAnswer: true })];
		const open: OpenSessionView = {
			sessionId: "open",
			live: true,
			canAnswer: true,
			ask: select("Continue?", "Yes", "No"),
		};
		expect(selectNeedsYou(live, open).map(i => i.sessionId)).toEqual(["other"]);
	});

	it("trusts the live guest over a stale poll: an answered ask leaves the bar before the next poll", () => {
		const live = [session("open", { awaitingAnswer: true })];
		const open: OpenSessionView = { sessionId: "open", live: true, canAnswer: true, ask: null };
		expect(selectNeedsYou(live, open)).toEqual([]);
	});

	it("keeps the open session in the bar when the guest cannot answer (read-only link) or is not live", () => {
		const live = [session("open", { awaitingAnswer: true })];
		const ask = select("Run rm -rf build?", "Approve", "Deny");
		const readOnly = selectNeedsYou(live, { sessionId: "open", live: true, canAnswer: false, ask });
		expect(readOnly).toHaveLength(1);
		expect(readOnly[0]).toMatchObject({ kind: "approval", question: "Run rm -rf build?" });
		const reconnecting = selectNeedsYou(live, { sessionId: "open", live: false, canAnswer: true, ask: null });
		expect(reconnecting).toHaveLength(1);
	});

	it("ignores stopped and crashed sessions even when flagged", () => {
		const items = selectNeedsYou(
			[session("a", { state: "stopped", awaitingAnswer: true }), session("b", { state: "crashed", awaitingAnswer: true })],
			NOT_OPEN,
		);
		expect(items).toEqual([]);
	});

	it("titles an untitled session by its directory", () => {
		const items = selectNeedsYou([session("x", { title: undefined, cwd: "/Users/dev/docs/", awaitingAnswer: true })], NOT_OPEN);
		expect(items[0]!.title).toBe("docs");
	});
});

describe("classifyAsk", () => {
	it("calls a yes/no select an approval, and a plain choice an ask", () => {
		expect(classifyAsk(select("Run it?", "Approve", "Deny"))).toBe("approval");
		expect(classifyAsk(select("Allow this command?", "Yes, once", "No"))).toBe("approval");
		expect(classifyAsk(select("Which branch?", "main", "release"))).toBe("ask");
		expect(classifyAsk(select("Grant permission to write?", "Allow", "Something else"))).toBe("approval");
	});

	it("never treats free text as an approval", () => {
		expect(classifyAsk({ reqId: 1, kind: "editor", title: "Approve with a comment" })).toBe("ask");
	});
});
