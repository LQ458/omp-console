/** Mouse access to what the keys do (split, zoom, close) and the named layouts menu. */
import { Columns2, LayoutGrid, Maximize2, Minimize2, Rows2, Settings, Trash2, X } from "lucide-react";
import type { ReactNode, SyntheticEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SplitAxis } from "../../lib/pane-layout";

export interface PaneActions {
	split(axis: SplitAxis): void;
	zoom(): void;
	close(): void;
	/** Names of the saved layouts, read when the menu opens. */
	layoutNames(): string[];
	/** False when the name is unusable or storage refused it. */
	saveLayout(name: string): boolean;
	loadLayout(name: string): void;
	deleteLayout(name: string): void;
}

export interface PaneBarProps {
	actions: PaneActions;
	paneCount: number;
	zoomed: boolean;
	onOpenSettings(): void;
}

export function PaneBar({ actions, paneCount, zoomed, onOpenSettings }: PaneBarProps): ReactNode {
	return (
		<div className="pn-bar" role="toolbar" aria-label="pane layout">
			<LayoutsMenu actions={actions} />
			<span className="pn-bar-sep" aria-hidden="true" />
			<button
				type="button"
				className="pn-bar-btn"
				onClick={() => actions.split("right")}
				title="Split right (Cmd+D)"
				aria-label="split pane right"
			>
				<Columns2 size={14} />
			</button>
			<button
				type="button"
				className="pn-bar-btn"
				onClick={() => actions.split("down")}
				title="Split down (Cmd+Shift+D)"
				aria-label="split pane down"
			>
				<Rows2 size={14} />
			</button>
			<button
				type="button"
				className="pn-bar-btn"
				onClick={actions.zoom}
				disabled={paneCount < 2 && !zoomed}
				aria-pressed={zoomed}
				title={zoomed ? "Show all panes (Cmd+Shift+Enter)" : "Zoom this pane (Cmd+Shift+Enter)"}
				aria-label={zoomed ? "show all panes" : "zoom this pane"}
			>
				{zoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
			</button>
			<button
				type="button"
				className="pn-bar-btn"
				onClick={actions.close}
				title="Close this pane (Cmd+W)"
				aria-label="close this pane"
			>
				<X size={14} />
			</button>
			<span className="pn-bar-count" aria-live="polite">
				{paneCount === 1 ? "1 pane" : `${paneCount} panes`}
			</span>
			<button
				type="button"
				className="pn-bar-btn"
				onClick={onOpenSettings}
				title="Global settings (⌘,)"
				aria-label="global settings"
			>
				<Settings size={14} />
			</button>
		</div>
	);
}

function LayoutsMenu({ actions }: { actions: PaneActions }): ReactNode {
	const [open, setOpen] = useState(false);
	const [names, setNames] = useState<string[]>([]);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	const toggle = useCallback(() => {
		setOpen(wasOpen => {
			if (!wasOpen) {
				setNames(actions.layoutNames());
				setError(null);
			}
			return !wasOpen;
		});
	}, [actions]);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent): void => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const save = (event: SyntheticEvent): void => {
		event.preventDefault();
		if (actions.saveLayout(draft)) {
			setDraft("");
			setError(null);
			setNames(actions.layoutNames());
		} else {
			setError("Pick another name (not empty, not “current”).");
		}
	};

	return (
		<div className="pn-menu" ref={rootRef}>
			<button
				type="button"
				className="pn-bar-btn pn-bar-btn-text"
				onClick={toggle}
				aria-haspopup="menu"
				aria-expanded={open}
				title="Saved pane layouts"
			>
				<LayoutGrid size={14} />
				<span>Layouts</span>
			</button>
			{open && (
				<div className="pn-menu-panel" role="menu" aria-label="saved layouts">
					{names.length === 0 && <p className="pn-menu-empty">No saved layouts yet.</p>}
					{names.map(name => (
						<div className="pn-menu-row" key={name} role="none">
							<button
								type="button"
								role="menuitem"
								className="pn-menu-item"
								onClick={() => {
									actions.loadLayout(name);
									setOpen(false);
								}}
							>
								{name}
							</button>
							<button
								type="button"
								className="pn-menu-delete"
								onClick={() => {
									actions.deleteLayout(name);
									setNames(actions.layoutNames());
								}}
								aria-label={`delete layout ${name}`}
								title="Delete this layout"
							>
								<Trash2 size={12} />
							</button>
						</div>
					))}
					<form className="pn-menu-save" onSubmit={save}>
						<input
							value={draft}
							onChange={event => setDraft(event.target.value)}
							placeholder="Save this layout as…"
							aria-label="layout name"
							maxLength={48}
						/>
						<button type="submit" className="sh-btn" disabled={draft.trim() === ""}>
							Save
						</button>
					</form>
					{error !== null && (
						<p className="pn-menu-error" role="alert">
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
