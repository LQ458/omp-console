import type { KeybindingsResponse } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { actionForOmpId, KEY_ACTION_LABELS } from "../../lib/keymap";
import { Sheet } from "../shell/Sheet";
import "./keybindings.css";

export interface KeybindingsSheetProps {
	keybindings: KeybindingsResponse | null;
	error: string | null;
	onClose(): void;
}

export function KeybindingsSheet({ keybindings, error, onClose }: KeybindingsSheetProps): ReactNode {
	const rows = keybindings === null
		? []
		: Object.entries(keybindings.bindings)
				.filter(([, keys]) => keys.length > 0)
					.map(([id, keys]) => {
						const action = actionForOmpId(id);
						return { id, label: action === undefined ? id : KEY_ACTION_LABELS[action], keys };
					})
					.sort((a, b) => a.label.localeCompare(b.label));

	return (
		<Sheet title="Keyboard shortcuts" onClose={onClose}>
			{keybindings === null ? (
				<p className="dk-hint" role={error === null ? "status" : "alert"}>
					{error === null ? "Loading omp keybindings…" : `Keybindings unavailable: ${error}`}
				</p>
			) : (
				<>
					<dl className="dk-keybindings">
						{rows.map(row => (
							<div className="dk-keybinding" key={row.id}>
								<dt>{row.label}</dt>
								<dd>{row.keys.join(" · ")}</dd>
							</div>
						))}
					</dl>
					<p className="dk-hint" role="note">
						Double Escape: {keybindings.doubleEscapeAction === "tree" ? "open the session tree" : keybindings.doubleEscapeAction === "rewind" ? "rewind to a message" : "disabled"}
					</p>
				</>
			)}
		</Sheet>
	);
}
