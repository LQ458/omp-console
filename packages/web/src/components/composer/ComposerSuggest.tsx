import { File, Folder, Slash, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { AssistRow } from "./use-assist";
import "./composer.css";

export interface ComposerSuggestProps {
	listId: string;
	title: string;
	rows: readonly AssistRow[];
	active: number;
	error: string | undefined;
	onPick(index: number): void;
	onHover(index: number): void;
}

export function suggestOptionId(listId: string, index: number): string {
	return `${listId}-${index}`;
}

function RowIcon({ row }: { row: AssistRow }): ReactNode {
	if (row.payload.kind === "file") return row.payload.item.kind === "dir" ? <Folder size={13} /> : <File size={13} />;
	if (row.payload.kind === "command") return <Slash size={13} />;
	return <Sparkles size={13} />;
}

/** Suggestion list docked above the composer for `@file`, `^model` and `/command` tokens. */
export function ComposerSuggest({ listId, title, rows, active, error, onPick, onHover }: ComposerSuggestProps): ReactNode {
	const listRef = useRef<HTMLUListElement | null>(null);

	useEffect(() => {
		listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [active, rows]);

	return (
		<div className="cmp-suggest">
			<div className="cmp-suggest-head">
				<span>{title}</span>
				<span className="cmp-suggest-keys">↑↓ move · Tab/Enter accept · Esc close</span>
			</div>
			{error !== undefined && rows.length === 0 ? (
				<p className="cmp-suggest-error" role="alert">
					{error}
				</p>
			) : (
				<ul id={listId} ref={listRef} className="cmp-suggest-list" role="listbox" aria-label={title}>
					{rows.map((row, index) => (
						<li
							key={row.key}
							id={suggestOptionId(listId, index)}
							role="option"
							aria-selected={index === active}
							aria-disabled={row.disabled === true}
							className="cmp-suggest-row"
							data-active={index === active ? "true" : "false"}
							data-disabled={row.disabled === true ? "true" : "false"}
							onMouseMove={() => onHover(index)}
							onMouseDown={event => event.preventDefault()}
							onClick={() => onPick(index)}
						>
							<span className="cmp-suggest-icon">
								<RowIcon row={row} />
							</span>
							<span className="cmp-suggest-primary">{row.primary}</span>
							{row.secondary && <span className="cmp-suggest-secondary">{row.secondary}</span>}
							{row.badge && <span className="ct-badge">{row.badge}</span>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
