import type {
	AgendaToday,
	ApiError,
	CardStatus,
	CardsResponse,
	NewSessionSuggestions,
	PathSuggestions,
	ReturnBrief,
	SessionCard,
	SessionSummary,
	TitleRevision,
	TitleSource,
} from "@omp-console/protocol";
import { OMP_CONSOLE_SESSION_URL_PREFIX } from "@omp-console/protocol";

const KNOWLEDGE_ROOT = "/Users/alice/Knowledge";
const PROJECTS_ROOT = "/Users/alice/Projects";
const MOCK_DIRECTORIES = [
	KNOWLEDGE_ROOT,
	PROJECTS_ROOT,
	`${PROJECTS_ROOT}/console-example`,
	`${PROJECTS_ROOT}/web-app`,
	`${PROJECTS_ROOT}/docs`,
];

export interface LibrarianMockContext {
	sessions(): { live: SessionSummary[]; recent: SessionSummary[] };
}

export interface LibrarianMock {
	/** Answers librarian and agenda routes; `undefined` for anything else. `route` has no `/api`. */
	handle(req: Request, route: string): Promise<Response | undefined>;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || "/";
}

function statusFor(session: SessionSummary, live: boolean): CardStatus {
	if (session.awaitingAnswer || session.state === "asking") return "waiting";
	if (session.state === "stopped") return "done";
	return live ? "unfinished" : "done";
}

function defaultCard(session: SessionSummary, live: boolean): SessionCard {
	const titleSource: TitleSource = session.title?.trim() ? "omp" : "deck";
	const status = statusFor(session, live);
	return {
		sessionId: session.id,
		cwd: session.cwd,
		workspaceId: undefined,
		title: session.title?.trim() || basename(session.cwd),
		titleSource,
		titleHistory: [],
		status,
		stoppedAt: status === "done" ? "The previous turn finished" : "The latest checkpoint",
		nextStep: status === "done" ? undefined : "Review the open work",
		topic: basename(session.cwd) === "omp" ? "omp console" : undefined,
		scheduled: session.title?.toLowerCase().startsWith("scheduled") ?? false,
		live,
		lastActivityAt: session.lastActivityAt,
		cardUpdatedAt: session.lastActivityAt,
		stale: false,
	};
}

export function createLibrarianMock(context: LibrarianMockContext): LibrarianMock {
	const stored = new Map<string, SessionCard>();

	function allSessions(): { live: SessionSummary[]; recent: SessionSummary[] } {
		const { live, recent } = context.sessions();
		return { live, recent };
	}

	function cardFor(sessionId: string): SessionCard | undefined {
		const { live, recent } = allSessions();
		const summary = live.find(session => session.id === sessionId) ?? recent.find(session => session.id === sessionId);
		if (!summary) return undefined;
		const isLive = live.some(session => session.id === sessionId);
		const saved = stored.get(sessionId);
		const current = saved ?? defaultCard(summary, isLive);
		const updated: SessionCard = {
			...current,
			cwd: summary.cwd,
			lastActivityAt: summary.lastActivityAt,
			live: isLive,
			status: isLive ? statusFor(summary, true) : current.status,
		};
		stored.set(sessionId, updated);
		return updated;
	}

	function cards(): SessionCard[] {
		const { live, recent } = allSessions();
		const sessions = new Map<string, { summary: SessionSummary; live: boolean }>();
		for (const summary of recent) sessions.set(summary.id, { summary, live: false });
		for (const summary of live) sessions.set(summary.id, { summary, live: true });
		return [...sessions.values()]
			.map(({ summary }) => cardFor(summary.id))
			.filter((card): card is SessionCard => card !== undefined)
			.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	function workspaceSuggestions(): NewSessionSuggestions {
		const counts = new Map<string, { sessions30d: number; lastUsedAt: number }>();
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		const { recent, live } = allSessions();
		for (const session of [...recent, ...live]) {
			if (session.lastActivityAt < thirtyDaysAgo) continue;
			const previous = counts.get(session.cwd);
			counts.set(session.cwd, {
				sessions30d: (previous?.sessions30d ?? 0) + 1,
				lastUsedAt: Math.max(previous?.lastUsedAt ?? 0, session.lastActivityAt),
			});
		}
		const paths = new Set([...counts.keys(), KNOWLEDGE_ROOT, `${PROJECTS_ROOT}/omp`]);
		return {
			recent: [...paths]
				.map(cwd => ({
					cwd,
					name: basename(cwd),
					sessions30d: counts.get(cwd)?.sessions30d ?? 0,
					lastUsedAt: counts.get(cwd)?.lastUsedAt ?? 0,
				}))
				.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name)),
			roots: [
				{ path: KNOWLEDGE_ROOT, kind: "knowledge" },
				{ path: PROJECTS_ROOT, kind: "project" },
			],
		};
	}

	function pathSuggestions(req: Request): PathSuggestions {
		const query = new URL(req.url).searchParams.get("q")?.trim() ?? "";
		const lowerQuery = query.toLowerCase();
		const { live, recent } = allSessions();
		const directories = [...new Set([...MOCK_DIRECTORIES, ...live.map(session => session.cwd), ...recent.map(session => session.cwd)])];
		const matches = directories
			.filter(path => path.toLowerCase().includes(lowerQuery))
			.map(path => ({ path, exists: true as const }));
		if (query === "") return { matches };
		const root = query.startsWith(`${KNOWLEDGE_ROOT}/`) || query === KNOWLEDGE_ROOT ? KNOWLEDGE_ROOT : PROJECTS_ROOT;
		const path = query.startsWith("/") ? query : `${root}/${query.replace(/^\/+/, "")}`;
		if (directories.includes(path)) return { matches };
		return { matches, create: { path, root } };
	}

	function brief(req: Request): ReturnBrief {
		const generatedAt = Date.now();
		const oldestSince = generatedAt - 7 * 24 * 60 * 60 * 1000;
		const rawSince = new URL(req.url).searchParams.get("since");
		const since = Math.max(rawSince === null ? oldestSince : Number(rawSince), oldestSince);
		const ranks: Record<ReturnBrief["lines"][number]["kind"], number> = { "needs-you": 0, finished: 1, unfinished: 2 };
		const lines: ReturnBrief["lines"] = cards()
			.filter(card => !card.scheduled)
			.map((card): ReturnBrief["lines"][number] => ({
				sessionId: card.sessionId,
				title: card.title,
				cwd: card.cwd,
				text: `${card.stoppedAt ?? "Stopped at the latest checkpoint"}${card.nextStep ? ` · Next ${card.nextStep}` : ""}`,
				status: card.status,
				changedAt: Math.max(card.lastActivityAt, card.cardUpdatedAt ?? 0),
				kind: card.status === "waiting" ? "needs-you" : card.status === "done" ? "finished" : "unfinished",
			}))
			.filter(line => line.changedAt > since)
			.sort((a, b) => ranks[a.kind] - ranks[b.kind] || b.changedAt - a.changedAt)
			.slice(0, 60);
		const items = agenda().items;
		return { since, generatedAt, lines, agenda: items };
	}

	function agenda(): AgendaToday {
		const live = allSessions().live;
		const session = live[0];
		return {
			available: true,
			items: [
				{
					uid: "mock-agenda-review",
					title: "Review today's open work",
					list: "Today",
					due: Date.now(),
					completed: false,
					...(session ? { sessionId: session.id, url: `${OMP_CONSOLE_SESSION_URL_PREFIX}${encodeURIComponent(session.id)}` } : {}),
				},
			],
		};
	}

	return {
		async handle(req, route) {
			if (route === "/cards" && req.method === "GET") {
				const response: CardsResponse = { cards: cards(), topics: ["omp console", "Work"], pending: 0, decisionBackend: "luna" };
				return json(response);
			}
			if (route === "/cards/refresh" && req.method === "POST") return new Response(null, { status: 202 });
			const titleRoute = /^\/cards\/([^/]+)\/title(\/undo)?$/.exec(route);
			if (titleRoute && req.method === "POST") {
				let sessionId: string;
				try {
					sessionId = decodeURIComponent(titleRoute[1]!);
				} catch {
					return fail(400, "bad-request", "invalid session id");
				}
				const current = cardFor(sessionId);
				if (!current) return fail(404, "not-found", "no session card");
				if (titleRoute[2]) {
					const previous: TitleRevision | undefined = current.titleHistory.at(-1);
					if (!previous) return fail(409, "conflict", "no earlier title");
					const undone = { ...current, title: previous.title, titleSource: previous.source, titleHistory: current.titleHistory.slice(0, -1) };
					stored.set(sessionId, undone);
					return json(undone);
				}
				const body: unknown = await req.json().catch(() => null);
				const title = (body as { title?: unknown } | null)?.title;
				if (typeof title !== "string" || title.trim() === "") return fail(400, "bad-request", "title is required");
				const history = [...current.titleHistory, { title: current.title, source: current.titleSource, at: Date.now() }];
				const renamed: SessionCard = { ...current, title: title.trim(), titleSource: "user", titleHistory: history };
				stored.set(sessionId, renamed);
				return json(renamed);
			}
			if (route === "/brief" && req.method === "GET") return json(brief(req));
			if (route === "/new-session/suggestions" && req.method === "GET") return json(workspaceSuggestions());
			if (route === "/new-session/paths" && req.method === "GET") return json(pathSuggestions(req));
			if (route === "/agenda/today" && req.method === "GET") return json(agenda());
			return undefined;
		},
	};
}
