/**
 * Phone layout (< 760 px): no splits. The panes are pages: a strip of tabs switches between them and only the
 * current page is mounted, so the others cost nothing but their (throttled-out) connections.
 */
import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { PaneFrame } from "./PaneFrame";
import { usePaneContext, usePaneState } from "./context";

export function PhonePanes(): ReactNode {
	const { model, titleOf } = usePaneContext();
	const state = usePaneState(model);
	return (
		<div className="pn-phone">
			{state.panes.length > 1 && (
				<div className="pn-phone-bar" role="tablist" aria-label="panes">
					{state.panes.map(pane => {
						const current = pane.id === state.focusedId;
						return (
							<span className="pn-phone-tab" key={pane.id} data-current={current ? "true" : "false"}>
								<button
									type="button"
									role="tab"
									aria-selected={current}
									className="pn-phone-tab-main"
									onClick={() => model.focus(pane.id)}
								>
									{pane.sessionId === null ? "Empty" : titleOf(pane.sessionId)}
								</button>
								{current && (
									<button
										type="button"
										className="pn-phone-tab-close"
										onClick={() => model.close(pane.id)}
										aria-label="close this pane"
									>
										<X size={12} />
									</button>
								)}
							</span>
						);
					})}
					<button type="button" className="pn-phone-add" onClick={() => model.split("right")} aria-label="new pane">
						<Plus size={14} />
					</button>
				</div>
			)}
			<div className="pn-phone-stage">
				<PaneFrame key={state.focusedId} paneId={state.focusedId} visible />
			</div>
		</div>
	);
}
