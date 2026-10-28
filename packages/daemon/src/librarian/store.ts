import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { SessionCard, TitleRevision } from "@omp-console/protocol";
import { atomicWriteFile } from "../workspaces/files";

export const DEFAULT_TOPICS = ["Career", "Courses", "Projects", "Agent tools", "Business", "Life", "Other"] as const;

const TITLE_SOURCES = new Set(["omp", "deck", "user"]);
const CARD_STATUSES = new Set(["waiting", "unfinished", "done"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRevision(value: unknown): TitleRevision | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.title !== "string" ||
		(value.source !== "omp" && value.source !== "deck" && value.source !== "user") ||
		typeof value.at !== "number" ||
		!Number.isFinite(value.at)
	) return undefined;
	return { title: value.title, source: value.source, at: value.at };
}

function parseCard(value: unknown): SessionCard | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.sessionId !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.title !== "string" ||
		typeof value.titleSource !== "string" ||
		!TITLE_SOURCES.has(value.titleSource) ||
		!Array.isArray(value.titleHistory) ||
		typeof value.status !== "string" ||
		!CARD_STATUSES.has(value.status) ||
		typeof value.scheduled !== "boolean" ||
		typeof value.live !== "boolean" ||
		typeof value.lastActivityAt !== "number" ||
		!Number.isFinite(value.lastActivityAt) ||
		typeof value.stale !== "boolean"
	) return undefined;
	const history: TitleRevision[] = [];
	for (const revision of value.titleHistory) {
		const parsed = parseRevision(revision);
		if (!parsed) return undefined;
		history.push(parsed);
	}
	if (value.cardUpdatedAt !== undefined && (typeof value.cardUpdatedAt !== "number" || !Number.isFinite(value.cardUpdatedAt))) return undefined;
	if (value.workspaceId !== undefined && typeof value.workspaceId !== "string") return undefined;
	if (value.stoppedAt !== undefined && typeof value.stoppedAt !== "string") return undefined;
	if (value.nextStep !== undefined && typeof value.nextStep !== "string") return undefined;
	if (value.topic !== undefined && typeof value.topic !== "string") return undefined;
	const card: SessionCard = {
		sessionId: value.sessionId,
		cwd: value.cwd,
		title: value.title,
		titleSource: value.titleSource as SessionCard["titleSource"],
		titleHistory: history,
		status: value.status as SessionCard["status"],
		scheduled: value.scheduled,
		live: value.live,
		lastActivityAt: value.lastActivityAt,
		stale: value.stale,
	};
	if (typeof value.workspaceId === "string") card.workspaceId = value.workspaceId;
	if (typeof value.stoppedAt === "string") card.stoppedAt = value.stoppedAt;
	if (typeof value.nextStep === "string") card.nextStep = value.nextStep;
	if (typeof value.topic === "string") card.topic = value.topic;
	if (typeof value.cardUpdatedAt === "number") card.cardUpdatedAt = value.cardUpdatedAt;
	return card;
}

function validTopics(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(topic => typeof topic === "string")) return undefined;
	const topics = [...new Set(value.map(topic => (topic as string).trim()).filter(Boolean))];
	return topics.length > 0 ? topics : undefined;
}

export class LibrarianStore {
	readonly #directory: string;
	readonly #cardsFile: string;
	readonly #topicsFile: string;

	constructor(stateDir: string) {
		this.#directory = path.join(stateDir, "librarian");
		this.#cardsFile = path.join(this.#directory, "cards.json");
		this.#topicsFile = path.join(this.#directory, "topics.json");
	}

	async readCards(): Promise<Map<string, SessionCard>> {
		let value: unknown;
		try {
			value = JSON.parse(await Bun.file(this.#cardsFile).text()) as unknown;
		} catch (error) {
			if (isEnoent(error) || error instanceof SyntaxError) return new Map();
			throw error;
		}
		if (!Array.isArray(value)) return new Map();
		const cards = new Map<string, SessionCard>();
		for (const item of value) {
			const card = parseCard(item);
			if (card) cards.set(card.sessionId, card);
		}
		return cards;
	}

	async writeCards(cards: Iterable<SessionCard>): Promise<void> {
		await atomicWriteFile(this.#cardsFile, `${JSON.stringify([...cards])}\n`, 0o600);
	}

	async readTopics(): Promise<string[]> {
		try {
			return validTopics(JSON.parse(await Bun.file(this.#topicsFile).text()) as unknown) ?? [...DEFAULT_TOPICS];
		} catch (error) {
			if (isEnoent(error) || error instanceof SyntaxError) return [...DEFAULT_TOPICS];
			throw error;
		}
	}

}
