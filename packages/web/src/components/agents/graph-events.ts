/**
 * Window events other panels listen for. `omp-console:open-panel` asks the shell to open a panel (the spawn dialog, with
 * the task prefilled); `omp-console:open-agent` asks the agents overlay to open an agent's drawer.
 */
export const OPEN_PANEL_EVENT = "omp-console:open-panel";
export const OPEN_AGENT_EVENT = "omp-console:open-agent";

export interface OpenSpawnPanelDetail {
	panel: "spawn";
	task: string;
	/** Put the keyboard focus on the profile picker instead of the task field. */
	focus?: "profile";
	profile?: string;
}

export interface OpenAgentDetail {
	agentId: string;
}

export function openSpawnPanel(detail: Omit<OpenSpawnPanelDetail, "panel">): void {
	window.dispatchEvent(new CustomEvent<OpenSpawnPanelDetail>(OPEN_PANEL_EVENT, { detail: { panel: "spawn", ...detail } }));
}

export function openAgent(agentId: string): void {
	window.dispatchEvent(new CustomEvent<OpenAgentDetail>(OPEN_AGENT_EVENT, { detail: { agentId } }));
}
