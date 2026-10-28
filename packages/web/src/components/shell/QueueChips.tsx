/**
 * Queue chips (spec 1.2): the steering and follow-up prompts waiting behind the running turn, each with a remove
 * button that calls `sessionOp(id, { op: "dequeue", index })`.
 *
 * Text comes from omp's `queue_update` (`GuestSnapshot.queue`): steering entries after the `liveSteered` ones, then
 * follow-ups, which is the index order omp's `remove_queued_message` uses. Until the first `queue_update` of a
 * connection arrives (a guest joining a session that already has a queue), the chips fall back to the prompts THIS
 * deck sent while a turn was running ({@link QueueTracker}) and a plain "queued message" for the rest, sized by
 * `SessionState.queuedMessageCount`.
 */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { DeckApi } from "../../lib/api";
import type { GuestClient, HostQueue } from "../../lib/client";
import { recordUsage } from "../../lib/journal";
import "./queue-chips.css";

export interface QueueChip {
	/** Position in the host's queue, 0 = next to run: the `index` a dequeue op takes. */
	index: number;
	/** What was sent; null when this deck did not send it. */
	text: string | null;
}

/** Texts remembered per client; older ones are certainly consumed or beyond what a chip row can show. */
const MAX_KNOWN = 50;
/** How long a just-sent prompt may exist before the host's count shows it; a zero count inside it is not "it ran". */
const COUNT_LAG_MS = 5_000;

interface KnownPrompt {
	text: string;
	at: number;
}

/**
 * The prompts this deck sent while a turn ran, oldest first, reconciled with the host's queue count.
 * The host runs its queue in order, so when the count drops by `d` the `d` oldest entries ran.
 */
export class QueueTracker {
	readonly #listeners = new Set<() => void>();
	#known: readonly KnownPrompt[] = [];
	#texts: readonly string[] = [];
	#prevCount = 0;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	getSnapshot = (): readonly string[] => this.#texts;

	/** A prompt was sent while a turn was running. */
	record(text: string, now: number = Date.now()): void {
		this.#set([...this.#known, { text, at: now }].slice(-MAX_KNOWN));
	}

	/**
	 * Applies the host's current count: entries that ran are forgotten. A count that did not drop changes nothing,
	 * and a prompt sent moments ago survives a zero count (the host's state frame has not caught up yet).
	 */
	reconcile(count: number, now: number = Date.now()): void {
		const consumed = this.#prevCount - count;
		const unknownAhead = Math.max(0, this.#prevCount - this.#known.length);
		this.#prevCount = count;
		let next = this.#known;
		if (consumed > 0) next = next.slice(Math.max(0, consumed - unknownAhead));
		if (count === 0) next = next.filter(entry => now - entry.at < COUNT_LAG_MS);
		if (next.length !== this.#known.length) this.#set(next);
	}

	/** The host removed the queue entry at `index` of a queue of `count`. */
	removed(index: number, count: number): void {
		const offset = index - Math.max(0, count - this.#known.length);
		this.#prevCount = Math.max(0, count - 1);
		if (offset < 0 || offset >= this.#known.length) return;
		this.#set(this.#known.filter((_, i) => i !== offset));
	}

	#set(next: readonly KnownPrompt[]): void {
		this.#known = next;
		this.#texts = next.map(entry => entry.text);
		for (const listener of this.#listeners) listener();
	}
}

const trackers = new WeakMap<GuestClient, QueueTracker>();

/** The tracker of one connection. It outlives the components that show it (pane moves, remounts). */
export function queueTracker(client: GuestClient): QueueTracker {
	let tracker = trackers.get(client);
	if (!tracker) {
		tracker = new QueueTracker();
		trackers.set(client, tracker);
	}
	return tracker;
}

/**
 * One chip per queued entry. The newest `known.length` entries carry the texts this deck sent; any older ones
 * are generic. The row never shows more chips than the host's count.
 */
export function mapQueueChips(count: number, known: readonly string[]): QueueChip[] {
	if (count <= 0) return [];
	const withText = Math.min(known.length, count);
	const unknown = count - withText;
	const chips: QueueChip[] = [];
	for (let i = 0; i < unknown; i++) chips.push({ index: i, text: null });
	for (let i = 0; i < withText; i++) chips.push({ index: unknown + i, text: known[known.length - withText + i]! });
	return chips;
}

/** Chips from the host's own queue: removable steering entries first, then follow-ups. */
export function hostQueueChips(queue: HostQueue): QueueChip[] {
	const visible = [...queue.steering.slice(queue.liveSteered), ...queue.followUp];
	return visible.map((text, index) => ({ index, text }));
}

export interface QueueChipsProps {
	client: GuestClient;
	/** `SessionState.queuedMessageCount`. */
	count: number;
	readOnly: boolean;
	/** Daemon API and session id: without them the chips are shown but cannot be removed. */
	api?: Pick<DeckApi, "sessionOp">;
	sessionId?: string;
}

const CHIP_TEXT_MAX = 48;

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > CHIP_TEXT_MAX ? `${flat.slice(0, CHIP_TEXT_MAX - 1)}…` : flat;
}

export function QueueChips({ client, count, readOnly, api, sessionId }: QueueChipsProps): ReactNode {
	const tracker = queueTracker(client);
	const known = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);
	const subscribeClient = useCallback((listener: () => void) => client.subscribe(listener), [client]);
	const readHostQueue = useCallback(() => client.getSnapshot().queue, [client]);
	const hostQueue = useSyncExternalStore(subscribeClient, readHostQueue, readHostQueue);
	const [removing, setRemoving] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		tracker.reconcile(count);
	}, [tracker, count]);

	const canRemove = api !== undefined && sessionId !== undefined && !readOnly;
	const remove = useCallback(
		async (index: number): Promise<void> => {
			if (!api || sessionId === undefined) return;
			setRemoving(index);
			setError(null);
			try {
				await api.sessionOp(sessionId, { op: "dequeue", index });
				tracker.removed(index, count);
				recordUsage({ feature: "1.2.queue", action: "dequeue", outcome: "ok", via: "direct", sessionId });
			} catch (err) {
				setError(err instanceof Error ? err.message : "could not remove the queued message");
				recordUsage({ feature: "1.2.queue", action: "dequeue", outcome: "error", via: "direct", sessionId });
			} finally {
				setRemoving(null);
			}
		},
		[api, sessionId, tracker, count],
	);

	const chips = hostQueue !== null ? hostQueueChips(hostQueue) : mapQueueChips(count, known);
	if (chips.length === 0) return null;
	return (
		<div
			className="qc-row"
			role="list"
			aria-label={`${chips.length} queued ${chips.length === 1 ? "message" : "messages"}`}
		>
			{chips.map(chip => (
				<span
					key={chip.index}
					className="qc-chip"
					data-known={chip.text !== null ? "true" : "false"}
					role="listitem"
					title={chip.text ?? "queued from another client"}
				>
					<span className="qc-pos">{chip.index === 0 ? "next" : `#${chip.index + 1}`}</span>
					<span className="qc-text">{chip.text !== null ? clip(chip.text) : "queued message"}</span>
					{canRemove && (
						<button
							type="button"
							className="qc-remove"
							onClick={() => void remove(chip.index)}
							disabled={removing !== null}
							aria-label={`remove queued message ${chip.index + 1}`}
							title="remove from the queue (omp: Alt+Up restores the last queued message to the editor)"
						>
							<X size={11} />
						</button>
					)}
				</span>
			))}
			{error !== null && (
				<span className="qc-error" role="alert">
					{error}
				</span>
			)}
		</div>
	);
}
