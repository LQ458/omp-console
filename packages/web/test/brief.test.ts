import { describe, expect, it } from "bun:test";
import type { BriefLine } from "@omp-console/protocol";
import { briefGroups, emptyBriefText, orderedBriefLines, remainingBriefCount, visibleBriefLines } from "../src/components/brief/brief-model";
import { homeSeenKey, markHomeSeen, readHomeSeen } from "../src/components/brief/brief-storage";
import { DeckApi } from "../src/lib/api";

class MemoryStorage {
	readonly #values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}
}

function line(kind: BriefLine["kind"], sessionId: string, changedAt: number): BriefLine {
	return {
		sessionId,
		title: sessionId,
		cwd: `/work/${sessionId}`,
		text: `Continue ${sessionId}`,
		status: kind === "needs-you" ? "waiting" : kind === "finished" ? "done" : "unfinished",
		changedAt,
		kind,
	};
}

describe("return brief presentation", () => {
	it("groups needs-you, finished, and unfinished sessions in the required order", () => {
		const grouped = briefGroups([
			line("unfinished", "stopped", 30),
			line("finished", "finished", 20),
			line("needs-you", "older-question", 10),
			line("needs-you", "new-question", 40),
		]);

		expect(grouped.map(group => group.heading)).toEqual([
			"Needs you",
			"Finished",
			"Stopped before finishing",
		]);
		expect(grouped[0]!.lines.map(item => item.sessionId)).toEqual(["new-question", "older-question"]);
	});

	it("caps each expanded group at five until its own more control is expanded", () => {
		const needsYou = Array.from({ length: 7 }, (_, index) => line("needs-you", `ask-${index}`, index));
		const group = briefGroups(needsYou)[0]!;
		const visible = visibleBriefLines(group.lines, false, 5);
		expect(visible.map(item => item.sessionId)).toEqual(["ask-6", "ask-5", "ask-4", "ask-3", "ask-2"]);
		expect(remainingBriefCount(group.lines, false, 5)).toBe(2);
		expect(visibleBriefLines(group.lines, true, 5)).toHaveLength(7);
	});

	it("puts needs-you first in the three-row compact view and counts the hidden remainder", () => {
		const ordered = orderedBriefLines([
			line("unfinished", "stopped", 30),
			line("finished", "done", 20),
			line("needs-you", "question", 10),
			line("unfinished", "stopped-2", 40),
		]);
		expect(ordered.slice(0, 3).map(item => item.sessionId)).toEqual(["question", "done", "stopped-2"]);
		expect(remainingBriefCount(ordered, false, 3)).toBe(1);
	});

	it("shows the last cursor as a relative quiet line when no session changed", () => {
		expect(emptyBriefText(Date.now() - 2 * 60 * 60 * 1000)).toBe("Nothing changed since 2h ago");
	});
});

describe("device-scoped brief cursor", () => {
	it("stores a cursor under the current origin and sends it on the brief request", async () => {
		const storage = new MemoryStorage();
		const origin = "https://phone.deck.test";
		const since = 1_798_000_123_456;
		markHomeSeen(storage, origin, since);
		const sent: string[] = [];
		const api = new DeckApi({
			fetch: async input => {
				sent.push(input);
				return new Response(JSON.stringify({ since, generatedAt: since, lines: [], agenda: [] }), {
					headers: { "content-type": "application/json" },
				});
			},
		});

		await api.brief(undefined, readHomeSeen(storage, origin));

		expect(storage.getItem(homeSeenKey(origin))).toBe(String(since));
		expect(sent).toEqual([`/api/brief?since=${since}`]);
		expect(readHomeSeen(storage, "https://mac.omp-console.test")).toBeUndefined();
	});

});
