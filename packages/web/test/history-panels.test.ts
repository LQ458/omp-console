import { describe, expect, it } from "bun:test";
import type { HistoryNode, Workspace } from "@omp-console/protocol";
import { historySearchScore, layoutHistory, rankHistoryNodes } from "../src/lib/history";

function node(id: string, title: string, createdAt: number, workspaceId = "project:one", keyPoints?: HistoryNode["keyPoints"]): HistoryNode {
	return { sessionId: id, title, createdAt, lastActivityAt: createdAt + 10, workspaceId, keyPoints };
}

const workspaces: Workspace[] = [{ id: "project:one", kind: "project", name: "one", root: "/one", rules: [], hueOverride: 210, liveSessions: 0 }, { id: "project:two", kind: "project", name: "two", root: "/two", rules: [], liveSessions: 0 }];

describe("history graph", () => {
	it("lays nodes into stable workspace lanes and keeps only edges with visible endpoints", () => {
		const first = node("a", "First", 10, "project:one");
		const second = node("b", "Second", 20, "project:two");
		const layout = layoutHistory([second, first], [{ from: "a", to: "b", kind: "handoff" }, { from: "a", to: "missing", kind: "fork" }], workspaces);
		expect(layout.lanes.map(lane => lane.label)).toEqual(["one", "two"]);
		expect(layout.nodes.map(item => item.node.sessionId)).toEqual(["a", "b"]);
		expect(layout.nodes.map(item => item.x)).toEqual(layoutHistory([second, first], [{ from: "a", to: "b", kind: "handoff" }], workspaces).nodes.map(item => item.x));
		expect(layout.edges).toHaveLength(1);
		expect(layout.nodes[0]?.lane.hue).toBe(210);
	});

	it("ranks title matches above key-point body matches", () => {
		const title = node("title", "Quota pacing", 1);
		const body = node("body", "Unrelated session", 2, "project:one", { sessionId: "body", title: "Unrelated session", decisions: ["quota pacing decision"], files: [], openQuestions: [], generatedAt: 2 });
		expect(historySearchScore(title, "quota")).toBeGreaterThan(historySearchScore(body, "quota"));
		expect(rankHistoryNodes([body, title], "quota").map(item => item.sessionId)).toEqual(["title", "body"]);
	});
});
