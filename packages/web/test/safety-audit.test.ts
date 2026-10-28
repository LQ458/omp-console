import { describe, expect, it } from "bun:test";
import type { GateAuditEntry } from "@omp-console/protocol";
import { auditKinds, auditTime, filterAudit, NO_FILTERS, verdictCounts, verdictTone } from "../src/components/safety/audit";

function entry(at: number, verdict: GateAuditEntry["verdict"], kinds: string[], summary: string, extra: Partial<GateAuditEntry> = {}): GateAuditEntry {
	return { at, verdict, kinds, summary, ...extra };
}

const LOG: GateAuditEntry[] = [
	entry(10, "allow", ["read"], "read notes.md", { sessionId: "a" }),
	entry(50, "would-ask", ["git push"], "git push origin main", { target: "github.com/x/y", sessionId: "a" }),
	entry(30, "would-deny", ["delete", "write-outside-workspace"], "rm -rf ~/old", { sessionId: "b" }),
	entry(40, "ask", ["email"], "send weekly mail", { target: "team@example.test", sessionId: "b" }),
	entry(20, "deny", ["git push"], "git push --force", { sessionId: "a" }),
];

describe("filterAudit", () => {
	it("lists newest first, and 'attention' hides only allowed actions", () => {
		expect(filterAudit(LOG, NO_FILTERS).map(e => e.at)).toEqual([50, 40, 30, 20, 10]);
		const attention = filterAudit(LOG, { ...NO_FILTERS, verdict: "attention" });
		expect(attention.map(e => e.verdict)).toEqual(["would-ask", "ask", "would-deny", "deny"]);
	});

	it("combines verdict, kind, session and text filters, matching text in the target too", () => {
		expect(filterAudit(LOG, { ...NO_FILTERS, kind: "git push" }).map(e => e.at)).toEqual([50, 20]);
		expect(filterAudit(LOG, { ...NO_FILTERS, kind: "git push", verdict: "deny" }).map(e => e.at)).toEqual([20]);
		expect(filterAudit(LOG, { ...NO_FILTERS, sessionId: "b" }).map(e => e.at)).toEqual([40, 30]);
		expect(filterAudit(LOG, { ...NO_FILTERS, query: "EXAMPLE.test" }).map(e => e.at)).toEqual([40]);
		expect(filterAudit(LOG, { ...NO_FILTERS, kind: "email", sessionId: "a" })).toEqual([]);
	});

	it("does not reorder or mutate the log it was given", () => {
		const copy = LOG.map(e => e.at);
		filterAudit(LOG, NO_FILTERS);
		expect(LOG.map(e => e.at)).toEqual(copy);
	});
});

describe("audit labels", () => {
	it("collects each kind once, counts verdicts, and marks allow green, asks amber, denials red", () => {
		expect(auditKinds(LOG)).toEqual(["delete", "email", "git push", "read", "write-outside-workspace"]);
		expect(verdictCounts(LOG)).toEqual({ allow: 1, ask: 1, deny: 1, "would-ask": 1, "would-deny": 1 });
		expect(["allow", "ask", "would-ask", "deny", "would-deny"].map(v => verdictTone(v as GateAuditEntry["verdict"]))).toEqual([
			"ok",
			"warn",
			"warn",
			"err",
			"err",
		]);
	});

	it("shows a relative time up to a day and the date after", () => {
		const now = Date.UTC(2026, 9, 23, 12, 0, 0);
		expect(auditTime(now - 12_000, now)).toBe("12s ago");
		expect(auditTime(now - 4 * 60_000, now)).toBe("4 min ago");
		expect(auditTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
		expect(auditTime(now - 3 * 86_400_000, now)).toBe("2026-10-20");
		expect(auditTime(now + 5_000, now)).toBe("0s ago");
	});
});
