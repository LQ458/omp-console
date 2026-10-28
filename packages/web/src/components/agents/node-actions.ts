/**
 * What the graph's context menu offers on an agent node and on a plan task node, with the omp equivalent of each
 * (spec 0.2: using the app teaches the TUI). Pure: the menu component runs the actions, this decides which exist.
 */
import type { AgentGraphStatus } from "../../lib/agent-graph";
import askProgressText from "./ask-progress.md" with { type: "text" };
import splitTaskTemplate from "./split-task.md" with { type: "text" };

export interface MenuItem {
	id: string;
	label: string;
	/** The omp command, tool call or syntax that does the same. */
	equivalent: string;
	enabled: boolean;
	/** Why a disabled item is disabled. */
	reason?: string;
	danger?: boolean;
}

export interface MenuCaps {
	/** View-link guest: the host rejects control frames. */
	readOnly: boolean;
	/** The daemon knows this session (model change, spawn dialog and draft runs need it). */
	hasSession: boolean;
}

export interface AgentMenuTarget {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	status: AgentGraphStatus;
	hasSessionFile: boolean;
}

const VIEW_ONLY = "this is a view-only link";

/** The fixed question "Ask about progress" sends. */
export const ASK_PROGRESS_MESSAGE = askProgressText.trim();

/** Steer text for "Split into subtasks": the template with the task filled in. */
export function splitTaskMessage(task: string): string {
	return splitTaskTemplate.trim().replace("{{task}}", task.replace(/\s+/g, " ").trim());
}

export function agentMenuItems(target: AgentMenuTarget, caps: MenuCaps): MenuItem[] {
	const live = target.status === "running";
	const gone = target.status === "parked" || target.status === "aborted";
	const hub = `/hub, select ${target.displayName}`;
	const control = (enabled: boolean, reason: string): Pick<MenuItem, "enabled" | "reason"> =>
		caps.readOnly ? { enabled: false, reason: VIEW_ONLY } : enabled ? { enabled: true } : { enabled: false, reason };
	const items: MenuItem[] = [
		{ id: "message", label: "Message", equivalent: `${hub}, then type`, ...control(live || target.kind === "main", "The agent is not running. Start it first.") },
		{ id: "ask", label: "Ask about progress", equivalent: `${hub}, then type "what is your progress?"`, ...control(live || target.kind === "main", "The agent is not running. Start it first.") },
		{
			id: "model",
			label: "Change model",
			equivalent: "/agents (per-agent model)",
			...control(caps.hasSession && (live || target.kind === "main"), caps.hasSession ? "The agent is not running. Start it first." : "Open a session first"),
		},
	];
	if (target.kind === "sub") {
		items.push(
			{ id: "kill", label: "Kill", equivalent: `${hub}, then x`, danger: true, ...control(live, "the agent is not running") },
			{ id: "revive", label: "Revive", equivalent: `${hub}, then r`, ...control(gone, "only a parked or aborted agent can be revived") },
		);
	}
	items.push({
		id: "transcript",
		label: "Open transcript",
		equivalent: `${hub}, then open`,
		...(target.hasSessionFile ? { enabled: true } : { enabled: false, reason: "no transcript file for this agent" }),
	});
	return items;
}

export interface TaskMenuTarget {
	content: string;
	/** Inferred running agent for the task. */
	agentName?: string;
}

export function taskMenuItems(target: TaskMenuTarget, caps: MenuCaps): MenuItem[] {
	const control = (enabled: boolean, reason: string): Pick<MenuItem, "enabled" | "reason"> =>
		caps.readOnly ? { enabled: false, reason: VIEW_ONLY } : enabled ? { enabled: true } : { enabled: false, reason };
	const items: MenuItem[] = [
		{
			id: "do-now",
			label: "Do this now",
			equivalent: "task tool: agent=<profile>, task=<this task>",
			...control(caps.hasSession, "Open a session first"),
		},
		{
			id: "split",
			label: "Split into subtasks",
			equivalent: "ask the main agent, or /todo append <phase> <task> per subtask",
			...control(true, ""),
		},
		{
			id: "assign",
			label: "Assign to agent profile…",
			equivalent: "task tool: agent=<profile>",
			...control(caps.hasSession, "Open a session first"),
		},
	];
	if (target.agentName !== undefined) {
		items.push({ id: "open-agent", label: `Open ${target.agentName}`, equivalent: "/hub, select the agent", enabled: true });
	}
	return items;
}
