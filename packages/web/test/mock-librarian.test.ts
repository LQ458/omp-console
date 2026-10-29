import { describe, expect, it } from "bun:test";
import type { AgendaToday, CardsResponse, NewSessionBrowseResponse, NewSessionSuggestions, PathSuggestions, ReturnBrief, SessionSummary } from "@omp-console/protocol";
import { createLibrarianMock, type LibrarianMock } from "../dev/mock-librarian";

function session(id: string, cwd: string, lastActivityAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		cwd,
		sessionFile: `${cwd}/.omp-console/${id}.jsonl`,
		title: `Original ${id}`,
		state: "idle",
		createdAt: lastActivityAt - 60_000,
		lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

async function call(
	mock: LibrarianMock,
	route: string,
	method = "GET",
	body?: unknown,
): Promise<Response> {
	const url = new URL(route, "http://deck.test");
	const request = new Request(url, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	const response = await mock.handle(request, url.pathname);
	if (!response) throw new Error(`Mock did not handle ${route}`);
	return response;
}

describe("librarian mock routes", () => {
	it("merges live and recent sessions into ordered cards with live state taking precedence", async () => {
		const now = Date.now();
		const mock = createLibrarianMock({
			sessions: () => ({
				live: [session("live", "/work/omp", now, { state: "asking", awaitingAnswer: true })],
				recent: [session("old", "/work/old", now - 1_000, { state: "stopped" })],
			}),
		});

		const response = await call(mock, "/cards");
		const result = (await response.json()) as CardsResponse;
		expect(result.cards.map(card => card.sessionId)).toEqual(["live", "old"]);
		expect(result.cards[0]?.status).toBe("waiting");
		expect(result.cards[0]?.live).toBe(true);
		expect(result.cards[1]?.status).toBe("done");
		expect(result.cards[1]?.live).toBe(false);
	});

	it("renames cards, restores title history through undo, and rejects missing cards", async () => {
		const now = Date.now();
		const mock = createLibrarianMock({ sessions: () => ({ live: [], recent: [session("s1", "/work/project", now)] }) });

		const renamedResponse = await call(mock, "/cards/s1/title", "POST", { title: "  Follow up  " });
		const renamed = (await renamedResponse.json()) as { sessionId: string; title: string; titleHistory: { title: string }[] };
		expect(renamed.title).toBe("Follow up");
		expect(renamed.titleHistory.map(revision => revision.title)).toEqual(["Original s1"]);

		const undoResponse = await call(mock, "/cards/s1/title/undo", "POST");
		const undone = (await undoResponse.json()) as { title: string; titleHistory: unknown[] };
		expect(undone.title).toBe("Original s1");
		expect(undone.titleHistory).toEqual([]);

		const missing = await call(mock, "/cards/missing/title", "POST", { title: "No card" });
		expect(missing.status).toBe(404);
	});

	it("provides recent workspace counts and a Create path row for unmatched locations", async () => {
		const now = Date.now();
		const mock = createLibrarianMock({
			sessions: () => ({
				live: [session("live", "/work/project", now)],
				recent: [session("recent", "/work/project", now - 1_000)],
			}),
		});
		const workspacesResponse = await call(mock, "/new-session/suggestions");
		const workspaces = (await workspacesResponse.json()) as NewSessionSuggestions;
		const project = workspaces.recent.find(workspace => workspace.cwd === "/work/project");
		expect(project?.sessions30d).toBe(2);

		const pathResponse = await call(mock, "/new-session/paths?q=brand-new");
		const paths = (await pathResponse.json()) as PathSuggestions;
		expect(paths.matches).toEqual([]);
		expect(paths.create?.path).toBe("/Users/alice/projects/brand-new");
	});

	it("browses the demo home, nested projects, and an empty folder", async () => {
		const mock = createLibrarianMock({ sessions: () => ({ live: [], recent: [] }) });
		const suggestions = (await (await call(mock, "/new-session/suggestions")).json()) as NewSessionSuggestions;
		expect(suggestions.recent.map(project => project.cwd)).toEqual([
			"/Users/alice/projects/api",
			"/Users/alice/projects/app",
		]);

		const home = (await (await call(mock, "/new-session/browse")).json()) as NewSessionBrowseResponse;
		expect(home).toMatchObject({
			dir: "/Users/alice",
			home: "/Users/alice",
			entries: [
				{ name: "code", path: "/Users/alice/code" },
				{ name: "Documents", path: "/Users/alice/Documents" },
				{ name: "projects", path: "/Users/alice/projects" },
			],
			truncated: false,
		});
		expect(home.parent).toBeUndefined();

		const projectFolders = (await (await call(mock, "/new-session/browse?dir=%2FUsers%2Falice%2Fprojects")).json()) as NewSessionBrowseResponse;
		expect(projectFolders.entries.map(entry => entry.name)).toEqual(["api", "app"]);
		const appFolders = (await (await call(mock, "/new-session/browse?dir=%2FUsers%2Falice%2Fprojects%2Fapp")).json()) as NewSessionBrowseResponse;
		expect(appFolders.entries.map(entry => entry.name)).toEqual(["docs", "src"]);

		const empty = await call(mock, "/new-session/browse?dir=%2FUsers%2Falice%2FDocuments");
		const emptyResponse = (await empty.json()) as NewSessionBrowseResponse;
		expect(emptyResponse.entries).toEqual([]);
		expect(emptyResponse.parent).toBe("/Users/alice");
		const missing = await call(mock, "/new-session/browse?dir=%2FUsers%2Falice%2Fmissing");
		expect(missing.status).toBe(404);
		expect((await missing.json()).error).toContain("Couldn't list this folder.");
	});

	it("filters the brief with the caller's cursor and leaves the old seen route unavailable", async () => {
		const now = Date.now();
		const mock = createLibrarianMock({
			sessions: () => ({ live: [session("live-1", "/work/project", now, { state: "asking", awaitingAnswer: true })], recent: [] }),
		});

		const briefResponse = await call(mock, "/brief");
		const brief = (await briefResponse.json()) as ReturnBrief;
		expect(brief.lines.map(line => [line.sessionId, line.kind])).toEqual([["live-1", "needs-you"]]);
		expect(brief.lines[0]!.changedAt).toBe(now);

		const cursor = now;
		const afterCursor = (await (await call(mock, `/brief?since=${cursor}`)).json()) as ReturnBrief;
		expect(afterCursor.since).toBe(cursor);
		expect(afterCursor.lines).toEqual([]);

		const agendaResponse = await call(mock, "/agenda/today");
		const agenda = (await agendaResponse.json()) as AgendaToday;
		expect(agenda.available).toBe(true);
		expect(agenda.items[0]?.sessionId).toBe("live-1");
		expect(agenda.items[0]?.url).toContain("omp-console://session/live-1");

		const seenRequest = new Request("http://deck.test/api/brief/seen", { method: "POST" });
		expect(await mock.handle(seenRequest, "/brief/seen")).toBeUndefined();
	});
});
