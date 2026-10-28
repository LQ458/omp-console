import type { DriftSuggestion, MovePreview } from "@omp-console/protocol";
import { FileWarning, FolderInput, Loader2, MonitorSmartphone } from "lucide-react";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { fmtBytes } from "../../lib/format";
import type { MoveFlow, MoveState } from "../../lib/move";

export const EXCLUDE_LABEL: Record<DriftSuggestion["excluded"][number]["reason"], string> = {
	"dependency-dir": "dependency folder",
	secret: "looks like a secret (left out, name only)",
	"special-file": "special file (pipe, device or socket)",
	hardlink: "hard-linked file",
	"too-large": "too large",
};

export function useMoveState(flow: MoveFlow): MoveState {
	return useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
}

export interface MovePreviewCardProps {
	preview: MovePreview;
}

/** Daemon-computed facts only: destination, counts, and what is left out. Nothing here comes from the agent. */
export function MovePreviewCard({ preview }: MovePreviewCardProps): ReactNode {
	return (
		<div className="sf-preview" aria-label="move preview">
			<dl className="sf-facts">
				<div>
					<dt>Copy to</dt>
					<dd>
						<code>{preview.destination}</code>
					</dd>
				</div>
				<div>
					<dt>Files</dt>
					<dd>{preview.files}</dd>
				</div>
				<div>
					<dt>Size</dt>
					<dd>{fmtBytes(preview.bytes)}</dd>
				</div>
				<div>
					<dt>Left out</dt>
					<dd>{preview.excluded.length}</dd>
				</div>
			</dl>
			{preview.excluded.length > 0 && (
				<ul className="sf-excluded" aria-label="excluded items">
					{preview.excluded.map(item => (
						<li key={item.path}>
							<FileWarning size={11} />
							<code>{item.path}</code>
							<span className="ws-muted">{EXCLUDE_LABEL[item.reason]}</span>
						</li>
					))}
				</ul>
			)}
			<p className="ws-muted sf-note">
				omp console copies; the original stays untouched. Then it runs <code>git init</code> and opens a new project session.
			</p>
		</div>
	);
}

export interface MovePanelProps {
	flow: MoveFlow;
	onPrepareAgain(): void;
	onOpenSession(sessionId: string): void;
	onUndo(moveId: string): void;
	undoNote?: string | null;
}

/** The part of the drift card that follows "Preview move". */
export function MovePanel({ flow, onPrepareAgain, onOpenSession, onUndo, undoNote }: MovePanelProps): ReactNode {
	const state = useMoveState(flow);
	switch (state.phase) {
		case "idle":
			return null;
		case "preparing":
			return (
				<div className="sf-step" role="status">
					<Loader2 size={13} className="sf-spin" /> Preparing a preview…
				</div>
			);
		case "preview":
		case "needs-mac":
		case "confirming":
			return (
				<div className="sf-step" data-phase={state.phase}>
					<MovePreviewCard preview={state.preview} />
					{state.phase === "preview" && state.note && (
						<div className="dk-notice dk-notice-warn ws-notice" role="status">
							<span>{state.note}</span>
						</div>
					)}
					{state.phase === "needs-mac" && (
						<div className="dk-notice dk-notice-warn ws-notice" role="status">
							<MonitorSmartphone size={14} />
							<span>
								Only the omp console Mac app can approve a move: it signs the approval with a key in your Keychain. Open this
								session in the Mac app to continue.
							</span>
						</div>
					)}
					<div className="ws-row-actions">
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							disabled={state.phase !== "preview"}
							onClick={() => void flow.confirm()}
						>
							<FolderInput size={13} />
							{state.phase === "needs-mac"
								? "Confirm on the Mac app"
								: state.phase === "confirming"
									? "Waiting for the Mac…"
									: "Confirm in the Mac app…"}
						</button>
						<button type="button" className="sh-btn" onClick={() => flow.cancel()}>
							Cancel
						</button>
					</div>
				</div>
			);
		case "done":
			return (
				<div className="sf-step" data-phase="done" role="status">
					<p>
						Copied to <code>{state.record.destination}</code>.
					</p>
					<div className="ws-row-actions">
						{state.record.newSessionId !== undefined && (
							<button type="button" className="sh-btn sh-btn-primary" onClick={() => onOpenSession(state.record.newSessionId!)}>
								Open the new session
							</button>
						)}
						<button type="button" className="sh-btn" onClick={() => onUndo(state.record.id)}>
							Undo
						</button>
					</div>
					{undoNote && (
						<div className="dk-notice dk-notice-warn ws-notice" role="status">
							<span>{undoNote}</span>
						</div>
					)}
				</div>
			);
		case "expired":
			return (
				<div className="sf-step" data-phase="expired">
					<div className="dk-notice dk-notice-warn ws-notice" role="status">
						<span>The preview expired. Nothing was copied.</span>
					</div>
					<div className="ws-row-actions">
						<button type="button" className="sh-btn" onClick={onPrepareAgain}>
							Prepare again
						</button>
					</div>
				</div>
			);
		case "failed":
			return (
				<div className="sf-step" data-phase="failed">
					<div className="dk-notice dk-notice-err ws-notice" role="alert">
						<span>{state.message}</span>
					</div>
					<div className="ws-row-actions">
						<button type="button" className="sh-btn" onClick={onPrepareAgain}>
							Try again
						</button>
					</div>
				</div>
			);
	}
}
