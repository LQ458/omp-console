import { describe, expect, it } from "bun:test";
import type { AgendaAskResponse, AgendaItem, AgendaToday } from "@omp-console/protocol";
import { AskCompletionLimit } from "../src/agenda/ask-limit";
import { askAnswerWithReceipt, createAgendaRoutes } from "../src/agenda/routes";
import type { AgendaHubConfig, AgendaPorts, AgendaRouteOptions } from "../src/agenda/ports";

const HUB: AgendaHubConfig = { python: "python", cwd: "/tmp/tasks-hub-fixture", env: { HUB_TZ: "America/Chicago" } };
const NOW = Date.parse("2026-10-23T17:00:00Z");

type AgendaRouteHandler = (req: Request, url: URL) => Promise<Response | undefined>;

function createRoutes(
	options: AgendaRouteOptions,
	ports: AgendaPorts = { askHidden: async () => ({ answer: "ok", sessionId: "ask-1" }) },
): AgendaRouteHandler {
	return createAgendaRoutes(ports, "/tmp/deck-agenda-test", options);
}

async function request(
	routes: AgendaRouteHandler,
	method: string,
	pathname: string,
	body?: unknown,
): Promise<Response> {
	const url = new URL(pathname, "http://deck.test");
	const response = await routes(
		new Request(url.href, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		}),
		url,
	);
	if (!response) throw new Error(`no route for ${pathname}`);
	return response;
}

function task(
	id: string,
	due: number | null,
	extras: { notes?: string; url?: string | null; completed?: boolean; priority?: number } = {},
): Record<string, unknown> {
	return {
		id,
		title: `Task ${id}`,
		list: "Inbox",
		due,
		notes: "",
		...(extras.priority === undefined ? {} : { priority: extras.priority }),
		...extras,
	};
}

describe("agenda routes", () => {
	it("returns due-today, overdue, and session-linked tasks using the hub timezone", async () => {
		const output = {
			lists: ["Inbox"],
			items: [
				task("overdue", Date.parse("2026-10-22T15:00:00Z") / 1000, { notes: "Reminder text" }),
				task("today", Date.parse("2026-10-23T18:30:00Z") / 1000),
				task("tomorrow", Date.parse("2026-10-24T15:00:00Z") / 1000),
				task("linked-url", Date.parse("2026-10-24T15:00:00Z") / 1000, { url: "omp-console://session/live-42" }),
				task("unlinked-notes", null, { notes: "Follow up\nomp console session: omp-console://session/notes-9" }),
				task("completed", Date.parse("2026-10-22T15:00:00Z") / 1000, { completed: true }),
			],
		};
		const routes = createRoutes({ hub: HUB, now: () => NOW, runBoardIo: async (_hub, args) => {
			expect(args).toEqual(["-m", "hub.board_io", "dump"]);
			return JSON.stringify(output);
		} });

		const response = await request(routes, "GET", "/api/agenda/today");
		const body = await response.json() as AgendaToday & { items: Array<AgendaItem & { notes?: string }> };
		expect(response.status).toBe(200);
		expect(body.available).toBe(true);
		expect(body.items.map(item => item.uid)).toEqual(["overdue", "today", "linked-url"]);
		expect(body.items[1]?.due).toBe(Date.parse("2026-10-23T18:30:00Z"));
		expect(body.items[2]).toMatchObject({ uid: "linked-url", url: "omp-console://session/live-42", sessionId: "live-42" });
		expect(body.items[0]?.notes).toBe("Reminder text");
	});

	it("lists tasks due in the next days only when asked, and rejects an out-of-range lookahead", async () => {
		const output = {
			lists: ["Inbox"],
			items: [
				task("today", Date.parse("2026-10-23T18:30:00Z") / 1000),
				task("tomorrow", Date.parse("2026-10-24T16:00:00Z") / 1000),
				task("next-week", Date.parse("2026-10-30T16:00:00Z") / 1000),
			],
		};
		// Its own hub object: the dump cache is per hub, so no other test's dump answers here.
		const routes = createRoutes({ hub: { ...HUB }, now: () => NOW, runBoardIo: async () => JSON.stringify(output) });
		const uids = async (path: string) => ((await (await request(routes, "GET", path)).json()) as AgendaToday).items.map(item => item.uid);

		expect(await uids("/api/agenda/today")).toEqual(["today"]);
		expect(await uids("/api/agenda/today?days=1")).toEqual(["today", "tomorrow"]);
		expect(await uids("/api/agenda/today?days=7")).toEqual(["today", "tomorrow", "next-week"]);
		expect((await request(routes, "GET", "/api/agenda/today?days=40")).status).toBe(400);
		expect((await request(routes, "GET", "/api/agenda/today?days=1.5")).status).toBe(400);
	});

	it("returns unavailable with a reason when tasks-hub is missing or fails", async () => {
		const unconfigured = await request(createRoutes({}), "GET", "/api/agenda/today");
		expect(unconfigured.status).toBe(200);
		expect(await unconfigured.json()).toEqual({ items: [], available: false, reason: "tasks-hub is not configured" });

		const failing = await request(createRoutes({ hub: HUB, runBoardIo: async () => { throw new Error("fixture failure"); } }), "GET", "/api/agenda/today");
		expect(failing.status).toBe(200);
		expect(await failing.json()).toEqual({ items: [], available: false, reason: "tasks-hub is unavailable" });
	});

	it("creates a task through board_io with the session link in tasks-hub's URL field", async () => {
		const calls: string[][] = [];
		const routes = createRoutes({ hub: HUB, runBoardIo: async (_hub, args) => {
			calls.push([...args]);
			if (args.at(-1) === "dump") return JSON.stringify({ lists: ["Inbox"], items: [] });
			const raw = args.at(-1);
			if (!raw) throw new Error("missing create request");
			const createRequest = JSON.parse(raw) as Record<string, unknown>;
			expect(createRequest).toMatchObject({
				title: "Review agenda",
					list: "Inbox",
				due: { date: "2026-10-23", time: "13:30" },
				priority: 0,
				notes: "from session",
				url: "omp-console://session/session-7",
				apply: true,
			});
			return JSON.stringify({ ok: true, id: "task-77" });
		} });
		const due = Date.parse("2026-10-23T18:30:00Z");

		const response = await request(routes, "POST", "/api/agenda/todos", {
			title: "Review agenda",
			due,
			notes: "from session",
			sessionId: "session-7",
		});
		const body = await response.json() as AgendaItem & { notes?: string };
		expect(response.status).toBe(201);
		expect(body).toEqual({
			uid: "task-77",
			title: "Review agenda",
			list: "Inbox",
			due,
			completed: false,
			url: "omp-console://session/session-7",
			sessionId: "session-7",
			notes: "from session",
		});
		expect(calls.map(args => args.at(-1))).toEqual(["dump", expect.any(String)]);
	});

	it("links an existing task to a session using a URL-checked board write", async () => {
		const uid = "task/77";
		const sessionId = "session/9";
		const due = Date.parse("2026-10-24T15:00:00Z") / 1000;
		let writeRequest: Record<string, unknown> | undefined;
		const routes = createRoutes({
			hub: HUB,
			runBoardIo: async (_hub, args) => {
				if (args[2] === "dump") {
					return JSON.stringify({ lists: ["Inbox"], items: [task(uid, due, { priority: 5, notes: "lab notes", url: null })] });
				}
				writeRequest = JSON.parse(args.at(-1)!) as Record<string, unknown>;
				return JSON.stringify({ ok: true, applied: true });
			},
		});

		const response = await request(routes, "POST", `/api/agenda/todos/${encodeURIComponent(uid)}/link`, { sessionId });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			uid,
			title: `Task ${uid}`,
			list: "Inbox",
			completed: false,
			due: due * 1000,
			url: "omp-console://session/session%2F9",
			sessionId,
			notes: "lab notes",
		});
		expect(writeRequest).toEqual({
			id: uid,
			field: "url",
			value: "omp-console://session/session%2F9",
			expect: { title: `Task ${uid}`, due, priority: 5, list: "Inbox", url: null },
			apply: true,
		});
	});

	it("completes the open task linked to the current session when no uid is given", async () => {
		const sessionId = "session-42";
		const link = `omp-console://session/${sessionId}`;
		let writeRequest: Record<string, unknown> | undefined;
		const routes = createRoutes({
			hub: HUB,
			runBoardIo: async (_hub, args) => {
				if (args[2] === "dump") {
					return JSON.stringify({ lists: ["Inbox"], items: [task("linked-task", null, { url: link, priority: 1 })] });
				}
				writeRequest = JSON.parse(args.at(-1)!) as Record<string, unknown>;
				return JSON.stringify({ ok: true, applied: true });
			},
		});

		const response = await request(routes, "POST", "/api/agenda/todos/complete", { sessionId });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ uid: "linked-task", sessionId, completed: true, title: "Task linked-task" });
		expect(writeRequest).toEqual({
			id: "linked-task",
			field: "complete",
			value: true,
			expect: { title: "Task linked-task", due: null, priority: 1, list: "Inbox", url: link },
			apply: true,
		});
	});

	it("completes a task named by uid, linked or not, and refuses an unknown or already completed one", async () => {
		let writeRequest: Record<string, unknown> | undefined;
		const routes = createRoutes({
			hub: HUB,
			runBoardIo: async (_hub, args) => {
				if (args[2] === "dump") {
					return JSON.stringify({
						lists: ["Inbox"],
						items: [task("homework", null, { priority: 0 }), task("done-already", null, { priority: 0, completed: true })],
					});
				}
				writeRequest = JSON.parse(args.at(-1)!) as Record<string, unknown>;
				return JSON.stringify({ ok: true, applied: true });
			},
		});

		const response = await request(routes, "POST", "/api/agenda/todos/complete", { sessionId: "any-session", uid: "homework" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ uid: "homework", sessionId: "any-session", completed: true, title: "Task homework" });
		expect(writeRequest).toMatchObject({ id: "homework", field: "complete", value: true, apply: true });

		expect((await request(routes, "POST", "/api/agenda/todos/complete", { sessionId: "s", uid: "missing" })).status).toBe(404);
		expect((await request(routes, "POST", "/api/agenda/todos/complete", { sessionId: "s", uid: "done-already" })).status).toBe(404);
	});

	it("lets an Ask session tick one task per ask even with parallel calls, and gives a slot back only on a definite failure", async () => {
		const limit = new AskCompletionLimit();
		let writes = 0;
		let writeOutput = JSON.stringify({ ok: true, applied: true });
		const routes = createRoutes({
			hub: { ...HUB },
			claimCompletion: sessionId => limit.claim(sessionId),
			runBoardIo: async (_hub, args) => {
				if (args[2] === "dump") return JSON.stringify({ lists: ["Inbox"], items: ["a", "b", "c"].map(id => task(id, null, { priority: 0 })) });
				writes++;
				return writeOutput;
			},
		});
		const complete = (uid: string) => request(routes, "POST", "/api/agenda/todos/complete", { sessionId: "ask", uid }).then(r => r.status);

		limit.begin("ask");
		expect(await complete("missing")).toBe(404);
		expect((await Promise.all(["a", "b", "c"].map(complete))).sort()).toEqual([200, 409, 409]);
		expect(writes).toBe(1);
		expect((await limit.end("ask", 5_000)).map(done => done.uid)).toHaveLength(1);

		// Between asks (and after a timed-out one) the Ask session cannot tick anything.
		expect(await complete("b")).toBe(409);

		// An unreadable write result may have landed: the slot stays taken.
		limit.begin("ask");
		writeOutput = "not json";
		expect(await complete("b")).toBe(502);
		writeOutput = JSON.stringify({ ok: true, applied: true });
		expect(await complete("c")).toBe(409);
		expect(await limit.end("ask", 5_000)).toEqual([{ uid: "b", title: "Task b", uncertain: true }]);

		// Other sessions are not limited.
		expect((await request(routes, "POST", "/api/agenda/todos/complete", { sessionId: "other", uid: "c" })).status).toBe(200);
	});

	it("binds a claim to its ask: a late result from an earlier ask never frees or fills the next ask's slot", async () => {
		const limit = new AskCompletionLimit();
		limit.begin("ask");
		const first = limit.claim("ask");
		if (typeof first !== "object") throw new Error("expected a claim");
		expect(await limit.end("ask", 10)).toEqual([]);
		limit.begin("ask");
		const second = limit.claim("ask");
		if (typeof second !== "object") throw new Error("expected a claim");
		first.release();
		first.complete({ uid: "late", title: "Late" });
		expect(typeof limit.claim("ask")).toBe("string");
		second.complete({ uid: "b", title: "B" });
		expect(await limit.end("ask", 5_000)).toEqual([{ uid: "b", title: "B" }]);
	});

	it("does not write once the ask has ended during a slow dump", async () => {
		const limit = new AskCompletionLimit();
		let writes = 0;
		const routes = createRoutes({
			hub: { ...HUB },
			claimCompletion: sessionId => limit.claim(sessionId),
			runBoardIo: async (_hub, args) => {
				if (args[2] === "dump") {
					await Bun.sleep(100);
					return JSON.stringify({ lists: ["Inbox"], items: [task("a", null, { priority: 0 })] });
				}
				writes++;
				return JSON.stringify({ ok: true, applied: true });
			},
		});
		limit.begin("ask");
		const pending = request(routes, "POST", "/api/agenda/todos/complete", { sessionId: "ask", uid: "a" });
		await Bun.sleep(20);
		expect(await limit.end("ask", 5_000)).toEqual([]);
		expect((await pending).status).toBe(409);
		expect(writes).toBe(0);
	});

	it("reports a write still running when the ask's time is up as 'may have been marked done'", async () => {
		const limit = new AskCompletionLimit();
		limit.begin("ask");
		const claim = limit.claim("ask");
		if (typeof claim !== "object") throw new Error("expected a claim");
		claim.writing({ uid: "slow", title: "Slow" });
		expect(await limit.end("ask", 20)).toEqual([{ uid: "slow", title: "Slow", uncertain: true }]);
	});

	it("waits for a write under way when an ask ends, so a last-moment tick is still reported", async () => {
		const limit = new AskCompletionLimit();
		limit.begin("ask");
		const claim = limit.claim("ask");
		if (typeof claim !== "object") throw new Error("expected a claim");
		setTimeout(() => claim.complete({ uid: "a", title: "A" }), 50);
		expect(await limit.end("ask", 5_000)).toEqual([{ uid: "a", title: "A" }]);
	});

	it("appends a daemon-written receipt of completed tasks to the Ask answer", () => {
		expect(askAnswerWithReceipt("Done.", [{ title: "Send project update" }])).toBe("Done.\n\n✓ Marked done: **Send project update**");
		expect(askAnswerWithReceipt(undefined, [{ title: "A" }])).toBe("✓ Marked done: **A**");
		expect(askAnswerWithReceipt("Nothing changed.", [])).toBe("Nothing changed.");
		expect(askAnswerWithReceipt(undefined, [{ title: "B", uncertain: true }])).toBe("⚠ May have been marked done (check the board): **B**");
		expect(askAnswerWithReceipt(undefined, [{ title: "**" }])).toBe("✓ Marked done: **(untitled task)**");
		expect(askAnswerWithReceipt(undefined, [{ title: "\u200b" }])).toBe("✓ Marked done: **(untitled task)**");
		expect(askAnswerWithReceipt(undefined, [{ title: "\u202e\u2066\u00ad\u0301" }])).toBe("✓ Marked done: **(untitled task)**");
		expect(askAnswerWithReceipt(undefined, [{ title: "abc\u202edef" }])).toBe("✓ Marked done: **abcdef**");
		expect(askAnswerWithReceipt(undefined, [{ title: "\u3164\u2800" }])).toBe("✓ Marked done: **(untitled task)**");
		expect(askAnswerWithReceipt(undefined, [{ title: "👨\u200d👩\u200d👧" }])).toBe("✓ Marked done: **👨\u200d👩\u200d👧**");
		expect(askAnswerWithReceipt(undefined, [{ title: "😀".repeat(300) }])).toBe(`✓ Marked done: **${"😀".repeat(199)}…**`);
	});

	it("counts days ahead in calendar days across daylight-saving changes", async () => {
		const items = [
			task("nov1", Date.parse("2026-11-01T16:00:00Z") / 1000),
			task("nov2", Date.parse("2026-11-02T16:00:00Z") / 1000),
			task("mar14", Date.parse("2027-03-14T16:00:00Z") / 1000),
			task("mar15", Date.parse("2027-03-15T16:00:00Z") / 1000),
		];
		const at = (iso: string) => createRoutes({ hub: { ...HUB }, now: () => Date.parse(iso), runBoardIo: async () => JSON.stringify({ lists: ["Inbox"], items }) });
		const uids = async (routes: AgendaRouteHandler) => ((await (await request(routes, "GET", "/api/agenda/today?days=1")).json()) as AgendaToday).items.map(item => item.uid);
		// 00:30 CDT on the night clocks go back: tomorrow is Nov 2.
		expect(await uids(at("2026-11-01T05:30:00Z"))).toEqual(["nov1", "nov2"]);
		// 23:30 CST before clocks go forward: tomorrow is Mar 14, not Mar 15.
		expect((await uids(at("2027-03-14T05:30:00Z"))).filter(uid => uid.startsWith("mar"))).toEqual(["mar14"]);
	});

	it("refuses completion when no open task links to the session", async () => {
		const routes = createRoutes({
			hub: HUB,
			runBoardIo: async () => JSON.stringify({ lists: ["Inbox"], items: [task("unlinked", null, { priority: 0 })] }),
		});
		const response = await request(routes, "POST", "/api/agenda/todos/complete", { sessionId: "session-without-task" });
		expect(response.status).toBe(404);
	});

	it("returns the hidden-session answer and sends agenda-tool instructions", async () => {
		let captured: { text: string; addendum: string } | undefined;
		const answer: AgendaAskResponse = { answer: "Added the task.", sessionId: "hidden-5" };
		const routes = createRoutes({}, {
			askHidden: async (text, systemAddendum) => {
				captured = { text, addendum: systemAddendum };
				return answer;
			},
		});

		const response = await request(routes, "POST", "/api/agenda/ask", { text: "  Add a task for Friday  " });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(answer);
		expect(captured?.text).toBe("Add a task for Friday");
		expect(captured?.addendum).toContain("agenda_today");
		expect(captured?.addendum).toContain("agenda_add");
	});

	it("rejects empty ask text and todo titles before calling a port", async () => {
		let calls = 0;
		const routes = createRoutes({ hub: HUB }, {
			askHidden: async () => {
				calls += 1;
				return { answer: "unused", sessionId: "unused" };
			},
		});
		const ask = await request(routes, "POST", "/api/agenda/ask", { text: "  " });
		const todo = await request(routes, "POST", "/api/agenda/todos", { title: "" });
		expect(ask.status).toBe(400);
		expect(todo.status).toBe(400);
		expect(calls).toBe(0);
	});
});

describe("agenda dump cache", () => {
	it("serves repeated reads from one dump, refreshes stale ones behind the answer, and rereads after a write", async () => {
		const hub: AgendaHubConfig = { ...HUB, cwd: "/tmp/tasks-hub-cache-fixture" };
		let clock = NOW;
		let dumps = 0;
		let items = [task("first", Date.parse("2026-10-23T18:30:00Z") / 1000, { priority: 0 })];
		const routes = createRoutes({
			hub,
			now: () => clock,
			runBoardIo: async (_hub, args) => {
				if (args.at(-1) === "dump") {
					dumps += 1;
					return JSON.stringify({ lists: ["Inbox"], items });
				}
				items = [...items, task("added", Date.parse("2026-10-23T19:00:00Z") / 1000, { priority: 0 })];
				return JSON.stringify({ ok: true, applied: true, id: "added" });
			},
		});
		const today = async (): Promise<string[]> =>
			((await (await request(routes, "GET", "/api/agenda/today")).json()) as AgendaToday).items.map(item => item.uid);

		expect(await today()).toEqual(["first"]);
		expect(await today()).toEqual(["first"]);
		expect(dumps).toBe(1);

		// Two minutes later the cached answer comes back at once while one refresh runs behind it.
		clock += 120_000;
		expect(await today()).toEqual(["first"]);
		await Bun.sleep(0);
		expect(dumps).toBe(2);

		// A task added through deck is visible on the very next read.
		const created = await request(routes, "POST", "/api/agenda/todos", { title: "Added" });
		expect(created.status).toBeLessThan(300);
		expect(await today()).toEqual(["first", "added"]);
	});
});
