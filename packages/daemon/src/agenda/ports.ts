import type { CompletionClaim } from "./ask-limit";
import type { AgendaAskResponse } from "@omp-console/protocol";

export interface AgendaPorts {
	/** Run a hidden quick-ask session with additional instructions; answers in the session's language. */
	askHidden(text: string, systemAddendum: string): Promise<AgendaAskResponse>;
}

export interface AgendaHubConfig {
	python: string;
	cwd: string;
	env: Record<string, string>;
}

export type AgendaBoardIoRunner = (hub: AgendaHubConfig, args: readonly string[]) => Promise<string>;

export interface AgendaRouteOptions {
	hub?: AgendaHubConfig;
	runBoardIo?: AgendaBoardIoRunner;
	now?: () => number;
	/**
	 * Claims a completion slot before a session completes a task, synchronously (parallel tool calls each claim): a
	 * string refuses it (409), undefined means unlimited. See `AskCompletionLimit`.
	 */
	claimCompletion?: (sessionId: string) => CompletionClaim | string | undefined;
}

/** An Ask failure whose message is written by the daemon and safe to show on the board. */
export class AgendaAskError extends Error {}
