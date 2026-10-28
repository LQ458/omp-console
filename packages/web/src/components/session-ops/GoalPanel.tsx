import type { SessionSummary } from "@omp-console/protocol";
import { Pause, Play, Target, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { DeckApi } from "../../lib/api";
import { readGoalProgress, runSessionOp, sessionOpError, type GoalProgress } from "../../lib/session-ops";
import { OmpEquivalent } from "../catalog/OmpEquivalent";

export interface GoalPanelProps {
	api: DeckApi;
	sessionId: string | null;
	summary?: SessionSummary;
	entries: readonly SessionEntry[];
}

export function GoalPanel({ api, sessionId, summary, entries }: GoalPanelProps): ReactNode {
	const sourceGoal = useMemo(() => readGoalProgress(entries, summary), [entries, summary]);
	const [localGoal, setLocalGoal] = useState<GoalProgress | null>(null);
	const [objective, setObjective] = useState("");
	const [tokenBudget, setTokenBudget] = useState("");
	const [budgetEdit, setBudgetEdit] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const goal = localGoal ?? sourceGoal;

	useEffect(() => {
		setLocalGoal(null);
		setObjective("");
		setTokenBudget("");
		setError(null);
	}, [sessionId]);
	useEffect(() => setBudgetEdit(goal?.tokenBudget == null ? "" : String(goal.tokenBudget)), [goal?.tokenBudget]);

	const run = async (action: "set" | "pause" | "resume" | "drop" | "budget", op: Parameters<typeof runSessionOp>[2], next?: GoalProgress): Promise<boolean> => {
		if (!sessionId || busy) return false;
		setBusy(true);
		setError(null);
		try {
			await runSessionOp(api, sessionId, op, { feature: "1.5.goal", action, screen: "status" });
			if (next) setLocalGoal(next);
			return true;
		} catch (cause) {
			setError(sessionOpError(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const saveGoal = async (): Promise<void> => {
		const cleanObjective = objective.trim();
		const budget = tokenBudget.trim() === "" ? undefined : Number(tokenBudget);
		if (!sessionId || cleanObjective === "" || (budget !== undefined && (!Number.isInteger(budget) || budget < 1))) return;
		const saved = await run("set", { op: "goal", action: "set", objective: cleanObjective, ...(budget === undefined ? {} : { tokenBudget: budget }) }, {
			objective: cleanObjective,
			status: "active",
			active: true,
			tokensUsed: 0,
			tokenBudget: budget ?? null,
		});
		if (saved) {
			setObjective("");
			setTokenBudget("");
		}
	};

	const changeStatus = (action: "pause" | "resume" | "drop"): void => {
		if (!goal) return;
		const status = action === "pause" ? "paused" : action === "resume" ? "active" : "dropped";
		void run(action, { op: "goal", action }, { ...goal, status, active: action === "resume" });
	};

	const changeBudget = (): void => {
		const budget = Number(budgetEdit);
		if (!goal || !Number.isInteger(budget) || budget < 1) return;
		void run("budget", { op: "goal", action: "budget", tokenBudget: budget }, { ...goal, tokenBudget: budget });
	};

	const progress = goal?.tokenBudget && goal.tokensUsed !== null ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100) : null;
	return (
		<section className="dk-status-section so-section" aria-label="goal controls">
			<h3 className="dk-section-title"><Target size={15} />Goal</h3>
			{goal && (goal.active || goal.objective !== "") ? (
				<div className="dk-goal-card" data-status={goal.status || "active"}>
					<Target size={16} />
					<div className="dk-goal-copy">
						<div className="dk-goal-objective">{goal.objective || "Goal active"}</div>
						<div className="dk-goal-status">{goal.status || "active"}</div>
						{progress !== null && (
						<>
							<div className="so-progress-label">{goal.tokensUsed?.toLocaleString()} / {goal.tokenBudget?.toLocaleString()} tokens</div>
							<div className="dk-progress" role="progressbar" aria-label="goal token budget" aria-valuemin={0} aria-valuemax={goal.tokenBudget ?? 0} aria-valuenow={goal.tokensUsed ?? 0}>
								<span style={{ width: `${progress}%` }} />
							</div>
						</>
						)}
					</div>
				</div>
			) : <p className="dk-hint">{sessionId ? "No goal set." : "Open a session to set a goal."}</p>}
			{sessionId && (
				<>
					<div className="so-goal-form">
						<label className="so-field"><span>Objective</span><input value={objective} onChange={event => setObjective(event.currentTarget.value)} maxLength={500} /></label>
						<label className="so-field"><span>Token budget (optional)</span><input type="number" min="1" step="1" value={tokenBudget} onChange={event => setTokenBudget(event.currentTarget.value)} /></label>
						<button type="button" className="dk-wide-btn so-primary" disabled={busy || objective.trim() === "" || (tokenBudget.trim() !== "" && (!Number.isInteger(Number(tokenBudget)) || Number(tokenBudget) < 1))} onClick={saveGoal}>
							{goal?.objective ? "Update goal" : "Set goal"}
						</button>
					</div>
					<OmpEquivalent text="goal tool" hint="set · pause · resume · drop · budget" actionId="1.5.goal" />
					{goal && (
						<div className="so-action-row">
							{goal.active ? (
								<button type="button" className="dk-wide-btn" disabled={busy} onClick={() => changeStatus("pause")}><Pause size={14} />Pause</button>
							) : goal.status === "paused" && (
								<button type="button" className="dk-wide-btn" disabled={busy} onClick={() => changeStatus("resume")}><Play size={14} />Resume</button>
							)}
							{(goal.active || goal.status === "paused") && <label className="so-field so-budget-edit"><span>New token budget</span><input type="number" min="1" step="1" value={budgetEdit} onChange={event => setBudgetEdit(event.currentTarget.value)} /></label>}
							{(goal.active || goal.status === "paused") && <button type="button" className="dk-wide-btn" disabled={busy || !Number.isInteger(Number(budgetEdit)) || Number(budgetEdit) < 1} onClick={changeBudget}>Update budget</button>}
							{goal.status !== "dropped" && <button type="button" className="dk-wide-btn so-danger" disabled={busy} onClick={() => changeStatus("drop")}><Trash2 size={14} />Drop goal</button>}
						</div>
					)}
				</>
				)}
			{error && <p className="so-error" role="alert">{error}</p>}
		</section>
	);
}
