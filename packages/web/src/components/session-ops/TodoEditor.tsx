import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { ArrowDown, ArrowUp, Plus, Save } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { readTodoSnapshot, reduceTodoPhases, runSessionOp, sessionOpError, todoOperation, type EditableTodoPhase, type TodoEditorAction, type TodoTaskStatus } from "../../lib/session-ops";
import { OmpEquivalent } from "../catalog/OmpEquivalent";

const STATUSES: ReadonlyArray<{ value: TodoTaskStatus; label: string }> = [
	{ value: "pending", label: "Pending" },
	{ value: "in_progress", label: "In progress" },
	{ value: "completed", label: "Completed" },
	{ value: "abandoned", label: "Abandoned" },
	{ value: "blocked", label: "Blocked" },
];

export interface TodoEditorProps {
	api: DeckApi;
	sessionId: string | null;
	entries: readonly SessionEntry[];
}

export function TodoEditor({ api, sessionId, entries }: TodoEditorProps): ReactNode {
	const snapshot = useMemo(() => readTodoSnapshot(entries), [entries]);
	const initial = snapshot?.phases ?? [];
	const [phases, setPhases] = useState<EditableTodoPhase[]>(initial);
	const [saved, setSaved] = useState<EditableTodoPhase[]>(initial);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lastEntryId = useRef(snapshot?.entryId ?? null);

	useEffect(() => {
		if (snapshot?.entryId === lastEntryId.current) return;
		const next = snapshot?.phases ?? [];
		lastEntryId.current = snapshot?.entryId ?? null;
		setPhases(next);
		setSaved(next);
		setError(null);
	}, [snapshot]);

	const dirty = JSON.stringify(phases) !== JSON.stringify(saved);
	const hasBlankTask = phases.some(phase => phase.tasks.some(task => task.content.trim() === ""));
	const canSave = dirty && !hasBlankTask;
	const change = (action: TodoEditorAction): void => {
		if (saving) return;
		setPhases(current => reduceTodoPhases(current, action));
		setError(null);
	};

	const save = async (): Promise<void> => {
		if (!sessionId || saving || !canSave) return;
		const previous = saved;
		const optimistic = phases;
		setSaved(optimistic);
		setSaving(true);
		setError(null);
		try {
			await runSessionOp(api, sessionId, todoOperation(optimistic), { feature: "1.4.todos", action: "save", screen: "status" });
			setSaved(optimistic);
		} catch (cause) {
			setPhases(previous);
			setSaved(previous);
			setError(sessionOpError(cause));
		} finally {
			setSaving(false);
		}
	};

	const completed = phases.flatMap(phase => phase.tasks).filter(task => task.status === "completed").length;
	const total = phases.reduce((count, phase) => count + phase.tasks.length, 0);
	return (
		<section className="dk-status-section so-section" aria-label="todos editor">
			<h3 className="dk-section-title">Todos <span className="dk-section-meta">{completed}/{total} done</span></h3>
			{phases.length === 0 && <p className="dk-hint">No todo list yet. Add a phase to start one.</p>}
			{total > 0 && <div className="dk-progress" role="progressbar" aria-label="todo progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}><span style={{ width: `${(completed / total) * 100}%` }} /></div>}
			{phases.map((phase, phaseIndex) => (
				<div className="so-phase" key={`phase-${phaseIndex}`}>
					<div className="so-phase-heading">
						<label className="so-field"><span>Phase {phaseIndex + 1}</span><input value={phase.name} onChange={event => change({ type: "phase:rename", phase: phaseIndex, name: event.currentTarget.value })} disabled={saving || !sessionId} /></label>
						<div className="so-order-buttons">
							<button type="button" className="dk-tap" aria-label={`move phase ${phaseIndex + 1} up`} disabled={saving || !sessionId || phaseIndex === 0} onClick={() => change({ type: "phase:move", phase: phaseIndex, direction: -1 })}><ArrowUp size={14} /></button>
							<button type="button" className="dk-tap" aria-label={`move phase ${phaseIndex + 1} down`} disabled={saving || !sessionId || phaseIndex === phases.length - 1} onClick={() => change({ type: "phase:move", phase: phaseIndex, direction: 1 })}><ArrowDown size={14} /></button>
						</div>
					</div>
					{phase.tasks.map((task, taskIndex) => (
						<div className="so-task-row" key={`task-${taskIndex}`}>
							<input aria-label={`task ${taskIndex + 1} in phase ${phaseIndex + 1}`} value={task.content} onChange={event => change({ type: "task:edit", phase: phaseIndex, task: taskIndex, content: event.currentTarget.value })} disabled={saving || !sessionId} />
							<select aria-label={`status for task ${taskIndex + 1}`} value={task.status} onChange={event => {
								const status = STATUSES.find(item => item.value === event.currentTarget.value)?.value;
								if (status) change({ type: "task:status", phase: phaseIndex, task: taskIndex, status });
							}} disabled={saving || !sessionId}>
								{STATUSES.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}
							</select>
							<div className="so-order-buttons">
								<button type="button" className="dk-tap" aria-label={`move task ${taskIndex + 1} up`} disabled={saving || !sessionId || taskIndex === 0} onClick={() => change({ type: "task:move", phase: phaseIndex, task: taskIndex, direction: -1 })}><ArrowUp size={14} /></button>
								<button type="button" className="dk-tap" aria-label={`move task ${taskIndex + 1} down`} disabled={saving || !sessionId || taskIndex === phase.tasks.length - 1} onClick={() => change({ type: "task:move", phase: phaseIndex, task: taskIndex, direction: 1 })}><ArrowDown size={14} /></button>
							</div>
						</div>
					))}
					<button type="button" className="dk-wide-btn so-secondary" disabled={saving || !sessionId} onClick={() => change({ type: "task:add", phase: phaseIndex })}><Plus size={14} />Add task</button>
				</div>
			))}
			{dirty && hasBlankTask && <p className="dk-hint">Fill in each new task before saving.</p>}
			<div className="so-action-row">
				<button type="button" className="dk-wide-btn so-secondary" disabled={saving || !sessionId} onClick={() => change({ type: "phase:add" })}><Plus size={14} />Add phase</button>
				<button type="button" className="dk-wide-btn so-primary" disabled={saving || !sessionId || !canSave} onClick={() => void save()}><Save size={14} />{saving ? "Saving…" : "Save todos"}</button>
			</div>
			<OmpEquivalent text="set_todos" actionId="1.4.todos" />
			{error && <p className="so-error" role="alert">{error}</p>}
		</section>
	);
}
