/** Read-only first-run checks exposed by `GET /api/setup`. */
export interface SetupResponse {
	omp: {
		found: boolean;
		path: string | null;
		version: string | null;
		error: string | null;
	};
	models: {
		availableCount: number | null;
		defaultModel: string | null;
		error: string | null;
	};
	sessions: {
		agentDir: string;
		count: number | null;
		error: string | null;
	};
	ompSetup: {
		agentDir: string;
		defaultAgentDir: string;
		usesDefaultAgentDir: boolean;
		defaultModel: string | null;
		modelRoles: number | null;
		skills: number | null;
		extensions: number | null;
		mcpServers: number | null;
		error: string | null;
	};
	/** Names only. Values from `~/.omp-console/env` never cross the API boundary. */
	envKeys: string[];
}
