import { describe, expect, it } from "bun:test";
import type { SessionCard, SessionSummary } from "@omp-console/protocol";
import { mergeSessionCards } from "../src/lib/cards";

function summary(id: string, state: SessionSummary["state"], awaitingAnswer = false): SessionSummary {
	return {
		id,
		cwd: "/work/peer",
		sessionFile: "/work/peer/session.jsonl",
		state,
		createdAt: 1,
		lastActivityAt: 2,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer,
	};
}

function card(id: string): SessionCard {
	return {
		sessionId: id,
		cwd: "/work/peer",
		sessionFile: "/work/peer/session.jsonl",
		title: "Peer session",
		titleSource: "deck",
		titleHistory: [],
		status: "done",
		scheduled: false,
		live: true,
		lastActivityAt: 2,
		stale: false,
	};
}

describe("peer session cards", () => {
	it("keeps a namespaced live summary attached for archive confirmation and opening", () => {
		const streaming = summary("vps:streaming", "streaming");
		const awaitingAnswer = summary("vps:waiting", "asking", true);
		const views = mergeSessionCards(
			[card(streaming.id), card(awaitingAnswer.id)],
			[streaming, awaitingAnswer],
			[],
		);

		expect(views.map(view => [view.summary?.id, view.live, view.status])).toEqual([
			[streaming.id, true, "unfinished"],
			[awaitingAnswer.id, true, "waiting"],
		]);
		expect(views[0]?.summary?.sessionFile).toBe(streaming.sessionFile);
		expect(views[1]?.summary?.awaitingAnswer).toBe(true);
	});
});
