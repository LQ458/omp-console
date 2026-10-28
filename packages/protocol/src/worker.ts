/**
 * Contract between the daemon (supervisor) and a session-host worker process. Owned by main.
 *
 * Launch (daemon -> worker), one process per AgentSession:
 *   <bun> packages/session-host/src/main.ts \
 *       --cwd <project dir> --relay <ws://127.0.0.1:PORT> --room <roomId> \
 *       [--resume <sessionFile>] [--fork <sessionFile>[:<entryId>]] [--model <selector>]
 * (Planned, blocked on an upstream change: a per-launch host ticket as a relay path prefix so only the launched
 * worker can take the host slot of its room. Today the relay is the plain URL.)
 * Secrets never travel in argv or in the environment (the agent's shells inherit the environment): the FIRST line
 * the daemon writes to the worker's stdin is a `WorkerLaunchSecrets` object; the worker reads it before anything else.
 * `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` stay environment variables, only when a test needs an isolated config root.
 *
 * Status (worker -> daemon): one JSON object per line on stdout. stderr is free-form logs.
 * Commands (daemon -> worker): one JSON object per line on stdin after the launch line. EOF on stdin means stop.
 */

/** First stdin line from the daemon: base64url 32-byte room key and 16-byte write token (full-permission guests). */
export interface WorkerLaunchSecrets {
	t: "launch";
	roomKey: string;
	writeToken: string;
	deviceToken: string;
	/** Session-scoped automation controls; never passed in argv or saved to omp settings. */
	overnight?: WorkerOvernightOptions;
}

import type { CatalogResponse, SetAgentThinkingRequest, SpawnAgentRequest } from "./features";
import type { ExtensionUiState, KeyPoints, ListPluginsResponse, SessionOp, SessionOpResult } from "./wave2";
import type { CleanseStateSummary, LiveModeStatus, LoopModeStatus, SessionOpV3, SessionOpV3Result, VibeModeStatus } from "./wave3";
import type { OvernightAutoAnswer, OvernightLastTurn, WorkerOvernightOptions } from "./overnight";

export type WorkerStatus =
	| { t: "ready"; sessionId: string; sessionFile?: string; rootAgentId: string; roomId: string }
	| {
			t: "state";
			state: "idle" | "streaming" | "asking";
			/** Agent loops are parked at their next safe boundary; in-flight work is not aborted. */
			paused: boolean;
			/** Epoch ms when the current pause began. */
			pausedAt?: number;
			model?: string;
			thinkingLevel?: string;
			awaitingAnswer: boolean;
			/** First ~200 characters of the question the session waits on, when `awaitingAnswer`. */
			pendingQuestion?: string;
			pendingKind?: "ask" | "approval";
			goalActive: boolean;
			goalObjective?: string;
			/** Live subagents under rootAgentId. */
			agentCount: number;
			/** Date.now() of the last agent or tool event. */
			lastEventAt: number;
			/** Minimal /cleanse lifecycle in the state line; the session op exposes its full board. */
			cleanse?: CleanseStateSummary;
			title?: string;
			loopMode?: LoopModeStatus;
			vibeMode?: VibeModeStatus;
			liveMode?: LiveModeStatus;
	  }
	| { t: "turn-end"; lastTurn: OvernightLastTurn }
	| ({ t: "auto-answer" } & OvernightAutoAnswer)
	| { t: "notify"; reason: "turn-finished" | "needs-answer" | "needs-approval"; summary?: string }
	| { t: "fatal"; message: string }
	/**
	 * Subagent lifecycle in this session (from omp's task lifecycle bus), so the daemon can run draft plans without a
	 * guest connection. `summary` is the first lines of the result or error on a terminal status.
	 */
	| {
			t: "agent";
			agentId: string;
			parentId?: string;
			profile: string;
			status: "started" | "completed" | "failed" | "aborted";
			summary?: string;
	  }
	/** Extension UI published in this session (status, widgets, omp console panels, notifications), whole state each time. */
	| { t: "ext-ui"; state: ExtensionUiState }
	/**
	 * Token use of one finished model request in this session (any agent), for quota burn estimates. `provider` and
	 * `model` as omp reports them; tokens exclude cache reads.
	 */
	| { t: "usage-sample"; agentId: string; provider: string; model: string; tokens: number; cacheReadTokens: number; at: number }
	/** The session's title changed (generated or renamed). */
	| { t: "title"; title: string }
	/** Opaque base64 delta from the realtime transport; decoded format is not exposed by the current native API. */
	| { t: "live-audio"; audio: string }
	/** Throttled live microphone and speaker RMS levels in [0, 1]. */
	| { t: "live-levels"; input: number; output: number };

export type WorkerCommand =
	| { t: "stop" }
	| { t: "ping"; id: string }
	/** Abort the running turn (same effect as a guest abort); replies `{t:"aborted", id, aborted:boolean}`. */
	| { t: "abort"; id: string }
	/**
	 * Change the model of one agent of the session tree (root or running subagent); applied as a session-only
	 * override. Replies `model-set` or `model-error` carrying the same `id`.
	 */
	| { t: "set-agent-model"; id: string; agentId: string; selector: string }
	/** Same agent scope as `set-agent-model`, for the thinking level. Replies `model-set`/`model-error`. */
	| { t: "set-agent-thinking"; id: string; agentId: string; level: SetAgentThinkingRequest["level"] }
	/** Build the catalog from the live session's registries. Replies `catalog` or `request-error`. */
	| { t: "catalog"; id: string }
	/** Run one remote-invokable slash command. Replies `accepted` or `request-error`. */
	| { t: "run-command"; id: string; text: string }
	/** Spawn a subagent of a profile through omp's task tool. Replies `spawned` (once registered) or `request-error`. */
	| { t: "spawn-agent"; id: string; request: SpawnAgentRequest }
	/** Stop one subagent (abort its turn, release it as an aborted tombstone). Replies `accepted` or `request-error`. */
	| { t: "cancel-agent"; id: string; agentId: string }
	/** Send a prompt to the main agent as the host user (handoff, quick-ask). Replies `accepted` once queued or started. */
	| { t: "send-prompt"; id: string; text: string }
	/** Change the live session's overnight dialog policy; subprocess env/priority changes apply on its next launch. */
	| { t: "overnight-options"; id: string; options: WorkerOvernightOptions | null }
	/** Hold (frozen) or release all guest prompts and commands; a frozen session also aborts its turn. Replies `accepted`. */
	| { t: "freeze"; id: string; frozen: boolean }
	/** Cancel an in-flight session op; no reply. */
	| { t: "cancel-session-op"; id: string }
	/** One session operation through omp's session API. Replies `session-op` or `request-error`. */
	| { t: "session-op"; id: string; op: SessionOp | SessionOpV3 }
	/** One bounded 16 kHz mono Float32 PCM frame from the owner-authenticated live WebSocket, encoded as base64. */
	| { t: "live-audio"; data: string }
	/** omp's `fetchUsageReports()`; replies `usage` with the raw reports (no credentials) or `request-error`. */
	| { t: "usage"; id: string }
	/** Generate key points from this session's transcript with the smol role. Replies `key-points` or `request-error`. */
	| { t: "summarize"; id: string }
	/** Generate (or regenerate) the title with omp's title generator. Replies `accepted`; the result arrives as `title`. */
	| { t: "refine-title"; id: string }
	/** List plugins, extensions, skills, MCP servers, hooks and custom tools. Replies `plugins`. */
	| { t: "plugins"; id: string }
	/** Enable or disable one entry from `plugins`, through omp's own manager; replies `accepted`. */
	| { t: "plugin-toggle"; id: string; pluginId: string; enabled: boolean }
	/**
	 * Flow-control policy pushed by the daemon whenever it changes: per provider, whether new top-level subagent spawns
	 * are admitted now, and whether new prompts must wait. The worker enforces it on spawns its main agent makes
	 * (omp `before_subagent_spawn`), holding them until a later policy admits them. No reply.
	 */
	| {
			t: "quota-policy";
			providers: Array<{ provider: string; admitSpawns: boolean; holdPrompts: boolean; reason?: string }>;
	  };

/** Replies to the request-style commands above, matched by `id`. */
export type WorkerRequestResult =
	| { t: "catalog"; id: string; catalog: CatalogResponse }
	| { t: "accepted"; id: string }
	| { t: "spawned"; id: string; agentId: string }
	| { t: "session-op"; id: string; result: SessionOpResult | SessionOpV3Result }
	/** Raw `UsageReport[]` from omp (`packages/ai/src/usage.ts`), passed through as JSON. */
	| { t: "usage"; id: string; reports: unknown[] }
	| { t: "key-points"; id: string; keyPoints: KeyPoints }
	| { t: "plugins"; id: string; plugins: ListPluginsResponse["plugins"] }
	/** `code` maps to the HTTP status the daemon answers with. */
	| { t: "request-error"; id: string; code: "bad-request" | "not-found" | "conflict" | "internal"; message: string };

/** Reply to `set-agent-model`, on stdout. `id` echoes the command's id so a late reply never answers a newer request. */
export type WorkerModelResult =
	| { t: "model-set"; id: string; agentId: string; model: string; thinkingLevel?: string }
	| { t: "model-error"; id: string; agentId: string; message: string };

/** Reply to `abort`, on stdout: `aborted` is false when no turn was running. `id` echoes the command's id. */
export interface WorkerAbortResult {
	t: "aborted";
	id: string;
	aborted: boolean;
}

/** Worker replies to ping with {t:"pong", id} on stdout (not part of WorkerStatus so supervisors may ignore it). */
export interface WorkerPong {
	t: "pong";
	id: string;
}
