import type { DraftRun } from "@omp-console/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeControlError } from "../../lib/agent-api";
import type { DeckApi } from "../../lib/api";
import { pickRun } from "../../lib/draft";
import { DraftRunPoller } from "./draft-run-poller";

export interface DraftRuns {
	runs: readonly DraftRun[];
	/** The run on show: the one picked, else an active one, else the newest. */
	run: DraftRun | undefined;
	selectRun(runId: string | null): void;
	/** A run the daemon just accepted (so it shows before the first poll), then polls for its progress. */
	push(run: DraftRun): void;
	refresh(): Promise<void>;
	/** Last failure of a list call; cleared by the next success. */
	error: string | null;
}

/** Runs of one session: loaded when mounted (a run started before a reload is still there), polled while any is active. */
export function useDraftRuns(api: DeckApi, sessionId: string): DraftRuns {
	const [runs, setRuns] = useState<readonly DraftRun[]>([]);
	const [picked, setPicked] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const poller = useRef<DraftRunPoller | null>(null);

	useEffect(() => {
		const next = new DraftRunPoller({
			list: async () => (await api.listDraftRuns(sessionId)).runs,
			onRuns: setRuns,
			onError: err => setError(err === null ? null : describeControlError(err, "load")),
		});
		poller.current = next;
		void next.refresh();
		return () => {
			next.stop();
			poller.current = null;
		};
	}, [api, sessionId]);

	const refresh = useCallback(async () => {
		await poller.current?.refresh();
	}, []);

	const push = useCallback(
		(run: DraftRun) => {
			setPicked(run.runId);
			setRuns(current => [...current.filter(existing => existing.runId !== run.runId), run]);
			void refresh();
		},
		[refresh],
	);

	const run = (picked !== null ? runs.find(candidate => candidate.runId === picked) : undefined) ?? pickRun(runs);
	return { runs, run, selectRun: setPicked, push, refresh, error };
}
