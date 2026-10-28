/**
 * Render throttling at the component boundary: a snapshot source that republishes at most once per interval.
 *
 * A background pane's `GuestClient` keeps receiving every frame; only the React subtree behind this source is
 * limited to one commit per interval. The first change after a quiet period publishes at once (leading edge),
 * later ones within the interval are folded into one publish when the interval ends (trailing edge), so the pane
 * is never more than one interval behind and never renders more often than the interval allows.
 *
 * Interval 0 passes every change straight through (the focused pane). Switching to 0 publishes whatever is
 * pending immediately, so a pane that gains focus shows the latest state without waiting for the timer.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";

export interface SnapshotSource<S> {
	subscribe(listener: () => void): () => void;
	getSnapshot(): S;
}

export class ThrottledSource<S> implements SnapshotSource<S> {
	readonly #source: SnapshotSource<S>;
	readonly #listeners = new Set<() => void>();
	#held: S;
	#intervalMs = 0;
	#timer: Timer | undefined;
	/** The source changed since the last publish and a publish is owed. */
	#dirty = false;
	#unsubscribe: (() => void) | null = null;

	constructor(source: SnapshotSource<S>) {
		this.#source = source;
		this.#held = source.getSnapshot();
	}

	/** Stable identity: safe to pass straight to `useSyncExternalStore`. */
	readonly subscribe = (listener: () => void): (() => void) => {
		if (this.#listeners.size === 0) {
			// Catch up on whatever happened while nobody was listening (the effect gap after first render).
			this.#held = this.#source.getSnapshot();
			this.#dirty = false;
			this.#unsubscribe = this.#source.subscribe(this.#onChange);
		}
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size > 0) return;
			this.#unsubscribe?.();
			this.#unsubscribe = null;
			this.#cancelTimer();
			this.#dirty = false;
		};
	};

	readonly getSnapshot = (): S => this.#held;

	/** 0 publishes every change; otherwise at most one publish per `ms`. */
	setInterval(ms: number): void {
		this.#intervalMs = ms;
		if (ms === 0) {
			this.#cancelTimer();
			if (this.#listeners.size > 0 && this.#source.getSnapshot() !== this.#held) this.#publish();
		}
	}

	readonly #onChange = (): void => {
		if (this.#intervalMs === 0) {
			this.#publish();
			return;
		}
		if (this.#timer !== undefined) {
			this.#dirty = true;
			return;
		}
		this.#publish();
		this.#startCooldown();
	};

	#startCooldown(): void {
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (!this.#dirty) return;
			this.#publish();
			this.#startCooldown();
		}, this.#intervalMs);
	}

	#cancelTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#publish(): void {
		this.#dirty = false;
		this.#held = this.#source.getSnapshot();
		for (const listener of this.#listeners) listener();
	}
}

/** Background panes render at this rate; the focused pane at the frame rate. */
export const BACKGROUND_PANE_MS = 250;

/**
 * Guest snapshot republished at most every `intervalMs` (0 = every change). `intervalMs` may change between
 * renders (focus moves); the client may not (a new client builds a new source).
 */
export function useThrottledGuestSnapshot(client: GuestClient, intervalMs: number): GuestSnapshot {
	const source = useMemo(
		() =>
			new ThrottledSource<GuestSnapshot>({
				subscribe: listener => client.subscribe(listener),
				getSnapshot: () => client.getSnapshot(),
			}),
		[client],
	);
	useEffect(() => {
		source.setInterval(intervalMs);
	}, [source, intervalMs]);
	const getServerSnapshot = useCallback(() => source.getSnapshot(), [source]);
	return useSyncExternalStore(source.subscribe, source.getSnapshot, getServerSnapshot);
}
