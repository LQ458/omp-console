import type { OvernightTemplate, OvernightQuiet } from "@omp-console/protocol";
import { RotateCw, Save } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { DEFAULT_OVERNIGHT_TEMPLATE, validateOvernightTemplate } from "../../lib/overnight";
import "./overnight.css";

export function OvernightSettings({ api }: { api: Pick<DeckApi, "getOvernightTemplate" | "setOvernightTemplate"> }): ReactNode {
	const [template, setTemplate] = useState<OvernightTemplate | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const load = async (signal?: AbortSignal): Promise<void> => {
		setLoading(true);
		setLoadError(null);
		try {
			const next = await api.getOvernightTemplate(signal);
			if (!signal?.aborted) setTemplate(next);
		} catch (error) {
			if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : "Overnight run settings could not be loaded.");
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	};

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [api]);

	const errors = template === null ? [] : validateOvernightTemplate(template);
	const updatePolicy = (patch: Partial<OvernightTemplate["policy"]>): void => {
		setTemplate(current => current === null ? null : { ...current, policy: { ...current.policy, ...patch } });
		setSaved(false);
		setSaveError(null);
	};
	const save = async (): Promise<void> => {
		if (template === null || errors.length > 0 || saving) return;
		setSaving(true);
		setSaveError(null);
		setSaved(false);
		try {
			setTemplate(await api.setOvernightTemplate(template));
			setSaved(true);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Overnight run settings could not be saved.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="dk-settings-section dk-overnight-settings" aria-label="Overnight run settings">
			<h3 className="dk-section-title">Overnight run</h3>
			<p className="dk-hint">These defaults apply to each Overnight run. You can change the instructions before starting.</p>
			{loading && <p className="dk-overnight-note" role="status">Loading Overnight run settings…</p>}
			{loadError && (
				<div className="dk-overnight-error" role="alert">
					{loadError}
					<button type="button" className="sh-btn" disabled={loading} onClick={() => void load()}>Retry</button>
				</div>
			)}
			{template && (
				<>
					<label className="dk-overnight-field">
						<span>Default end time</span>
						<input type="time" value={template.policy.deadlineLocalTime} onChange={event => updatePolicy({ deadlineLocalTime: event.currentTarget.value })} />
					</label>
					<div className="dk-overnight-settings-grid">
						<label className="dk-overnight-field">
							<span>How long to wait for an answer (seconds)</span>
							<input type="number" min={1} step={1} value={template.policy.askTimeoutSec} onChange={event => updatePolicy({ askTimeoutSec: Number(event.currentTarget.value) })} />
						</label>
						<label className="dk-overnight-field">
							<span>Maximum times to continue after a turn ends without a clear finish</span>
							<input type="number" min={0} step={1} value={template.policy.maxIdleContinuations} onChange={event => updatePolicy({ maxIdleContinuations: Number(event.currentTarget.value) })} />
						</label>
					</div>
					<label className="dk-overnight-field">
						<span>Quiet level</span>
						<select value={template.policy.quiet} onChange={event => updatePolicy({ quiet: event.currentTarget.value as OvernightQuiet })}>
							<option value="normal">Normal — standard priority.</option>
							<option value="quiet">Quiet — lower priority; the system stays more responsive.</option>
							<option value="silent">Lowest priority — may run more slowly.</option>
						</select>
					</label>
					<label className="dk-overnight-keep-awake">
						<input type="checkbox" checked={template.policy.keepAwake} onChange={event => updatePolicy({ keepAwake: event.currentTarget.checked })} />
						<span><strong>Keep awake</strong><small>Keep this computer awake while an Overnight run is active.</small></span>
					</label>
					<label className="dk-overnight-field">
						<span>Default instructions</span>
						<textarea rows={10} value={template.prompt} onChange={event => {
							const prompt = event.currentTarget.value;
							setTemplate(current => current === null ? null : { ...current, prompt });
							setSaved(false);
							setSaveError(null);
						}} />
					</label>
					{errors.map(error => <p className="dk-overnight-error" key={error} role="alert">{error}</p>)}
					{saveError && <p className="dk-overnight-error" role="alert">{saveError}</p>}
					{saved && <p className="dk-overnight-success" role="status">Overnight run settings saved.</p>}
					<div className="dk-overnight-submit">
						<button type="button" className="sh-btn sh-btn-primary" disabled={loading || saving || errors.length > 0} onClick={() => void save()}>
							<Save size={14} aria-hidden="true" />{saving ? "Saving…" : "Save defaults"}
						</button>
						<button type="button" className="sh-btn" disabled={loading || saving} onClick={() => {
							setTemplate({ ...DEFAULT_OVERNIGHT_TEMPLATE, policy: { ...DEFAULT_OVERNIGHT_TEMPLATE.policy } });
							setSaved(false);
							setSaveError(null);
						}}> <RotateCw size={14} aria-hidden="true" />Reset defaults</button>
					</div>
				</>
			)}
		</section>
	);
}
