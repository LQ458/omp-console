import type { OvernightQuiet, OvernightTemplate, PreflightCheck, StartOvernightRequest } from "@omp-console/protocol";
import { BadgeCheck, CircleAlert, CircleX, Moon, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { buildOvernightRequest, canStartOvernight, DEFAULT_OVERNIGHT_TEMPLATE, validateOvernightTemplate } from "../../lib/overnight";
import { shortenPath } from "../../lib/format";
import "./overnight.css";

export interface OvernightSetupProps {
	api: Pick<DeckApi, "getOvernightTemplate" | "getOvernightPreflight">;
	cwd: string | null;
	initialTask?: string;
	busy?: boolean;
	startLabel?: string;
	onStart(request: StartOvernightRequest): void | Promise<void>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "The Overnight run request failed.";
}

function clockLabel(value: string): string {
	const [hourText, minuteText] = value.split(":");
	const hour = Number(hourText);
	const minute = Number(minuteText);
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) return value;
	const date = new Date(2000, 0, 1, hour, minute);
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function CheckRow({ check }: { check: PreflightCheck }): ReactNode {
	const Icon = check.status === "ok" ? BadgeCheck : check.status === "warn" ? CircleAlert : CircleX;
	return (
		<li className={`dk-overnight-check dk-overnight-check-${check.status}`}>
			<Icon size={15} aria-hidden="true" />
			<div>
				<strong>{check.label}</strong>
				<p>{check.detail}</p>
				{check.fix && <p className="dk-overnight-fix">Fix: {check.fix}</p>}
			</div>
		</li>
	);
}

export function OvernightSetup({ api, cwd, initialTask = "", busy = false, startLabel = "Start Overnight run", onStart }: OvernightSetupProps): ReactNode {
	const [template, setTemplate] = useState<OvernightTemplate | null>(null);
	const [templateLoading, setTemplateLoading] = useState(true);
	const [templateError, setTemplateError] = useState<string | null>(null);
	const [task, setTask] = useState(initialTask);
	const [deadlineLocalTime, setDeadlineLocalTime] = useState(DEFAULT_OVERNIGHT_TEMPLATE.policy.deadlineLocalTime);
	const [quiet, setQuiet] = useState<OvernightQuiet>(DEFAULT_OVERNIGHT_TEMPLATE.policy.quiet);
	const [prompt, setPrompt] = useState(DEFAULT_OVERNIGHT_TEMPLATE.prompt);
	const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
	const [preflightLoading, setPreflightLoading] = useState(false);
	const [preflightError, setPreflightError] = useState<string | null>(null);
	const [startError, setStartError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const currentTemplate = useMemo<OvernightTemplate | null>(() => template === null ? null : {
		...template,
		prompt,
		policy: { ...template.policy, deadlineLocalTime, quiet },
	}, [template, prompt, deadlineLocalTime, quiet]);
	const validationErrors = currentTemplate === null ? [] : validateOvernightTemplate(currentTemplate);

	useEffect(() => {
		const controller = new AbortController();
		setTemplateLoading(true);
		setTemplateError(null);
		void api.getOvernightTemplate(controller.signal).then(result => {
			if (controller.signal.aborted) return;
			setTemplate(result);
			setDeadlineLocalTime(result.policy.deadlineLocalTime);
			setQuiet(result.policy.quiet);
			setPrompt(result.prompt);
		}).catch((error: unknown) => {
			if (!controller.signal.aborted) setTemplateError(errorText(error));
		}).finally(() => {
			if (!controller.signal.aborted) setTemplateLoading(false);
		});
		return () => controller.abort();
	}, [api]);

	useEffect(() => {
		if (cwd === null || cwd.trim() === "") {
			setChecks(null);
			setPreflightLoading(false);
			setPreflightError(null);
			return;
		}
		const controller = new AbortController();
		setPreflightLoading(true);
		setPreflightError(null);
		setChecks(null);
		void api.getOvernightPreflight(cwd, controller.signal).then(result => {
			if (!controller.signal.aborted) setChecks(result.checks);
		}).catch((error: unknown) => {
			if (!controller.signal.aborted) setPreflightError(errorText(error));
		}).finally(() => {
			if (!controller.signal.aborted) setPreflightLoading(false);
		});
		return () => controller.abort();
	}, [api, cwd]);

	const canRun = template !== null && validationErrors.length === 0 && task.trim() !== "" && cwd !== null &&
		checks !== null && canStartOvernight(checks) && !preflightLoading && !templateLoading && !busy && !submitting;
	const hasFailures = checks?.some(check => check.status === "fail") === true;

	const start = async (overrideFailures = false): Promise<void> => {
		if (template === null || templateLoading || validationErrors.length > 0 || preflightError !== null || preflightLoading || cwd === null || task.trim() === "" || checks === null || (!canStartOvernight(checks) && !overrideFailures)) return;
		if (overrideFailures && !window.confirm("The checks found issues. Start anyway?")) return;
		const requestTemplate: OvernightTemplate = {
			...template,
			prompt,
			policy: { ...template.policy, deadlineLocalTime, quiet },
		};
		setStartError(null);
		setSubmitting(true);
		try {
			await onStart(buildOvernightRequest(task, requestTemplate));
		} catch (error) {
			setStartError(errorText(error));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<section className="dk-overnight-setup" aria-label="Overnight run setup">
			<div className="dk-overnight-setup-title">
				<Moon size={17} aria-hidden="true" />
				<div><strong>Overnight run</strong><span>{cwd === null ? "Choose a workspace below" : shortenPath(cwd)}</span></div>
			</div>
			<label className="dk-overnight-field dk-overnight-task">
				<span>Task</span>
				<textarea value={task} onChange={event => setTask(event.currentTarget.value)} placeholder="What should omp work on?" rows={3} />
			</label>
			<div className="dk-overnight-options">
				<label className="dk-overnight-field">
					<span>End time</span>
					<input type="time" value={deadlineLocalTime} onChange={event => setDeadlineLocalTime(event.currentTarget.value)} />
				</label>
				<p className="dk-overnight-until">until {clockLabel(deadlineLocalTime)}</p>
				<label className="dk-overnight-field dk-overnight-quiet">
					<span>Quiet level</span>
					<select value={quiet} onChange={event => setQuiet(event.currentTarget.value as OvernightQuiet)}>
						<option value="normal">Normal — standard priority.</option>
						<option value="quiet">Quiet — lower priority; the system stays more responsive.</option>
						<option value="silent">Lowest priority — may run more slowly.</option>
					</select>
				</label>
			</div>
			<details className="dk-overnight-prompt">
				<summary>Edit instructions</summary>
				<label className="dk-overnight-field">
					<span>Instructions for this run</span>
					<textarea value={prompt} onChange={event => setPrompt(event.currentTarget.value)} rows={8} />
				</label>
			</details>
			<section className="dk-overnight-preflight" aria-label="Checks before you start">
				<div className="dk-overnight-section-head"><strong>Checks before you start</strong>{preflightLoading && <span role="status">Checking…</span>}</div>
				{cwd === null && <p className="dk-overnight-note">Choose a Project folder to check it before starting.</p>}
				{preflightError && <p className="dk-overnight-error" role="alert">Could not run checks: {preflightError}</p>}
				{checks && <ul>{checks.map(check => <CheckRow key={check.id} check={check} />)}</ul>}
			</section>
			{templateLoading && <p className="dk-overnight-note" role="status">Loading Overnight run settings…</p>}
			{templateError && <p className="dk-overnight-error" role="alert">Could not load Overnight run settings: {templateError}</p>}
			{validationErrors.map(error => <p className="dk-overnight-error" key={error} role="alert">{error}</p>)}
			{startError && <p className="dk-overnight-error" role="alert">{startError}</p>}
			<div className="dk-overnight-submit">
				<button type="button" className="sh-btn sh-btn-primary" disabled={!canRun || hasFailures || preflightError !== null} onClick={() => void start()}>
					{busy || submitting ? "Starting…" : startLabel}
				</button>
				{hasFailures && (
					<button type="button" className="sh-btn" disabled={!template || templateLoading || validationErrors.length > 0 || checks === null || preflightLoading || preflightError !== null || busy || submitting || task.trim() === ""} onClick={() => void start(true)}>
						Start anyway
					</button>
				)}
			</div>
		</section>
	);
}
