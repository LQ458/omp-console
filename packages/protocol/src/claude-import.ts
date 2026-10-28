export type ClaudeImportSource = "claude" | "codex";

export interface ClaudeImportSummary {
	dir: string;
	found: boolean;
	sessionCount: number;
	projectCount: number;
}

export interface ClaudeImportSession {
	id: string;
	source: ClaudeImportSource;
	projectPath: string;
	title: string;
	firstMessage: string | null;
	messageCount: number;
	lastActivityAt: number;
	alreadyImported: boolean;
	importedSessionId?: string;
}

export interface ClaudeImportProject {
	path: string;
	sessions: ClaudeImportSession[];
}

export interface ClaudeImportSessionsResponse {
	source: ClaudeImportSource;
	dir: string;
	found: boolean;
	projects: ClaudeImportProject[];
}

export interface StartClaudeImportRequest {
	ids: string[];
}

export interface ClaudeImportItemResult {
	id: string;
	status: "imported" | "already-imported" | "error";
	sessionId?: string;
	error?: string;
	/** Set when the session was imported but something non-fatal failed (the de-duplication index could not be saved). */
	warning?: string;
}

export interface ClaudeImportJobResponse {
	jobId: string;
	source: ClaudeImportSource;
	status: "running" | "complete";
	total: number;
	completed: number;
	results: ClaudeImportItemResult[];
}

export interface ClaudeImportSettingsResponse {
	userConfigEnabled: boolean;
	userSkillsEnabled: boolean;
	userCommandsEnabled: boolean;
	claudeConfigDirOverride: boolean;
}

export interface UpdateClaudeImportSettingsRequest {
	userConfigEnabled: boolean;
	userSkillsEnabled: boolean;
	userCommandsEnabled: boolean;
}
