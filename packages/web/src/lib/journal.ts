/**
 * Local usage journal (spec 0.5), client side. UI code calls {@link recordUsage}; events are sanitized to the
 * protocol's fixed fields (so prompt text, file contents and credentials cannot ride along), batched, and sent to the
 * daemon through `DeckApi.recordJournal` every 5 s or 50 events. When the page is hidden the queue goes out with a
 * `keepalive` fetch so the last events of a session survive a tab close. Nothing here ever throws into a caller.
 */
import type { JournalEvent } from "@omp-console/protocol";
import type { DeckApi, FetchLike } from "./api";

export type UsageEvent = Omit<JournalEvent, "at">;

export const FLUSH_INTERVAL_MS = 5_000;
export const FLUSH_BATCH = 50;
/** Events kept while the daemon is unreachable; the oldest are dropped first. */
export const MAX_BUFFER = 500;
/** `POST /api/journal` accepts at most 200 events per call; the hide path stays well below keepalive's 64 KB cap. */
const SEND_CHUNK = 100;

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "error", "abandoned"]);
const VIAS: ReadonlySet<string> = new Set(["catalog", "suggestion", "palette", "graph", "composer", "direct"]);

function clip(value: string | undefined, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length === 0 ? undefined : flat.slice(0, max);
}

/** Copies only the protocol's fields and bounds their length; unknown keys are dropped. */
export function sanitizeEvent(event: UsageEvent, at: number): JournalEvent {
	const out: JournalEvent = {
		at,
		feature: clip(event.feature, 64) ?? "unknown",
		action: clip(event.action, 64) ?? "unknown",
		outcome: OUTCOMES.has(event.outcome) ? event.outcome : "ok",
	};
	if (typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs)) {
		out.latencyMs = Math.max(0, Math.round(event.latencyMs));
	}
	if (event.via !== undefined && VIAS.has(event.via)) out.via = event.via;
	const screen = clip(event.screen, 64);
	if (screen !== undefined) out.screen = screen;
	const detail = clip(event.detail, 80);
	if (detail !== undefined) out.detail = detail;
	const sessionId = clip(event.sessionId, 64);
	if (sessionId !== undefined) out.sessionId = sessionId;
	return out;
}

export interface JournalTransport {
	/** Normal batch send; a rejection puts the events back in the queue. */
	send(events: JournalEvent[]): Promise<void>;
	/** Fire-and-forget send used while the page is going away. */
	sendOnHide(events: JournalEvent[]): void;
}

export interface UsageJournalOptions {
	now?: () => number;
	/** Arms a one-shot timer and returns its canceller. */
	schedule?: (fn: () => void, ms: number) => () => void;
	flushIntervalMs?: number;
	flushBatch?: number;
	maxBuffer?: number;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
}

export class UsageJournal {
	readonly #now: () => number;
	readonly #schedule: (fn: () => void, ms: number) => () => void;
	readonly #interval: number;
	readonly #batch: number;
	readonly #maxBuffer: number;
	#queue: JournalEvent[] = [];
	#transport: JournalTransport | null = null;
	#cancelTimer: (() => void) | null = null;
	#inflight: Promise<void> | null = null;
	#context: Pick<UsageEvent, "sessionId" | "screen"> = {};

	constructor(options: UsageJournalOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#schedule = options.schedule ?? defaultSchedule;
		this.#interval = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
		this.#batch = options.flushBatch ?? FLUSH_BATCH;
		this.#maxBuffer = options.maxBuffer ?? MAX_BUFFER;
	}

	/** Events queued and not yet handed to the transport. */
	get pending(): number {
		return this.#queue.length;
	}

	/** Defaults applied to events that name no session or screen. */
	setContext(context: Pick<UsageEvent, "sessionId" | "screen">): void {
		this.#context = { ...this.#context, ...context };
	}

	bind(transport: JournalTransport | null): void {
		this.#transport = transport;
		if (transport !== null && this.#queue.length > 0) void this.flush();
	}

	record(event: UsageEvent): void {
		try {
			const merged: UsageEvent = {
				...event,
				screen: event.screen ?? this.#context.screen,
				sessionId: event.sessionId ?? this.#context.sessionId,
			};
			this.#queue.push(sanitizeEvent(merged, this.#now()));
			if (this.#queue.length > this.#maxBuffer) this.#queue.splice(0, this.#queue.length - this.#maxBuffer);
			if (this.#transport !== null && this.#queue.length >= this.#batch) {
				void this.flush();
			} else {
				this.#arm();
			}
		} catch {
			// the journal must never break the action it describes
		}
	}

	/** Sends everything queued, in order, at most one request in flight. Never rejects. */
	async flush(): Promise<void> {
		while (this.#inflight !== null) await this.#inflight;
		const transport = this.#transport;
		if (transport === null || this.#queue.length === 0) return;
		this.#disarm();
		const run = this.#drain(transport);
		this.#inflight = run;
		try {
			await run;
		} finally {
			this.#inflight = null;
		}
	}

	/** Page hidden or closing: hand the queue to the transport's keepalive path synchronously. */
	flushOnHide(): void {
		const transport = this.#transport;
		if (transport === null || this.#queue.length === 0) return;
		this.#disarm();
		const events = this.#queue;
		this.#queue = [];
		for (let i = 0; i < events.length; i += SEND_CHUNK) {
			try {
				transport.sendOnHide(events.slice(i, i + SEND_CHUNK));
			} catch {
				// lost on page exit: acceptable
			}
		}
	}

	async #drain(transport: JournalTransport): Promise<void> {
		while (this.#queue.length > 0) {
			const events = this.#queue.splice(0, SEND_CHUNK);
			try {
				await transport.send(events);
			} catch {
				this.#queue.unshift(...events);
				if (this.#queue.length > this.#maxBuffer) this.#queue.splice(0, this.#queue.length - this.#maxBuffer);
				this.#arm();
				return;
			}
		}
	}

	#arm(): void {
		if (this.#cancelTimer !== null) return;
		this.#cancelTimer = this.#schedule(() => {
			this.#cancelTimer = null;
			if (this.#transport === null) {
				this.#arm();
				return;
			}
			void this.flush();
		}, this.#interval);
	}

	#disarm(): void {
		this.#cancelTimer?.();
		this.#cancelTimer = null;
	}
}

type JournalApi = Pick<DeckApi, "recordJournal">;

/** Daemon transport: `DeckApi.recordJournal` normally, a `keepalive` fetch on hide. */
export function daemonTransport(api: JournalApi, fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init)): JournalTransport {
	return {
		send: events => api.recordJournal(events),
		sendOnHide(events) {
			void fetchImpl("/api/journal", {
				method: "POST",
				keepalive: true,
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ events }),
			}).catch(() => {});
		},
	};
}

export const journal = new UsageJournal();

/** Records one UI event. `detail` is a short non-content tag; never pass prompt text. */
export function recordUsage(event: UsageEvent): void {
	journal.record(event);
}

/** Wires the shared journal to a daemon API; returns an unbind function. */
export function bindJournal(api: JournalApi): () => void {
	const transport = daemonTransport(api);
	journal.bind(transport);
	return () => {
		journal.bind(null);
	};
}

type VisibilityTarget = Pick<Document, "addEventListener" | "removeEventListener"> & { visibilityState: string };
type UnloadTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/** Flushes the journal when the page is hidden or unloaded. Returns a remover. */
export function installJournalLifecycle(doc: VisibilityTarget, win: UnloadTarget, target: UsageJournal = journal): () => void {
	const onVisibility = (): void => {
		if (doc.visibilityState === "hidden") target.flushOnHide();
	};
	const onPageHide = (): void => target.flushOnHide();
	doc.addEventListener("visibilitychange", onVisibility);
	win.addEventListener("pagehide", onPageHide);
	return () => {
		doc.removeEventListener("visibilitychange", onVisibility);
		win.removeEventListener("pagehide", onPageHide);
	};
}
