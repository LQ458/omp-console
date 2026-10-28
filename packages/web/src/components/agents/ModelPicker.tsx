import type { ListModelsResponse } from "@omp-console/protocol";
import { Check, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { buildModelGroups, type ModelPickItem } from "../../lib/agent-models";
import "./agents.css";

export interface ModelPickerProps {
	/** Null until loaded. */
	models: ListModelsResponse | null;
	loading?: boolean;
	/** Sentence shown instead of the list when `GET /api/models` failed. */
	error?: string | null;
	/** Selector or model id currently in use; marked in the list. */
	current?: string;
	/** Disables every row while a pick is being sent. */
	busy?: boolean;
	onPick(item: ModelPickItem): void;
	onRetry?(): void;
}

/**
 * Searchable model list grouped by provider, role aliases first. Unavailable models (most of a catalog of thousands)
 * are hidden behind a "show" row until searched for or asked for, then listed disabled: rendering them all made the
 * phone sheet slow.
 */
export function ModelPicker(props: ModelPickerProps): ReactNode {
	const { models, loading = false, error = null, current, busy = false, onPick, onRetry } = props;
	const [query, setQuery] = useState("");
	const [showUnavailable, setShowUnavailable] = useState(false);
	const searching = query.trim() !== "";
	const { groups, hidden } = useMemo(() => {
		const all = models ? buildModelGroups(models, query) : [];
		if (showUnavailable || searching) return { groups: all, hidden: 0 };
		let hiddenCount = 0;
		const visible = all
			.map(group => {
				const items = group.items.filter(item => item.available || item.kind === "role" || item.selector === current);
				hiddenCount += group.items.length - items.length;
				return { ...group, items };
			})
			.filter(group => group.items.length > 0);
		return { groups: visible, hidden: hiddenCount };
	}, [models, query, showUnavailable, searching, current]);

	if (error !== null) {
		return (
			<div className="ag-picker">
				<div className="ag-inline-note ag-inline-note--err" role="alert">
					{error}
				</div>
				{onRetry ? (
					<button type="button" className="ag-btn" onClick={onRetry}>
						retry
					</button>
				) : null}
			</div>
		);
	}
	if (models === null || loading) {
		return (
			<div className="ag-picker ag-picker-loading dk-content-enter" role="status" aria-label="Loading models" aria-busy="true">
				<span className="ag-picker-loading-label">Loading models…</span>
				<div className="ag-picker-loading-rows" aria-hidden="true">
					<span className="dk-skeleton" />
					<span className="dk-skeleton" />
					<span className="dk-skeleton" />
					<span className="dk-skeleton" />
				</div>
			</div>
		);
	}

	return (
		<div className="ag-picker">
			<label className="ag-picker-search">
				<Search size={14} aria-hidden />
				<input
					type="search"
					value={query}
					placeholder="Search models or roles"
					aria-label="search models"
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					onChange={event => setQuery(event.target.value)}
				/>
			</label>
			<div className="ag-picker-list dk-content-enter" role="listbox" aria-label="models">
				{groups.length === 0 ? <div className="ag-empty">{searching ? `No model matches “${query.trim()}”` : "No available models"}</div> : null}
				{groups.map(group => (
					<div key={group.id} className="ag-picker-group" role="group" aria-label={group.label}>
						<div className="ag-picker-group-label">{group.label}</div>
						{group.items.map(item => {
							const isCurrent = current !== undefined && (item.selector === current || item.detail === current);
							return (
								<button
									key={`${group.id}:${item.selector}`}
									type="button"
									role="option"
									aria-selected={isCurrent}
									className="ag-picker-item"
									data-kind={item.kind}
									data-available={item.available ? "true" : "false"}
									disabled={busy || !item.available}
									onClick={() => onPick(item)}
								>
									<span className="ag-picker-main">
										<span className="ag-picker-label">{item.label}</span>
										<span className="ag-picker-detail">
											{item.kind === "role" ? `→ ${item.detail}` : item.selector}
										</span>
									</span>
									{!item.available ? (
										<span className="ag-chip">unavailable</span>
									) : isCurrent ? (
										<Check size={14} aria-label="in use" />
									) : null}
								</button>
							);
						})}
					</div>
				))}
				{hidden > 0 ? (
					<button type="button" className="ag-picker-more" onClick={() => setShowUnavailable(true)}>
						Show {hidden} unavailable model{hidden === 1 ? "" : "s"}
					</button>
				) : null}
			</div>
		</div>
	);
}
