/**
 * On-disk state of the history area under the daemon state dir:
 *
 *   <stateDir>/history/<sessionId>.json   the session's latest key points (one file per session, written atomically)
 *   <stateDir>/history-edges.jsonl        edges deck recorded itself (handoff, move, plan-run), one JSON object per line
 *
 * Fork edges are not stored: they come from the `parentSession` field of the persisted session headers.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HistoryEdge, KeyPoints } from "@omp-console/protocol";
import { isEnoent } from "@oh-my-pi/pi-utils";

const EDGE_KINDS: ReadonlySet<string> = new Set(["fork", "handoff", "move", "plan-run"]);

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** A stored card, or `undefined` for anything that is not a complete `KeyPoints` (a torn or foreign file). */
export function parseKeyPoints(value: unknown): KeyPoints | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const card = value as Record<string, unknown>;
	if (
		typeof card.sessionId !== "string" ||
		typeof card.title !== "string" ||
		typeof card.generatedAt !== "number" ||
		!isStringArray(card.decisions) ||
		!isStringArray(card.files) ||
		!isStringArray(card.openQuestions) ||
		(card.goal !== undefined && typeof card.goal !== "string") ||
		(card.outcome !== undefined && typeof card.outcome !== "string")
	) {
		return undefined;
	}
	return card as unknown as KeyPoints;
}

export function parseEdge(value: unknown): HistoryEdge | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const edge = value as Record<string, unknown>;
	if (typeof edge.from !== "string" || edge.from === "" || typeof edge.to !== "string" || edge.to === "") return undefined;
	if (typeof edge.kind !== "string" || !EDGE_KINDS.has(edge.kind)) return undefined;
	return { from: edge.from, to: edge.to, kind: edge.kind as HistoryEdge["kind"] };
}

export function edgeKey(edge: HistoryEdge): string {
	return `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
}

export class HistoryStore {
	readonly #dir: string;
	readonly #edgesFile: string;
	#cache = new Map<string, { mtimeMs: number; card: KeyPoints | undefined }>();

	constructor(stateDir: string) {
		this.#dir = path.join(stateDir, "history");
		this.#edgesFile = path.join(stateDir, "history-edges.jsonl");
	}

	#fileFor(sessionId: string): string {
		return path.join(this.#dir, `${encodeURIComponent(sessionId)}.json`);
	}

	async readKeyPoints(sessionId: string): Promise<KeyPoints | undefined> {
		try {
			return parseKeyPoints(JSON.parse(await Bun.file(this.#fileFor(sessionId)).text()));
		} catch (error) {
			if (isEnoent(error) || error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	async writeKeyPoints(card: KeyPoints): Promise<void> {
		const file = this.#fileFor(card.sessionId);
		await fs.mkdir(this.#dir, { recursive: true });
		const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await Bun.write(temp, `${JSON.stringify(card, null, 2)}\n`);
		await fs.rename(temp, file);
	}

	/** Every stored card by session id; unchanged files are not re-read. */
	async readAllKeyPoints(): Promise<Map<string, KeyPoints>> {
		let names: string[];
		try {
			names = await fs.readdir(this.#dir);
		} catch (error) {
			if (isEnoent(error)) return new Map();
			throw error;
		}
		const seen = new Set<string>();
		const cards = new Map<string, KeyPoints>();
		await Promise.all(
			names
				.filter(name => name.endsWith(".json"))
				.map(async name => {
					const file = path.join(this.#dir, name);
					seen.add(file);
					try {
						const { mtimeMs } = await fs.stat(file);
						const cached = this.#cache.get(file);
						let card = cached?.card;
						if (!cached || cached.mtimeMs !== mtimeMs) {
							card = parseKeyPoints(JSON.parse(await Bun.file(file).text()));
							this.#cache.set(file, { mtimeMs, card });
						}
						if (card) cards.set(card.sessionId, card);
					} catch {
						// a file that vanished or is torn mid-listing is simply not a card
					}
				}),
		);
		for (const file of this.#cache.keys()) if (!seen.has(file)) this.#cache.delete(file);
		return cards;
	}

	async readEdges(): Promise<HistoryEdge[]> {
		let text: string;
		try {
			text = await Bun.file(this.#edgesFile).text();
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const edges: HistoryEdge[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const edge = parseEdge(JSON.parse(line));
				if (edge) edges.push(edge);
			} catch {
				// a torn last line from a crash mid-append
			}
		}
		return edges;
	}

	async appendEdge(edge: HistoryEdge): Promise<void> {
		await fs.mkdir(path.dirname(this.#edgesFile), { recursive: true });
		await fs.appendFile(this.#edgesFile, `${JSON.stringify(edge)}\n`);
	}
}
