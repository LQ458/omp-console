import type { AgentProfileDetail, CatalogResponse, SpawnEstimate } from "@omp-console/protocol";
import { Plus, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeControlError } from "../../lib/agent-api";
import type { DeckApi } from "../../lib/api";
import { recordUsage } from "../../lib/journal";
import { modelSummary, toolsSummary } from "../../lib/profiles";
import { SpawnEstimateBadge } from "../quota/QuotaBadges";
import {
	emptyRow,
	MAX_BATCH_ROWS,
	OPEN_AGENT_EVENT,
	OPEN_PANEL_EVENT,
	openAgent,
	parseOpenAgentEvent,
	parseSpawnPanelEvent,
	type RowStatus,
	type RowValidation,
	runSpawn,
	type SpawnPanelDetail,
	type SpawnRow,
	taskEquivalent,
	validateRows,
	withPath,
} from "../../lib/spawn";
import { Sheet } from "../shell/Sheet";
import { OmpLine, OverlayLayer } from "./OmpLine";
import "./spawn.css";

/** Calls `onOpen` with the agent id of every `omp-console:open-agent` event, so the app can select that agent's drawer. */
export function useOpenAgentEvent(onOpen: (agentId: string) => void): void {
	useEffect(() => {
		const handler = (event: Event): void => {
			const id = parseOpenAgentEvent(event);
			if (id !== null) onOpen(id);
		};
		window.addEventListener(OPEN_AGENT_EVENT, handler);
		return () => window.removeEventListener(OPEN_AGENT_EVENT, handler);
	}, [onOpen]);
}

/** Mounted once per open session: opens the spawn dialog on `omp-console:open-panel` with `{panel: "spawn"}`. */
export function SpawnHost({ api, sessionId, readOnly }: { api: DeckApi; sessionId: string | undefined; readOnly: boolean }): ReactNode {
	const [preset, setPreset] = useState<SpawnPanelDetail | null>(null);
	useEffect(() => {
		const handler = (event: Event): void => {
			const detail = parseSpawnPanelEvent(event);
			if (detail !== null && sessionId !== undefined && !readOnly) {
				event.preventDefault();
				setPreset(detail);
			}
		};
		window.addEventListener(OPEN_PANEL_EVENT, handler);
		return () => window.removeEventListener(OPEN_PANEL_EVENT, handler);
	}, [sessionId, readOnly]);
	const close = useCallback(() => setPreset(null), []);
	if (preset === null || sessionId === undefined) return null;
	return (
		<OverlayLayer>
			<SpawnDialog api={api} sessionId={sessionId} preset={preset} onClose={close} />
		</OverlayLayer>
	);
}

type CatalogState =
	| { state: "loading" }
	| { state: "ready"; profiles: readonly AgentProfileDetail[] }
	| { state: "error"; message: string };

export interface SpawnDialogProps {
	api: DeckApi;
	sessionId: string;
	preset?: Omit<SpawnPanelDetail, "panel"> | null;
	onClose(): void;
}

export function SpawnDialog({ api, sessionId, preset = null, onClose }: SpawnDialogProps): ReactNode {
	const [catalog, setCatalog] = useState<CatalogState>({ state: "loading" });
	const [mode, setMode] = useState<"single" | "batch">("single");
	const [rows, setRows] = useState<SpawnRow[]>(() => {
		const row = emptyRow(preset?.profile ?? "");
		row.task = preset?.task ?? "";
		row.files = [...(preset?.files ?? [])];
		return [row];
	});
	const [statuses, setStatuses] = useState<ReadonlyMap<string, RowStatus>>(new Map());
	const [showErrors, setShowErrors] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const mounted = useRef(true);
	const startedAny = useRef(false);
	const dialogRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		setCatalog({ state: "loading" });
		try {
			const response: CatalogResponse = await api.catalog(sessionId);
			if (!mounted.current) return;
			setCatalog({ state: "ready", profiles: response.profiles });
			// Preselect omp's default profile when nothing was asked for.
			setRows(current =>
				current.map(row =>
					row.profile === "" && response.profiles.some(p => p.name === "task") ? { ...row, profile: "task" } : row,
				),
			);
		} catch (err) {
			if (mounted.current) setCatalog({ state: "error", message: describeControlError(err, "load") });
		}
	}, [api, sessionId]);

	useEffect(() => {
		void load();
		recordUsage({ feature: "2.5.spawn", action: "open-dialog", outcome: "ok", via: preset?.profile ? "catalog" : "direct", screen: "spawn", sessionId });
	}, [load, preset?.profile, sessionId]);

	const activeRows = mode === "single" ? rows.slice(0, 1) : rows;
	const profiles = catalog.state === "ready" ? catalog.profiles : [];
	const known = useMemo(() => new Set(profiles.map(p => p.name)), [profiles]);
	const problems = useMemo(() => validateRows(activeRows, known), [activeRows, known]);

	const close = useCallback(() => {
		if (submitting) return;
		if (!startedAny.current && rows.some(r => r.task.trim() !== "")) {
			recordUsage({ feature: "2.5.spawn", action: "spawn", outcome: "abandoned", screen: "spawn", sessionId });
		}
		onClose();
	}, [submitting, rows, onClose, sessionId]);

	// Capture phase: an in-pane dialog remains modal, but a windowed one only owns Escape from inside itself.
	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			const sheet = dialogRef.current?.closest(".dk-sheet");
			const windowed = sheet?.getAttribute("data-display-mode") !== "in-pane";
			const targetInside = sheet !== null && sheet !== undefined && event.target instanceof Node && sheet.contains(event.target);
			if (windowed && !targetInside) return;
			event.stopPropagation();
			close();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [close]);

	const patchRow = (key: string, patch: Partial<SpawnRow>): void =>
		setRows(current => current.map(row => (row.key === key ? { ...row, ...patch } : row)));

	const setBatch = (batch: boolean): void => {
		setMode(batch ? "batch" : "single");
		if (batch) setRows(current => (current.length < 2 ? [...current, emptyRow(current[0]?.profile ?? "")] : current));
	};

	const submit = async (): Promise<void> => {
		setShowErrors(true);
		if (submitting || problems.size > 0 || activeRows.length === 0) return;
		setSubmitting(true);
		const result = await runSpawn(
			{
				api,
				sessionId,
				record: recordUsage,
				onStatus: (key, status) => {
					if (mounted.current) setStatuses(current => new Map(current).set(key, status));
				},
			},
			activeRows,
			statuses,
			preset?.profile ? "catalog" : "direct",
		);
		if (result.agentIds.length > 0) startedAny.current = true;
		if (!mounted.current) return;
		setSubmitting(false);
		if (result.failed === 0) {
			onClose();
			const first = result.agentIds[0];
			if (first !== undefined) openAgent(first);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void submit();
		}
	};

	const failed = activeRows.filter(row => statuses.get(row.key)?.state === "error").length;
	const doneCount = activeRows.filter(row => statuses.get(row.key)?.state === "done").length;
	const label = submitting
		? "Starting…"
		: failed > 0
			? `Retry ${failed} failed`
			: activeRows.length > 1
				? `Start ${activeRows.length} agents`
				: "Start agent";

	return (
		<Sheet title={mode === "batch" ? "Start agents" : "Start agent"} windowKind="spawn" onClose={close}>
			<div className="sp-dialog" ref={dialogRef} onKeyDown={onKeyDown}>
				<p className="sp-lead">
					Start an agent with the selected agent profile and task. The main agent gets the result in this session.
				</p>

				<div className="sp-seg" role="radiogroup" aria-label="how many agents">
					<button type="button" role="radio" aria-checked={mode === "single"} data-on={mode === "single"} className="sp-seg-btn" disabled={submitting} onClick={() => setBatch(false)}>
						One agent
					</button>
					<button type="button" role="radio" aria-checked={mode === "batch"} data-on={mode === "batch"} className="sp-seg-btn" disabled={submitting} onClick={() => setBatch(true)}>
						Several agents
					</button>
				</div>

				{catalog.state === "loading" ? <p className="sp-hint">Loading agent profiles…</p> : null}
				{catalog.state === "error" ? (
					<div className="sp-msg sp-msg-err" role="alert">
						{catalog.message}
						<button type="button" className="sp-btn" onClick={() => void load()}>
							Retry
						</button>
					</div>
				) : null}

				{catalog.state === "ready" && profiles.length === 0 ? (
					<div className="sp-msg sp-msg-err" role="alert">
						No agent profiles are available for this session.
					</div>
				) : null}

				{catalog.state === "ready" && profiles.length > 0
					? activeRows.map((row, index) => (
							<RowFields
								key={row.key}
								index={index}
								row={row}
								api={api}
								profiles={profiles}
								compact={mode === "batch"}
								errors={showErrors ? problems.get(row.key) : undefined}
								status={statuses.get(row.key)}
								disabled={submitting}
								onChange={patch => patchRow(row.key, patch)}
								onRemove={mode === "batch" && rows.length > 1 ? () => setRows(current => current.filter(r => r.key !== row.key)) : undefined}
							/>
						))
					: null}

				{mode === "batch" && catalog.state === "ready" ? (
					<button
						type="button"
						className="sp-btn sp-add"
						disabled={submitting || rows.length >= MAX_BATCH_ROWS}
						onClick={() => setRows(current => [...current, emptyRow(current[current.length - 1]?.profile ?? "")])}
					>
						<Plus size={14} aria-hidden /> Add agent{rows.length >= MAX_BATCH_ROWS ? ` (max ${MAX_BATCH_ROWS})` : ""}
					</button>
				) : null}

				<OmpLine
					text={taskEquivalent(activeRows)}
					onCopy={() => recordUsage({ feature: "0.2.equivalent", action: "copy-task", outcome: "ok", via: "direct", screen: "spawn", sessionId })}
				/>
				<p className="sp-hint">
					{activeRows.length > 1
						? "Several agents are sent one after another, in this order."
						: "Press Cmd/Ctrl+Enter to start from the task box."}
					{doneCount > 0 && failed > 0 ? ` ${doneCount} already started and will not start again.` : ""}
				</p>

				<div className="sp-actions">
					<button
						type="button"
						className="sp-btn sp-btn-primary"
						disabled={submitting || catalog.state !== "ready" || profiles.length === 0}
						onClick={() => void submit()}
					>
						{label}
					</button>
					<button type="button" className="sp-btn" disabled={submitting} onClick={close}>
						{doneCount > 0 && failed > 0 ? "Close" : "Cancel"}
					</button>
				</div>
			</div>
		</Sheet>
	);
}

interface RowFieldsProps {
	index: number;
	row: SpawnRow;
	api: DeckApi;
	profiles: readonly AgentProfileDetail[];
	compact: boolean;
	errors: RowValidation | undefined;
	status: RowStatus | undefined;
	disabled: boolean;
	onChange(patch: Partial<SpawnRow>): void;
	onRemove?(): void;
}

/** "≈ N tokens · ~X % of <window>" for the chosen profile and its model; hidden until the daemon has enough samples. */
function ProfileEstimate({ api, profile, model }: { api: DeckApi; profile: string; model: string | undefined }): ReactNode {
	const [estimate, setEstimate] = useState<SpawnEstimate | null>(null);
	useEffect(() => {
		setEstimate(null);
		if (profile === "" || !model) return;
		const controller = new AbortController();
		api.spawnEstimate(profile, model, controller.signal).then(setEstimate, () => setEstimate(null));
		return () => controller.abort();
	}, [api, profile, model]);
	return <SpawnEstimateBadge estimate={estimate} />;
}

function RowFields({ index, row, api, profiles, compact, errors, status, disabled, onChange, onRemove }: RowFieldsProps): ReactNode {
	const [fileDraft, setFileDraft] = useState("");
	const [fileError, setFileError] = useState<string | null>(null);
	const locked = disabled || status?.state === "done";
	const selected = profiles.find(p => p.name === row.profile);

	const addFile = (): void => {
		if (fileDraft.trim() === "") return;
		const result = withPath(row.files, fileDraft);
		setFileError(result.error);
		if (result.error === null) {
			onChange({ files: result.files });
			setFileDraft("");
		}
	};

	const idBase = `sp-${row.key}`;
	return (
		<div className="sp-row" data-compact={compact ? "true" : "false"} data-status={status?.state ?? "idle"}>
			<fieldset className="sp-fields" disabled={locked}>
			{compact ? (
				<legend className="sp-legend">
					Agent {index + 1}
					{status?.state === "done" ? <span className="sp-state sp-state-ok">started</span> : null}
					{status?.state === "spawning" ? <span className="sp-state">starting…</span> : null}
				</legend>
			) : null}

			{compact ? (
				<label className="sp-field">
					<span className="sp-label">Agent profile</span>
					<select
						className="sp-input"
						value={row.profile}
						aria-invalid={errors?.profile ? "true" : undefined}
						onChange={event => onChange({ profile: event.target.value })}
					>
						<option value="">Pick an agent profile…</option>
						{profiles.map(p => (
							<option key={p.name} value={p.name}>
								{p.name} · {p.source}
							</option>
						))}
					</select>
					{selected ? <span className="sp-sub">{modelSummary(selected)} · {toolsSummary(selected.tools)}</span> : null}
				</label>
			) : (
				<div className="sp-field" role="radiogroup" aria-label="agent profile">
					<span className="sp-label">Agent profile</span>
					<div className="sp-profiles">
						{profiles.map(p => (
							<button
								key={p.name}
								type="button"
								role="radio"
								aria-checked={row.profile === p.name}
								className="sp-profile"
								data-on={row.profile === p.name ? "true" : "false"}
								onClick={() => onChange({ profile: p.name })}
							>
								<span className="sp-profile-head">
									<span className="sp-profile-name">{p.name}</span>
									<span className="sp-chip">{p.source}</span>
								</span>
								{p.description ? <span className="sp-profile-desc">{p.description}</span> : null}
								<span className="sp-profile-meta">
									{modelSummary(p)} · {toolsSummary(p.tools)}
								</span>
							</button>
						))}
					</div>
				</div>
			)}
			{errors?.profile ? <FieldError id={`${idBase}-profile`} text={errors.profile} /> : null}
			<ProfileEstimate api={api} profile={row.profile} model={selected?.effectiveModel} />

			<label className="sp-field">
				<span className="sp-label">Task</span>
				<textarea
					className="sp-input sp-task"
					rows={compact ? 3 : 5}
					value={row.task}
					placeholder="What should this agent do? Be specific about the result you want."
					aria-invalid={errors?.task ? "true" : undefined}
					aria-describedby={errors?.task ? `${idBase}-task` : undefined}
					onChange={event => onChange({ task: event.target.value })}
				/>
			</label>
			{errors?.task ? <FieldError id={`${idBase}-task`} text={errors.task} /> : null}

			<details className="sp-more" open={!compact}>
				<summary>Name, files, isolation</summary>
				<label className="sp-field">
					<span className="sp-label">Name (optional)</span>
					<input
						className="sp-input"
						value={row.name}
						placeholder="omp picks one"
						aria-invalid={errors?.name ? "true" : undefined}
						autoCapitalize="off"
						autoComplete="off"
						spellCheck={false}
						onChange={event => onChange({ name: event.target.value })}
					/>
				</label>
				{errors?.name ? <FieldError id={`${idBase}-name`} text={errors.name} /> : null}

				<div className="sp-field">
					<span className="sp-label">Files (handed over as @path mentions)</span>
					<div className="sp-file-add">
						<input
							className="sp-input"
							value={fileDraft}
							placeholder="src/lib/api.ts"
							aria-label="file path to add"
							autoCapitalize="off"
							autoComplete="off"
							spellCheck={false}
							onChange={event => {
								setFileDraft(event.target.value);
								setFileError(null);
							}}
							onKeyDown={event => {
								if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
									event.preventDefault();
									event.stopPropagation();
									addFile();
								}
							}}
						/>
						<button type="button" className="sp-btn" onClick={addFile}>
							Add
						</button>
					</div>
					{fileError ? <FieldError id={`${idBase}-file`} text={fileError} /> : null}
					{row.files.length > 0 ? (
						<ul className="sp-files" aria-label="files">
							{row.files.map(file => (
								<li key={file} className="sp-file">
									<code>{file}</code>
									<button type="button" className="sp-x" aria-label={`remove ${file}`} onClick={() => onChange({ files: row.files.filter(f => f !== file) })}>
										<X size={14} aria-hidden />
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>

				<label className="sp-check">
					<input type="checkbox" checked={row.isolated} onChange={event => onChange({ isolated: event.target.checked })} />
					<span>
						<span className="sp-check-title">Run in an isolated worktree</span>
						<span className="sp-sub">
							The agent works in its own git worktree, so its edits do not touch your working tree until omp merges them
							back. Used only when your omp settings allow isolation; otherwise the daemon refuses the spawn.
						</span>
					</span>
				</label>
			</details>
			</fieldset>

			{status?.state === "error" ? (
				<div className="sp-msg sp-msg-err" role="alert">
					{status.message}
				</div>
			) : null}
			{status?.state === "done" ? (
				<div className="sp-msg sp-msg-ok" role="status">
					Started as {status.agentId}.{" "}
					<button type="button" className="sp-link" onClick={() => openAgent(status.agentId)}>
						Open
					</button>
				</div>
			) : null}
			{onRemove ? (
				<button type="button" className="sp-btn sp-remove" disabled={disabled} onClick={onRemove}>
					Remove agent {index + 1}
				</button>
			) : null}
		</div>
	);
}

function FieldError({ id, text }: { id: string; text: string }): ReactNode {
	return (
		<div id={id} className="sp-field-err" role="alert">
			{text}
		</div>
	);
}
