/** One completion slot, bound to the ask that claimed it (a late result never lands in a later ask). */
export interface CompletionClaim {
	/** False once the ask has ended: a write not yet started must not happen. */
	active(): boolean;
	/** The hub write for this task is starting: if the ask ends before it settles, the receipt says it may be done. */
	writing(task: { uid: string; title: string }): void;
	complete(task: { uid: string; title: string }): void;
	/** The write's outcome is unknown (it may have landed): the slot stays taken and the receipt says so. */
	uncertain(task: { uid: string; title: string }): void;
	release(): void;
}

export interface AskCompletion {
	uid: string;
	title: string;
	uncertain?: true;
}

interface Pending {
	settled: Promise<void>;
	task?: { uid: string; title: string };
}

interface Ask {
	claimed: number;
	done: AskCompletion[];
	/** Claims whose hub write has not settled; ending the ask waits for them, up to its settle time. */
	pending: Set<Pending>;
	closed: boolean;
}

/**
 * The hidden Ask session may complete one task per ask (a hostile task title cannot tick several) and only while an
 * ask is in progress: between asks, and after a timed-out ask, its completions are refused. Other sessions are not
 * limited (`claim` returns undefined).
 */
export class AskCompletionLimit {
	static readonly PER_ASK = 1;
	readonly #askSessions = new Set<string>();
	readonly #open = new Map<string, Ask>();

	/** Starts an ask on a hidden session; the previous ask's claims no longer count for it. */
	begin(sessionId: string): void {
		this.#askSessions.add(sessionId);
		this.#open.set(sessionId, { claimed: 0, done: [], pending: new Set(), closed: false });
	}

	/** A retired Ask session: no longer tracked. */
	forget(sessionId: string): void {
		this.#askSessions.delete(sessionId);
	}

	/**
	 * Ends the ask (answered, failed or timed out): no new claims or writes, then waits up to `settleMs` for writes
	 * already under way. One still running after that is reported as "may have been marked done", so every write the
	 * ask started appears in the returned list.
	 */
	async end(sessionId: string, settleMs: number): Promise<AskCompletion[]> {
		const ask = this.#open.get(sessionId);
		this.#open.delete(sessionId);
		if (!ask) return [];
		ask.closed = true;
		if (ask.pending.size > 0 && settleMs > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.all([...ask.pending].map(pending => pending.settled)),
				new Promise<void>(resolve => {
					timer = setTimeout(resolve, settleMs);
				}),
			]);
			clearTimeout(timer);
		}
		const unsettled: AskCompletion[] = [...ask.pending].flatMap(pending => (pending.task ? [{ ...pending.task, uncertain: true as const }] : []));
		return [...ask.done, ...unsettled];
	}

	claim(sessionId: string): CompletionClaim | string | undefined {
		if (!this.#askSessions.has(sessionId)) return undefined;
		const ask = this.#open.get(sessionId);
		if (!ask) return "the agenda ask is over; ask again to mark a task done";
		if (ask.claimed >= AskCompletionLimit.PER_ASK) return "one task can be marked done per ask; ask again for the next one";
		ask.claimed++;
		let settled = false;
		const { promise, resolve } = Promise.withResolvers<void>();
		const pending: Pending = { settled: promise };
		ask.pending.add(pending);
		const settle = (): void => {
			settled = true;
			ask.pending.delete(pending);
			resolve();
		};
		return {
			active: () => !ask.closed,
			writing: task => {
				pending.task = task;
			},
			complete: task => {
				if (settled) return;
				ask.done.push(task);
				settle();
			},
			uncertain: task => {
				if (settled) return;
				ask.done.push({ ...task, uncertain: true });
				settle();
			},
			release: () => {
				if (settled) return;
				ask.claimed--;
				settle();
			},
		};
	}
}
