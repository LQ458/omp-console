/**
 * Scripted collab host room: connects to a relay as host and serves the canned fixture session to
 * any guest that joins. Shared by `mock-host.ts` (standalone relay + one room) and
 * `mock-daemon.ts` (one room per fake session).
 *
 * Replays a scripted streaming turn on every guest prompt, ticks subagent progress on the bus,
 * and answers fetch-transcript with byte slices of the fixture JSONL — the frames a real
 * `omp /collab` host emits.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiRequestDraft,
	HostFrame,
	SessionEntry,
	SessionState,
	WireFrame,
} from "@oh-my-pi/pi-wire";
import { WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";
import { makeStreamTokens } from "../bench/make-transcript";
import { AGENT_TREE_SILENT, makeTreeAgents, makeTreeLifecycle, makeTreeProgress } from "./agent-tree-fixture";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";
import { COLLAB_PROTO, formatCollabLink, generateRoomId, packEnvelope, unpackEnvelope } from "../src/lib/link";
import {
	fixtureAgents,
	fixtureEntries,
	fixtureHeader,
	fixtureModel,
	HOST_DISPLAY_NAME,
	makeProbeProgress,
	makeScriptedTurn,
	type ScriptedStep,
	subagentTranscriptJsonl,
} from "./fixture";

const STEP_INTERVAL_MS = 40;
const DEFAULT_TICK_MS = 2_000;
const AGENTS_SNAPSHOT_EVERY = 5;
const SNAPSHOT_CHUNK_ENTRIES = 256;
const STREAM_TURN_GAP_MS = 300;

export interface MockRoomOptions {
	/** Relay the host connects to (`ws://…`; `/r/<roomId>?role=host` is appended). */
	relayUrl: string;
	title?: string;
	cwd?: string;
	/** Session id echoed in the welcome header. */
	sessionId?: string;
	tickMs?: number;
	log?: (message: string) => void;
	/** Fires when the relay connection drops without `stop()`. */
	onLost?: (reason: string) => void;
	/** Initial transcript instead of the canned fixture entries. */
	entries?: readonly SessionEntry[];
	/** Streams tokens to guests at a fixed rate from the first join on. */
	stream?: MockStreamFixture;
	/** A question the host is blocked on from the start. */
	ask?: CollabUiRequestDraft;
	/** Replaces the canned agents with the nested spawn tree of `agent-tree-fixture.ts` (root, 3 children, 1 grandchild). */
	agentTree?: boolean;
}

export interface MockStreamFixture {
	tokensPerSecond: number;
	/** Length of one streamed message; the next one starts right after. */
	durationMs: number;
}

export interface MockRoomStatus {
	streaming: boolean;
	entryCount: number;
	agentCount: number;
	guests: number;
	/** A question is waiting for an answer. */
	asking: boolean;
}

export interface MockRoom {
	readonly roomId: string;
	/** Collab link guests join with, for the relay URL the guest can reach. */
	linkFor(publicRelayUrl: string, permission?: "full" | "view"): string;
	status(): MockRoomStatus;
	participants(): SessionState["participants"];
	/** Raises a host question; every guest sees it until one answers. */
	ask(draft: CollabUiRequestDraft): void;
	/** Current host ask for mock HTTP session-op access. */
	pendingUiRequest(): CollabUiRequest | null;
	/** Answers the matching current ask as an HTTP-originated guest; false means stale reqId. */
	answerUiRequest(reqId: number, value: string | null): boolean;
	/**
	 * Session-only model override for the root agent or a running subagent (what the daemon's
	 * `POST /api/sessions/:id/agents/:agentId/model` does). `unknown`: no such agent; `not-live`: parked or stopped.
	 */
	setAgentModel(agentId: string, model: string): "ok" | "unknown" | "not-live";
	/** Stops the current turn and drops queued prompts; false when the room was idle. */
	abortTurn(): boolean;
	/** Appends a transcript entry and sends it to every guest, as the host does when a tool finishes. */
	append(entry: SessionEntry): void;
	/** Current transcript entries in host order, for mock session operations. */
	transcriptEntries(): readonly SessionEntry[];
	/** Removes the selected current-branch user message and later entries; null when it is not rewindable. */
	rewindTo(entryId: string): SessionEntry | null;
	/** Id of the newest transcript entry (parent of the next one). */
	lastEntryId(): string | null;
	/** Resolves once the host socket is open on the relay. */
	readonly ready: Promise<void>;
	/** Says bye to guests, then closes the room. Idempotent. */
	stop(reason?: string): Promise<void>;
}

export async function startMockRoom(options: MockRoomOptions): Promise<MockRoom> {
	const log = options.log ?? (() => {});
	const roomId = generateRoomId();
	const rawKey = generateRoomKey();
	const rawWriteToken = crypto.getRandomValues(new Uint8Array(WRITE_TOKEN_BYTES));
	const key = await importRoomKey(rawKey);
	const header = {
		...fixtureHeader,
		id: options.sessionId ?? fixtureHeader.id,
		title: options.title ?? fixtureHeader.title,
		cwd: options.cwd ?? fixtureHeader.cwd,
	};

	const entries: SessionEntry[] = [...(options.entries ?? fixtureEntries)];
	const agents: AgentSnapshot[] = options.agentTree
		? makeTreeAgents(Date.now())
		: fixtureAgents.map(agent => ({ ...agent }));
	/** Models set through `setAgentModel`; the root agent's shows in the header state, subagents' in progress. */
	const agentModels = new Map<string, string>();
	const silentAgents: ReadonlySet<string> = options.agentTree ? AGENT_TREE_SILENT : new Set();
	const peers = new Map<number, string>();
	const transcriptBytes = new TextEncoder().encode(subagentTranscriptJsonl);
	const transcriptDecoder = new TextDecoder();

	let lastEntryId: string | null = entries[entries.length - 1]?.id ?? null;
	let streaming = false;
	let queuedPrompts = 0;
	let turnSeq = 0;
	let liveEntrySeq = 0;
	let streamTurn = 0;
	let replayQueue: ScriptedStep[] = [];
	let replayTimer: Timer | null = null;
	let tick = 0;
	let stopping = false;
	let nextReqId = 1;
	let pendingAsk: CollabUiRequest | null = options.ask ? { ...options.ask, reqId: nextReqId++ } : null;

	const ws = new WebSocket(`${options.relayUrl}/r/${roomId}?role=host`);
	ws.binaryType = "arraybuffer";
	const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();

	let sendChain: Promise<void> = Promise.resolve();
	let recvChain: Promise<void> = Promise.resolve();

	/** Seal and send a frame; peerId 0 broadcasts, N targets that guest. */
	function sendFrame(frame: HostFrame, targetPeer = 0): void {
		sendChain = sendChain
			.then(async () => {
				if (ws.readyState !== WebSocket.OPEN) return;
				const sealed = await seal(key, frame);
				ws.send(packEnvelope(targetPeer, sealed));
			})
			.catch((err: unknown) => {
				log(`send failed: ${String(err)}`);
			});
	}

	function mainModel(): SessionState["model"] {
		const root = agents.find(agent => agent.kind === "main");
		const override = root ? agentModels.get(root.id) : undefined;
		return override ? { ...fixtureModel, id: override, name: override } : fixtureModel;
	}

	function buildState(): SessionState {
		const participants: SessionState["participants"] = [{ name: HOST_DISPLAY_NAME, role: "host" }];
		for (const name of peers.values()) participants.push({ name, role: "guest" });
		const tokens = 51_000 + entries.length * 120;
		return {
			isStreaming: streaming,
			queuedMessageCount: queuedPrompts,
			sessionName: header.title,
			cwd: header.cwd,
			model: mainModel(),
			thinkingLevel: "medium",
			contextUsage: {
				tokens,
				contextWindow: fixtureModel.contextWindow,
				percent:
					fixtureModel.contextWindow !== null && fixtureModel.contextWindow > 0
						? (tokens / fixtureModel.contextWindow) * 100
						: null,
			},
			participants,
		};
	}

	function broadcastState(): void {
		sendFrame({ t: "state", state: buildState() });
	}

	function appendEntry(entry: SessionEntry): void {
		entries.push(entry);
		lastEntryId = entry.id;
		sendFrame({ t: "entry", entry });
	}

	function rewindEntry(entryId: string): SessionEntry | null {
		const entriesById = new Map<string, SessionEntry>();
		for (const entry of entries) entriesById.set(entry.id, entry);

		let currentId = lastEntryId;
		while (currentId !== null && currentId !== entryId) {
			const current = entriesById.get(currentId);
			if (!current) return null;
			currentId = current.parentId;
		}
		const selected = entriesById.get(entryId);
		if (currentId !== entryId || selected?.type !== "message" || selected.message.role !== "user") return null;

		const retained = new Set<string>();
		currentId = selected.parentId;
		while (currentId !== null) {
			const ancestor = entriesById.get(currentId);
			if (!ancestor) break;
			retained.add(currentId);
			currentId = ancestor.parentId;
		}
		let kept = 0;
		for (const entry of entries) {
			if (retained.has(entry.id)) entries[kept++] = entry;
		}
		entries.length = kept;
		lastEntryId = selected.parentId;
		return selected;
	}

	function notice(level: "info" | "warning" | "error", message: string): void {
		sendFrame({ t: "event", event: { type: "notice", level, message, source: "collab" } });
	}

	// ── scripted turn replay ───────────────────────────────────────────────────

	function startReplay(): void {
		turnSeq++;
		replayQueue = makeScriptedTurn(turnSeq, lastEntryId);
		scheduleStep();
	}

	function scheduleStep(): void {
		replayTimer = setTimeout(() => {
			replayTimer = null;
			const step = replayQueue.shift();
			if (step) applyStep(step);
			if (replayQueue.length > 0) {
				scheduleStep();
				return;
			}
			if (queuedPrompts > 0) {
				queuedPrompts--;
				startReplay();
			}
		}, STEP_INTERVAL_MS);
	}

	function applyStep(step: ScriptedStep): void {
		switch (step.kind) {
			case "event":
				sendFrame({ t: "event", event: step.event });
				break;
			case "entry":
				appendEntry(step.entry);
				break;
			case "state":
				streaming = step.streaming;
				broadcastState();
				break;
		}
	}

	function cancelReplay(): void {
		if (replayTimer !== null) {
			clearTimeout(replayTimer);
			replayTimer = null;
		}
		replayQueue = [];
		stopTokenStream();
	}

	/**
	 * Streaming fixture: one `message_update` frame per token at a fixed rate (timer drift is
	 * corrected against the turn's start), turn after turn, so a bench run can start any time.
	 */
	const tokenStream: { started: boolean; stopped: boolean; timer: Timer | null } = {
		started: false,
		stopped: false,
		timer: null,
	};

	function stopTokenStream(): void {
		tokenStream.stopped = true;
		if (tokenStream.timer !== null) {
			clearTimeout(tokenStream.timer);
			tokenStream.timer = null;
		}
	}

	function startTokenStream(fixture: MockStreamFixture): void {
		tokenStream.started = true;
		const tokens = makeStreamTokens(Math.max(1, Math.round((fixture.tokensPerSecond * fixture.durationMs) / 1000)));
		const intervalMs = 1000 / fixture.tokensPerSecond;
		const message = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			model: fixtureModel.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const runTurn = (): void => {
			if (tokenStream.stopped) return;
			streamTurn++;
			sendFrame({ t: "event", event: { type: "agent_start" } });
			streaming = true;
			broadcastState();
			sendFrame({ t: "event", event: { type: "message_start", message: message("") } });
			const startedAt = performance.now();
			let sent = 0;
			let text = "";
			const emit = (): void => {
				tokenStream.timer = null;
				if (tokenStream.stopped) return;
				if (sent >= tokens.length) {
					const final = message(text);
					sendFrame({ t: "event", event: { type: "message_end", message: final } });
					appendEntry({
						id: `stream-${streamTurn}`,
						parentId: lastEntryId,
						timestamp: new Date().toISOString(),
						type: "message",
						message: final,
					});
					sendFrame({ t: "event", event: { type: "agent_end" } });
					streaming = false;
					broadcastState();
					tokenStream.timer = setTimeout(runTurn, STREAM_TURN_GAP_MS);
					return;
				}
				text += tokens[sent++];
				sendFrame({ t: "event", event: { type: "message_update", message: message(text) } });
				tokenStream.timer = setTimeout(emit, Math.max(0, startedAt + sent * intervalMs - performance.now()));
			};
			emit();
		};
		tokenStream.stopped = false;
		runTurn();
	}

	// ── guest frame handling ───────────────────────────────────────────────────

	function peerName(fromPeer: number): string {
		return peers.get(fromPeer) ?? `guest-${fromPeer}`;
	}

	function handleHello(name: string, proto: number, fromPeer: number): void {
		if (proto !== COLLAB_PROTO) {
			sendFrame(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		peers.set(fromPeer, cleanName);
		sendFrame(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header,
				state: buildState(),
				agents: agents.map(agent => ({ ...agent })),
				entryCount: entries.length,
			},
			fromPeer,
		);
		for (let from = 0; from === 0 || from < entries.length; from += SNAPSHOT_CHUNK_ENTRIES) {
			const chunk = entries.slice(from, from + SNAPSHOT_CHUNK_ENTRIES);
			const final = from + SNAPSHOT_CHUNK_ENTRIES >= entries.length;
			sendFrame({ t: "snapshot-chunk", entries: chunk, final }, fromPeer);
		}
		if (options.agentTree) {
			for (const payload of makeTreeLifecycle()) {
				sendFrame({ t: "bus", channel: "task:subagent:lifecycle", data: payload }, fromPeer);
			}
			for (const payload of makeTreeProgress(tick, agentModels, silentAgents)) {
				sendFrame({ t: "bus", channel: "task:subagent:progress", data: payload }, fromPeer);
			}
		}
		log(`${cleanName} joined (peer ${fromPeer})`);
		if (pendingAsk !== null) sendFrame({ t: "ui-request", request: pendingAsk }, fromPeer);
		broadcastState();
		if (options.stream && !tokenStream.started) startTokenStream(options.stream);
	}

	function handlePrompt(text: string, fromPeer: number): void {
		liveEntrySeq++;
		appendEntry({
			id: `live-${liveEntrySeq}`,
			parentId: lastEntryId,
			timestamp: new Date().toISOString(),
			type: "custom_message",
			customType: "collab-prompt",
			content: text,
			details: { from: peerName(fromPeer) },
			display: true,
		});
		if (replayTimer !== null || replayQueue.length > 0) {
			queuedPrompts++;
			broadcastState();
			return;
		}
		startReplay();
	}

	function abortTurn(): boolean {
		const wasReplaying = replayTimer !== null || replayQueue.length > 0;
		const active =
			streaming ||
			wasReplaying ||
			queuedPrompts > 0 ||
			(options.stream !== undefined && tokenStream.started && !tokenStream.stopped);
		cancelReplay();
		queuedPrompts = 0;
		if (wasReplaying || streaming) sendFrame({ t: "event", event: { type: "agent_end" } });
		streaming = false;
		broadcastState();
		return active;
	}

	function handleAbort(fromPeer: number): void {
		notice("info", `${peerName(fromPeer)} interrupted`);
		abortTurn();
	}

	function handleAgentCmd(cmd: string, agentId: string, fromPeer: number): void {
		notice("info", `${peerName(fromPeer)} sent agent-cmd ${cmd} → ${agentId}`);
		const agent = agents.find(candidate => candidate.id === agentId);
		if (!agent || agent.kind === "main") return;
		if (cmd === "kill" && agent.status === "running") agent.status = "aborted";
		else if (cmd === "revive" && (agent.status === "parked" || agent.status === "aborted")) agent.status = "running";
		else return;
		agent.lastActivity = Date.now();
		sendFrame({ t: "agents", agents: agents.map(snapshot => ({ ...snapshot })) });
	}

	function handleFetchTranscript(reqId: number, fromByte: number, fromPeer: number): void {
		const total = transcriptBytes.byteLength;
		const start = Math.max(0, Math.min(fromByte, total));
		const text = start >= total ? "" : transcriptDecoder.decode(transcriptBytes.subarray(start));
		// We always serve to EOF, so the next offset base is the full size.
		sendFrame({ t: "transcript", reqId, text, newSize: total }, fromPeer);
	}

	/** Shows `draft` to every guest (and to guests that join later) until one answers. */
	function askGuests(draft: CollabUiRequestDraft): void {
		pendingAsk = { ...draft, reqId: nextReqId++ };
		sendFrame({ t: "ui-request", request: pendingAsk });
		broadcastState();
	}

	function handleUiResponse(reqId: number, value: string | undefined, fromPeer: number): void {
		if (pendingAsk === null || pendingAsk.reqId !== reqId) return;
		pendingAsk = null;
		sendFrame({ t: "ui-request-end", reqId });
		notice("info", value === undefined ? `${peerName(fromPeer)} cancelled the question` : `${peerName(fromPeer)} answered: ${value}`);
		broadcastState();
	}

	function handleFrame(frame: WireFrame, fromPeer: number): void {
		switch (frame.t) {
			case "hello":
				handleHello(frame.name, frame.proto, fromPeer);
				break;
			case "prompt":
				handlePrompt(frame.text, fromPeer);
				break;
			case "ui-response":
				handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "abort":
				handleAbort(fromPeer);
				break;
			case "agent-cmd":
				handleAgentCmd(frame.cmd, frame.agentId, fromPeer);
				break;
			case "fetch-transcript":
				handleFetchTranscript(frame.reqId, frame.fromByte, fromPeer);
				break;
			default:
				// Host-frame echoes or unknown types: ignore.
				break;
		}
	}

	function handleControl(text: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof msg !== "object" || msg === null) return;
		const control = msg as { t?: unknown; peer?: unknown };
		if (control.t === "peer-left" && typeof control.peer === "number") {
			const name = peers.get(control.peer);
			peers.delete(control.peer);
			if (name) log(`${name} left (peer ${control.peer})`);
			broadcastState();
		}
	}

	ws.onopen = () => resolveReady();

	ws.onmessage = event => {
		const data: unknown = event.data;
		if (typeof data === "string") {
			handleControl(data);
			return;
		}
		if (!(data instanceof ArrayBuffer)) return;
		const envelope = unpackEnvelope(new Uint8Array(data));
		if (!envelope) return;
		recvChain = recvChain
			.then(async () => {
				const frame = await open(key, envelope.payload);
				handleFrame(frame, envelope.peerId);
			})
			.catch((err: unknown) => {
				log(`dropping undecryptable frame: ${String(err)}`);
			});
	};

	ws.onclose = event => {
		const reason = `relay socket closed (${event.code} ${event.reason || "no reason"})`;
		rejectReady(new Error(reason));
		if (stopping) return;
		stopping = true;
		cancelReplay();
		clearInterval(tickInterval);
		options.onLost?.(reason);
	};

	// ── progress ticker ────────────────────────────────────────────────────────

	const tickInterval: Timer = setInterval(() => {
		tick++;
		if (options.agentTree) {
			for (const payload of makeTreeProgress(tick, agentModels, silentAgents)) {
				if (agents.find(agent => agent.id === payload.progress.id)?.status !== "running") continue;
				sendFrame({ t: "bus", channel: "task:subagent:progress", data: payload });
			}
		} else {
			const probe = makeProbeProgress(tick);
			const model = agentModels.get(probe.progress.id);
			if (model) probe.progress.resolvedModel = model;
			sendFrame({ t: "bus", channel: "task:subagent:progress", data: probe });
		}
		const now = Date.now();
		for (const agent of agents) {
			if (agent.status === "running" && !silentAgents.has(agent.id)) agent.lastActivity = now;
		}
		if (tick % AGENTS_SNAPSHOT_EVERY === 0) {
			sendFrame({ t: "agents", agents: agents.map(agent => ({ ...agent })) });
		}
	}, options.tickMs ?? DEFAULT_TICK_MS);

	ready.catch(() => {});

	return {
		roomId,
		linkFor: (publicRelayUrl, permission = "full") =>
			formatCollabLink(publicRelayUrl, roomId, rawKey, permission === "view" ? undefined : rawWriteToken),
		status: () => ({
			streaming,
			entryCount: entries.length,
			agentCount: agents.filter(agent => agent.kind === "sub").length,
			guests: peers.size,
			asking: pendingAsk !== null,
		}),
		participants: () => buildState().participants,
		ready,
		setAgentModel(agentId, model) {
			const agent = agents.find(candidate => candidate.id === agentId);
			if (!agent) return "unknown";
			if (agent.kind === "sub" && agent.status !== "running") return "not-live";
			agentModels.set(agentId, model);
			if (agent.kind === "main") broadcastState();
			return "ok";
		},
		abortTurn: () => abortTurn(),
		ask: draft => askGuests(draft),
		pendingUiRequest: () => pendingAsk,
		answerUiRequest(reqId, value) {
			if (pendingAsk === null || pendingAsk.reqId !== reqId) return false;
			handleUiResponse(reqId, value ?? undefined, 0);
			return true;
		},
		append: entry => appendEntry(entry),
		transcriptEntries: () => entries,
		rewindTo: entryId => rewindEntry(entryId),
		lastEntryId: () => lastEntryId,
		async stop(reason = "mock host shutting down"): Promise<void> {
			if (stopping) return;
			stopping = true;
			cancelReplay();
			clearInterval(tickInterval);
			sendFrame({ t: "bye", reason });
			// Let the bye flush through the send chain before tearing the room down.
			await sendChain;
			try {
				ws.close(1000);
			} catch {
				// already closing
			}
		},
	};
}
