import type { ReactNode } from "react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DeckApi } from "../../lib/api";
import { SleepSettingsStore, type SleepSettingsSnapshot } from "../../lib/sleep-settings";
import "./auto-sleep.css";

export function AutoSleepSettings({ api }: { api: DeckApi }): ReactNode {
	const store = useMemo(() => new SleepSettingsStore(api), [api]);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	useEffect(() => {
		void store.load();
		return () => store.dispose();
	}, [store]);
	return (
		<AutoSleepSettingsView
			snapshot={snapshot}
			onDraft={draft => store.setDraft(draft)}
			onSave={() => void store.save()}
			onRetry={() => void store.load()}
		/>
	);
}

export function AutoSleepSettingsView({
	snapshot,
	onDraft,
	onSave,
	onRetry,
}: {
	snapshot: SleepSettingsSnapshot;
	onDraft(draft: string): void;
	onSave(): void;
	onRetry(): void;
}): ReactNode {
	const currentValue = snapshot.minutes === null
		? "Unavailable"
		: snapshot.minutes === 0
			? "Off"
			: `${snapshot.minutes} minute${snapshot.minutes === 1 ? "" : "s"}`;
	return (
		<section className="dk-settings-section dk-sleep-settings" aria-label="Auto-sleep">
			<h3 className="dk-section-title">Auto-sleep</h3>
			<p className="dk-hint">Sleep quiet sessions after they have been idle for this many minutes. Set 0 for Off.</p>
			{snapshot.load === "loading" && <p className="dk-hint" role="status">Loading auto-sleep…</p>}
			{snapshot.load === "error" && (
				<div className="dk-sleep-feedback">
					<p className="dk-sleep-error" role="alert">Could not load auto-sleep settings: {snapshot.error}</p>
					<button type="button" className="dk-wide-btn" onClick={onRetry}>Retry</button>
				</div>
			)}
			{snapshot.load === "ready" && (
				<>
					<p className="dk-sleep-current" role="status" aria-live="polite">Current value: <strong>{currentValue}</strong></p>
					<label className="dk-sleep-input">
						<span>Idle minutes before quiet sessions sleep</span>
						<input
							type="number"
							inputMode="numeric"
							min="0"
							step="1"
							value={snapshot.draft}
							disabled={snapshot.saving}
							onChange={event => onDraft(event.currentTarget.value)}
						/>
					</label>
					<div className="dk-sleep-actions">
						<button
							type="button"
							className="dk-wide-btn"
							aria-pressed={snapshot.draft.trim() === "0"}
							disabled={snapshot.saving}
							onClick={() => onDraft("0")}
						>
							Off
						</button>
						<button type="button" className="dk-wide-btn" disabled={snapshot.saving} onClick={onSave}>
							{snapshot.saving ? "Saving…" : "Save"}
						</button>
					</div>
					{snapshot.message !== null && <p className="dk-sleep-saved" role="status">{snapshot.message}</p>}
					{snapshot.error !== null && <p className="dk-sleep-error" role="alert">{snapshot.error}</p>}
				</>
			)}
		</section>
	);
}
