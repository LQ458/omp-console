/**
 * Agent-to-agent messages (omp's IRC bus) read back out of session transcripts, aggregated into graph edges.
 *
 * omp records a message in up to four places, and none of them carries the whole fact:
 *   - `custom_message` `irc:incoming` in the recipient's transcript (`details` {id, from, message, replyTo?, broadcast?});
 *   - `custom_message` `irc:relay` in the main transcript, a display-only copy of traffic between two other agents
 *     (`details` {from, to, body});
 *   - the result of the sending tool (`write agent://<id>`), `details` {op: "send", from, to, receipts} (the
 *     recipient `all` is a broadcast, one receipt per peer);
 *   - the result of `wait` when it consumed a message, `details.waited` {id, from, to, replyTo?}.
 * The same message therefore shows up once per transcript it touches; `mergeIrcEvents` folds those copies into one
 * event so a counted edge is a count of messages, not of sightings. Shapes are read defensively: an entry that does
 * not match is skipped, never guessed at.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { parseJsonl } from "./jsonl";
import type { GraphLayout, LaidOutNode } from "./agent-graph";
import type { TranscriptResult } from "./client";

export type EdgeKind = "spawn" | "message" | "reply" | "broadcast";

/** What the graph's edge toggles offer, in display order. */
export const EDGE_KINDS: ReadonlyArray<{ kind: EdgeKind; label: string; hint: string }> = [
	{ kind: "spawn", label: "spawn", hint: "parent started child (the task assignment)" },
	{ kind: "message", label: "messages", hint: "one agent wrote to another (IRC)" },
	{ kind: "reply", label: "replies", hint: "a message that answers an earlier one" },
	{ kind: "broadcast", label: "broadcasts", hint: "one message to every live peer" },
];

export interface IrcEvent {
	from: string;
	to: string;
	/** Epoch ms. */
	at: number;
	/** Message id; only the recipient side records it. */
	id?: string;
	replyTo?: string;
	broadcast: boolean;
	/** Which transcript copies were folded into this event (`<owner>:<source>`). */
	origins: string[];
}

export interface MessageEdge {
	from: string;
	to: string;
	kind: Exclude<EdgeKind, "spawn">;
	count: number;
	lastAt: number;
}

/** Copies of one message are recorded within this long of each other (tool result vs delivery vs relay). */
export const MERGE_WINDOW_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function entryTime(entry: SessionEntry): number {
	const at = Date.parse(entry.timestamp);
	return Number.isFinite(at) ? at : 0;
}

function event(owner: string, source: string, from: string, to: string, at: number, extra: Partial<IrcEvent> = {}): IrcEvent {
	return { from, to, at, broadcast: false, ...extra, origins: [`${owner}:${source}`] };
}

/** IRC facts in one agent's transcript. `owner` is that agent's registry id (the recipient of `irc:incoming`). */
export function extractIrcEvents(owner: string, entries: readonly SessionEntry[]): IrcEvent[] {
	const out: IrcEvent[] = [];
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			const d = entry.details;
			if (!isRecord(d)) continue;
			if (entry.customType === "irc:incoming") {
				const from = str(d.from);
				if (from === undefined || from === owner) continue;
				out.push(
					event(owner, "incoming", from, owner, entryTime(entry), {
						id: str(d.id),
						replyTo: str(d.replyTo),
						broadcast: d.broadcast === true,
					}),
				);
			} else if (entry.customType === "irc:relay") {
				const from = str(d.from);
				const to = str(d.to);
				if (from === undefined || to === undefined || from === to) continue;
				out.push(event(owner, "relay", from, to, entryTime(entry)));
			}
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		const details = message.details;
		if (!isRecord(details)) continue;
		if (details.op === "wait" && isRecord(details.waited)) {
			const w = details.waited;
			const from = str(w.from);
			const to = str(w.to) ?? owner;
			if (from === undefined || from === to) continue;
			out.push(
				event(owner, "wait", from, to, typeof w.ts === "number" ? w.ts : message.timestamp, {
					id: str(w.id),
					replyTo: str(w.replyTo),
					broadcast: w.broadcast === true,
				}),
			);
			continue;
		}
		const send = details.op === "send" ? details : isRecord(details.message) && details.message.op === "send" ? details.message : null;
		if (send === null) continue;
		const from = str(send.from) ?? owner;
		const to = str(send.to);
		if (to === undefined) continue;
		const receipts = Array.isArray(send.receipts) ? send.receipts.filter(isRecord) : [];
		if (to === "all") {
			for (const receipt of receipts) {
				const target = str(receipt.to);
				if (target === undefined || target === from || receipt.outcome === "failed") continue;
				out.push(event(owner, "send", from, target, message.timestamp, { broadcast: true }));
			}
			continue;
		}
		if (from === to) continue;
		const delivered = receipts.length === 0 ? !message.isError : receipts.some(receipt => receipt.outcome !== "failed");
		if (delivered) out.push(event(owner, "send", from, to, message.timestamp));
	}
	return out;
}

/**
 * Folds the several recordings of one message into one event. Two events are the same message when they share an id,
 * or have the same direction within `MERGE_WINDOW_MS` and come from different transcript sources. The richer copy
 * wins (the recipient's carries the id and `replyTo`).
 */
export function mergeIrcEvents(events: readonly IrcEvent[]): IrcEvent[] {
	const sorted = [...events].sort((a, b) => a.at - b.at);
	const merged: IrcEvent[] = [];
	for (const next of sorted) {
		let best: IrcEvent | undefined;
		let bestGap = Number.POSITIVE_INFINITY;
		for (let i = merged.length - 1; i >= 0; i--) {
			const seen = merged[i]!;
			if (next.at - seen.at > MERGE_WINDOW_MS) break;
			if (seen.from !== next.from || seen.to !== next.to) continue;
			const sameId = seen.id !== undefined && seen.id === next.id;
			const sharesOrigin = next.origins.some(origin => seen.origins.includes(origin));
			if (!sameId && sharesOrigin) continue;
			const gap = Math.abs(next.at - seen.at);
			if (gap < bestGap) {
				best = seen;
				bestGap = gap;
			}
		}
		if (!best) {
			merged.push({ ...next, origins: [...next.origins] });
			continue;
		}
		best.id ??= next.id;
		best.replyTo ??= next.replyTo;
		best.broadcast ||= next.broadcast;
		best.origins.push(...next.origins);
	}
	return merged;
}

/** Registry id the graph uses for a raw IRC id: exact, else case-insensitive, with `main` meaning the main agent. */
export function resolveAgentId(raw: string, ids: ReadonlySet<string>, mainId: string | undefined): string | undefined {
	if (ids.has(raw)) return raw;
	const lower = raw.toLowerCase();
	if (lower === "main" && mainId !== undefined) return mainId;
	for (const id of ids) if (id.toLowerCase() === lower) return id;
	return undefined;
}

/** Counts per (sender, recipient, kind). Events naming an agent the graph does not have are dropped. */
export function aggregateMessageEdges(
	events: readonly IrcEvent[],
	ids: ReadonlySet<string>,
	mainId: string | undefined,
): MessageEdge[] {
	const edges = new Map<string, MessageEdge>();
	for (const e of mergeIrcEvents(events)) {
		const from = resolveAgentId(e.from, ids, mainId);
		const to = resolveAgentId(e.to, ids, mainId);
		if (from === undefined || to === undefined || from === to) continue;
		const kind: MessageEdge["kind"] = e.broadcast ? "broadcast" : e.replyTo !== undefined ? "reply" : "message";
		const key = `${from}\u0000${to}\u0000${kind}`;
		const edge = edges.get(key);
		if (edge) {
			edge.count++;
			edge.lastAt = Math.max(edge.lastAt, e.at);
		} else {
			edges.set(key, { from, to, kind, count: 1, lastAt: e.at });
		}
	}
	return [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
}

/** Incremental reader of one subagent transcript that keeps only its IRC facts (a full transcript can be large). */
export class IrcTail {
	#cursor = 0;
	#carry = "";
	#events: IrcEvent[] = [];
	#failed = false;

	constructor(readonly owner: string) {}

	get cursor(): number {
		return this.#cursor;
	}

	get events(): readonly IrcEvent[] {
		return this.#events;
	}

	/** A host-side error ended this reader; do not poll again. */
	get failed(): boolean {
		return this.#failed;
	}

	/** Applies one `fetchTranscript` reply. True when new IRC events were read. */
	apply(reply: TranscriptResult | null): boolean {
		if (reply === null || this.#failed) return false;
		if (reply.kind === "error") {
			this.#failed = true;
			return false;
		}
		const parsed = parseJsonl(reply.text, this.#carry);
		this.#carry = parsed.carry;
		this.#cursor = reply.newSize;
		const entries: SessionEntry[] = [];
		for (const item of parsed.items) {
			if (typeof item === "object" && item !== null && "type" in item && item.type !== "session") entries.push(item as SessionEntry);
		}
		const fresh = extractIrcEvents(this.owner, entries);
		if (fresh.length === 0) return false;
		this.#events = [...this.#events, ...fresh];
		return true;
	}
}

// ---- geometry ------------------------------------------------------------------------------------

export interface PlacedMessageEdge {
	edge: MessageEdge;
	/** SVG path (a quadratic curve) from the sender's box to the recipient's box. */
	d: string;
	/** Badge position: the middle of the curve. */
	labelX: number;
	labelY: number;
}

const BOW = 26;
const BOW_STEP = 16;
const GAP = 3;

function exitT(node: LaidOutNode, dx: number, dy: number): number {
	const tx = dx === 0 ? Number.POSITIVE_INFINITY : node.width / 2 / Math.abs(dx);
	const ty = dy === 0 ? Number.POSITIVE_INFINITY : node.height / 2 / Math.abs(dy);
	return Math.min(tx, ty);
}

/**
 * Curves between node boxes, always bowed to the left of the direction of travel, so A→B and B→A take opposite
 * sides and never overlap, and edges of different kinds between the same pair fan out.
 */
export function placeMessageEdges(layout: GraphLayout, edges: readonly MessageEdge[]): PlacedMessageEdge[] {
	const at = new Map(layout.nodes.map(node => [node.id, node]));
	const slot = new Map<string, number>();
	const out: PlacedMessageEdge[] = [];
	for (const edge of edges) {
		const a = at.get(edge.from);
		const b = at.get(edge.to);
		if (!a || !b) continue;
		const pair = `${edge.from}\u0000${edge.to}`;
		const index = slot.get(pair) ?? 0;
		slot.set(pair, index + 1);
		const ax = a.x + a.width / 2;
		const ay = a.y + a.height / 2;
		const bx = b.x + b.width / 2;
		const by = b.y + b.height / 2;
		const dx = bx - ax;
		const dy = by - ay;
		const len = Math.hypot(dx, dy);
		if (len === 0) continue;
		const ux = dx / len;
		const uy = dy / len;
		const bow = BOW + index * BOW_STEP;
		const cx = (ax + bx) / 2 - uy * bow;
		const cy = (ay + by) / 2 + ux * bow;
		// Leave and enter along the chord towards the control point, so the curve starts and ends on the box edge.
		const sx = cx - ax;
		const sy = cy - ay;
		const ex = cx - bx;
		const ey = cy - by;
		const ts = exitT(a, sx, sy);
		const te = exitT(b, ex, ey);
		const slen = Math.hypot(sx, sy) || 1;
		const elen = Math.hypot(ex, ey) || 1;
		const p0x = ax + sx * ts + (sx / slen) * GAP;
		const p0y = ay + sy * ts + (sy / slen) * GAP;
		const p2x = bx + ex * te + (ex / elen) * GAP;
		const p2y = by + ey * te + (ey / elen) * GAP;
		out.push({
			edge,
			d: `M ${round(p0x)} ${round(p0y)} Q ${round(cx)} ${round(cy)} ${round(p2x)} ${round(p2y)}`,
			labelX: round(0.25 * p0x + 0.5 * cx + 0.25 * p2x),
			labelY: round(0.25 * p0y + 0.5 * cy + 0.25 * p2y),
		});
	}
	return out;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Tooltip text of a counted edge: "3 messages, Main to RelayProbe". */
export function messageEdgeTitle(edge: MessageEdge): string {
	const noun = edge.kind === "reply" ? (edge.count === 1 ? "reply" : "replies") : edge.count === 1 ? "message" : "messages";
	const prefix = edge.kind === "broadcast" ? "broadcast " : "";
	return `${edge.count} ${prefix}${noun}, ${edge.from} to ${edge.to}`;
}
