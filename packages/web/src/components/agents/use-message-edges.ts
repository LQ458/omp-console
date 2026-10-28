import type { AgentSnapshot, SessionEntry } from "@oh-my-pi/pi-wire";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GuestClient } from "../../lib/client";
import { aggregateMessageEdges, extractIrcEvents, IrcTail, type IrcEvent, type MessageEdge } from "../../lib/message-edges";

const POLL_MS = 2500;
/** A non-running agent whose transcript did not grow for this many polls is left alone until it shows activity. */
const SETTLE_POLLS = 2;

interface TailState {
	tail: IrcTail;
	unchanged: number;
	lastActivity: number;
}

/**
 * Message edges of the session: IRC facts from the main transcript (already replicated) plus those read from each
 * subagent's transcript file with incremental `fetchTranscript` polls. Only the IRC facts are kept, not the entries.
 * Nothing is polled while `enabled` is false.
 */
export function useMessageEdges(props: {
	client: GuestClient | undefined;
	agents: readonly AgentSnapshot[];
	entries: readonly SessionEntry[];
	enabled: boolean;
}): MessageEdge[] {
	const { client, agents, entries, enabled } = props;
	const mainId = agents.find(agent => agent.kind === "main")?.id;
	const tails = useRef(new Map<string, TailState>());
	const agentsRef = useRef(agents);
	agentsRef.current = agents;
	const [version, setVersion] = useState(0);

	const mainEvents = useMemo<IrcEvent[]>(
		() => (enabled && mainId !== undefined ? extractIrcEvents(mainId, entries) : []),
		[enabled, mainId, entries],
	);

	useEffect(() => {
		if (!enabled || client === undefined) return;
		const source = client;
		let disposed = false;
		let inFlight = false;
		const round = async (): Promise<void> => {
			if (inFlight) return;
			inFlight = true;
			try {
				let grew = false;
				await Promise.all(
					agentsRef.current
						.filter(agent => agent.kind === "sub" && agent.hasSessionFile)
						.map(async agent => {
							let state = tails.current.get(agent.id);
							if (!state) {
								state = { tail: new IrcTail(agent.id), unchanged: 0, lastActivity: agent.lastActivity };
								tails.current.set(agent.id, state);
							}
							if (state.tail.failed) return;
							if (agent.lastActivity !== state.lastActivity) {
								state.lastActivity = agent.lastActivity;
								state.unchanged = 0;
							}
							if (agent.status !== "running" && state.unchanged >= SETTLE_POLLS) return;
							const before = state.tail.cursor;
							const reply = await source.fetchTranscript(agent.id, before);
							if (disposed) return;
							if (state.tail.apply(reply)) grew = true;
							state.unchanged = state.tail.cursor === before ? state.unchanged + 1 : 0;
						}),
				);
				if (grew && !disposed) setVersion(current => current + 1);
			} finally {
				inFlight = false;
			}
		};
		void round();
		const timer = setInterval(() => void round(), POLL_MS);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [enabled, client]);

	const ids = useMemo(() => new Set(agents.map(agent => agent.id)), [agents]);
	return useMemo(() => {
		if (!enabled) return [];
		const events: IrcEvent[] = [...mainEvents];
		for (const state of tails.current.values()) events.push(...state.tail.events);
		return aggregateMessageEdges(events, ids, mainId);
		// `version` stands for the tails' contents, which live in a ref.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	}, [enabled, mainEvents, ids, mainId, version]);
}
