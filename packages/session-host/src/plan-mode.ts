/**
 * Plan mode for a session without a TUI (`session-op` plan-mode). omp keeps plan mode state on the session
 * (`getPlanModeState`/`setPlanModeState`) and owns the entry/exit choreography in `InteractiveMode`; its ACP agent
 * (`modes/acp/acp-agent.ts`, `#applyModeChange`) is the headless precedent this follows:
 *
 *  - entering sets the plan state with the plan file, registers the plan-proposal handler that consumes the agent's
 *    `write` to `xd://propose`, injects the plan-mode context when a turn is streaming, and journals the mode change;
 *  - the proposal handler validates the plan file with omp's own `resolveApprovedPlan` and approves it immediately:
 *    a submitted plan leaves plan mode, autosaves like the TUI, and the agent proceeds; the plan stays in the transcript
 *    and its file for reading afterwards;
 *  - leaving clears the state and the handler and journals `none`.
 *
 * Not done here (the TUI does it, ACP does not): switching to the `plan` model role on entry.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { type PlanApprovalDetails, resolveApprovedPlan } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { autosaveApprovedPlan } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave";
import { resolvePlanFilePath } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { RequestError } from "./request-error";

const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";

interface ResolvedPlan {
	planFilePath: string;
	planContent: string;
	title: string;
}

/** The goal controls plan mode needs: an active goal (often the agent's own) waits while the agent plans. */
interface PlanGoals {
	handle(command: { op: "pause" | "resume" }): Promise<unknown>;
	settled(): Promise<void>;
}

export class PlanModeController {
	readonly #session: AgentSession;
	readonly #goals: PlanGoals | undefined;
	/** Plan mode paused an active goal; approving the plan or leaving plan mode resumes it. */
	#resumeGoal = false;

	constructor(session: AgentSession, goals?: PlanGoals) {
		this.#session = session;
		this.#goals = goals;
	}

	get enabled(): boolean {
		return this.#session.getPlanModeState()?.enabled === true;
	}

	async set(enabled: boolean): Promise<void> {
		if (enabled) await this.#enter();
		else await this.#exit();
	}

	async #enter(): Promise<void> {
		const session = this.#session;
		if (this.enabled) return;
		if (!cfgPlanEnabled.get(session.settings)) throw new RequestError("bad-request", "plan mode is disabled (setting plan.enabled)");
		const goal = session.getGoalModeState();
		if (goal?.enabled === true && goal.goal.status === "active") {
			if (!this.#goals) throw new RequestError("conflict", "exit goal mode first: drop the goal before entering plan mode");
			await this.#goals.handle({ op: "pause" });
			await this.#goals.settled();
			this.#resumeGoal = true;
		}
		const previous = session.getPlanModeState();
		const planFilePath = previous?.planFilePath ?? (session.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL);
		session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: previous?.workflow ?? "parallel",
			reentry: previous !== undefined,
		});
		session.setPlanProposalHandler?.(title => this.#proposal(title));
		if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
		session.sessionManager.appendModeChange("plan", { planFilePath });
	}

	async #exit(): Promise<void> {
		const session = this.#session;
		if (!this.enabled) return;
		// A mid-turn exit must not leave the live turn planning against the old tool policy.
		if (session.isStreaming) {
			await session.runModeExitTeardown(async () => {
				await session.abort({ reason: "plan mode exited" });
				this.#teardown();
			});
		} else {
			this.#teardown();
		}
		await this.#resumePausedGoal();
	}

	#teardown(): void {
		const session = this.#session;
		session.setPlanProposalHandler?.(null);
		session.setPlanModeState(undefined);
		session.sessionManager.appendModeChange("none");
	}

	async #resumePausedGoal(): Promise<void> {
		if (!this.#resumeGoal || !this.#goals) return;
		this.#resumeGoal = false;
		try {
			await this.#goals.handle({ op: "resume" });
		} catch (error) {
			logger.warn("Failed to resume the goal paused for plan mode", { error: String(error) });
		}
	}

	#resolvePath(planFilePath: string): string {
		const manager = this.#session.sessionManager;
		return resolvePlanFilePath(planFilePath, {
			localProtocolOptions: { getArtifactsDir: () => manager.getArtifactsDir(), getSessionId: () => manager.getSessionId() },
			cwd: manager.getCwd(),
		});
	}

	async #readPlan(planFilePath: string): Promise<string | null> {
		try {
			return await Bun.file(this.#resolvePath(planFilePath)).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async #listLocalPlans(): Promise<string[]> {
		const root = this.#resolvePath("local://");
		try {
			const entries = await fs.readdir(root, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async entry => ({
						url: `local://${entry.name}`,
						mtime: (await fs.stat(path.join(root, entry.name)).catch(() => null))?.mtimeMs ?? 0,
					})),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	}

	/** The agent submitted a plan (`xd://propose`): approve it at once; the agent never waits for a review. */
	async #proposal(title: string): Promise<AgentToolResult<unknown>> {
		const session = this.#session;
		const state = session.getPlanModeState();
		if (!state?.enabled) throw new ToolError("Plan mode is not active.");
		const resolved = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => this.#readPlan(url),
			listPlanFiles: () => this.#listLocalPlans(),
		});
		return this.#approve({ planFilePath: resolved.planFilePath, planContent: resolved.planContent, title: resolved.title });
	}

	async #approve(plan: ResolvedPlan): Promise<AgentToolResult<unknown>> {
		const autosaveFailed = await this.#savePlan(plan);
		await this.#resumePausedGoal();
		const details: PlanApprovalDetails = { planFilePath: plan.planFilePath, title: plan.title, planExists: true };
		return {
			content: [
				{
					type: "text",
					text: `Plan approved at ${plan.planFilePath}. Plan mode exited; proceed with the implementation.${autosaveFailed ? " (Plan autosave failed; continuing.)" : ""}`,
				},
			],
			details,
		};
	}

	async #savePlan(plan: ResolvedPlan): Promise<boolean> {
		this.#session.setPlanReferencePath(plan.planFilePath);
		this.#teardown();
		try {
			await autosaveApprovedPlan({
				settings: this.#session.settings,
				cwd: this.#session.sessionManager.getCwd(),
				title: plan.title,
				planContent: plan.planContent,
				force: true,
			});
			return false;
		} catch (error) {
			logger.warn("Failed to autosave plan", { error: String(error) });
			return true;
		}
	}
}
