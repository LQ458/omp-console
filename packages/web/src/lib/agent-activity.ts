/**
 * Browser-side record of when each subagent's progress last changed. The host refreshes `AgentSnapshot.lastActivity`
 * on running heartbeats but sends `agents` frames only on change, so a busy agent can look idle for a while; every
 * progress payload the guest receives is a fresh payload object, which is the signal tracked here.
 *
 * The first-seen time lives on the payload object, not on the tracker: the rail, the graph sheet and the status
 * sheet each run a tracker, and one that mounts late must not restamp an old payload as fresh (that would hide a
 * stalled agent for two minutes after every panel opens).
 */
import type { SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { useMemo } from "react";

const firstSeenAt = new WeakMap<SubagentProgressPayload, number>();

export class ProgressSeen {
	#seenAt: ReadonlyMap<string, number> = new Map();

	/**
	 * Per agent id, the time the browser first saw its current progress payload (`now` for a payload nobody has
	 * seen yet). The returned map keeps its identity until something changes, so it is safe as a memo dependency.
	 */
	observe(progress: ReadonlyMap<string, SubagentProgressPayload>, now: number): ReadonlyMap<string, number> {
		const next = new Map<string, number>();
		let changed = progress.size !== this.#seenAt.size;
		for (const [id, payload] of progress) {
			let at = firstSeenAt.get(payload);
			if (at === undefined) {
				at = now;
				firstSeenAt.set(payload, at);
			}
			next.set(id, at);
			if (this.#seenAt.get(id) !== at) changed = true;
		}
		if (changed) this.#seenAt = next;
		return this.#seenAt;
	}
}

/** One tracker per component instance; call with the latest progress map and clock on each render. */
export function useProgressSeen(
	progress: ReadonlyMap<string, SubagentProgressPayload>,
	now: number,
): ReadonlyMap<string, number> {
	const tracker = useMemo(() => new ProgressSeen(), []);
	return tracker.observe(progress, now);
}
