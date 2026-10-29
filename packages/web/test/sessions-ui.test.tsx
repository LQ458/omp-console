import { describe, expect, it, vi } from "bun:test";
import type { AgendaItem, AgendaToday, CardStatus, ReturnBrief as ReturnBriefData, SessionCard, SessionSummary } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { AgendaSessionActionView } from "../src/components/agenda/AgendaSessionAction";
import { AgendaTaskRow, agendaDueLabel, agendaShouldShow, agendaTaskPrompt } from "../src/components/agenda/AgendaStrip";
import { newFolderPath, newSessionBreadcrumbs, pickerIndexAfterMove, requestForPickerOption } from "../src/components/newsession/NewSessionPicker";
import { SessionCardList, turnElapsed } from "../src/components/switcher/SessionCardList";
import {
	groupSessionCards,
	hiddenCardsInGroup,
	mergeSessionCards,
	renameCardOptimistically,
	undoCardTitleOptimistically,
	visibleCardsInGroup,
} from "../src/lib/cards";

function summary(id: string, lastActivityAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		cwd: `/work/${id}`,
		sessionFile: `/work/${id}.jsonl`,
		state: "idle",
		createdAt: 1,
		lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

function card(
	id: string,
	status: CardStatus,
	lastActivityAt: number,
	extra: Partial<SessionCard> = {},
): SessionCard {
	return {
		sessionId: id,
		cwd: `/work/${id}`,
		title: `Title ${id}`,
		titleSource: "user",
		titleHistory: [],
		status,
		stoppedAt: "A checkpoint",
		nextStep: "Review the result",
		topic: "Alpha",
		scheduled: false,
		live: false,
		lastActivityAt,
		stale: false,
		...extra,
	};
}

function cardView(sessionCard: SessionCard) {
	return {
		card: sessionCard,
		live: sessionCard.live,
		status: sessionCard.status,
	};
}

const NOW = 10_000_000_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("session card grouping", () => {
	it("uses current live state and activity while retaining librarian card text", () => {
		const liveCard = card("live", "done", 1, { title: "Card title" });
		const merged = mergeSessionCards(
			[liveCard],
			[summary("live", 50, { state: "asking", awaitingAnswer: true, cwd: "/work/current" })],
			[],
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.card.title).toBe("Card title");
		expect(merged[0]?.card.cwd).toBe("/work/current");
		expect(merged[0]?.card.lastActivityAt).toBe(50);
		expect(merged[0]?.live).toBe(true);
		expect(merged[0]?.status).toBe("waiting");
	});

	it("shows idle, working, paused and completed states for live sessions", () => {
		const now = Date.now();
		const merged = mergeSessionCards(
			[
				card("idle", "unfinished", now, { live: true }),
				card("working", "unfinished", now - 1, { live: true }),
				card("paused", "unfinished", now - 2, { live: true }),
				card("done", "done", now - 3, { live: true }),
			],
			[
				summary("idle", now, { state: "idle" }),
				summary("working", now - 1, { state: "streaming" }),
				summary("paused", now - 2, { state: "streaming", paused: true, pausedAt: now - 90_000 }),
				summary("done", now - 3, { state: "idle" }),
			],
			[],
		);
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={merged}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
			/>,
		);

		expect(html).toContain('class="dk-card-status dk-card-status-quiet">Idle</span>');
		expect(html).toContain('class="dk-card-status dk-card-status-working">Working</span>');
		expect(html).toContain('class="dk-card-status dk-card-status-paused">Paused 1m</span>');
		expect(html).toContain('class="dk-state dk-state-paused" title="Paused" role="img" aria-label="paused"');
		expect(html).toContain('class="dk-card-status dk-card-status-done">Done</span>');
		expect(html).not.toContain(">Live</span>");
		expect(merged.map(item => item.status)).toEqual(["unfinished", "unfinished", "unfinished", "done"]);
	});

	it("says Offline for live sessions of a machine that stopped answering, and keeps the others live", () => {
		const now = Date.now();
		const merged = mergeSessionCards(
			[card("mac:gone", "unfinished", now, { live: true }), card("here", "unfinished", now - 1, { live: true })],
			[summary("mac:gone", now, { state: "streaming" }), summary("here", now - 1, { state: "streaming" })],
			[],
		);
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={merged}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
				offlineMachines={new Set(["mac"])}
			/>,
		);
		expect(html).toContain('data-offline="true"');
		expect(html).toContain('class="dk-card-status dk-card-status-offline">Offline</span>');
		expect(html).toContain('class="dk-card-status dk-card-status-working">Working</span>');
		expect(html).toContain(">Mac<");
	});

	it("does not count asleep sessions in the live filter chip", () => {
		const now = Date.now();
		const merged = mergeSessionCards(
			[card("asleep", "unfinished", now, { live: true }), card("running", "unfinished", now - 1, { live: true })],
			[summary("asleep", now, { state: "asleep" }), summary("running", now - 1, { state: "streaming" })],
			[],
		);
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={merged}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
			/>,
		);
		expect(html).toContain("1 here.");
		expect(html).toContain('aria-hidden="true"></span>1 live</button>');
	});

	it("uses a session title instead of the empty-message placeholder", () => {
		const merged = mergeSessionCards(
			[card("empty", "unfinished", NOW, { title: "(no messages)" })],
			[summary("empty", NOW, { title: "A titled session" })],
			[],
		);

		expect(merged[0]?.card.title).toBe("A titled session");
	});

	it("orders status groups, topics, and recent sessions consistently", () => {
		const cards = [
			cardView(card("done", "done", NOW - 20, { topic: "Alpha" })),
			cardView(card("working", "unfinished", NOW - 40, { topic: "Beta" })),
			cardView(card("waiting", "waiting", NOW - 30, { topic: "Alpha" })),
			cardView(card("untagged", "unfinished", NOW - 10, { topic: undefined })),
			cardView(card("scheduled", "unfinished", NOW - 50, { scheduled: true })),
		];

		const statusGroups = groupSessionCards(cards, ["Beta", "Alpha"], false, NOW);
		expect(statusGroups.map(group => group.label)).toEqual(["Waiting on you", "Unfinished", "Done", "Scheduled"]);
		expect(statusGroups[0]?.cards.map(item => item.card.sessionId)).toEqual(["waiting"]);
		expect(statusGroups[1]?.cards.map(item => item.card.sessionId)).toEqual(["working", "untagged"]);
		expect(statusGroups[3]?.cards.map(item => item.card.sessionId)).toEqual(["scheduled"]);

		const topicGroups = groupSessionCards(cards, ["Beta", "Alpha"], true, NOW);
		expect(topicGroups.map(group => group.label)).toEqual(["Beta", "Alpha", "No topic", "Scheduled"]);
	});

	it("groups saved sessions by project folder, including older sessions", () => {
		const folders = [
			cardView(card("alpha-recent", "done", NOW, { cwd: "/work/alpha" })),
			cardView(card("alpha-old", "unfinished", NOW - WEEK_MS - 1, { cwd: "/work/alpha" })),
			cardView(card("beta", "waiting", NOW - 1, { cwd: "/work/beta" })),
		];
		const groups = groupSessionCards(folders, [], "folder", NOW);

		expect(groups.map(group => group.label)).toEqual(["/work/alpha", "/work/beta"]);
		expect(groups[0]?.cards.map(item => item.card.sessionId)).toEqual(["alpha-recent", "alpha-old"]);
		expect(groups.flatMap(group => group.cards.map(item => item.card.sessionId))).toHaveLength(3);
	});
	it("groups equivalent Windows working-directory spellings together without folding POSIX case", () => {
		const folders = [
			cardView(card("windows-a", "done", NOW, { cwd: "C:\\Users\\Leo\\repo" })),
			cardView(card("windows-b", "done", NOW, { cwd: "c:/users/leo/REPO" })),
			cardView(card("posix-a", "done", NOW, { cwd: "/work/Repo" })),
			cardView(card("posix-b", "done", NOW, { cwd: "/work/repo" })),
		];
		const groups = groupSessionCards(folders, [], "folder", NOW);
		expect(groups).toHaveLength(3);
		expect(groups.find(group => group.label === "C:\\Users\\Leo\\repo")?.cards.map(item => item.card.sessionId)).toEqual(["windows-a", "windows-b"]);
		expect(groups.some(group => group.label === "/work/Repo")).toBe(true);
		expect(groups.some(group => group.label === "/work/repo")).toBe(true);
	});

	it("labels terminal sessions and saved sessions distinctly and explains copy/read-only opening", () => {
		const now = Date.now();
		const cards = mergeSessionCards(
			[
				card("terminal", "done", now, { cwd: "/work/terminal" }),
				card("saved", "done", now - 1, { cwd: "/work/saved" }),
				card("deleted", "done", now - 2, { cwd: "/work/deleted" }),
			],
			[],
			[
				summary("terminal", now, { state: "stopped", source: "terminal", cwdExists: true }),
				summary("saved", now - 1, { state: "stopped", cwdExists: true }),
				summary("deleted", now - 2, { state: "stopped", source: "terminal", cwdExists: false }),
			],
		);
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={cards}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onReadOnlyTranscript={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
			/>,
		);

		expect((html.match(/>From terminal<\/span>/g) ?? []).length).toBe(2);
		expect((html.match(/>Saved<\/span>/g) ?? []).length).toBe(1);
		expect(html).toContain("Opens a copy; the terminal session is unchanged.");
		expect(html).toContain("This project folder no longer exists. Opens a saved transcript read-only.");
	});


	it("groups pinned sessions first and excludes them from scheduled and status groups", () => {
		const cards = [
			cardView(card("pinned-scheduled", "unfinished", NOW - 1, { pinned: true, scheduled: true })),
			cardView(card("pinned-old", "done", NOW - WEEK_MS - 1, { pinned: true })),
			cardView(card("waiting", "waiting", NOW - 1)),
			cardView(card("older", "done", NOW - WEEK_MS - 1)),
			cardView(card("scheduled", "unfinished", NOW - 1, { scheduled: true })),
		];
		const groups = groupSessionCards(cards, [], false, NOW);

		expect(groups.map(group => group.label)).toEqual(["Pinned", "Waiting on you", "Older", "Scheduled"]);
		expect(groups[0]?.cards.map(item => item.card.sessionId)).toEqual(["pinned-scheduled", "pinned-old"]);
		expect(groups.flatMap(group => group.cards.map(item => item.card.sessionId)).sort()).toEqual(
			cards.map(item => item.card.sessionId).sort(),
		);
	});

	it("moves sessions older than seven days into one collapsed Older group", () => {
		const cards = [
			cardView(card("waiting-boundary", "waiting", NOW - WEEK_MS)),
			cardView(card("waiting-old", "waiting", NOW - WEEK_MS - 1)),
			cardView(card("working-recent", "unfinished", NOW - 1)),
			cardView(card("working-old", "unfinished", NOW - WEEK_MS - 2)),
			cardView(card("done-old", "done", NOW - WEEK_MS - 3)),
			cardView(card("scheduled-old", "unfinished", NOW - WEEK_MS - 4, { scheduled: true })),
		];
		const groups = groupSessionCards(cards, [], false, NOW);
		const older = groups.find(group => group.key === "older");

		expect(groups.map(group => group.label)).toEqual(["Waiting on you", "Unfinished", "Older", "Scheduled"]);
		expect(groups[0]?.cards.map(item => item.card.sessionId)).toEqual(["waiting-boundary"]);
		expect(groups[1]?.cards.map(item => item.card.sessionId)).toEqual(["working-recent"]);
		expect(older?.cards.map(item => item.card.sessionId)).toEqual(["waiting-old", "working-old", "done-old"]);
		expect(older?.collapsible).toBe(true);
		expect(older && visibleCardsInGroup(older, false, false)).toEqual([]);
		expect(older && visibleCardsInGroup(older, true, false).map(item => item.card.sessionId)).toEqual([
			"waiting-old", "working-old", "done-old",
		]);
		expect(groups.flatMap(group => group.cards.map(item => item.card.sessionId)).sort()).toEqual(
			cards.map(item => item.card.sessionId).sort(),
		);
		const topicGroups = groupSessionCards(cards, [], true, NOW);
		expect(topicGroups.map(group => group.label)).toEqual(["Alpha", "Older", "Scheduled"]);
		expect(topicGroups.find(group => group.key === "older")?.cards.map(item => item.card.sessionId)).toEqual([
			"waiting-old", "working-old", "done-old",
		]);

		const renderCards = [
			cardView(card("recent", "waiting", Date.now() - 1_000)),
			cardView(card("waiting-old", "waiting", 1)),
			cardView(card("working-old", "unfinished", 1)),
			cardView(card("done-old", "done", 1)),
		];
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={renderCards}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
			/>,
		);
		expect(html).toContain("Older");
		expect(html).toContain("Archive all");
		expect(html).toContain('aria-label="Actions for Title recent"');
		expect(html).toContain('Older</span><span class="dk-section-count">3</span>');
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("Title waiting-old");
	});

	it("shows five cards per group, reports the remainder, and keeps scheduled cards folded", () => {
		const cards = Array.from({ length: 6 }, (_, index) => cardView(card(`wait-${index}`, "waiting", NOW - index)));
		cards.push(cardView(card("scheduled", "unfinished", NOW - 1, { scheduled: true })));
		const groups = groupSessionCards(cards, [], false, NOW);
		const waiting = groups.find(group => group.key === "waiting");
		const scheduled = groups.find(group => group.key === "scheduled");
		expect(waiting).toBeDefined();
		expect(waiting && visibleCardsInGroup(waiting, false, false).map(item => item.card.sessionId)).toEqual([
			"wait-0", "wait-1", "wait-2", "wait-3", "wait-4",
		]);
		expect(waiting && hiddenCardsInGroup(waiting)).toBe(1);
		expect(scheduled && visibleCardsInGroup(scheduled, false, false)).toEqual([]);
		expect(scheduled && visibleCardsInGroup(scheduled, false, true).map(item => item.card.sessionId)).toEqual(["scheduled"]);
	});

	it("renders two-line session cards and the topic toggle", () => {
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={[cardView(card("visible", "waiting", Date.now() - 1_000))]}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
			/>,
		);
		expect(html).toContain("Waiting on you");
		expect(html).toContain("A checkpoint · Next: Review the result");
		expect(html).toContain(">Group by topic</option>");
	});

	it("shows active loop progress on phone session cards", () => {
		const at = Date.now();
		const cards = mergeSessionCards(
			[card("looping", "unfinished", at, { live: true })],
			[summary("looping", at, { loopMode: { active: true, iteration: 2, limit: "5 iterations", waitingForPrompt: false } })],
			[],
		);
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={cards}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
			/>,
		);
		expect(html).toContain('class="dk-card-loop"');
		expect(html).toContain("Loop 2/5 iterations");
		expect(html).toContain('aria-label="Loop 2/5 iterations"');
	});

	it("keeps the title, status, and preview in the session's single open target", () => {
		const now = Date.now();
		const cards = mergeSessionCards(
			[card("row-target", "waiting", now, { title: "Approval session" })],
			[summary("row-target", now, { state: "asking", awaitingAnswer: true, model: "gpt-6-luna", pendingQuestion: "Approve tool access?" })],
			[],
		);
		const html = renderToStaticMarkup(
			<SessionCardList
				cards={cards}
				topics={[]}
				health={null}
				selectedId={null}
				busy={false}
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={() => {}}
				onArchiveAll={() => {}}
			/>,
		);
		const openStart = html.lastIndexOf("<button", html.indexOf('class="dk-card-open"'));
		const openEnd = html.indexOf("</button>", openStart) + "</button>".length;
		const openTarget = html.slice(openStart, openEnd);
		const visibleText = openTarget.replace(/<[^>]*>/g, "");

		expect(openTarget).toContain('class="dk-card-line-one"');
		expect(openTarget).toContain('class="dk-card-line-two"');
		expect(visibleText).toContain("Approval session");
		expect(visibleText).toContain("Waiting");
		expect(visibleText).toContain("Approve tool access?");
		expect(visibleText).not.toContain("gpt-6-luna");
		expect(openTarget).toContain('title="Model: gpt-6-luna"');
	});
});

describe("optimistic card title updates", () => {
	it("shows a renamed title immediately, saves the returned card, and clears the override", async () => {
		let overrides: ReadonlyMap<string, string> = new Map();
		const visibleTitles: (string | undefined)[] = [];
		const setOverrides = (update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): void => {
			overrides = update(overrides);
			visibleTitles.push(overrides.get("session-1"));
		};
		const updated = card("session-1", "unfinished", 20, { title: "New title" });
		const saveCard = vi.fn();
		const setCardTitle = vi.fn(async (sessionId: string, title: string) => {
			expect(sessionId).toBe("session-1");
			expect(title).toBe("New title");
			return updated;
		});

		const result = await renameCardOptimistically({ setCardTitle }, "session-1", "New title", setOverrides, saveCard);

		expect(visibleTitles).toEqual(["New title", undefined]);
		expect(setCardTitle).toHaveBeenCalledTimes(1);
		expect(saveCard).toHaveBeenCalledWith(updated);
		expect(result.title).toBe("New title");
	});

	it("rolls an optimistic title back after a failed rename", async () => {
		let overrides: ReadonlyMap<string, string> = new Map();
		const visibleTitles: (string | undefined)[] = [];
		const setOverrides = (update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): void => {
			overrides = update(overrides);
			visibleTitles.push(overrides.get("session-1"));
		};
		const saveCard = vi.fn();
		const setCardTitle = vi.fn(async () => {
			throw new Error("rename rejected");
		});

		await expect(renameCardOptimistically({ setCardTitle }, "session-1", "New title", setOverrides, saveCard)).rejects.toThrow(
			"rename rejected",
		);
		expect(visibleTitles).toEqual(["New title", undefined]);
		expect(saveCard).not.toHaveBeenCalled();
	});

	it("calls undo and displays the restored title until the server response arrives", async () => {
		let overrides: ReadonlyMap<string, string> = new Map();
		const visibleTitles: (string | undefined)[] = [];
		const setOverrides = (update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): void => {
			overrides = update(overrides);
			visibleTitles.push(overrides.get("session-1"));
		};
		const restored = card("session-1", "unfinished", 20, { title: "Before rename" });
		const saveCard = vi.fn();
		const undoCardTitle = vi.fn(async (sessionId: string) => {
			expect(sessionId).toBe("session-1");
			return restored;
		});

		await undoCardTitleOptimistically({ undoCardTitle }, "session-1", "Before rename", setOverrides, saveCard);
		expect(visibleTitles).toEqual(["Before rename", undefined]);
		expect(undoCardTitle).toHaveBeenCalledTimes(1);
		expect(saveCard).toHaveBeenCalledWith(restored);
	});

	it("rolls an optimistic restore back when the undo request fails", async () => {
		let overrides: ReadonlyMap<string, string> = new Map();
		const visibleTitles: (string | undefined)[] = [];
		const setOverrides = (update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): void => {
			overrides = update(overrides);
			visibleTitles.push(overrides.get("session-1"));
		};
		const saveCard = vi.fn();
		const undoCardTitle = vi.fn(async () => {
			throw new Error("undo rejected");
		});

		await expect(
			undoCardTitleOptimistically({ undoCardTitle }, "session-1", "Before rename", setOverrides, saveCard),
		).rejects.toThrow("undo rejected");
		expect(visibleTitles).toEqual(["Before rename", undefined]);
		expect(saveCard).not.toHaveBeenCalled();
	});
});

describe("new session picker", () => {
	it("wraps keyboard selection in both directions and leaves empty lists unselected", () => {
		expect(pickerIndexAfterMove(2, 1, 3)).toBe(0);
		expect(pickerIndexAfterMove(0, -1, 3)).toBe(2);
		expect(pickerIndexAfterMove(-1, 1, 0)).toBe(-1);
	});

	it("turns workspace and Create rows into cwd requests and keeps model optional", () => {
		const workspace = {
			cwd: "/work/project",
			name: "project",
			sessions30d: 3,
			lastUsedAt: 10,
		};
		expect(requestForPickerOption({ kind: "workspace", workspace }, "  claude-test ")).toEqual({
			cwd: "/work/project",
			model: "claude-test",
		});
		expect(requestForPickerOption({ kind: "create", path: "/work/new-project" }, "")).toEqual({
			cwd: "/work/new-project",
			createDirectory: true,
		});
	});
	it("builds home-relative breadcrumbs and joins paths with native separators", () => {
		expect(newSessionBreadcrumbs("/home/alice", "/home/alice/projects/app")).toEqual([
			{ label: "Home", path: "/home/alice" },
			{ label: "projects", path: "/home/alice/projects" },
			{ label: "app", path: "/home/alice/projects/app" },
		]);
		expect(newSessionBreadcrumbs("C:\\Users\\Leo", "C:\\Users\\Leo\\code\\app")).toEqual([
			{ label: "Home", path: "C:\\Users\\Leo" },
			{ label: "code", path: "C:\\Users\\Leo\\code" },
			{ label: "app", path: "C:\\Users\\Leo\\code\\app" },
		]);
		expect(newFolderPath("C:\\Users\\Leo\\Projects", " test-app ")).toBe("C:\\Users\\Leo\\Projects\\test-app");
		expect(newFolderPath("/home/alice/projects", "test-app")).toBe("/home/alice/projects/test-app");
	});

});

describe("return brief and agenda visibility", () => {
	const emptyBrief: ReturnBriefData = { since: 0, generatedAt: 1, lines: [], agenda: [] };

	it("hides agenda when unavailable and shows it when available", () => {
		const unavailable: AgendaToday = { available: false, items: [] };
		const available: AgendaToday = { available: true, items: [] };
		expect(agendaShouldShow(null)).toBe(false);
		expect(agendaShouldShow(unavailable)).toBe(false);
		expect(agendaShouldShow(available)).toBe(true);
	});
});

describe("agenda actions", () => {
	const task: AgendaItem = {
		uid: "agenda-1",
		title: "Write a lab report",
		list: "Inbox",
		completed: false,
		due: Date.parse("2026-10-24T15:00:00Z"),
		notes: "Include the results.",
	};

	it("renders a start action for an unlinked item and opens linked items", () => {
		const start = renderToStaticMarkup(
			<AgendaTaskRow item={task} canOpenSession={() => true} onOpenSession={() => {}} onStartSession={() => {}} />,
		);
		const linked = renderToStaticMarkup(
			<AgendaTaskRow
				item={{ ...task, url: "omp-console://session/session-1", sessionId: "session-1" }}
				canOpenSession={() => true}
				onOpenSession={() => {}}
				onStartSession={() => {}}
			/>,
		);
		// The label names the task first, then when it is due.
		expect(start).toContain('aria-label="Start session: Write a lab report');
		expect(start).toContain("Start session");
		expect(linked).toContain('aria-label="Open session: Write a lab report');
		expect(linked).toContain("Open session");
		expect(linked).not.toContain("Start session");
	});

	it("builds the editable first prompt from task details", () => {
		expect(agendaTaskPrompt(task)).toBe(
			"Task from my agenda: Write a lab report\nInclude the results.\nDue: 2026-10-24T15:00:00.000Z",
		);
		expect(agendaTaskPrompt({ ...task, due: undefined, notes: undefined })).toBe(
			"Task from my agenda: Write a lab report\n\nDue: not set",
		);
	});

	it("shows Mark task done for a linked open task", () => {
		const linked = renderToStaticMarkup(
			<AgendaSessionActionView
				item={{ ...task, url: "omp-console://session/session-1", sessionId: "session-1" }}
				busy={false}
				message={null}
				error={null}
				onMarkDone={() => {}}
			/>
		);
		const busy = renderToStaticMarkup(
			<AgendaSessionActionView item={task} busy message={null} error={null} onMarkDone={() => {}} />,
		);
		const absent = renderToStaticMarkup(
			<AgendaSessionActionView item={null} busy={false} message={null} error={null} onMarkDone={() => {}} />,
		);
		expect(linked).toContain("Mark task done");
		expect(busy).toContain("Marking…");
		expect(busy).toContain("disabled");
		expect(absent).toBe("");
	});
});

describe("agenda due labels", () => {
	const now = new Date(2026, 9, 24, 14, 0).getTime();
	it("marks yesterday's and today's passed deadlines overdue, and names today, tomorrow and later days", () => {
		expect(agendaDueLabel(undefined, now)).toBeNull();
		expect(agendaDueLabel(new Date(2026, 9, 23, 9, 0).getTime(), now)).toMatchObject({ overdue: true });
		expect(agendaDueLabel(new Date(2026, 9, 23, 9, 0).getTime(), now)?.text.startsWith("Overdue ·")).toBe(true);
		expect(agendaDueLabel(new Date(2026, 9, 24, 9, 0).getTime(), now)).toMatchObject({ overdue: true });
		// A date-only task due today is not late until the day is over.
		expect(agendaDueLabel(new Date(2026, 9, 24).getTime(), now)).toEqual({ text: "Today", overdue: false });
		expect(agendaDueLabel(new Date(2026, 9, 24, 21, 0).getTime(), now)?.text.startsWith("Today ")).toBe(true);
		expect(agendaDueLabel(new Date(2026, 9, 25).getTime(), now)).toEqual({ text: "Tomorrow", overdue: false });
		expect(agendaDueLabel(new Date(2026, 9, 27).getTime(), now)).toMatchObject({ overdue: false });
	});
});

describe("turn elapsed", () => {
	it("stays silent for the first minute, then counts minutes and hours", () => {
		const now = 10_000_000;
		expect(turnElapsed(undefined, now)).toBeNull();
		expect(turnElapsed(now - 59_000, now)).toBeNull();
		expect(turnElapsed(now - 60_000, now)).toBe("1m");
		expect(turnElapsed(now - 59 * 60_000, now)).toBe("59m");
		expect(turnElapsed(now - 60 * 60_000, now)).toBe("1h");
		expect(turnElapsed(now - 65 * 60_000, now)).toBe("1h 5m");
	});
});
