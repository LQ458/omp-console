import type { MoveRecord } from "@omp-console/protocol";
import { RefreshCw, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { relTime } from "../../lib/format";
import { recordUsage } from "../../lib/journal";
import { canUndo, moveStateLabel, undoMove } from "../../lib/move";
import { basename } from "../../lib/native-path";
import "./safety.css";

export interface MoveHistoryProps {
	api: Pick<DeckApi, "listMoves" | "undoMove">;
}

/** Every move deck has done, newest first, with a one-click undo for copies that are still untouched. */
export function MoveHistory({ api }: MoveHistoryProps): ReactNode {
	const [moves, setMoves] = useState<MoveRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [busyId, setBusyId] = useState<string | null>(null);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const response = await api.listMoves();
			setMoves([...response.moves].sort((a, b) => b.at - a.at));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "could not load moves");
		}
	}, [api]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const undo = async (record: MoveRecord): Promise<void> => {
		setBusyId(record.id);
		const outcome = await undoMove(api, record.id);
		recordUsage({ feature: "9.move", action: "undo", outcome: outcome.ok ? "ok" : "error", via: "direct", screen: "moves" });
		setNotes(current => {
			const next = { ...current };
			if (outcome.ok) delete next[record.id];
			else next[record.id] = outcome.message;
			return next;
		});
		setBusyId(null);
		await refresh();
	};

	if (moves === null) {
		return error ? (
			<div className="dk-notice dk-notice-err ws-notice" role="alert">
				<span>{error}</span>
			</div>
		) : (
			<div className="ws-empty" role="status">Loading project moves…</div>
		);
	}

	return (
		<div className="sf-panel">
			<div className="sf-moves-head">
				<span className="ws-muted">{moves.length} project move{moves.length === 1 ? "" : "s"}</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={() => void refresh()} aria-label="Refresh project moves" title="Refresh">
					<RefreshCw size={14} />
				</button>
			</div>
			{moves.length === 0 && <div className="ws-empty">No project moves yet. omp-console only copies a project from the Notes folder after you confirm on the Mac.</div>}
			<ul className="sf-move-list">
				{moves.map(record => (
					<li key={record.id} className="sf-move" data-state={record.state}>
						<div className="sf-move-main">
							<code className="sf-move-dest">{record.destination}</code>
							<span className="sf-move-meta">
								<span className="sf-move-state" data-state={record.state}>
									{moveStateLabel(record.state)}
								</span>
								<span className="ws-muted">{relTime(record.at)}</span>
							</span>
							{record.error && <span className="sf-slug-error">{record.error}</span>}
							{record.state === "undone" && record.trashPath && (
								<span className="ws-muted">
									<code>{record.trashPath.endsWith("/") || record.trashPath.endsWith("\\") ? "" : basename(record.trashPath)}</code>
								</span>
							)}
							{notes[record.id] && (
								<span className="sf-slug-error" role="status">
									{notes[record.id]}
								</span>
							)}
						</div>
						{canUndo(record) && (
							<button type="button" className="sh-btn" disabled={busyId !== null} onClick={() => void undo(record)} title="Delete the copy if it is unchanged">
								<Undo2 size={13} /> Undo
							</button>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
