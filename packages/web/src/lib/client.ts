/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * commit, so React change detection is reference equality all the way.
 *
 * High-rate frames (streaming `message_update`, `tool_execution_update`,
 * subagent progress) are applied immediately but published at most once per
 * animation frame; every other frame publishes synchronously, flushing any
 * pending state with it, so the published end state is unchanged.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	HostFrame,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import {
	commandNameFromSource,
	commandResultNeedsCard,
	decodeCommandResultMessage,
	takeExpectedCommandResult,
	type CommandResult,
} from "./command-results";
import { benchFrameReceived } from "./bench";
import { importRoomKey } from "./codec";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

import { offlineTranscriptCache } from "./offline-cache/cache";
import { markOfflineCachedEntries } from "./offline-cache/view";
import type { OfflineCachedTranscript, OfflineTranscriptCommit } from "./offline-cache/types";
export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";
export const RESTART_LOST_MESSAGE = "This session was lost in a restart before anything was saved";

function hasConversationHistory(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		entry =>
			entry.type === "message" ||
			entry.type === "custom_message" ||
			entry.type === "branch_summary" ||
			entry.type === "compaction",
	);
}

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
	source?: string;
}

/** omp's queue (`queue_update`): the first `liveSteered` steering entries already run inside the streaming reply. */
export interface HostQueue {
	steering: readonly string[];
	followUp: readonly string[];
	liveSteered: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	cached: boolean;
	cachedPartial: boolean;

	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
	/** Long remote command results, newest last; retained until dismissed or this client is reloaded. */
	commandResults: readonly CommandResult[];
	/** Snapshot download progress between `welcome` and its final chunk, else null. */
	loading: { received: number; total: number } | null;
	/** Host queue from omp's `queue_update`; null until the first one arrives on this connection. */
	queue: HostQueue | null;
}

/** Command result cards kept per session (oldest dropped): every card stays mounted, so this bounds memory and DOM. */
const MAX_COMMAND_RESULTS = 20;
const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
/** Commit delay when `requestAnimationFrame` is unavailable (tests, non-DOM hosts). */
const FRAME_FALLBACK_MS = 16;

/** Runs `callback` on the next animation frame; returns its cancel function. */
function scheduleFrame(callback: () => void): () => void {
	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(callback);
		return () => cancelAnimationFrame(id);
	}
	const timer = setTimeout(callback, FRAME_FALLBACK_MS);
	return () => clearTimeout(timer);
}

/** High-rate frames whose publish is deferred to the next animation frame. */
function isCoalescable(frame: HostFrame): boolean {
	if (frame.t === "event")
		return frame.event.type === "message_update" || frame.event.type === "tool_execution_update";
	return frame.t === "bus" && frame.channel === "task:subagent:progress";
}

/** Frames that carry visible transcript content: the "token" of token-to-paint in `?bench`. */
function isTokenFrame(frame: HostFrame): boolean {
	if (frame.t === "event") return frame.event.type === "message_update" || frame.event.type === "tool_execution_update";
	return frame.t === "entry";
}

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

/**
 * The entries on the branch ending at `leafId`, in their original order: the chain from the tip through `parentId`
 * (the host remaps `parentId` to the nearest replicated ancestor). null when the tip is not among the entries, so the
 * caller can fall back to showing everything rather than an empty transcript.
 */
export function branchEntries(entries: readonly SessionEntry[], leafId: string | null): SessionEntry[] | null {
	if (leafId === null) return [];
	const parentOf = new Map<string, string | null>();
	for (const entry of entries) parentOf.set(entry.id, entry.parentId);
	if (!parentOf.has(leafId)) return null;
	const onBranch = new Set<string>();
	for (let cursor: string | null | undefined = leafId; cursor != null && !onBranch.has(cursor); cursor = parentOf.get(cursor)) {
		onBranch.add(cursor);
	}
	return entries.filter(entry => onBranch.has(entry.id));
}

export class GuestClient {
	#socket: CollabSocket | null = null;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	#writeToken: string | undefined;
	#cacheKey: string | null = null;
	#cached = false;
	#cachedPartial = false;
	#cacheLastEntryAt = Date.now();
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: SessionEntry[] = [];
	#roomMissing = false;
	#restartLost = false;
	#transportDropped = false;
	#lastSentPrompt: string | null = null;
	/** Ids of `#entries`: a resync or a replayed frame never shows the same entry twice. */
	#entryIds = new Set<string>();
	/**
	 * Snapshot in flight since `welcome`: chunk entries, plus live `entry`
	 * frames that arrived meanwhile (published after the snapshot, at the tail).
	 */
	#pendingSnapshot: {
		entries: SessionEntry[];
		live: SessionEntry[];
		total: number;
		preserveRewound: boolean;
	} | null = null;
	#replicaToken: string | undefined;
	#skipResumeOnce = false;
	#resumeRecoveryAttempted = false;
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	/**
	 * Bus-map keys absent from the latest `agents` frame. Progress can arrive
	 * before its agent is listed, so such keys survive one `agents` frame and
	 * are pruned only if the next one still omits them.
	 */
	#unlistedBusIds = new Set<string>();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#queue: HostQueue | null = null;
	/**
	 * Tip of the host's current branch (`SessionState.leafId`): only the chain from it through `parentId` shows, so a
	 * rewind on any client (or the host's own tree navigation) hides the abandoned rows on every client and after any
	 * reconnect. Each appended entry becomes the tip. `undefined`: a host that does not report it; then the entries a
	 * rewind from this connection took off the branch are hidden locally via `#rewound` instead.
	 */
	#leafId: string | null | undefined = undefined;
	readonly #rewound = new Set<string>();
	#readOnly = false;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#commandResults: readonly CommandResult[] = [];
	#snapshot: GuestSnapshot;
	/**
	 * Published entries array, cached across commits: rebuilt only when
	 * `#entries` is mutated (welcome/snapshot-chunk/entry frames). Every
	 * other frame (streaming message_update, state, bus, agents) reuses the
	 * same reference, so entry-identity consumers (Transcript memo,
	 * useSyncExternalStore) skip their O(n) scans per token.
	 */
	#publishedEntries: readonly SessionEntry[] = [];
	/** Cancels the scheduled deferred commit; null when none is pending. */
	#cancelFrameCommit: (() => void) | null = null;

	constructor(link: string | null, displayName: string) {
		this.#name = displayName;
		if (link !== null) this.#attachSocket(link);
		this.#snapshot = this.#buildSnapshot();
	}

	#attachSocket(link: string): void {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		socket.onOpen = () => this.#handleOpen();
		socket.onFrame = frame => this.#applyFrameSafe(frame);
		socket.onClose = (reason, willReconnect, closeCode) => this.#handleClose(reason, willReconnect, closeCode);

		this.#socket = socket;
	}

	connect(link?: string): void {
		let socket = this.#socket;
		if (socket === null) {
			if (link === undefined) throw new Error("a room link is required to connect a cached transcript");
			this.#attachSocket(link);
			socket = this.#socket;
		}
		if (socket === null) throw new Error("the session transport could not be created");
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
	}

	/** Reconnect and resync from a fresh welcome; false when ended or the current room is missing. */
	reconnect(): boolean {
		if (this.#restartLost) return true;
		const socket = this.#socket;
		if (this.#phase === "ended" || this.#roomMissing || socket === null) return false;
		socket.reconnectNow();
		return true;
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#socket?.close();
	}
	setOfflineCacheKey(key: string): void {
		this.#cacheKey = key;
	}

	hydrateOfflineTranscript(record: OfflineCachedTranscript): void {
		this.#entries = [...record.entries];
		const separator = record.metadata.key.indexOf(":");
		this.#header = {
			type: "session",
			id: separator > 0 ? record.metadata.key.slice(separator + 1) : record.metadata.key,
			title: record.metadata.title,
			timestamp: new Date(record.metadata.lastEntryAt).toISOString(),
			cwd: record.metadata.cwd,
		};
		this.#entryIds = new Set(this.#entries.map(entry => entry.id));
		this.#leafId = record.metadata.leafId;
		this.#cacheLastEntryAt = record.metadata.lastEntryAt;
		this.#replicaToken = record.metadata.partial || record.metadata.pruned === true ? undefined : record.metadata.replicaToken ?? undefined;
		this.#everConnected = this.#replicaToken !== undefined;
		this.#cached = true;
		this.#cachedPartial = record.metadata.partial;
		// Not read-only: the composer keeps working as during any reconnect (it says so and sends once live).
		this.#phase = "reconnecting";
		this.#publishedEntries = this.#visibleEntries();
		this.#commit();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	dismissCommandResult(id: number): void {
		const next = this.#commandResults.filter(result => result.id !== id);
		if (next.length === this.#commandResults.length) return;
		this.#commandResults = next;
		this.#commit();
	}

	/** Cached stable reference; replaced per commit (at most once per animation frame for streaming frames). */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}
	get roomMissing(): boolean {
		return this.#roomMissing;
	}

	get canRestartAfterLoss(): boolean {
		return this.#restartLost;
	}

	getRestartContext(): { cwd: string; prompt: string; model?: string } | null {
		if (!this.#restartLost || this.#header === null || this.#lastSentPrompt === null) return null;
		const model = this.#state?.model;
		return {
			cwd: this.#header.cwd,
			prompt: this.#lastSentPrompt,
			...(model === undefined ? {} : { model: `${model.provider}/${model.id}` }),
		};
	}


	/** Marks a no-transcript first turn as lost instead of presenting an empty replacement session as recovered. */
	markUnrestorableAfterRestart(): boolean {
		if (
			!this.#roomMissing ||
			!this.#transportDropped ||
			hasConversationHistory(this.#entries) ||
			this.#lastSentPrompt === null ||
			this.#header === null
		) {
			return false;
		}
		this.#restartLost = true;
		this.#phase = "reconnecting";
		this.#endedReason = RESTART_LOST_MESSAGE;
		this.#pendingSnapshot = null;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		this.#clearUiRequests();
		this.#socket?.close();
		this.#commit();
		return true;
	}

	setRestartError(message: string): void {
		if (!this.#restartLost) return;
		this.#endedReason = `${RESTART_LOST_MESSAGE}: ${message}`;
		this.#commit();
	}

	/** Ends normally when the room vanished after a host close (End, crash) and the session has no live room. */
	endAfterHostClose(): boolean {
		if (!this.#roomMissing || this.#transportDropped) return false;
		this.#roomMissing = false;
		this.#end("no such room");
		return true;
	}

	/** The host rewound to just before `entryId` (wave-3 `rewind` op): hide it and every visible entry after it. */
	rewoundTo(entryId: string): void {
		if (this.#leafId !== undefined) {
			const entry = this.#entries.find(candidate => candidate.id === entryId);
			if (entry === undefined) return;
			this.#setLeaf(entry.parentId);
			return;
		}
		this.#hideFrom(entryId, 0);
	}

	/** The host rewound to an agent answer (wave-3 `rewind` op, `keptThrough`): keep `entryId`, hide every visible entry after it. */
	rewoundAfter(entryId: string): void {
		if (this.#leafId !== undefined) {
			this.#setLeaf(entryId);
			return;
		}
		this.#hideFrom(entryId, 1);
	}

	#setLeaf(leafId: string | null): void {
		this.#leafId = leafId;
		this.#publishedEntries = this.#visibleEntries();
		this.#persistCommittedTranscript();
		this.#commit();
	}

	#hideFrom(entryId: string, offset: number): void {
		const visible = this.#visibleEntries();
		const start = visible.findIndex(entry => entry.id === entryId);
		if (start === -1) return;
		for (const entry of visible.slice(start + offset)) this.#rewound.add(entry.id);
		this.#publishedEntries = this.#visibleEntries();
		this.#persistCommittedTranscript();
		this.#commit();
	}

	#visibleEntries(): SessionEntry[] {
		if (this.#leafId !== undefined) {
			const branch = branchEntries(this.#entries, this.#leafId);
			if (branch !== null) return branch;
		}
		return this.#rewound.size === 0 ? [...this.#entries] : this.#entries.filter(entry => !this.#rewound.has(entry.id));
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		const socket = this.#socket;
		if (socket === null) {
			// Not connected (a saved copy): nothing is sent; the caller shows the failure and keeps its text.
			this.#noteCachedOffline();
			throw new Error("Not sent: the session is offline. It will be available again once it reconnects.");
		}
		socket.send(images && images.length > 0 ? { t: "prompt", text, images } : { t: "prompt", text });
		this.#lastSentPrompt = images && images.length > 0 ? null : text;
	}


	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		const socket = this.#socket;
		if (socket === null) {
			this.#noteCachedOffline();
			return;
		}
		socket.send({ t: "ui-response", reqId, value });
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
	}

	sendAbort(): void {
		const socket = this.#socket;
		if (socket === null) {
			this.#noteCachedOffline();
			return;
		}
		socket.send({ t: "abort" });
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		const socket = this.#socket;
		if (socket === null) {
			this.#noteCachedOffline();
			return;
		}
		socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const socket = this.#socket;
		if (socket === null) return Promise.resolve(null);
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/**
	 * Test seam: apply a synthetic host frame through the real apply path. With
	 * `flush` (default), a commit deferred to the next animation frame is
	 * published now, so the snapshot reflects the frame on return.
	 */
	applyFrameForTest(frame: HostFrame, options: { flush?: boolean } = {}): void {
		this.#applyFrameSafe(frame);
		if ((options.flush ?? true) && this.#cancelFrameCommit !== null) this.#commit();
	}

	#handleOpen(): void {
		const socket = this.#socket;
		if (socket === null) return;
		const resume =
			this.#everConnected &&
			this.#replicaToken !== undefined &&
			this.#pendingSnapshot === null &&
			!this.#skipResumeOnce
				? {
						token: this.#replicaToken,
						entryId: this.#entries.at(-1)?.id ?? "",
						count: this.#entries.length,
					}
				: undefined;
		this.#skipResumeOnce = false;
		socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: this.#name,
			writeToken: this.#writeToken,
			...(resume === undefined ? {} : { resume }),
		});
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean, closeCode?: number): void {
		this.#clearSnapshotProgressTimer();
		if (this.#phase === "ended" || this.#restartLost) return;
		if (closeCode === 4001) this.#transportDropped = false;
		else if (closeCode === 1006 && this.#welcomed) this.#transportDropped = true;
		if (willReconnect) {
			if (this.#welcomed && reason === "no such room") {
				// 4001 then 4004 is both "the user ended it" and "a graceful daemon shutdown closed it": the room
				// lookup decides (a link means it was restored; a 404 after a host close ends normally).
				this.#roomMissing = true;
			}
			this.#phase = "reconnecting";
			// The next welcome restarts the snapshot; drop the partial one.
			this.#pendingSnapshot = null;
			this.#commit();
			return;
		}
		this.#end(reason);
	}


	#end(reason: string): void {
		if (this.#phase === "ended" || this.#restartLost) return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#pendingSnapshot = null;
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		this.#clearUiRequests();
		this.#commit();
		this.#socket?.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end("timed out waiting for the host's session snapshot");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		if (isTokenFrame(frame)) benchFrameReceived();
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome": {
				// A resume base is valid only for the local replica it was issued
				// against. Reject a mismatched delta before changing visible state.
				if (frame.resumeBase !== undefined && frame.resumeBase !== this.#entries.length) {
					if (!this.#resumeRecoveryAttempted) {
						this.#resumeRecoveryAttempted = true;
						this.#skipResumeOnce = true;
						this.#pendingSnapshot = null;
						this.#clearSnapshotProgressTimer();
						console.warn("collab: resume base mismatch; reconnecting without resume", {
							localCount: this.#entries.length,
							resumeBase: frame.resumeBase,
						});
						this.#socket?.reconnectNow();
					}
					return;
				}
				this.#replicaToken = frame.replicaToken;
				this.#resumeRecoveryAttempted = false;
				this.#header = frame.header;
				if (frame.resumeBase !== undefined) {
					if (frame.entryCount === 0) {
						this.#pendingSnapshot = null;
					} else {
						this.#pendingSnapshot = {
							entries: [...this.#entries],
							live: [],
							total: frame.resumeBase + frame.entryCount,
							preserveRewound: true,
						};
					}
				} else if (frame.entryCount === 0) {
					this.#entries = [];
					this.#entryIds.clear();
					this.#rewound.clear();
					this.#publishedEntries = [];
					this.#pendingSnapshot = null;
				} else {
					this.#pendingSnapshot = {
						entries: [],
						live: [],
						total: frame.entryCount,
						preserveRewound: false,
					};
				}
				this.#state = frame.state;
				this.#leafId = frame.state.leafId;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#unlistedBusIds.clear();
				this.#working = frame.state.isStreaming;
				this.#queue = null;
				this.#readOnly = frame.readOnly === true;
				this.#clearUiRequests();
				this.#welcomed = true;
				this.#roomMissing = false;
				this.#restartLost = false;
				this.#transportDropped = false;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}

				this.#endedReason = null;
				// A resume with nothing new still applies a branch tip that moved while this guest was away.
				if (this.#pendingSnapshot === null) {
					this.#publishedEntries = this.#visibleEntries();
					this.#cached = false;
					this.#cachedPartial = false;
					this.#persistCommittedTranscript(true);
				}
				break;
			}
			case "snapshot-chunk": {
				// Buffer fragments and publish the transcript once, when the
				// snapshot completes (as the TUI guest does). Intermediate chunks
				// only advance `loading`: publishing entries per chunk re-renders
				// the transcript per chunk, and a 50 MB session is ~100 chunks.
				const pending = this.#pendingSnapshot;
				if (pending === null) return;
				pending.entries.push(...frame.entries);
				// Complete on `final` or once every promised entry arrived, so a
				// lost final chunk doesn't strand a fully received transcript.
				if (!frame.final && pending.entries.length < pending.total) {
					this.#armSnapshotProgressTimer();
					break;
				}
				this.#entries = [];
				this.#entryIds.clear();
				for (const entry of pending.entries) this.#pushEntry(entry);
				for (const entry of pending.live) this.#pushEntry(entry);
				if (!pending.preserveRewound) this.#rewound.clear();
				this.#publishedEntries = this.#visibleEntries();
				this.#pendingSnapshot = null;
				this.#clearSnapshotProgressTimer();
				this.#phase = "live";
				this.#cached = false;
				this.#cachedPartial = false;
				this.#persistCommittedTranscript(true);
				break;
			}
			case "entry":
				// The committed row supersedes the finished stream ghost, even when
				// the row is buffered behind an in-flight snapshot.
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				// The host appends at its leaf: a new entry is the branch tip until a state frame says otherwise. Set in
				// frame order even while a snapshot is buffering, so a later state frame (a rewind) still wins.
				// An entry written off the active branch (a background bash result routed back to where it started) records
				// `activeLeafId` and leaves the host's leaf where it is.
				if (this.#leafId !== undefined && !this.#entryIds.has(frame.entry.id) && frame.entry.activeLeafId === undefined) {
					this.#leafId = frame.entry.id;
				}
				if (this.#pendingSnapshot !== null) {
					this.#pendingSnapshot.live.push(frame.entry);
					break;
				}
				if (!this.#pushEntry(frame.entry)) break;
				this.#publishedEntries = this.#visibleEntries();
				this.#persistCommittedTranscript();
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				if (frame.state.leafId !== undefined && frame.state.leafId !== this.#leafId) {
					this.#leafId = frame.state.leafId;
					if (this.#pendingSnapshot === null) this.#publishedEntries = this.#visibleEntries();
				}
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				if (this.#pendingSnapshot === null) this.#persistCommittedTranscript();
				break;
			case "agents":
				this.#agents = [...frame.agents];
				this.#pruneBusMaps();
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		if (isCoalescable(frame)) this.#scheduleCommit();
		else this.#commit();
	}

	/** Appends unless the id is already present; false when it was a duplicate. */
	#pushEntry(entry: SessionEntry): boolean {
		if (this.#entryIds.has(entry.id)) return false;
		this.#entryIds.add(entry.id);
		this.#entries.push(entry);
		this.#cacheLastEntryAt = Date.now();
		return true;
	}

	/**
	 * Drops progress/lifecycle payloads of agents the host no longer lists.
	 * A key missing from this `agents` frame is pruned when it was already
	 * missing from the previous one; the one-frame grace covers progress that
	 * outran its agent's registration.
	 */
	#pruneBusMaps(): void {
		if (this.#progress.size === 0 && this.#lifecycle.size === 0) {
			this.#unlistedBusIds.clear();
			return;
		}
		const listed = new Set<string>();
		for (const agent of this.#agents) listed.add(agent.id);
		const previouslyUnlisted = this.#unlistedBusIds;
		const unlisted = new Set<string>();
		const prune = <V>(map: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
			let kept: Map<string, V> | null = null;
			for (const [id, value] of map) {
				const drop = !listed.has(id) && previouslyUnlisted.has(id);
				if (!listed.has(id) && !drop) unlisted.add(id);
				if (drop && kept === null) {
					kept = new Map();
					for (const [keptId, keptValue] of map) {
						if (keptId === id) break;
						kept.set(keptId, keptValue);
					}
				} else if (!drop && kept !== null) {
					kept.set(id, value);
				}
			}
			return kept ?? map;
		};
		this.#progress = prune(this.#progress);
		this.#lifecycle = prune(this.#lifecycle);
		this.#unlistedBusIds = unlisted;
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "queue_update":
				this.#queue = { steering: event.steering, followUp: event.followUp, liveSteered: event.liveSteered };
				break;
			case "notice":
				this.#pushNotice(event.level, event.message, event.source);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string, source?: string): void {
		const id = ++this.#noticeSeq;
		const at = Date.now();
		const name = commandNameFromSource(source);
		const decoded = name === undefined ? { text: message } : decodeCommandResultMessage(message);
		const notice: Notice = { id, level, message: decoded.text, at, source };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
		if (source !== undefined && name !== undefined && commandResultNeedsCard(source, level, decoded.text) && takeExpectedCommandResult(name)) {
			this.#commandResults = [
				...this.#commandResults,
				{
					id,
					name,
					source,
					level,
					message: decoded.text,
					at,
					usageReports: decoded.usageReports,
				},
			];
			if (this.#commandResults.length > MAX_COMMAND_RESULTS) this.#commandResults = this.#commandResults.slice(-MAX_COMMAND_RESULTS);
		}
	}

	#noteCachedOffline(): void {
		const message = "This is a saved copy. Messages can be sent once the session reconnects.";
		if (this.#notices.at(-1)?.message === message) return;
		this.#pushNotice("warning", message);
		this.#commit();
	}
	#persistCommittedTranscript(immediate = false): void {
		const key = this.#cacheKey;
		if (key === null) return;
		const commit: OfflineTranscriptCommit = {
			entries: this.#entries,
			title: this.#header?.title ?? this.#state?.sessionName ?? "",
			cwd: this.#header?.cwd ?? this.#state?.cwd ?? "",
			replicaToken: this.#replicaToken ?? null,
			leafId: this.#leafId ?? null,
			lastEntryAt: this.#cacheLastEntryAt,
			archivedAt: null,
			live: this.#welcomed && this.#phase !== "ended",
			waitingOnYou: this.#uiRequest !== null,
			unfinished: true,
		};
		if (immediate) void offlineTranscriptCache.write(key, commit);
		else offlineTranscriptCache.scheduleWrite(key, commit);
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			cached: this.#cached,
			cachedPartial: this.#cachedPartial,

			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#publishedEntries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			notices: this.#notices,
			commandResults: this.#commandResults,
			loading: this.#pendingSnapshot && {
				received: this.#pendingSnapshot.entries.length,
				total: this.#pendingSnapshot.total,
			},
			queue: this.#queue,
		};
	}

	/** Publishes on the next animation frame; a synchronous commit before then supersedes it. */
	#scheduleCommit(): void {
		if (this.#cancelFrameCommit !== null) return;
		this.#cancelFrameCommit = scheduleFrame(() => {
			this.#cancelFrameCommit = null;
			this.#commit();
		});
	}

	#commit(): void {
		if (this.#cancelFrameCommit !== null) {
			this.#cancelFrameCommit();
			this.#cancelFrameCommit = null;
		}
		if (this.#cached) markOfflineCachedEntries(this.#publishedEntries, this.#cachedPartial);
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
