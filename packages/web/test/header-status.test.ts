import { describe, expect, it } from "bun:test";
import type { SessionSummary } from "@omp-console/protocol";
import type { HealthView } from "../src/lib/health";
import { headerAttentionStatus, headerConnectionStatus, headerHealthStatus } from "../src/components/shell/HeaderBar";

function session(extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "session-1",
		title: "A task",
		cwd: "/work/task",
		state: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

const HEALTHY = { level: "ok", title: "worker ready" } satisfies HealthView;

describe("header attention status", () => {
	it("labels approval and question waits with their elapsed time", () => {
		const approval = headerAttentionStatus(
			session({ state: "asking", awaitingAnswer: true, pendingKind: "approval", lastActivityAt: 0 }),
			123_000,
		);
		expect(approval).toEqual({
			label: "Needs you · approval · 2m03s",
			title: "Waiting for your approval · 2m03s",
		});

		const question = headerAttentionStatus(
			session({ state: "asking", pendingKind: "ask", lastActivityAt: 110_000 }),
			123_000,
		);
		expect(question?.label).toBe("Needs you · question · 13.0s");
	});

	it("does not keep an answered or ended session in the attention state", () => {
		expect(headerAttentionStatus(session(), 10_000)).toBeNull();
		expect(headerAttentionStatus(session({ state: "stopped", awaitingAnswer: true }), 10_000)).toBeNull();
		expect(headerAttentionStatus(session({ state: "crashed", awaitingAnswer: true }), 10_000)).toBeNull();
	});

	it("replaces healthy only when the session summary confirms no pending answer", () => {
		const waiting = headerAttentionStatus(
			session({ state: "asking", awaitingAnswer: true, pendingKind: "approval" }),
			10_000,
		);
		expect(headerHealthStatus(HEALTHY, waiting, true)?.label).toContain("Needs you · approval ·");
		expect(headerHealthStatus(HEALTHY, null, false)).toBeNull();
		expect(headerHealthStatus(HEALTHY, null, true)?.label).toBe("healthy");
		expect(headerHealthStatus({ level: "stalled", title: "worker stalled" }, null, false)?.label).toBe("stalled");
	});

	it("uses a non-green connection state while offline or reconnecting", () => {
		expect(headerConnectionStatus("live", false)).toEqual({ label: "Offline", phase: "reconnecting" });
		expect(headerConnectionStatus("reconnecting", true)).toEqual({ label: "Reconnecting", phase: "reconnecting" });
		expect(headerConnectionStatus("live", true)).toEqual({ label: "Live", phase: "live" });
	});
});
