import type { ExtensionUiState, PluginInfo } from "@omp-console/protocol";

/** What the plugin routes need from the worker supervisor (its methods of the same names have exactly these shapes). */
export interface PluginPorts {
	plugins(sessionId: string): Promise<PluginInfo[]>;
	togglePlugin(sessionId: string, pluginId: string, enabled: boolean): Promise<void>;
	/** The newest extension UI state of a live session; empty until its worker publishes one. Unknown session: rejects `not-found`. */
	extensionUi(sessionId: string): ExtensionUiState;
}
