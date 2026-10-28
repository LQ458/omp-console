import { describe, expect, it } from "bun:test";
import type { DaemonHealth, WorkerHealth } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { DeckApiError } from "../src/lib/api";
import { deriveGoal } from "../src/lib/goal";
import { healthView } from "../src/lib/health";

function goalResult(id: string, goal: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "goal",
			content: [{ type: "text", text: "ok" }],
			details: { goal },
			isError: false,
			timestamp: 1,
		},
	};
}

function userEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:00Z",
		message: { role: "user", content: "hi", timestamp: 1 },
	};
}

describe("deriveGoal", () => {
	it("follows the latest goal tool result through its lifecycle", () => {
		const entries = [
			goalResult("g1", { objective: "ship it", status: "active" }),
			userEntry("u1"),
			goalResult("g2", { objective: "ship it", status: "budget-limited" }),
		];
		expect(deriveGoal(entries)).toEqual({ objective: "ship it", status: "budget-limited", active: true });
		expect(deriveGoal([...entries, goalResult("g3", { objective: "ship it", status: "complete" })])).toMatchObject({
			status: "complete",
			active: false,
		});
		expect(deriveGoal([...entries, goalResult("g4", { objective: "ship it", status: "paused" })])?.active).toBe(
			false,
		);
	});

	it("a dropped goal (null details.goal) means no goal, even if an earlier result was active", () => {
		expect(deriveGoal([goalResult("g1", { objective: "x", status: "active" }), goalResult("g2", null)])).toBeNull();
	});

	it("ignores transcripts without goal results and malformed details", () => {
		expect(deriveGoal([userEntry("u1")])).toBeNull();
		expect(deriveGoal([goalResult("g1", { objective: "x" })])).toBeNull();
	});
});

describe("healthView", () => {
	const worker: WorkerHealth = {
		sessionId: "s1",
		pid: 4242,
		state: "streaming",
		rssBytes: 300 * 1024 * 1024,
		startedAt: 1,
		lastEventAt: 2,
		stalled: false,
		restarts: 1,
	};
	const health: DaemonHealth = { version: 1, startedAt: 1, workers: [worker], guests: 1, stalledAfterMs: 60_000 };

	it("reports the selected session's stalled flag, not another session's", () => {
		const stalled: DaemonHealth = { ...health, workers: [worker, { ...worker, sessionId: "s2", stalled: true }] };
		expect(healthView(stalled, null, "s1").level).toBe("ok");
		expect(healthView(stalled, null, "s2").level).toBe("stalled");
	});

	it("offline wins over stale health data; the title distinguishes a refusal from an outage", () => {
		const outage = healthView(health, new DeckApiError("network", 0, "x"), "s1");
		const refused = healthView(health, new DeckApiError("auth", 401, "x"), "s1");
		expect(outage.level).toBe("offline");
		expect(refused.level).toBe("offline");
		expect(outage.title).not.toBe(refused.title);
	});

	it("is unknown before the first health response", () => {
		expect(healthView(null, null, "s1").level).toBe("unknown");
	});
});
