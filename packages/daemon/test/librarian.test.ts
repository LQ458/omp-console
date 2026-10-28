import { afterEach, describe, expect, it } from "bun:test";
import type { AgendaItem, SessionCard, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DecisionAnswer, DecisionModel, DecisionQuestion, DecisionRequest, TextModel, TextRequest } from "../src/models/types";
import type { PersistedSession } from "../src/history/ports";
import type { LiveConversation, LibrarianPorts } from "../src/librarian/ports";
import { createLibrarianRoutes, type LibrarianRoutes } from "../src/librarian/routes";
import { makeTmp } from "./helpers";

const temporaryRoots: string[] = [];
const liveRoutes: LibrarianRoutes[] = [];

interface TextCard {
	title: string;
	stoppedAt: string;
	nextStep: string;
}

class FakeTextModel implements TextModel {
	readonly calls: TextRequest[] = [];
	response: TextCard = { title: "Generated title", stoppedAt: "Reached the current checkpoint", nextStep: "Continue the implementation" };
	failuresRemaining = 0;
	latencyMs = 0;
	active = 0;
	maxActive = 0;

	async complete(request: TextRequest): Promise<string> {
		this.calls.push(request);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this.latencyMs > 0) await Bun.sleep(this.latencyMs);
			if (this.failuresRemaining > 0) {
				this.failuresRemaining--;
				throw new Error("model unavailable");
			}
			return JSON.stringify(this.response);
		} finally {
			this.active--;
		}
	}
}

class FakeDecisionModel implements DecisionModel {
	readonly backend = "luna" as const;
	readonly calls: DecisionRequest[] = [];
	status: "waiting" | "unfinished" | "done" = "unfinished";
	topic = "Projects";
	driftProbability = 0.9;
	rootChoice: "knowledge" | "project" = "project";
	failuresRemaining = 0;

	async decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>> {
		this.calls.push(request);
		if (this.failuresRemaining > 0) {
			this.failuresRemaining--;
			throw new Error("decision unavailable");
		}
		const answers: Record<string, DecisionAnswer> = {};
		for (const [key, question] of Object.entries(request.questions)) {
			if (question.type === "noul") {
				answers[key] = { type: "noul", probability: this.driftProbability };
				continue;
			}
			if (question.type === "score") {
				answers[key] = { type: "score", value: 0, probabilities: {}, confidence: 1 };
				continue;
			}
			const selected = this.#selection(key, question);
			answers[key] = { type: "choice", selected, probabilities: { [selected]: 1 }, confidence: 1 };
		}
		return answers;
	}

	#selection(key: string, question: Extract<DecisionQuestion, { type: "choice" }>): string {
		if (key === "status" && question.options.includes(this.status)) return this.status;
		if (key === "topic" && question.options.includes(this.topic)) return this.topic;
		if (key === "root" && question.options.includes(this.rootChoice)) return this.rootChoice;
		return question.options[0]!;
	}
}

interface Runtime {
	root: string;
	stateDir: string;
	knowledgeRoot: string;
	projectsRoot: string;
	persisted: PersistedSession[];
	live: SessionSummary[];
	conversations: Map<string, LiveConversation>;
	text: FakeTextModel;
	decisions: FakeDecisionModel;
	routes: LibrarianRoutes;
	now: { value: number };
}

function temporaryDirectory(): string {
	const directory = makeTmp("deck-librarian-");
	temporaryRoots.push(directory);
	return directory;
}

function runtime(options: {
	scheduleConfig?: string | ((root: string) => string);
	now?: number;
	agenda?: AgendaItem[];
	initialCards?: (roots: Pick<Runtime, "knowledgeRoot" | "projectsRoot">) => SessionCard[];
	initialTopics?: string[];
} = {}): Runtime {
	const root = temporaryDirectory();
	const stateDir = path.join(root, "state");
	const knowledgeRoot = path.join(root, "knowledge");
	const projectsRoot = path.join(root, "GitHub");
	fs.mkdirSync(knowledgeRoot, { recursive: true });
	fs.mkdirSync(projectsRoot, { recursive: true });
	const scheduleConfig = typeof options.scheduleConfig === "function" ? options.scheduleConfig(root) : options.scheduleConfig;
	const initialCards = options.initialCards?.({ knowledgeRoot, projectsRoot });
	if (initialCards || options.initialTopics) {
		fs.mkdirSync(path.join(stateDir, "librarian"), { recursive: true });
	}
	if (initialCards) {
		const directory = path.join(stateDir, "librarian");
		fs.writeFileSync(path.join(directory, "cards.json"), `${JSON.stringify(initialCards)}\n`, { mode: 0o600 });
	}
	if (options.initialTopics) {
		fs.writeFileSync(path.join(stateDir, "librarian", "topics.json"), `${JSON.stringify(options.initialTopics)}\n`, { mode: 0o600 });
	}
	const persisted: PersistedSession[] = [];
	const live: SessionSummary[] = [];
	const conversations = new Map<string, LiveConversation>();
	const text = new FakeTextModel();
	const decisions = new FakeDecisionModel();
	const now = { value: options.now ?? 1_000 };
	const ports: LibrarianPorts = {
		list: () => live,
		listPersisted: async () => persisted,
		readLiveConversation: async sessionId => conversations.get(sessionId) ?? { messages: [] },
		textModel: text,
		decisionModel: decisions,
		...(options.agenda === undefined ? {} : { agendaToday: async () => options.agenda! }),
	};
	const routes = createLibrarianRoutes(ports, stateDir, {
		knowledgeRoot,
		projectRoots: [projectsRoot],
		...(scheduleConfig === undefined ? {} : { scheduleConfig }),
		intervalMs: 0,
		now: () => now.value,
	});
	liveRoutes.push(routes);
	return { root, stateDir, knowledgeRoot, projectsRoot, persisted, live, conversations, text, decisions, routes, now };
}

function persistedSession(
	runtimeValue: Runtime,
	id: string,
	cwd: string,
	modifiedAt: number,
	options: { title?: string; firstMessage?: string; transcript?: string[] } = {},
): PersistedSession {
	const directory = path.join(runtimeValue.root, "sessions");
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `${encodeURIComponent(id)}.jsonl`);
	const transcript = options.transcript ?? [options.firstMessage ?? "Please inspect the project and continue the work."];
	const rows = transcript.map((text, index) => JSON.stringify({
		type: "message",
		id: `${id}-${index}`,
		message: { role: index % 2 === 0 ? "user" : "assistant", content: text },
	}));
	fs.writeFileSync(file, `${rows.join("\n")}\n`);
	return {
		id,
		file,
		cwd,
		modifiedAt,
		createdAt: modifiedAt - 10_000,
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.firstMessage === undefined ? {} : { firstMessage: options.firstMessage }),
	};
}

function liveSession(id: string, cwd: string, lastActivityAt: number, title?: string): SessionSummary {
	return {
		id,
		cwd,
		state: "idle",
		createdAt: lastActivityAt - 10_000,
		lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...(title === undefined ? {} : { title }),
	};
}

async function request(
	routes: LibrarianRoutes,
	method: string,
	pathName: string,
	body?: unknown,
): Promise<Response> {
	const url = new URL(pathName, "http://deck.test");
	const response = await routes(new Request(url.href, {
		method,
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	}), url);
	if (!response) throw new Error(`librarian did not handle ${pathName}`);
	return response;
}

async function responseJson<T>(response: Response): Promise<T> {
	return await response.json() as T;
}

function savedCards(runtimeValue: Runtime): SessionCard[] {
	const file = path.join(runtimeValue.stateDir, "librarian", "cards.json");
	if (!fs.existsSync(file)) return [];
	return JSON.parse(fs.readFileSync(file, "utf8")) as SessionCard[];
}

function savedCard(runtimeValue: Runtime, sessionId: string): SessionCard | undefined {
	return savedCards(runtimeValue).find(card => card.sessionId === sessionId);
}


function card(
	sessionId: string,
	cwd: string,
	lastActivityAt: number,
	status: SessionCard["status"],
	extra: Partial<SessionCard> = {},
): SessionCard {
	return {
		sessionId,
		cwd,
		title: `${sessionId} title`,
		titleSource: "deck",
		titleHistory: [],
		status,
		scheduled: false,
		live: false,
		lastActivityAt,
		cardUpdatedAt: lastActivityAt,
		stale: false,
		...extra,
	};
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`timed out waiting for ${message}`);
}

async function waitForSavedCard(runtimeValue: Runtime, sessionId: string, predicate: (value: SessionCard) => boolean): Promise<SessionCard> {
	let result: SessionCard | undefined;
	await waitFor(() => {
		result = savedCard(runtimeValue, sessionId);
		return result !== undefined && predicate(result);
	}, `card ${sessionId}`);
	return result!;
}

afterEach(() => {
	for (const routes of liveRoutes.splice(0)) routes.dispose();
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("librarian routes", () => {
	it("indexes persisted and live sessions once by id and prefers live state", async () => {
		const app = runtime();
		app.persisted.push(
			persistedSession(app, "shared", path.join(app.knowledgeRoot, "notes"), 100, { title: "Persisted title" }),
			persistedSession(app, "old", path.join(app.knowledgeRoot, "notes"), 80),
		);
		app.live.push(liveSession("shared", path.join(app.projectsRoot, "Repo"), 200, "Live title"));
		app.live.push(liveSession("live-only", path.join(app.projectsRoot, "Other"), 300));

		const response = await responseJson<{ cards: SessionCard[]; decisionBackend: string }>(await request(app.routes, "GET", "/api/cards?includeScheduled=true"));
		expect(response.cards.map(item => item.sessionId)).toEqual(["live-only", "shared", "old"]);
		expect(response.cards[1]).toMatchObject({ title: "Live title", cwd: path.join(app.projectsRoot, "Repo"), workspaceId: "project:Repo", live: true });
		expect(response.cards[2]).toMatchObject({ workspaceId: "knowledge", live: false });
		expect(response.decisionBackend).toBe("luna");
		expect(savedCards(app)).toHaveLength(3);
	});

	it("matches scheduled tasks against the normalized first prompt", async () => {
		const firstMessage = "PLEASE   REVIEW the release and add a summary with details for the current branch";
		const app = runtime({
			scheduleConfig: root => {
				const schedulerDir = path.join(root, "scheduler");
				fs.mkdirSync(schedulerDir, { recursive: true });
				fs.writeFileSync(path.join(schedulerDir, "scheduled.md"), "Please   review the release and add a summary\nwith details");
				const config = path.join(schedulerDir, "omp-local-schedule.toml");
				fs.writeFileSync(config, '[[tasks]]\nprompt_file = "scheduled.md"\n');
				return config;
			},
		});
		app.persisted.push(persistedSession(app, "scheduled", app.knowledgeRoot, 100, { firstMessage }));
		const hiddenByDefault = await responseJson<{ cards: SessionCard[] }>(await request(app.routes, "GET", "/api/cards"));
		const included = await responseJson<{ cards: SessionCard[] }>(await request(app.routes, "GET", "/api/cards?includeScheduled=true"));
		expect(hiddenByDefault.cards).toEqual([]);
		expect(included.cards).toHaveLength(1);
		expect(included.cards[0]).toMatchObject({ scheduled: true, sessionId: "scheduled" });
	});

	it("uses topics from the librarian state file for choices and card responses", async () => {
		const app = runtime({ initialTopics: ["Research", "Operations"] });
		app.persisted.push(persistedSession(app, "topics", app.knowledgeRoot, 100));
		app.decisions.topic = "Research";

		const response = await responseJson<{ topics: string[] }>(await request(app.routes, "GET", "/api/cards?includeScheduled=true"));
		expect(response.topics).toEqual(["Research", "Operations"]);
		const updated = await waitForSavedCard(app, "topics", value => value.cardUpdatedAt === 1_000);
		expect(updated.topic).toBe("Research");
		expect(app.decisions.calls[0]!.questions.topic).toMatchObject({ options: ["Research", "Operations"] });
	});

	it("lists a session whose newest messages are all the agent's, titled from its first prompt", async () => {
		const app = runtime();
		const session = persistedSession(app, "long-turn", app.knowledgeRoot, 100);
		// One prompt, then a long run of agent messages: the transcript tail holds no user message at all.
		const rows = [
			{ type: "custom_message", customType: "collab-prompt", content: "Prepare the release notes outreach plan" },
			...Array.from({ length: 12 }, (_, index) => ({ type: "message", message: { role: "assistant", content: `step ${index}` } })),
		];
		fs.writeFileSync(session.file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
		app.persisted.push(session);

		await request(app.routes, "GET", "/api/cards?includeScheduled=true");
		const updated = await waitForSavedCard(app, "long-turn", value => value.cardUpdatedAt === 1_000);
		expect(updated.empty).toBeUndefined();
		expect(app.text.calls[0]!.prompt).toContain("Prepare the release notes outreach plan");
		const listed = await responseJson<{ cards: SessionCard[] }>(await request(app.routes, "GET", "/api/cards?includeScheduled=true"));
		expect(listed.cards.map(item => item.sessionId)).toContain("long-turn");
	});

	it("replaces a stale title only above the drift threshold and keeps its revision", async () => {
		for (const scenario of [
			{ probability: 0.9, expectedTitle: "Generated title", expectedHistory: 1 },
			{ probability: 0.75, expectedTitle: "Old title", expectedHistory: 0 },
		]) {
			const app = runtime({
				now: 1_000,
				initialCards: ({ knowledgeRoot }) => [card("drift", knowledgeRoot, 200, "unfinished", {
					title: "Old title",
					titleSource: "deck",
					cardUpdatedAt: 100,
					stale: true,
				})],
			});
			app.persisted.push(persistedSession(app, "drift", app.knowledgeRoot, 200));
			app.decisions.driftProbability = scenario.probability;

			await request(app.routes, "POST", "/api/cards/refresh", { sessionIds: ["drift"] });
			const refreshed = await waitForSavedCard(app, "drift", value => value.cardUpdatedAt === 1_000);
			expect(refreshed.title).toBe(scenario.expectedTitle);
			expect(refreshed.titleHistory).toHaveLength(scenario.expectedHistory);
			if (scenario.expectedHistory === 1) {
				expect(refreshed.titleHistory[0]).toMatchObject({ title: "Old title", source: "deck" });
				const restored = await responseJson<SessionCard>(await request(app.routes, "POST", "/api/cards/drift/title/undo"));
				expect(restored).toMatchObject({ title: "Old title", titleSource: "deck" });
			}
		}
	});

	it("never auto-replaces a user title and undo restores the title before a rename", async () => {
		const app = runtime({
			now: 500,
			initialCards: ({ knowledgeRoot }) => [card("user-title", knowledgeRoot, 200, "unfinished", {
				title: "Omp title",
				titleSource: "omp",
				cardUpdatedAt: 100,
				stale: true,
			})],
		});
		app.persisted.push(persistedSession(app, "user-title", app.knowledgeRoot, 200));

		const renamed = await responseJson<SessionCard>(await request(app.routes, "POST", "/api/cards/user-title/title", { title: "Example title" }));
		expect(renamed).toMatchObject({ title: "Example title", titleSource: "user" });
		await request(app.routes, "POST", "/api/cards/refresh", { sessionIds: ["user-title"] });
		const refreshed = await waitForSavedCard(app, "user-title", value => value.cardUpdatedAt === 500);
		expect(refreshed.title).toBe("Example title");
		expect(app.decisions.calls.some(call => "drift" in call.questions)).toBe(false);

		const restored = await responseJson<SessionCard>(await request(app.routes, "POST", "/api/cards/user-title/title/undo"));
		expect(restored).toMatchObject({ title: "Omp title", titleSource: "omp" });
	});

	it("filters the return brief by device cursor and maps card lifecycle to a consumer-facing kind", async () => {
		const agenda: AgendaItem[] = [{ uid: "task-1", title: "Prepare review", list: "Today", completed: false }];
		const app = runtime({
			now: 500,
			agenda,
			initialCards: ({ knowledgeRoot }) => [
				card("done", knowledgeRoot, 300, "done", { stoppedAt: "Completed the patch", cardUpdatedAt: 250 }),
				card("waiting", knowledgeRoot, 200, "waiting", { stoppedAt: "Need approval", nextStep: "Choose the target", cardUpdatedAt: 200 }),
				card("unfinished", knowledgeRoot, 250, "unfinished", { stoppedAt: "Finished the tests", nextStep: "Review the diff", cardUpdatedAt: 350 }),
			],
		});
		app.persisted.push(
			persistedSession(app, "done", app.knowledgeRoot, 300),
			persistedSession(app, "waiting", app.knowledgeRoot, 200),
			persistedSession(app, "unfinished", app.knowledgeRoot, 250),
		);

		const brief = await responseJson<{
			since: number;
			lines: Array<{ sessionId: string; text: string; changedAt: number; kind: string }>;
			agenda: AgendaItem[];
		}>(await request(app.routes, "GET", "/api/brief?since=100"));
		expect(brief.since).toBe(100);
		expect(brief.lines.map(line => [line.sessionId, line.kind, line.changedAt])).toEqual([
			["waiting", "needs-you", 200],
			["done", "finished", 300],
			["unfinished", "unfinished", 350],
		]);
		expect(brief.lines[0]!.text).toBe("Need approval — next: Choose the target");
		expect(brief.agenda).toEqual(agenda);

		const afterCursor = await responseJson<{ since: number; lines: Array<{ sessionId: string }> }>(
			await request(app.routes, "GET", "/api/brief?since=200"),
		);
		expect(afterCursor).toMatchObject({ since: 200, lines: [{ sessionId: "done" }, { sessionId: "unfinished" }] });
	});

	it("clamps old cursors to seven days and uses the same window for a first visit", async () => {
		const day = 24 * 60 * 60 * 1000;
		const now = 10 * day;
		const app = runtime({
			now,
			initialCards: ({ knowledgeRoot }) => [
				card("old", knowledgeRoot, now - 8 * day, "unfinished", { cardUpdatedAt: now - 8 * day }),
				card("recent", knowledgeRoot, now - 6 * day, "unfinished", { cardUpdatedAt: now - 5 * day }),
			],
		});
		app.persisted.push(
			persistedSession(app, "old", app.knowledgeRoot, now - 8 * day),
			persistedSession(app, "recent", app.knowledgeRoot, now - 6 * day),
		);

		const oldCursor = await responseJson<{ since: number; lines: Array<{ sessionId: string }> }>(
			await request(app.routes, "GET", `/api/brief?since=${now - 30 * day}`),
		);
		expect(oldCursor).toMatchObject({ since: now - 7 * day, lines: [{ sessionId: "recent" }] });
		const firstVisit = await responseJson<{ since: number; lines: Array<{ sessionId: string }> }>(
			await request(app.routes, "GET", "/api/brief"),
		);
		expect(firstVisit).toEqual(oldCursor);
	});

	it("returns at most sixty matching lines, newest within a kind first", async () => {
		const count = 65;
		const ids = Array.from({ length: count }, (_, index) => `cap-${index}`);
		const app = runtime({
			now: 10_000,
			initialCards: ({ knowledgeRoot }) => ids.map((id, index) => {
				const at = index + 100;
				return card(id, knowledgeRoot, at, "unfinished", { cardUpdatedAt: at + 1 });
			}),
		});
		app.persisted.push(...ids.map((id, index) => persistedSession(app, id, app.knowledgeRoot, index + 100)));

		const brief = await responseJson<{ lines: Array<{ sessionId: string }> }>(await request(app.routes, "GET", "/api/brief?since=0"));
		expect(brief.lines.map(line => line.sessionId)).toEqual(ids.slice(5).reverse());
	});

	it("does not expose a daemon-global seen route", async () => {
		const app = runtime();
		const url = new URL("/api/brief/seen", "http://deck.test");
		const response = await app.routes(new Request(url.href, { method: "POST" }), url);
		expect(response).toBeUndefined();
	});

	it("returns an empty agenda when no agenda source is configured", async () => {
		const app = runtime();
		const brief = await responseJson<{ agenda: AgendaItem[] }>(await request(app.routes, "GET", "/api/brief"));
		expect(brief.agenda).toEqual([]);
	});



	it("keeps a failed card stale and retries it on a later pass", async () => {
		const app = runtime({ now: 900 });
		app.persisted.push(persistedSession(app, "retry", app.knowledgeRoot, 200));
		app.text.failuresRemaining = 1;

		await request(app.routes, "GET", "/api/cards?includeScheduled=true");
		await waitFor(() => app.text.calls.length === 1 && savedCard(app, "retry")?.stale === true, "first failed attempt");
		await request(app.routes, "POST", "/api/cards/refresh", { sessionIds: ["retry"] });
		const refreshed = await waitForSavedCard(app, "retry", value => value.cardUpdatedAt === 900);
		expect(refreshed.stale).toBe(false);
		expect(refreshed.title).toBe("Generated title");
		expect(app.text.calls).toHaveLength(2);
	});

	it("limits model processing to two cards at once", async () => {
		const app = runtime();
		app.text.latencyMs = 15;
		for (let index = 0; index < 5; index++) {
			app.persisted.push(persistedSession(app, `parallel-${index}`, app.knowledgeRoot, 100 + index));
		}

		await request(app.routes, "GET", "/api/cards?includeScheduled=true");
		await waitFor(() => app.text.calls.length === 5 && app.text.active === 0, "all card model calls");
		expect(app.text.maxActive).toBe(2);
	});

	it("runs the card, rename, undo, brief, and agenda route flow", async () => {
		const agenda: AgendaItem[] = [{ uid: "smoke-task", title: "Review", list: "Today", completed: false }];
		const app = runtime({ now: 1_000, agenda });
		app.persisted.push(persistedSession(app, "smoke", path.join(app.projectsRoot, "omp"), 800, {
			transcript: ["Implement a feature", "The feature is in progress"],
		}));
		fs.mkdirSync(path.join(app.projectsRoot, "omp"), { recursive: true });

		const indexed = await responseJson<{ cards: SessionCard[] }>(await request(app.routes, "GET", "/api/cards?includeScheduled=true"));
		expect(indexed.cards).toHaveLength(1);
		await waitForSavedCard(app, "smoke", value => value.cardUpdatedAt === 1_000);
		const generated = await responseJson<{ cards: SessionCard[] }>(await request(app.routes, "GET", "/api/cards?includeScheduled=true"));
		expect(generated.cards[0]).toMatchObject({ title: "Generated title", stoppedAt: "Reached the current checkpoint", nextStep: "Continue the implementation" });

		await request(app.routes, "POST", "/api/cards/smoke/title", { title: "Personal smoke title" });
		const undone = await responseJson<SessionCard>(await request(app.routes, "POST", "/api/cards/smoke/title/undo"));
		expect(undone).toMatchObject({ title: "Generated title", titleSource: "deck" });
		const brief = await responseJson<{ lines: Array<{ sessionId: string }>; agenda: AgendaItem[] }>(await request(app.routes, "GET", "/api/brief"));
		expect(brief.lines.map(line => line.sessionId)).toEqual(["smoke"]);
		expect(brief.agenda).toEqual(agenda);
	});

	it("rejects malformed filters, titles, and unknown-card undo without mutating state", async () => {
		const app = runtime();
		expect((await request(app.routes, "GET", "/api/cards?limit=0")).status).toBe(400);
		expect((await request(app.routes, "POST", "/api/cards/missing/title", { title: " " })).status).toBe(400);
		expect((await request(app.routes, "POST", "/api/cards/missing/title/undo")).status).toBe(404);
	});
});
