import { describe, expect, it } from "bun:test";
import type { DaemonHealth, SessionSummary, WorkerHealth } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeScreen, homeState } from "../src/components/shell/HomeScreen";
import { StatusSheet } from "../src/components/shell/StatusSheet";
import { DeckApi, DeckApiError } from "../src/lib/api";
import { fmtAge, fmtBytes } from "../src/lib/format";
import { healthRows } from "../src/lib/health";
import { deriveTodos } from "../src/lib/todos";

function toolResult(id: string, toolName: string, details: unknown, isError = false): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:00Z",
		message: { role: "toolResult", toolCallId: `c-${id}`, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 1 },
	};
}

const board = (...tasks: Array<[string, string]>): unknown => ({
	phases: [{ name: "Work", tasks: tasks.map(([content, status]) => ({ content, status })) }],
});

describe("deriveTodos", () => {
	it("the latest todo result is the board: progress follows each update", () => {
		const entries = [
			toolResult("t1", "todo", board(["a", "in_progress"], ["b", "pending"])),
			toolResult("t2", "todo", board(["a", "completed"], ["b", "in_progress"], ["c", "abandoned"])),
		];
		const after = deriveTodos(entries);
		expect(after).toMatchObject({ total: 3, completed: 1, inProgress: 1, current: "b" });
		expect(deriveTodos(entries.slice(0, 1))).toMatchObject({ completed: 0, current: "a" });
	});

	it("skips failed and malformed results and falls back to the previous good board", () => {
		const entries = [
			toolResult("t1", "todo", board(["a", "completed"])),
			toolResult("t2", "todo", { phases: "nope" }),
			toolResult("t3", "todo", board(["x", "pending"]), true),
			toolResult("t4", "goal", { goal: { objective: "o", status: "active" } }),
		];
		expect(deriveTodos(entries)).toMatchObject({ total: 1, completed: 1 });
	});

	it("treats unknown statuses as pending and an empty board as none", () => {
		expect(deriveTodos([toolResult("t1", "todo", board(["a", "weird"]))])?.phases[0]!.tasks[0]!.status).toBe("pending");
		expect(deriveTodos([toolResult("t1", "todo", { phases: [] })])).toBeNull();
		expect(deriveTodos([])).toBeNull();
	});
});

function worker(sessionId: string, extra: Partial<WorkerHealth> = {}): WorkerHealth {
	return { sessionId, pid: 1, state: "idle", rssBytes: 310 * 1024 * 1024, startedAt: 0, lastEventAt: 9_000, stalled: false, restarts: 0, ...extra };
}

function daemon(...workers: WorkerHealth[]): DaemonHealth {
	return { version: 1, startedAt: 0, workers, guests: 2, stalledAfterMs: 60_000 };
}

function summary(id: string, title?: string): SessionSummary {
	return { id, title, cwd: `/w/${id}`, state: "idle", createdAt: 1, lastActivityAt: 1, agentCount: 0, goalActive: false, awaitingAnswer: false };
}

describe("healthRows", () => {
	it("puts crashed and stalled workers first and measures the age of the last event", () => {
		const rows = healthRows(
			daemon(worker("aaa", { lastEventAt: 9_000 }), worker("bbb", { stalled: true, lastEventAt: 1_000 }), worker("ccc", { state: "crashed" })),
			[summary("aaa", "Alpha"), summary("bbb", "Beta"), summary("ccc", "Gamma")],
			10_000,
		);
		expect(rows.map(r => r.title)).toEqual(["Gamma", "Beta", "Alpha"]);
		expect(rows.find(r => r.title === "Beta")!.lastEventAgeMs).toBe(9_000);
	});

	it("falls back to a short id for a worker without a live summary, and to no rows without a report", () => {
		expect(healthRows(daemon(worker("0123456789")), [], 10_000)[0]!.title).toBe("01234567");
		expect(healthRows(null, [], 10_000)).toEqual([]);
	});
});

describe("format helpers", () => {
	it("formats memory and event age", () => {
		expect(fmtBytes(310 * 1024 * 1024)).toBe("310 MB");
		expect(fmtBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
		expect(fmtAge(500)).toBe("now");
		expect([fmtAge(42_000), fmtAge(5 * 60_000), fmtAge(3 * 3_600_000)]).toEqual(["42s", "5m", "3h"]);
	});
});

describe("StatusSheet", () => {
	it("shows the session goal and health for the open session", () => {
		const html = renderToStaticMarkup(
			<StatusSheet
				onClose={() => {}}
				api={new DeckApi()}
				client={null}
				selectedId="aaa"
				sessions={[{ ...summary("aaa", "Alpha"), goalActive: true, goalObjective: "Ship the thing" }]}
				health={daemon(worker("aaa", { stalled: true, restarts: 2 }))}
				listError={null}
				onFork={() => {}}
			/>,
		);
		expect(html).toContain("Ship the thing");
		expect(html).toContain("stalled");
		expect(html).toContain("310 MB");
		expect(html).toContain("Restarts");
		expect(html).toContain("open"); // marks the connected session's card
	});

	it("says so when the daemon is unreachable while still showing the last report", () => {
		const html = renderToStaticMarkup(
			<StatusSheet
				onClose={() => {}}
				api={new DeckApi()}
				client={null}
				selectedId={null}
				sessions={[]}
				health={daemon(worker("aaa"))}
				listError={new DeckApiError("network", 0, "daemon unreachable")}
				onFork={() => {}}
			/>,
		);
		expect(html).toContain("Daemon unreachable; showing the last report.");
	});
});

describe("HomeScreen", () => {
	it("introduces omp console and presents the first-session checklist on an empty home screen", () => {
		const api = new DeckApi();
		const html = renderToStaticMarkup(
			<HomeScreen
				state="idle"
				mode="desktop"
				liveCount={0}
				existingSessionCount={0}
				linkError={null}
				onRetry={() => {}}
				onOpenSessions={() => {}}
				onOpenSessionList={() => {}}
				onOpenStatus={() => {}}
				onOpenSettings={() => {}}
				api={api}
				setupApi={api}
				overnightSessions={[]}
				loadOvernightState={async () => { throw new Error("no overnight state"); }}
				onOpenOvernight={() => {}}
				canOpenSession={() => false}
				onOpenSession={() => {}}
			/>,
		);
		expect(html).toContain("omp console lets you start and manage omp sessions from a browser.");
		expect(html).toContain("First-run setup");
		expect(html).toContain("Start your first session");
	});

	it("authorization beats reachability, which beats loading", () => {
		const net = new DeckApiError("network", 0, "x");
		expect(homeState(true, net, true)).toBe("not-authorized");
		expect(homeState(false, net, true)).toBe("unreachable");
		expect(homeState(false, null, false)).toBe("connecting");
		expect(homeState(false, null, true)).toBe("idle");
	});

	it("renders the not-authorized and unreachable states without collab wording", () => {
		const api = {
			brief: async () => ({ since: 0, generatedAt: 0, lines: [], agenda: [] }),
			agendaToday: async () => ({ items: [], available: false }),
		};
		const props = {
			mode: "phone" as const,
			liveCount: 0,
			linkError: null,
			onRetry: () => {},
			onOpenSessions: () => {},
			onOpenSessionList: () => {},
			onOpenStatus: () => {},
			onOpenSettings: () => {},
			api,
			overnightSessions: [],
			loadOvernightState: async () => { throw new Error("no overnight state"); },
			onOpenOvernight: () => {},
			canOpenSession: () => false,
			onOpenSession: () => {},
		};
		const denied = renderToStaticMarkup(<HomeScreen {...props} state="not-authorized" />);
		const down = renderToStaticMarkup(<HomeScreen {...props} state="unreachable" />);
		expect(denied).toContain("Not authorized");
		expect(down).toContain("Daemon unreachable");
		expect(down).toContain("Retry now");
		for (const html of [denied, down, renderToStaticMarkup(<HomeScreen {...props} state="idle" />)]) {
			expect(html.toLowerCase()).not.toContain("collab");
		}
	});
	it("hides optional home panels until the daemon advertises their capabilities", () => {
		const props = {
			mode: "desktop" as const,
			liveCount: 0,
			linkError: null,
			onRetry: () => {},
			onOpenSessions: () => {},
			onOpenSessionList: () => {},
			onOpenStatus: () => {},
			onOpenSettings: () => {},
			api: {
				brief: async () => ({ since: 0, generatedAt: 1, lines: [], agenda: [] }),
				agendaToday: async () => ({ items: [], available: true }),
			},
			overnightSessions: [],
			loadOvernightState: async (sessionId: string) => ({
				sessionId,
				startedAt: 0,
				policy: { deadline: new Date(86_400_000).toISOString(), askTimeoutSec: 60, quiet: "normal" as const, maxIdleContinuations: 1, keepAwake: false },
				phase: "complete" as const,
				continuations: 0,
				idleContinuations: 0,
				events: [],
			}),
			onOpenOvernight: () => {},
			canOpenSession: () => false,
			onOpenSession: () => {},
		};
		const disabled = renderToStaticMarkup(<HomeScreen {...props} state="idle" />);
		expect(disabled).not.toContain("While you were away");
		expect(disabled).not.toContain("<strong>Today</strong>");
		expect(disabled).not.toContain("Overnight run");
		const enabled = renderToStaticMarkup(<HomeScreen {...props} state="idle" librarianEnabled agendaEnabled />);
		expect(enabled).toContain("While you were away");
		expect(enabled).toContain("<strong>Today</strong>");
	});
});
