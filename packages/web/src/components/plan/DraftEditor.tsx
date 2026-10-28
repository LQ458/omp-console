import type { AgentProfileDetail, DraftPlan } from "@omp-console/protocol";
import { LayoutGrid, Pencil, Play, Plus, Save, Square, TriangleAlert } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { DeckApi } from "../../lib/api";
import {
	type DraftIssue,
	draftReducer,
	draftToTaskCalls,
	EMPTY_DRAFT,
	fromDraftPlan,
	isRunActive,
	parseDraft,
	runNodeById,
	runSummary,
	serializeDraft,
	storageKeyFor,
	toDraftPlan,
	validateDraft,
} from "../../lib/draft";
import { browserStorage } from "../../lib/storage";
import { useNow } from "../agents/use-agent-graph";
import { openAgent } from "../agents/graph-events";
import { trackGraph } from "../agents/graph-usage";
import { OmpEquivalent } from "../agents/OmpEquivalent";
import { type DraftSelection, DraftCanvas } from "./DraftCanvas";
import { DraftPanel } from "./DraftPanel";
import { describeDraftError } from "./draft-errors";
import { useDraftRuns } from "./use-draft-runs";
import "./plan.css";

type View = "edit" | "run";

function loadDraft(sessionId: string) {
	const storage = browserStorage();
	try {
		return parseDraft(storage?.getItem(storageKeyFor(sessionId)) ?? null) ?? EMPTY_DRAFT;
	} catch {
		return EMPTY_DRAFT;
	}
}

function defaultProfile(profiles: readonly AgentProfileDetail[] | null): string {
	if (!profiles || profiles.length === 0) return "";
	return profiles.find(profile => profile.name === "task")?.name ?? profiles[0]!.name;
}

function isTyping(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/**
 * The draft graph tab (spec 4.5/4.6): draw tasks and "waits for" edges, run them through the daemon, watch the run,
 * save and load templates. The draft is kept in localStorage per session so closing the sheet loses nothing.
 */
export function DraftEditor(props: { api: DeckApi; sessionId: string; readOnly: boolean }): ReactNode {
	const { api, sessionId, readOnly } = props;
	const [draft, dispatch] = useReducer(draftReducer, sessionId, loadDraft);
	const [selection, setSelection] = useState<DraftSelection>(null);
	const [profiles, setProfiles] = useState<readonly AgentProfileDetail[] | null>(null);
	const [profilesError, setProfilesError] = useState<string | null>(null);
	const [templates, setTemplates] = useState<readonly DraftPlan[]>([]);
	const [pendingTemplate, setPendingTemplate] = useState<string>("");
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const [showIssues, setShowIssues] = useState(false);
	const [busy, setBusy] = useState(false);
	const [viewChoice, setViewChoice] = useState<View | null>(null);
	const runs = useDraftRuns(api, sessionId);
	const now = useNow(1000);
	const { run } = runs;
	const view: View = viewChoice ?? (run && isRunActive(run) ? "run" : "edit");
	const runView = view === "run" && run !== undefined;

	useEffect(() => {
		try {
			browserStorage()?.setItem(storageKeyFor(sessionId), serializeDraft(draft));
		} catch {
			// storage full or blocked: the draft just does not survive a reload
		}
	}, [draft, sessionId]);

	useEffect(() => {
		const controller = new AbortController();
		api.catalog(sessionId, controller.signal).then(
			catalog => {
				setProfiles(catalog.profiles);
				setProfilesError(null);
			},
			err => {
				if (!controller.signal.aborted) setProfilesError(describeDraftError(err));
			},
		);
		api.listPlanTemplates(controller.signal).then(
			list => setTemplates(list.templates),
			() => {},
		);
		return () => controller.abort();
	}, [api, sessionId]);

	const profileNames = useMemo(() => profiles?.map(profile => profile.name), [profiles]);
	const plan = useMemo(() => {
		const wire = toDraftPlan(draft);
		return { ...wire, name: wire.name || "Untitled draft" };
	}, [draft]);
	const issues: DraftIssue[] = useMemo(() => validateDraft(plan, profileNames), [plan, profileNames]);
	const flagged = useMemo(() => new Set(showIssues ? issues.flatMap(issue => issue.nodeIds) : []), [showIssues, issues]);
	const runNodes = useMemo(() => (run ? fromDraftPlan(run.plan).nodes : []), [run]);
	const shownNodes = runView ? runNodes : draft.nodes;
	const selectedNode = selection?.kind === "node" ? shownNodes.find(node => node.id === selection.id) : undefined;
	const active = isRunActive(run);
	const taskCalls = useMemo(() => JSON.stringify(draftToTaskCalls(plan)), [plan]);

	const note = (ok: boolean, text: string): void => setNotice({ ok, text });

	const addNode = (): void => {
		dispatch({ type: "add", profile: defaultProfile(profiles) });
		trackGraph("4.5.draft", "add-node", { sessionId });
	};

	const remove = useCallback((): void => {
		if (readOnly || runView || !selection) return;
		if (selection.kind === "node") dispatch({ type: "remove", id: selection.id });
		else dispatch({ type: "disconnect", from: selection.from, to: selection.to });
		trackGraph("4.5.draft", selection.kind === "node" ? "remove-node" : "remove-edge", { sessionId });
		setSelection(null);
	}, [readOnly, runView, selection, sessionId]);

	const start = useCallback(async (): Promise<void> => {
		if (readOnly || busy || runView) return;
		if (issues.length > 0) {
			setShowIssues(true);
			trackGraph("4.5.draft", "run-blocked", { outcome: "abandoned", detail: issues[0]!.kind, sessionId });
			return;
		}
		setBusy(true);
		setNotice(null);
		const began = Date.now();
		try {
			const started = await api.startDraftRun(sessionId, plan);
			runs.push(started);
			setViewChoice("run");
			setSelection(null);
			trackGraph("4.5.draft", "run", { detail: `${plan.nodes.length} nodes`, sessionId, latencyMs: Date.now() - began });
		} catch (err) {
			note(false, describeDraftError(err));
			trackGraph("4.5.draft", "run", { outcome: "error", sessionId, latencyMs: Date.now() - began });
		} finally {
			setBusy(false);
		}
	}, [readOnly, busy, runView, issues, api, sessionId, plan, runs]);

	const cancel = async (): Promise<void> => {
		if (!run || busy) return;
		setBusy(true);
		try {
			await api.cancelDraftRun(sessionId, run.runId);
			await runs.refresh();
			trackGraph("4.5.draft", "cancel", { sessionId });
		} catch (err) {
			note(false, describeDraftError(err));
			trackGraph("4.5.draft", "cancel", { outcome: "error", sessionId });
		} finally {
			setBusy(false);
		}
	};

	const saveTemplate = async (): Promise<void> => {
		if (draft.name.trim() === "") {
			note(false, "Name the draft first: the name is the template's name.");
			return;
		}
		try {
			await api.savePlanTemplate(plan);
			const list = await api.listPlanTemplates();
			setTemplates(list.templates);
			note(true, `Saved the template "${plan.name}".`);
			trackGraph("4.6.template", "save", { sessionId });
		} catch (err) {
			note(false, describeDraftError(err));
			trackGraph("4.6.template", "save", { outcome: "error", sessionId });
		}
	};

	const loadTemplate = (name: string): void => {
		const found = templates.find(template => template.name === name);
		if (!found) return;
		dispatch({ type: "load", plan: found });
		setSelection(null);
		setViewChoice("edit");
		setPendingTemplate("");
		setShowIssues(false);
		note(true, `Loaded "${name}". It is a copy: changes stay here until you save the template again.`);
		trackGraph("4.6.template", "load", { sessionId });
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void start();
			return;
		}
		if ((event.key === "Delete" || event.key === "Backspace") && !isTyping(event.target)) {
			event.preventDefault();
			remove();
		}
	};

	const issueRows = showIssues && !runView && issues.length > 0 ? issues : [];

	return (
		<div className="de" onKeyDown={onKeyDown}>
			<div className="de-bar">
				<input
					className="de-name"
					value={runView && run ? run.plan.name : draft.name}
					disabled={readOnly || runView}
					placeholder="Draft name (also the template name)"
					aria-label="draft name"
					onChange={event => dispatch({ type: "rename", name: event.target.value })}
				/>
				{runView ? (
					<>
						<button type="button" className="ag-btn" onClick={() => setViewChoice("edit")}>
							<Pencil size={13} aria-hidden /> Edit draft
						</button>
						{active ? (
							<button type="button" className="ag-btn ag-btn--danger" disabled={busy} onClick={() => void cancel()}>
								<Square size={12} aria-hidden /> Cancel run
							</button>
						) : null}
					</>
				) : (
					<>
						<button type="button" className="ag-btn" disabled={readOnly} onClick={addNode}>
							<Plus size={13} aria-hidden /> Add task
						</button>
						<button
							type="button"
							className="ag-btn"
							disabled={readOnly || draft.nodes.length < 2}
							title="Lay tasks out left to right by dependency"
							onClick={() => {
								dispatch({ type: "layout" });
								trackGraph("4.5.draft", "auto-layout", { sessionId });
							}}
						>
							<LayoutGrid size={13} aria-hidden /> Auto layout
						</button>
						<button
							type="button"
							className="ag-btn de-run"
							disabled={readOnly || busy}
							title="Run the draft (Cmd+Enter)"
							onClick={() => void start()}
						>
							<Play size={13} aria-hidden /> Run <kbd className="de-kbd">⌘↵</kbd>
						</button>
					</>
				)}
			</div>

			<div className="de-bar de-bar--sub">
				{!runView ? (
					<>
						<button type="button" className="ag-btn" disabled={readOnly} onClick={() => void saveTemplate()}>
							<Save size={13} aria-hidden /> Save as template
						</button>
						<select
							className="de-select"
							aria-label="load a template"
							value={pendingTemplate}
							disabled={templates.length === 0}
							onChange={event => {
								const name = event.target.value;
								if (draft.nodes.length === 0 && name !== "") loadTemplate(name);
								else setPendingTemplate(name);
							}}
						>
							<option value="">{templates.length === 0 ? "no templates yet" : "Load template…"}</option>
							{templates.map(template => (
								<option key={template.name} value={template.name}>
									{template.name} ({template.nodes.length})
								</option>
							))}
						</select>
						{pendingTemplate !== "" ? (
							<span className="de-confirm">
								Replace the current draft with "{pendingTemplate}"?
								<button type="button" className="ag-btn" onClick={() => loadTemplate(pendingTemplate)}>
									Load
								</button>
								<button type="button" className="ag-btn" onClick={() => setPendingTemplate("")}>
									Keep mine
								</button>
							</span>
						) : null}
					</>
				) : run ? (
					<>
						<span className={`de-runstate de-runstate--${run.state}`}>{run.state}</span>
						<span className="de-summary">{runSummary(run)}</span>
						{runs.runs.length > 1 ? (
							<select
								className="de-select"
								aria-label="choose a run"
								value={run.runId}
								onChange={event => runs.selectRun(event.target.value)}
							>
								{[...runs.runs]
									.sort((a, b) => b.startedAt - a.startedAt)
									.map(item => (
										<option key={item.runId} value={item.runId}>
											{item.plan.name} · {new Date(item.startedAt).toLocaleTimeString()} · {item.state}
										</option>
									))}
							</select>
						) : null}
					</>
				) : null}
				{runs.error !== null ? <span className="de-error">{runs.error}</span> : null}
			</div>

			{notice ? (
				<div className={notice.ok ? "ag-inline-note ag-inline-note--ok de-note" : "ag-inline-note ag-inline-note--err de-note"} role={notice.ok ? "status" : "alert"}>
					{notice.text}
				</div>
			) : null}
			{issueRows.length > 0 ? (
				<ul className="de-issues" aria-label="problems with the draft">
					{issueRows.map(issue => (
						<li key={`${issue.kind}:${issue.message}`}>
							<TriangleAlert size={12} aria-hidden /> {issue.message}
						</li>
					))}
				</ul>
			) : null}
			{!selectedNode && shownNodes.length > 0 ? (
				<div className="de-hint">
					{runView
						? "Tap a task to see its state and open the agent that ran it."
						: "Tap a task to edit it. Drag from its right dot to the task that must wait for it. Delete removes the selected task or line."}
				</div>
			) : null}
			<div className="de-body">
				<DraftCanvas
					nodes={shownNodes}
					selection={selection}
					flagged={flagged}
					run={runView ? run : undefined}
					now={now}
					onSelect={setSelection}
					onMove={(id, x, y) => dispatch({ type: "move", id, x, y })}
					onConnect={(from, to) => {
						dispatch({ type: "connect", from, to });
						trackGraph("4.5.draft", "connect", { sessionId });
					}}
					onOpenAgent={id => {
						trackGraph("4.5.draft", "open-agent", { sessionId });
						openAgent(id);
					}}
				/>
				{selectedNode ? (
					<aside className="de-side">
						<DraftPanel
							key={`${runView ? run?.runId : "draft"}:${selectedNode.id}`}
							node={selectedNode}
							allNodes={shownNodes}
							profiles={profiles}
							profilesError={profilesError}
							editable={!readOnly && !runView}
							runNode={runView ? runNodeById(run, selectedNode.id) : undefined}
							now={now}
							onUpdate={patch => dispatch({ type: "update", id: selectedNode.id, patch })}
							onSetDependency={(dep, on) => dispatch({ type: on ? "connect" : "disconnect", from: dep, to: selectedNode.id })}
							onRemove={remove}
							onOpenAgent={id => {
								trackGraph("4.5.draft", "open-agent", { sessionId });
								openAgent(id);
							}}
						/>
					</aside>
				) : null}
			</div>
			<OmpEquivalent text="no DAG in omp: one `task` tool call per node, started when its dependencies are done" copy={taskCalls} />
		</div>
	);
}

