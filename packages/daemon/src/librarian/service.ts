import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type {
	AgendaItem,
	BriefLine,
	CardStatus,
	CardsResponse,
	ReturnBrief,
	SessionCard,
	SessionSummary,
} from "@omp-console/protocol";
import type { DecisionAnswer, DecisionQuestion } from "../models/types";
import type { PersistedSession } from "../history/ports";
import { DEFAULT_TOPICS, LibrarianStore } from "./store";
import type { ConversationMessage, LibrarianPorts } from "./ports";
import cardPrompt from "./prompts/card.md" with { type: "text" };
import driftPrompt from "./prompts/drift.md" with { type: "text" };
import statusPrompt from "./prompts/status.md" with { type: "text" };
import topicPrompt from "./prompts/topic.md" with { type: "text" };
import { boundConversation, readSessionConversation } from "./transcript";
import type { WorkspaceRoots } from "./paths";
import { firstPromptFromHead } from "../recent";

const SESSION_HEAD_BYTES = 64 * 1024;
const HEAD_PROMPT_CHARS = 2_000;

const DEFAULT_PASS_INTERVAL_MS = 30_000;
const DEFAULT_LIST_TTL_MS = 5_000;
const DEFAULT_CARD_LIMIT = 200;
export const MAX_CARD_LIMIT = 1_000;
const TITLE_DRIFT_THRESHOLD = 0.75;
/** Sessions the automatic pass gives cards to: activity in the last 30 days. */
const BACKGROUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A brief never reaches back further than a week and returns at most sixty sessions. */
const BRIEF_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const BRIEF_MAX_LINES = 60;

interface IndexedSession {
	id: string;
	cwd: string;
	lastActivityAt: number;
	live: boolean;
	title?: string;
	sessionFile?: string;
	firstMessage?: string;
}

export interface LibrarianOptions {
	/** Local scheduler TOML (`[[tasks]]` entries refer to `prompt_file`). */
	scheduleConfig?: string;
	knowledgeRoot?: string;
	projectRoots?: readonly string[];
	/** Background pass interval; `0` disables the timer. */
	intervalMs?: number;
	listTtlMs?: number;
	now?: () => number;
	log?: (message: string) => void;
}

export interface CardsQuery {
	limit?: number;
	workspace?: string;
	includeScheduled?: boolean;
}

export type UndoTitleResult =
	| { kind: "updated"; card: SessionCard }
	| { kind: "not-found" }
	| { kind: "no-history" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePrompt(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function workspaceIdFor(cwd: string, roots: WorkspaceRoots): Promise<string | undefined> {
	const candidate = path.resolve(cwd);
	if (roots.knowledgeRoot !== undefined && within(path.resolve(roots.knowledgeRoot), candidate)) return "knowledge";
	for (const projectRoot of [...roots.projectRoots].map(root => path.resolve(root)).sort((a, b) => b.length - a.length)) {
		if (!within(projectRoot, candidate)) continue;
		try {
			const metadata = await fs.lstat(path.join(projectRoot, ".git"));
			if (!metadata.isSymbolicLink() && (metadata.isDirectory() || metadata.isFile())) return `project:${path.basename(projectRoot)}`;
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
		const [child] = path.relative(projectRoot, candidate).split(path.sep);
		return child ? `project:${child}` : undefined;
	}
	return undefined;
}

function cleanLine(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > maxChars ? line.slice(0, maxChars).trimEnd() : line;
}

function parseCardText(raw: string): { title: string; stoppedAt?: string; nextStep?: string } {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("invalid card text JSON");
	}
	if (!isRecord(value)) throw new Error("card text must be an object");
	const title = cleanLine(value.title, 120);
	if (!title) throw new Error("card title is missing");
	const result: { title: string; stoppedAt?: string; nextStep?: string } = { title };
	const stoppedAt = cleanLine(value.stoppedAt, 180);
	const nextStep = cleanLine(value.nextStep, 180);
	if (stoppedAt !== undefined) result.stoppedAt = stoppedAt;
	if (nextStep !== undefined) result.nextStep = nextStep;
	return result;
}

function choice(answers: Record<string, DecisionAnswer>, key: string, options: readonly string[]): string {
	const answer = answers[key];
	if (answer?.type !== "choice" || !options.includes(answer.selected)) {
		throw new Error(`invalid ${key} decision`);
	}
	return answer.selected;
}

function probability(answers: Record<string, DecisionAnswer>, key: string): number {
	const answer = answers[key];
	if (answer?.type !== "noul" || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
		throw new Error(`invalid ${key} decision`);
	}
	return answer.probability;
}

const TEMP_ROOTS = [...new Set([os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map(dir => path.resolve(dir)))];

/** Sessions outside configured workspace roots (such as test harnesses and benchmarks) are not project work. */
function throwaway(card: SessionCard): boolean {
	return card.workspaceId === undefined && TEMP_ROOTS.some(root => within(root, path.resolve(card.cwd)));
}

/** The first prompt in a session file (deck or TUI), read from its head; undefined when nobody has prompted it yet. */
async function sessionHeadPrompt(sessionFile: string | undefined): Promise<string | undefined> {
	if (sessionFile === undefined) return undefined;
	try {
		return firstPromptFromHead(await Bun.file(sessionFile).slice(0, SESSION_HEAD_BYTES).text());
	} catch {
		return undefined;
	}
}

function cardCopy(card: SessionCard): SessionCard {
	return { ...card, titleHistory: card.titleHistory.map(revision => ({ ...revision })) };
}

function sessionFromPersisted(session: PersistedSession): IndexedSession {
	return {
		id: session.id,
		cwd: session.cwd,
		lastActivityAt: session.modifiedAt,
		live: false,
		sessionFile: session.file,
		...(session.title === undefined ? {} : { title: session.title }),
		...(session.firstMessage === undefined ? {} : { firstMessage: session.firstMessage }),
	};
}

function mergeLiveSession(session: SessionSummary, previous: IndexedSession | undefined): IndexedSession {
	return {
		id: session.id,
		cwd: session.cwd,
		lastActivityAt: Math.max(session.lastActivityAt, previous?.lastActivityAt ?? 0),
		live: true,
		...(session.title === undefined ? (previous?.title === undefined ? {} : { title: previous.title }) : { title: session.title }),
		...(session.sessionFile === undefined ? (previous?.sessionFile === undefined ? {} : { sessionFile: previous.sessionFile }) : { sessionFile: session.sessionFile }),
		...(previous?.firstMessage === undefined ? {} : { firstMessage: previous.firstMessage }),
	};
}

function makeInitialCard(session: IndexedSession, workspaceId: string | undefined, scheduled: boolean): SessionCard {
	// Until the librarian writes one: omp's title, else the first prompt's first line, else the folder.
	const firstLine = session.firstMessage?.replace(/\s+/g, " ").trim().slice(0, 80);
	const title = session.title?.trim() || firstLine || path.basename(session.cwd) || "Untitled session";
	return {
		sessionId: session.id,
		cwd: session.cwd,
		...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
		...(workspaceId === undefined ? {} : { workspaceId }),
		title,
		titleSource: session.title?.trim() ? "omp" : "deck",
		titleHistory: [],
		status: "unfinished",
		scheduled,
		live: session.live,
		lastActivityAt: session.lastActivityAt,
		stale: true,
	};
}

function appendRevision(card: SessionCard, at: number): void {
	card.titleHistory.push({ title: card.title, source: card.titleSource, at });
}

function briefText(card: SessionCard): string {
	const stoppedAt = card.stoppedAt?.trim();
	const nextStep = card.nextStep?.trim();
	if (stoppedAt && nextStep) return `${stoppedAt} — next: ${nextStep}`;
	return stoppedAt || nextStep || card.title;
}

function briefKind(status: CardStatus): BriefLine["kind"] {
	if (status === "waiting") return "needs-you";
	if (status === "done") return "finished";
	return "unfinished";
}

function statusRank(status: CardStatus): number {
	if (status === "waiting") return 0;
	if (status === "done") return 1;
	return 2;
}

function cardChangedAt(card: SessionCard): number {
	return Math.max(card.lastActivityAt, card.cardUpdatedAt ?? 0);
}

export class LibrarianService {
	readonly #ports: LibrarianPorts;
	readonly #store: LibrarianStore;
	readonly #roots: WorkspaceRoots;
	readonly #scheduleConfig: string | undefined;
	readonly #listTtlMs: number;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	readonly #abort = new AbortController();
	readonly #inFlight = new Set<string>();
	readonly #firstPrompts = new Map<string, string>();
	#cards = new Map<string, SessionCard>();
	#topics: string[] = [...DEFAULT_TOPICS];
	#sessionIndex = new Map<string, IndexedSession>();
	#persistedCache: { at: number; sessions: PersistedSession[] } | undefined;
	#scheduledPrefixes: { configMtimeMs: number; values: string[] } | undefined;
	#ready: Promise<void>;
	#syncRun: Promise<void> | undefined;
	#writeTail: Promise<void> = Promise.resolve();
	#running: Promise<void> | undefined;
	#queuedAll = false;
	readonly #queuedIds = new Set<string>();
	#timer: Timer | undefined;
	#disposed = false;

	constructor(ports: LibrarianPorts, stateDir: string, options: LibrarianOptions = {}) {
		this.#ports = ports;
		this.#store = new LibrarianStore(stateDir);
		this.#roots = {
			...(options.knowledgeRoot === undefined ? {} : { knowledgeRoot: path.resolve(options.knowledgeRoot) }),
			projectRoots: (options.projectRoots ?? []).map(root => path.resolve(root)),
		};
		this.#scheduleConfig = options.scheduleConfig;
		this.#listTtlMs = options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => {});
		this.#ready = Promise.all([this.#store.readCards(), this.#store.readTopics()]).then(([cards, topics]) => {
			this.#cards = cards;
			this.#topics = topics;
		});
		const intervalMs = options.intervalMs ?? DEFAULT_PASS_INTERVAL_MS;
		if (intervalMs > 0) {
			this.#timer = setInterval(() => {
				void this.#synchronize().then(() => this.#enqueueAllStale()).catch(() => this.#log("librarian: background index refresh failed"));
			}, intervalMs);
			this.#timer.unref();
		}
	}

	async #persistedSessions(): Promise<PersistedSession[]> {
		const now = this.#now();
		if (this.#persistedCache && now - this.#persistedCache.at < this.#listTtlMs) return this.#persistedCache.sessions;
		const sessions = await this.#ports.listPersisted();
		this.#persistedCache = { at: now, sessions };
		return sessions;
	}

	async #loadSchedulePrefixes(): Promise<string[] | undefined> {
		if (!this.#scheduleConfig) return [];
		let configMtimeMs: number;
		try {
			configMtimeMs = (await fs.stat(this.#scheduleConfig)).mtimeMs;
		} catch {
			this.#log("librarian: schedule configuration unavailable");
			return undefined;
		}
		if (this.#scheduledPrefixes?.configMtimeMs === configMtimeMs) return this.#scheduledPrefixes.values;
		try {
			const parsed: unknown = Bun.TOML.parse(await Bun.file(this.#scheduleConfig).text());
			if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) throw new Error("tasks is not an array");
			const prefixes: string[] = [];
			for (const task of parsed.tasks) {
				if (!isRecord(task) || typeof task.prompt_file !== "string") continue;
				const promptFile = path.isAbsolute(task.prompt_file)
					? task.prompt_file
					: path.resolve(path.dirname(this.#scheduleConfig), task.prompt_file);
				try {
					const prompt = normalizePrompt(await Bun.file(promptFile).text()).slice(0, 160);
					if (prompt) prefixes.push(prompt);
				} catch {
					this.#log("librarian: scheduled prompt file unavailable");
				}
			}
			this.#scheduledPrefixes = { configMtimeMs, values: prefixes };
			return prefixes;
		} catch {
			this.#log("librarian: schedule configuration is invalid");
			return undefined;
		}
	}

	async #firstPrompt(session: IndexedSession): Promise<string | undefined> {
		const cached = this.#firstPrompts.get(session.id);
		if (cached) return cached;
		if (session.firstMessage) {
			this.#firstPrompts.set(session.id, session.firstMessage);
			return session.firstMessage;
		}
		return undefined;
	}

	async #synchronizeInner(): Promise<void> {
		await this.#ready;
		const [persisted, prefixes] = await Promise.all([this.#persistedSessions(), this.#loadSchedulePrefixes()]);
		const sessions = new Map<string, IndexedSession>();
		for (const session of persisted) sessions.set(session.id, sessionFromPersisted(session));
		for (const live of this.#ports.list()) sessions.set(live.id, mergeLiveSession(live, sessions.get(live.id)));
		this.#sessionIndex = sessions;
		let changed = false;
		for (const session of sessions.values()) {
			const workspaceId = await workspaceIdFor(session.cwd, this.#roots);
			let card = this.#cards.get(session.id);
			let scheduled = card?.scheduled ?? false;
			if (!this.#scheduleConfig) scheduled = false;
			else if (prefixes !== undefined) {
				const firstPrompt = await this.#firstPrompt(session);
				if (firstPrompt !== undefined) {
					const normalized = normalizePrompt(firstPrompt);
					scheduled = prefixes.some(prefix => normalized.startsWith(prefix));
				}
			}
			if (!card) {
				card = makeInitialCard(session, workspaceId, scheduled);
				this.#cards.set(session.id, card);
				changed = true;
				continue;
			}
			if (card.cwd !== session.cwd) {
				card.cwd = session.cwd;
				changed = true;
			}
			if (card.workspaceId !== workspaceId) {
				if (workspaceId === undefined) delete card.workspaceId;
				else card.workspaceId = workspaceId;
				changed = true;
			}
			if (card.live !== session.live) {
				card.live = session.live;
				changed = true;
			}
			if (session.sessionFile !== undefined && card.sessionFile !== session.sessionFile) {
				card.sessionFile = session.sessionFile;
				changed = true;
			}
			if (session.lastActivityAt > card.lastActivityAt) {
				card.lastActivityAt = session.lastActivityAt;
				changed = true;
			}
			if (card.stale !== (card.cardUpdatedAt === undefined || card.lastActivityAt > card.cardUpdatedAt)) {
				card.stale = card.cardUpdatedAt === undefined || card.lastActivityAt > card.cardUpdatedAt;
				changed = true;
			}
			if (card.scheduled !== scheduled) {
				card.scheduled = scheduled;
				changed = true;
			}
			if (session.title?.trim() && card.titleSource === "omp" && card.title !== session.title.trim()) {
				appendRevision(card, this.#now());
				card.title = session.title.trim();
				changed = true;
			}
		}
		if (changed) await this.#saveCards();
	}

	async #synchronize(): Promise<void> {
		if (this.#syncRun) return this.#syncRun;
		const run = this.#synchronizeInner();
		this.#syncRun = run;
		try {
			await run;
		} finally {
			if (this.#syncRun === run) this.#syncRun = undefined;
		}
	}

	#saveCards(): Promise<void> {
		const write = (): Promise<void> => this.#store.writeCards(this.#cards.values());
		this.#writeTail = this.#writeTail.then(write, write);
		return this.#writeTail;
	}

	#enqueueAllStale(): void {
		if (this.#disposed) return;
		this.#queuedAll = true;
		this.#kick();
	}

	#enqueueIds(sessionIds: readonly string[]): void {
		if (this.#disposed) return;
		for (const id of sessionIds) this.#queuedIds.add(id);
		this.#kick();
	}

	#kick(): void {
		if (this.#running || this.#disposed || (!this.#queuedAll && this.#queuedIds.size === 0)) return;
		const run = this.#drain();
		this.#running = run;
		void run.catch(() => this.#log("librarian: background pass failed")).finally(() => {
			if (this.#running === run) this.#running = undefined;
			if (!this.#disposed && (this.#queuedAll || this.#queuedIds.size > 0)) this.#kick();
		});
	}

	async #drain(): Promise<void> {
		while (!this.#disposed && (this.#queuedAll || this.#queuedIds.size > 0)) {
			const allStale = this.#queuedAll;
			this.#queuedAll = false;
			const explicitIds = new Set(this.#queuedIds);
			this.#queuedIds.clear();
			await this.#synchronize();
			// The automatic pass covers the last BACKGROUND_WINDOW_MS of activity (newest first); older sessions get a
			// card when something asks for it (`refresh` with ids), so a long history never becomes a model bill.
			const horizon = this.#now() - BACKGROUND_WINDOW_MS;
			const candidates = [...this.#cards.values()]
				.filter(card => (allStale && card.stale && card.lastActivityAt >= horizon && !throwaway(card)) || explicitIds.has(card.sessionId))
				.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
			let next = 0;
			const processNext = async (): Promise<void> => {
				while (!this.#disposed && next < candidates.length) {
					const card = candidates[next++]!;
					if (this.#inFlight.has(card.sessionId)) continue;
					this.#inFlight.add(card.sessionId);
					try {
						await this.#processCard(card.sessionId);
					} catch {
						this.#log(`librarian: card refresh failed for ${card.sessionId}`);
					} finally {
						this.#inFlight.delete(card.sessionId);
					}
				}
			};
			await Promise.all([processNext(), processNext()]);
		}
	}

	async #conversation(session: IndexedSession): Promise<ConversationMessage[]> {
		if (!session.live) return session.sessionFile ? readSessionConversation(session.sessionFile) : [];
		const conversation = await this.#ports.readLiveConversation(session.id);
		if (conversation.firstUserPrompt) this.#firstPrompts.set(session.id, conversation.firstUserPrompt);
		return boundConversation(conversation.messages);
	}

	async #processCard(sessionId: string): Promise<void> {
		if (this.#disposed) return;
		const session = this.#sessionIndex.get(sessionId);
		const initial = this.#cards.get(sessionId);
		if (!session || !initial) return;
		let messages = await this.#conversation(session);
		// The newest messages can all be the agent's (a long turn of tool work), so whether the session was ever prompted
		// comes from the top of its file, which also holds the real first prompt.
		const headPrompt = await sessionHeadPrompt(session.sessionFile);
		if (headPrompt) this.#firstPrompts.set(sessionId, headPrompt);
		// Nothing said yet: no model call; the card is marked empty and stays out of the lists until a prompt arrives.
		if (headPrompt === undefined && !messages.some(message => message.role === "user")) {
			const card = this.#cards.get(sessionId);
			if (card) {
				card.empty = true;
				card.stale = false;
				card.cardUpdatedAt = this.#now();
				await this.#saveCards();
			}
			return;
		}
		const reopened = this.#cards.get(sessionId);
		if (reopened?.empty) delete reopened.empty;
		// The card model still needs to know what was asked when the tail is all agent work.
		if (headPrompt !== undefined && !messages.some(message => message.role === "user")) {
			messages = [{ role: "user", text: headPrompt.slice(0, HEAD_PROMPT_CHARS) }, ...messages];
		}
		const firstPrompt = this.#firstPrompts.get(sessionId);
		const prefixes = await this.#loadSchedulePrefixes();
		if (this.#scheduleConfig && prefixes !== undefined && firstPrompt) {
			const scheduled = prefixes.some(prefix => normalizePrompt(firstPrompt).startsWith(prefix));
			const card = this.#cards.get(sessionId);
			if (card && card.scheduled !== scheduled) {
				card.scheduled = scheduled;
				await this.#saveCards();
			}
		}
		const current = this.#cards.get(sessionId);
		if (!current) return;
		const hasPriorTitle = current.titleSource === "user" || current.titleSource === "omp" || current.cardUpdatedAt !== undefined;
		const questions: Record<string, DecisionQuestion> = {
			status: { type: "choice", instructions: statusPrompt, options: ["waiting", "unfinished", "done"] },
			topic: { type: "choice", instructions: topicPrompt, options: this.#topics },
		};
		if (hasPriorTitle && current.titleSource !== "user") {
			questions.drift = { type: "noul", instructions: driftPrompt };
		}
		const state = [JSON.stringify({ title: current.title, messages })];
		const [rawText, answers] = await Promise.all([
			this.#ports.textModel.complete({ system: cardPrompt, prompt: JSON.stringify(messages), maxTokens: 256, signal: this.#abort.signal }),
			this.#ports.decisionModel.decide({ state, questions, signal: this.#abort.signal }),
		]);
		const generated = parseCardText(rawText);
		const status = choice(answers, "status", ["waiting", "unfinished", "done"]) as CardStatus;
		const topic = choice(answers, "topic", this.#topics);
		const updated = this.#cards.get(sessionId);
		if (!updated) return;
		const at = this.#now();
		if (updated.titleSource !== "user") {
			if (!hasPriorTitle) {
				updated.title = generated.title;
				updated.titleSource = "deck";
			} else if (answers.drift !== undefined && probability(answers, "drift") > TITLE_DRIFT_THRESHOLD && generated.title !== updated.title) {
				appendRevision(updated, at);
				updated.title = generated.title;
				updated.titleSource = "deck";
			}
		}
		updated.status = status;
		updated.topic = topic;
		if (generated.stoppedAt === undefined) delete updated.stoppedAt;
		else updated.stoppedAt = generated.stoppedAt;
		if (generated.nextStep === undefined) delete updated.nextStep;
		else updated.nextStep = generated.nextStep;
		updated.cardUpdatedAt = at;
		updated.stale = updated.lastActivityAt > at;
		await this.#saveCards();
	}

	async cards(query: CardsQuery = {}): Promise<CardsResponse> {
		await this.#synchronize();
		const limit = query.limit ?? DEFAULT_CARD_LIMIT;
		let cards = [...this.#cards.values()].filter(card => this.#listable(card));
		if (query.workspace !== undefined) cards = cards.filter(card => card.workspaceId === query.workspace);
		if (query.includeScheduled !== true) cards = cards.filter(card => !card.scheduled);
		cards.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
		const selected = cards.slice(0, limit).map(cardCopy);
		this.#enqueueAllStale();
		return {
			cards: selected,
			topics: [...this.#topics],
			pending: cards.filter(card => card.stale && card.lastActivityAt >= this.#now() - BACKGROUND_WINDOW_MS).length,
			decisionBackend: this.#ports.decisionModel.backend,
		};
	}

	/** Shown in lists and the brief: a known session that has been talked to, not a throwaway temp-dir run. */
	#listable(card: SessionCard): boolean {
		return this.#sessionIndex.has(card.sessionId) && card.empty !== true && !throwaway(card);
	}

	async setTitle(sessionId: string, title: string): Promise<SessionCard | undefined> {
		await this.#synchronize();
		const card = this.#cards.get(sessionId);
		if (!card) return undefined;
		appendRevision(card, this.#now());
		card.title = title;
		card.titleSource = "user";
		await this.#saveCards();
		return cardCopy(card);
	}

	async undoTitle(sessionId: string): Promise<UndoTitleResult> {
		await this.#synchronize();
		const card = this.#cards.get(sessionId);
		if (!card) return { kind: "not-found" };
		const previous = card.titleHistory.pop();
		if (!previous) return { kind: "no-history" };
		card.title = previous.title;
		card.titleSource = previous.source;
		await this.#saveCards();
		return { kind: "updated", card: cardCopy(card) };
	}

	async refresh(sessionIds?: string[]): Promise<void> {
		await this.#synchronize();
		if (!sessionIds || sessionIds.length === 0) {
			this.#enqueueAllStale();
			return;
		}
		for (const id of sessionIds) {
			const card = this.#cards.get(id);
			if (card) card.stale = true;
		}
		await this.#saveCards();
		this.#enqueueIds(sessionIds);
	}

	async brief(requestedSince?: number): Promise<ReturnBrief> {
		await this.#synchronize();
		const generatedAt = this.#now();
		const since = Math.max(requestedSince ?? generatedAt - BRIEF_LOOKBACK_MS, generatedAt - BRIEF_LOOKBACK_MS);
		const cards = [...this.#cards.values()]
			.filter(card => this.#listable(card) && !card.scheduled && cardChangedAt(card) > since)
			.sort((a, b) => statusRank(a.status) - statusRank(b.status) || cardChangedAt(b) - cardChangedAt(a))
			.slice(0, BRIEF_MAX_LINES);
		const lines: BriefLine[] = cards.map(card => ({
			sessionId: card.sessionId,
			title: card.title,
			cwd: card.cwd,
			...(card.sessionFile === undefined ? {} : { sessionFile: card.sessionFile }),
			text: briefText(card),
			status: card.status,
			changedAt: cardChangedAt(card),
			kind: briefKind(card.status),
		}));
		const agenda: AgendaItem[] = this.#ports.agendaToday ? await this.#ports.agendaToday() : [];
		return { since, generatedAt, lines, agenda };
	}


	/** The session's card title (generated or the user's), for notifications; undefined before its first card. */
	cardTitle(sessionId: string): string | undefined {
		return this.#cards.get(sessionId)?.title || undefined;
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#abort.abort();
	}
}
