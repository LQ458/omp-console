/**
 * Mock omp console daemon for developing and testing the web UI without the real daemon.
 *
 * One `Bun.serve` mounts, like the real daemon: the control API under `/api` (contract in
 * `@omp-console/protocol`), the content-blind relay under `/r/<roomId>`, and optionally the built web
 * assets (`--dist dist`). Every "live session" is backed by a scripted fixture host room
 * (`mock-room.ts`), so the transcript, streaming turn, tool cards, subagents and prompts work.
 *
 * Simulated, not real: `goalActive` of the first seeded session (the goal and todo panels read real
 * `goal`/`todo` tool results in its transcript), and `stalled` (flip with `POST /mock/stall/<id>`).
 * "Docs sweep" waits on a real host question from the start. `POST /mock/ask/<id>` raises the sample
 * question again and `POST /mock/todo/<id>` appends a later todo board, to watch the needs-you bar and
 * the status sheet react.
 *
 *   bun dev/mock-daemon.ts [--port 7711] [--dist dist] [--features all|<feature,...>] [--deny] [--unpaired] [--pair-rate-limited]
 *
 * `--unpaired` starts with no device and a mock one-time code `ABCD-2345`.
 * `--pair-rate-limited` makes `POST /api/pair` return HTTP 429 for UI error testing.
 * `--deny` answers every `/api` request 401, to exercise the not-authorized UI state.
 * `--fixtures` adds the `bench-50k` and `bench-stream` rooms used by `bench/run-headless.ts`.
 * `--agent-tree` adds the `agent-tree` room (nested spawn tree with mixed outcomes, see `agent-tree-fixture.ts`).
 * The Settings config routes (`GET/PUT /api/config`, `POST /api/daemon/restart`) and model/profile routes (`/api/models`, `/api/profiles`,
 * `PUT /api/profiles/:name/model`, `PUT /api/model-roles/:role`, `POST /api/sessions/:id/agents/:agentId/model`,
 * `POST /api/sessions/:id/abort`) are backed by in-memory mocks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AbortSessionResponse,
	ApiError,
	CreateSessionRequest,
	DaemonCapabilities,
	DaemonHealth,
	DaemonConfigFeatureStatus,
	DaemonConfigFile,
	DaemonConfigResponse,
	OptionalFeatureName,
	KeybindingsResponse,
	ListSessionsResponse,
	OvernightEvent,
	OvernightPhase,
	OvernightPolicy,
	OvernightState,
	OvernightTemplate,
	PeersResponse,
	PreflightCheck,
	QuickAskSource,
	RoomLinkResponse,
	SessionSummary,
	LiveModeStatus,
	SetAgentModelRequest,
	SetAgentModelResponse,
	SetModelRoleRequest,
	SetProfileModelRequest,
	SetupResponse,
	SleepSettingsRequest,
	SleepSettingsResponse,
	WorkerHealth,
} from "@omp-console/protocol";
import { LIVE_INPUT_MAX_FRAME_BYTES } from "@omp-console/protocol";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { DEFAULT_OVERNIGHT_TEMPLATE, nextLocalDeadline, validateOvernightTemplate } from "../src/lib/overnight";
import { DEFAULT_TRANSCRIPT_LINES, makeTranscript } from "../bench/make-transcript";
import { AGENT_TREE_SESSION_ID } from "./agent-tree-fixture";
import { fixtureEntries, makeGoalAndTodoEntries, makeTodoAdvanceEntry } from "./fixture";
import { createRelay, type SocketData } from "./local-relay";
import { createComposerMock } from "./mock-composer";
import { MockConfig } from "./mock-config";
import { handleControlsMock } from "./mock-controls";
import { createPanelsMock } from "./mock-panels";
import { createSessionOpsMock } from "./mock-session-ops";
import { createWorkspacesMock } from "./mock-workspaces";
import { handlePanesMock, paneFixtures } from "./mock-panes";
import { createGraphMock } from "./mock-graph";
import { createLibrarianMock } from "./mock-librarian";
import { type MockRoom, type MockRoomOptions, startMockRoom } from "./mock-room";

/** The question the seeded "Docs sweep" session (and `POST /mock/ask/<id>`) puts to guests. */
const DOCS_SWEEP_ASK: CollabUiRequestDraft = {
	kind: "select",
	title: "Plan review\n1. Update the stale close-code guidance\n2. Keep examples aligned with the current protocol",
	options: [
		{ label: "Yes, rewrite them", description: "Edit docs/collab.md and docs/collab-protocol.md" },
		{ label: "Only report mismatches" },
		{ label: "No, stop here" },
	],
	selectionMarker: "radio",
	initialIndex: 1,
};
const GOAL_OBJECTIVE = "Make the guest socket recover after a relay redeploy, with a regression test";

const MOCK_KEYBINDINGS: KeybindingsResponse = {
	bindings: {
		"app.interrupt": ["escape"],
		"app.thinking.cycle": ["shift+tab"],
		"app.model.cycleForward": ["ctrl+p"],
		"app.model.cycleBackward": ["ctrl+shift+p"],
		"app.model.select": ["alt+m"],
		"app.model.selectTemporary": ["alt+p"],
		"app.plan.toggle": ["alt+shift+p"],
		"app.history.search": ["ctrl+r"],
		"app.tools.expand": ["ctrl+o"],
		"app.thinking.toggle": ["ctrl+t"],
		"app.approval.approve": ["ctrl+enter"],
		"app.message.dequeue": ["alt+up"],
		"app.retry": ["f5", "alt+r"],
		"app.agents.hub": ["alt+a"],
		"app.clipboard.copyPrompt": ["alt+shift+c"],
	},
	doubleEscapeAction: "rewind",
};
type MockFeature = keyof DaemonCapabilities["features"];
const MOCK_FEATURES: readonly MockFeature[] = [
	"librarian",
	"agenda",
	"quickAsk",
	"peers",
	"openrouterDecisions",
	"computerUse",
	"overnight",
];
const MOCK_QUICK_ASK_SOURCES: readonly QuickAskSource[] = ["siyuan", "repo", "web", "history"];
const MOCK_PEERS: PeersResponse = {
	self: { id: "local", name: "Local" },
	peers: [{ id: "example-host", name: "Example host", reachable: false, reason: "mock peer" }],
};


function mockFeatureStatuses(
	file: DaemonConfigFile,
	capabilities: DaemonCapabilities,
): Record<OptionalFeatureName, DaemonConfigFeatureStatus> {
	const get = (name: OptionalFeatureName): DaemonConfigFeatureStatus => {
		const missing = (() => {
			switch (name) {
				case "librarian":
					return [
						...(file.knowledgeRoot === undefined ? ["Notes folder"] : []),
						...(file.projectRoots?.length ? [] : ["at least one Project folder"]),
					];
				case "agenda":
					return file.agendaHub === undefined ? ["task board folder"] : [];
				case "quickAsk":
					return [
						...(file.knowledgeRoot === undefined ? ["Notes folder"] : []),
						...(file.quickAsk?.sources?.length ? [] : ["a source for Ask your notes"]),
					];
				case "peers":
					return (file.peers ?? []).flatMap(peer => peer.tokenFile === undefined ? [`Other computer token file for ${peer.id}`] : []);
				case "openrouterDecisions":
					return capabilities.features.librarian ? [] : ["Project search"];
				case "computerUse":
					return [];
				case "overnight":
					return [];
			}
		})();
		return {
			configured: file.features?.[name] === true,
			effective: capabilities.features[name],
			missing,
			overriddenByFlag: false,
		};
	};
	return {
		librarian: get("librarian"),
		agenda: get("agenda"),
		quickAsk: get("quickAsk"),
		peers: get("peers"),
		openrouterDecisions: get("openrouterDecisions"),
		computerUse: get("computerUse"),
		overnight: get("overnight"),
	};
}
const DEFAULT_PORT = 7711;
const STALLED_AFTER_MS = 60_000;
/** Session ids of the `fixtures` rooms; `bench/run-headless.ts` opens `/?bench#session=<id>`. */
export const BENCH_TRANSCRIPT_SESSION_ID = "bench-50k";
export const BENCH_STREAM_SESSION_ID = "bench-stream";

interface LiveSession {
	summary: SessionSummary;
	room: MockRoom;
	simulated: { awaitingAnswer: boolean; goalActive: boolean };
	stalled: boolean;
	pid: number;
	startedAt: number;
}
interface MockDevice {
	id: string;
	label: string;
	createdAt: number;
	lastSeenAt: number;
}

export interface MockDaemonOptions {
	port?: number;
	/** Directory of built web assets to serve at `/`. */
	dist?: string;
	/** Answer every `/api` request with 401. */
	deny?: boolean;
	/** Start without a paired browser so the pairing flow can be exercised (`ABCD-2345`). */
	paired?: boolean;
	/** Return HTTP 429 from pairing requests to exercise the Pair screen's rate-limit error. */
	pairRateLimited?: boolean;
	/** Seed two live and three recent sessions (default true). */
	seed?: boolean;
	/**
	 * Also start the `?bench` fixture rooms: `bench-50k` (a 50k-line transcript) and `bench-stream`
	 * (a 100 tokens/s streaming turn). Open `/?bench#session=<id>`.
	 */
	fixtures?: boolean;
	/** Also start the `agent-tree` room: a root, three children and one grandchild with mixed outcomes. */
	agentTree?: boolean;
	/** Serve the workspace, rules, quick-ask, gate, drift and move mocks (`mock-workspaces.ts`) and seed a knowledge and a scratch session. */
	workspaces?: boolean;
	/** Expose selected optional features, or every feature with `all`. */
	features?: "all" | readonly MockFeature[];
	/** Also start six streaming sessions, `pane-1` .. `pane-6`, for the tiled-panes bench and screenshots. */
	panes?: boolean;
	log?: (message: string) => void;
}

export interface MockDaemon {
	url: string;
	/** Session ids currently live. */
	liveIds(): string[];
	stop(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOvernightTemplate(value: unknown): OvernightTemplate | null {
	if (!isRecord(value) || typeof value.prompt !== "string" || !isRecord(value.policy)) return null;
	const policy = value.policy;
	if (
		typeof policy.deadlineLocalTime !== "string" ||
		typeof policy.askTimeoutSec !== "number" ||
		(policy.quiet !== "normal" && policy.quiet !== "quiet" && policy.quiet !== "silent") ||
		typeof policy.maxIdleContinuations !== "number" ||
		typeof policy.keepAwake !== "boolean"
	) return null;
	const template: OvernightTemplate = {
		prompt: value.prompt,
		policy: {
			deadlineLocalTime: policy.deadlineLocalTime,
			askTimeoutSec: policy.askTimeoutSec,
			quiet: policy.quiet,
			maxIdleContinuations: policy.maxIdleContinuations,
			keepAwake: policy.keepAwake,
		},
	};
	return validateOvernightTemplate(template).length === 0 ? template : null;
}

interface NormalizedOvernightRequest {
	task: string;
	prompt: string;
	policy: OvernightPolicy;
}

function parseStartOvernightRequest(value: unknown, template: OvernightTemplate): NormalizedOvernightRequest | null {
	if (!isRecord(value) || typeof value.task !== "string" || value.task.trim() === "") return null;
	if (value.prompt !== undefined && typeof value.prompt !== "string") return null;
	if (typeof value.prompt === "string" && value.prompt.trim() === "") return null;
	const overrides: Partial<OvernightPolicy> = {};
	if (value.policy !== undefined) {
		if (!isRecord(value.policy)) return null;
		const policy = value.policy;
		if (policy.deadline !== undefined) {
			if (
				typeof policy.deadline !== "string" ||
				!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(policy.deadline) ||
				!Number.isFinite(Date.parse(policy.deadline))
			) return null;
			overrides.deadline = policy.deadline;
		}
		if (policy.askTimeoutSec !== undefined) {
			if (!Number.isSafeInteger(policy.askTimeoutSec) || (policy.askTimeoutSec as number) < 1) return null;
			overrides.askTimeoutSec = policy.askTimeoutSec as number;
		}
		if (policy.quiet !== undefined) {
			if (policy.quiet !== "normal" && policy.quiet !== "quiet" && policy.quiet !== "silent") return null;
			overrides.quiet = policy.quiet;
		}
		if (policy.maxIdleContinuations !== undefined) {
			if (!Number.isSafeInteger(policy.maxIdleContinuations) || (policy.maxIdleContinuations as number) < 0) return null;
			overrides.maxIdleContinuations = policy.maxIdleContinuations as number;
		}
		if (policy.keepAwake !== undefined) {
			if (typeof policy.keepAwake !== "boolean") return null;
			overrides.keepAwake = policy.keepAwake;
		}
	}
	return {
		task: value.task.trim(),
		prompt: typeof value.prompt === "string" ? value.prompt : template.prompt,
		policy: {
			deadline: overrides.deadline ?? nextLocalDeadline(template.policy.deadlineLocalTime),
			askTimeoutSec: overrides.askTimeoutSec ?? template.policy.askTimeoutSec,
			quiet: overrides.quiet ?? template.policy.quiet,
			maxIdleContinuations: overrides.maxIdleContinuations ?? template.policy.maxIdleContinuations,
			keepAwake: overrides.keepAwake ?? template.policy.keepAwake,
		},
	};
}

const OVERNIGHT_TRANSITIONS: readonly { phase: OvernightPhase; kind: OvernightEvent["kind"]; detail: string; waitMs: number }[] = [
	{ phase: "continuing", kind: "continue", detail: "The first turn ended early; the mock controller continued the task.", waitMs: 850 },
	{ phase: "waiting-retry", kind: "retry-wait", detail: "A simulated transient error is waiting before retry.", waitMs: 850 },
	{ phase: "running", kind: "continue", detail: "The retry window ended and work resumed.", waitMs: 850 },
	{ phase: "complete", kind: "complete", detail: "The simulated overnight task is complete.", waitMs: 0 },
];

function mockLiveSocketId(socket: Bun.ServerWebSocket<SocketData>): string | undefined {
	const sessionId = (socket.data as SocketData & { liveSessionId?: unknown }).liveSessionId;
	return typeof sessionId === "string" ? sessionId : undefined;
}

export async function startMockDaemon(options: MockDaemonOptions = {}): Promise<MockDaemon> {
	const enabledFeatures = new Set(options.features === "all" ? MOCK_FEATURES : (options.features ?? []));
	const capabilities: DaemonCapabilities = {
		features: {
			librarian: enabledFeatures.has("librarian"),
			agenda: enabledFeatures.has("agenda"),
			quickAsk: enabledFeatures.has("quickAsk"),
			peers: enabledFeatures.has("peers"),
			openrouterDecisions: enabledFeatures.has("openrouterDecisions"),
			computerUse: enabledFeatures.has("computerUse"),
			overnight: enabledFeatures.has("overnight"),
		},
		quickAskSources: enabledFeatures.has("quickAsk") ? [...MOCK_QUICK_ASK_SOURCES] : [],
	};

	let configFile: DaemonConfigFile = {
		features: Object.fromEntries(MOCK_FEATURES.map(name => [name, enabledFeatures.has(name)])) as Partial<Record<OptionalFeatureName, boolean>>,
		scheduleFile: "/mock/schedules.toml",
		quickAsk: { sources: enabledFeatures.has("quickAsk") ? [...MOCK_QUICK_ASK_SOURCES] : [] },
		...(enabledFeatures.has("librarian") || enabledFeatures.has("quickAsk") ? { knowledgeRoot: "/mock/knowledge" } : {}),
		...(enabledFeatures.has("librarian") ? { projectRoots: ["/mock/project"] } : {}),
		...(enabledFeatures.has("agenda") ? { agendaHub: "/mock/tasks-hub" } : {}),
		...(enabledFeatures.has("peers") ? { peers: [{ id: "example-host", name: "Example host", url: "https://peer.example", tokenFile: "/mock/peer-token" }] } : {}),
	};
	let restartUnavailableUntil = 0;
	function applyConfiguredFeatures(): void {
		const librarian = configFile.features?.librarian === true &&
			configFile.knowledgeRoot !== undefined &&
			(configFile.projectRoots?.length ?? 0) > 0;
		const agenda = configFile.features?.agenda === true && configFile.agendaHub !== undefined;
		const quickAsk = configFile.features?.quickAsk === true &&
			configFile.knowledgeRoot !== undefined &&
			(configFile.quickAsk?.sources?.length ?? 0) > 0;
		const peers = configFile.features?.peers === true &&
			(configFile.peers ?? []).every(peer => peer.tokenFile !== undefined);
		capabilities.features = {
			...capabilities.features,
			librarian,
			agenda,
			quickAsk,
			peers,
			openrouterDecisions: configFile.features?.openrouterDecisions === true && librarian,
			computerUse: configFile.features?.computerUse === true,
			overnight: configFile.features?.overnight === true,
		};
		capabilities.quickAskSources = quickAsk ? [...(configFile.quickAsk?.sources ?? [])] : [];
	}
	const hasOptionalFeature = Object.entries(capabilities.features).some(([name, enabled]) => name !== "overnight" && enabled);
	const log = options.log ?? (() => {});
	let paired = options.paired ?? true;
	let currentPairingCode = paired ? undefined : "ABCD-2345";
	const initialDeviceTime = Date.now();
	const devices: MockDevice[] = paired
		? [
				{ id: "mock-current", label: "Mock browser", createdAt: initialDeviceTime - 60_000, lastSeenAt: initialDeviceTime },
				{ id: "mock-other", label: "Phone", createdAt: initialDeviceTime - 86_400_000, lastSeenAt: initialDeviceTime - 60_000 },
			]
		: [];
	let currentDeviceId = paired ? "mock-current" : "";
	const live = new Map<string, LiveSession>();
	const liveSockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
	const relay = createRelay();
	const liveFrameBudget = new WeakMap<Bun.ServerWebSocket<SocketData>, { tokens: number; at: number; levelAt: number }>();
	const recent: SessionSummary[] = [];
	const overnightStates = new Map<string, OvernightState>();
	const overnightProgress = new Map<string, { stage: number; nextAt: number }>();
	let overnightTemplate: OvernightTemplate = structuredClone(DEFAULT_OVERNIGHT_TEMPLATE);
	let overnightTicker: Timer | undefined;
	let sleepMinutes = 120;
	let nextPid = 41_000;
	let internalUrl = "";
	const daemonStartedAt = Date.now();
	const config = new MockConfig();
	const composerMock = createComposerMock();
	const panelsMock = createPanelsMock();
	const sessionOpsMock = createSessionOpsMock({
		getSession(id) {
			const session = live.get(id);
			if (!session) return undefined;
			return {
				summary: session.summary,
				room: session.room,
				setGoal(active, objective) {
					session.simulated.goalActive = active;
					session.summary.goalActive = active;
					session.summary.goalObjective = objective;
				},
				setLoopMode(status) {
					session.summary.loopMode = status;
				},
				setVibeMode(status) {
					session.summary.vibeMode = status;
				},
			};
		},
		onLiveMode(sessionId, status) {
			liveSockets.get(sessionId)?.send(JSON.stringify({ t: "state", liveMode: status }));
		},
	});
	const workspacesMock = options.workspaces || hasOptionalFeature
		? createWorkspacesMock({
				sessions: () => [...live.values()].map(summaryOf),
				quickAskSources: capabilities.quickAskSources,
				startSession: async (cwd, title, entries) =>
					summaryOf(await startSession(cwd, title, undefined, undefined, { awaitingAnswer: false, goalActive: false }, { entries })),
			})
		: undefined;
	const graphMock = createGraphMock();
	const librarianMock = createLibrarianMock({
		sessions: () => ({ live: [...live.values()].map(summaryOf), recent: [...recent] }),
	});

	function recentSummary(cwd: string, title: string, ageMs: number): SessionSummary {
		const id = crypto.randomUUID();
		const at = Date.now() - ageMs;
		return {
			id,
			title,
			cwd,
			sessionFile: `${cwd}/.omp/sessions/${id}.jsonl`,
			model: "claude-sonnet-5-5",
			thinkingLevel: "medium",
			state: "stopped",
			createdAt: at - 3_600_000,
			lastActivityAt: at,
			agentCount: 0,
			goalActive: false,
			awaitingAnswer: false,
		};
	}

	async function startSession(
		cwd: string,
		title: string,
		model: string | undefined,
		sessionFile: string | undefined,
		simulated: LiveSession["simulated"],
		fixture: Pick<MockRoomOptions, "entries" | "stream" | "ask" | "agentTree"> & { id?: string } = {},
	): Promise<LiveSession> {
		const id = fixture.id ?? crypto.randomUUID();
		const room = await startMockRoom({
			relayUrl: internalUrl,
			title,
			cwd,
			sessionId: id,
			entries: fixture.entries,
			stream: fixture.stream,
			ask: fixture.ask,
			agentTree: fixture.agentTree,
			log: message => log(`[${title}] ${message}`),
			onLost: reason => {
				log(`[${title}] ${reason}`);
				live.delete(id);
			},
		});
		await room.ready;
		const now = Date.now();
		const session: LiveSession = {
			summary: {
				id,
				title,
				cwd,
				sessionFile: sessionFile ?? `${cwd}/.omp/sessions/${id}.jsonl`,
				model: model ?? "claude-sonnet-5-5",
				thinkingLevel: "medium",
				state: "idle",
				createdAt: now,
				lastActivityAt: now,
				roomId: room.roomId,
				rootAgentId: "Main",
				agentCount: 0,
				goalActive: false,
				awaitingAnswer: false,
			},
			room,
			simulated,
			stalled: false,
			pid: nextPid++,
			startedAt: now,
		};
		live.set(id, session);
		return session;
	}

	function mockMorningReport(phase: OvernightPhase): string {
		const done = phase === "complete" ? "The mock Overnight run completed." : "The Overnight run stopped; the session remains available for normal work.";
		return [
			"# Morning report",
			"",
			"## Done",
			done,
			"",
			"## Verified",
			"Observed running → continuing → waiting-retry → running → complete in the mock controller.",
			"",
			"## Decisions",
			"None.",
			"",
			"## Blockers",
			"None.",
			"",
			"## Next",
			"Review the session transcript and continue any remaining work.",
		].join("\n");
	}

	function changeOvernightPhase(
		sessionId: string,
		phase: OvernightPhase,
		kind: OvernightEvent["kind"],
		detail: string,
		nextActionAt?: number,
	): OvernightState | null {
		const current = overnightStates.get(sessionId);
		if (!current) return null;
		const at = Date.now();
		const next: OvernightState = {
			...current,
			phase,
			continuations: current.continuations + (phase === "continuing" ? 1 : 0),
			nextActionAt,
			events: [...current.events, { at, kind, detail }].slice(-500),
		};
		if (phase === "complete" || phase === "stopped") next.report = mockMorningReport(phase);
		overnightStates.set(sessionId, next);
		return next;
	}

	function advanceOvernightRuns(): void {
		const now = Date.now();
		for (const [sessionId, progress] of overnightProgress) {
			if (now < progress.nextAt) continue;
			const transition = OVERNIGHT_TRANSITIONS[progress.stage];
			if (!transition) {
				overnightProgress.delete(sessionId);
				continue;
			}
			changeOvernightPhase(
				sessionId,
				transition.phase,
				transition.kind,
				transition.detail,
				transition.phase === "waiting-retry" ? now + transition.waitMs : undefined,
			);
			if (transition.phase === "complete") overnightProgress.delete(sessionId);
			else overnightProgress.set(sessionId, { stage: progress.stage + 1, nextAt: now + transition.waitMs });
		}
		if (overnightProgress.size === 0 && overnightTicker !== undefined) {
			clearInterval(overnightTicker);
			overnightTicker = undefined;
		}
	}

	function beginOvernight(sessionId: string, request: NormalizedOvernightRequest): OvernightState {
		const now = Date.now();
		const state: OvernightState = {
			sessionId,
			startedAt: now,
			policy: request.policy,
			phase: "running",
			continuations: 0,
			idleContinuations: 0,
			events: [{ at: now, kind: "start", detail: `Started overnight task: ${request.task}` }],
		};
		overnightStates.set(sessionId, state);
		overnightProgress.set(sessionId, { stage: 0, nextAt: now + 650 });
		if (overnightTicker === undefined) overnightTicker = setInterval(advanceOvernightRuns, 100);
		return state;
	}

	/** Live summary refreshed from the room at request time. */
	function summaryOf(session: LiveSession): SessionSummary {
		const status = session.room.status();
		const simulatedState = session.simulated.awaitingAnswer || status.asking ? "asking" : undefined;
		const awaitingAnswer = session.simulated.awaitingAnswer || status.asking;
		const overnightState = overnightStates.get(session.summary.id);
		const summary: SessionSummary = {
			...session.summary,
			state: status.streaming ? "streaming" : (simulatedState ?? "idle"),
			agentCount: status.agentCount,
			goalActive: session.simulated.goalActive,
			goalObjective: session.simulated.goalActive ? (session.summary.goalObjective ?? GOAL_OBJECTIVE) : undefined,
			awaitingAnswer,
			pendingQuestion: awaitingAnswer ? DOCS_SWEEP_ASK.title : undefined,
			pendingKind: awaitingAnswer ? "ask" : undefined,
			lastActivityAt: status.streaming ? Date.now() : session.summary.lastActivityAt,
			overnight: overnightState === undefined
				? undefined
				: { phase: overnightState.phase, deadline: overnightState.policy.deadline, continuations: overnightState.continuations },
		};
		return workspacesMock?.decorate(summary) ?? summary;
	}

	function publicRelayUrl(req: Request): string {
		const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
		const secure = req.headers.get("x-forwarded-proto") === "https";
		return `${secure ? "wss" : "ws"}://${host}`;
	}

	async function createSession(body: CreateSessionRequest): Promise<Response> {
		if (typeof body.cwd !== "string" || body.cwd.trim() === "") return fail(400, "bad-request", "cwd is required");
		const cwd = body.cwd.trim();
		let overnightRequest: NormalizedOvernightRequest | null = null;
		if (body.overnight !== undefined) {
			if (!capabilities.features.overnight) return fail(400, "bad-request", "Overnight run is off. Turn it on in Settings → Advanced → Optional features, then restart the daemon.");
			overnightRequest = parseStartOvernightRequest(body.overnight, overnightTemplate);
			if (overnightRequest === null) return fail(400, "bad-request", "The Overnight run task or settings are invalid.");
		}
		const label = path.basename(cwd) || cwd;
		let title = label;
		let sessionFile: string | undefined;
		if (body.resumeSessionFile) {
			const index = recent.findIndex(s => s.sessionFile === body.resumeSessionFile);
			const found = index >= 0 ? recent.splice(index, 1)[0] : undefined;
			title = found?.title ?? label;
			sessionFile = body.resumeSessionFile;
		} else if (body.forkFrom) {
			const source = [...recent, ...[...live.values()].map(s => s.summary)].find(
				s => s.sessionFile === body.forkFrom?.sessionFile,
			);
			title = `${source?.title ?? label} (fork)`;
		}
		const session = await startSession(cwd, title, body.model, sessionFile, {
			awaitingAnswer: false,
			goalActive: false,
		});
		if (overnightRequest !== null) beginOvernight(session.summary.id, overnightRequest);
		return json(summaryOf(session));
	}

	function health(): DaemonHealth {
		const workers: WorkerHealth[] = [...live.values()].map(s => ({
			sessionId: s.summary.id,
			pid: s.pid,
			state: summaryOf(s).state,
			rssBytes: 310 * 1024 * 1024,
			startedAt: s.startedAt,
			lastEventAt: s.stalled ? Date.now() - STALLED_AFTER_MS * 2 : Date.now(),
			stalled: s.stalled,
			restarts: 0,
		}));
		return { version: 1, startedAt: daemonStartedAt, workers, guests: 0, stalledAfterMs: STALLED_AFTER_MS };
	}

	function agentModelRoute(session: LiveSession, agentId: string, body: unknown): Response {
		const selector = (body as Partial<SetAgentModelRequest> | null)?.selector;
		if (typeof selector !== "string" || selector.trim() === "") return fail(400, "bad-request", "selector is required");
		const resolved = config.resolve(selector);
		if (!resolved.ok) return fail(400, "bad-request", resolved.message);
		const outcome = session.room.setAgentModel(agentId, resolved.model);
		if (outcome === "unknown") return fail(404, "not-found", `no agent ${agentId} in this session`);
		if (outcome === "not-live") return fail(409, "conflict", `agent ${agentId} has no live session`);
		const response: SetAgentModelResponse = { agentId, model: resolved.model };
		return json(response);
	}

	async function handleApi(req: Request, url: URL): Promise<Response> {
		if (options.deny) return fail(401, "unauthorized", "owner identity required");
		const route = url.pathname.slice("/api".length);
		const method = req.method;
		if (route === "/pair/status" && method === "GET") {
			return new Response(JSON.stringify({ paired }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
		}
		if (route === "/pair" && method === "POST") {
			if (options.pairRateLimited) return fail(429, "bad-request", "Too many pairing attempts. Wait a minute before trying again.");
			const input: unknown = await req.json().catch(() => null);
			if (!isRecord(input) || typeof input.code !== "string" || typeof input.label !== "string") {
				return fail(400, "bad-request", "Pairing request must include a code and device label.");
			}
			if (currentPairingCode === undefined) {
				return new Response(JSON.stringify({ code: "expired", error: "This pairing code expired or was already used." }), {
					status: 410,
					headers: { "content-type": "application/json", "cache-control": "no-store" },
				});
			}
			if (input.code.replaceAll("-", "").toUpperCase() !== currentPairingCode.replaceAll("-", "")) {
				return fail(400, "bad-request", "That pairing code is incorrect.");
			}
			if (input.label.trim().length === 0 || input.label.length > 100) {
				return fail(400, "bad-request", "Device label must be 1–100 characters.");
			}
			currentPairingCode = undefined;
			const now = Date.now();
			const device: MockDevice = {
				id: `mock-${crypto.randomUUID()}`,
				label: input.label.trim(),
				createdAt: now,
				lastSeenAt: now,
			};
			devices.push(device);
			if (!paired) currentDeviceId = device.id;
			paired = true;
			return new Response(JSON.stringify({ deviceId: device.id }), {
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
					"set-cookie": "omc_device=mock-paired; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000",
				},
			});
		}
		if (!paired) return fail(401, "unauthorized", "device pairing required");
		if (route === "/setup" && method === "GET") {
			const agentDir = "/Users/alice/.omp/agent";
			const response: SetupResponse = {
				omp: { found: true, path: "/Users/alice/.bun/bin/omp", version: "18.13.2", error: null },
				models: { availableCount: 2, defaultModel: "anthropic/claude-sonnet-4-5", error: null },
				sessions: { agentDir, count: recent.length + live.size, error: null },
				ompSetup: {
					agentDir,
					defaultAgentDir: agentDir,
					usesDefaultAgentDir: true,
					defaultModel: "anthropic/claude-sonnet-4-5",
					modelRoles: 2,
					skills: 1,
					extensions: 1,
					mcpServers: 0,
					error: null,
				},
				envKeys: ["ANTHROPIC_API_KEY"],
			};
			return json(response);
		}
		const overnightRoute = route === "/overnight/template" ||
			route === "/overnight/preflight" ||
			/^\/sessions\/[^/]+\/overnight$/.test(route);
		if (overnightRoute && !capabilities.features.overnight) {
			return fail(404, "not-found", "Overnight run is off.");
		}
		if (route === "/overnight/template") {
			if (method === "GET") return json(structuredClone(overnightTemplate));
			if (method === "PUT") {
				const input: unknown = await req.json().catch(() => null);
				const next = parseOvernightTemplate(input);
				if (next === null) return fail(400, "bad-request", "overnight template fields are invalid");
				overnightTemplate = next;
				return json(structuredClone(overnightTemplate));
			}
		}
		if (route === "/overnight/preflight" && method === "GET") {
			const cwd = url.searchParams.get("cwd") ?? "";
			const scenario = url.searchParams.get("scenario") ?? "mixed";
			const validCwd = path.isAbsolute(cwd);
			const checks: PreflightCheck[] = [
				{
					id: "workspace",
					label: "Workspace",
					status: !validCwd || scenario === "fail" ? "fail" : "ok",
					detail: validCwd ? `Ready to run in ${cwd}.` : "Choose an absolute working directory.",
					...(!validCwd || scenario === "fail" ? { fix: "Select a reachable absolute workspace path." } : {}),
				},
				{
					id: "access",
					label: "Access",
					status: scenario === "mixed" || scenario === "warn" ? "warn" : "ok",
					detail: "No interactive permission prompt is simulated.",
					...(scenario === "mixed" || scenario === "warn" ? { fix: "Review access requirements before leaving the run unattended." } : {}),
				},
				{ id: "daemon", label: "Daemon", status: "ok", detail: "The mock daemon is reachable." },
			];
			return json({ checks });
		}
		if (route === "/devices" && method === "GET") {
			return new Response(JSON.stringify({ devices: [...devices], currentDeviceId }), {
				headers: { "content-type": "application/json", "cache-control": "no-store" },
			});
		}
		if (route === "/pair/code" && method === "POST") {
			currentPairingCode = "WXYZ-6789";
			return new Response(JSON.stringify({ code: currentPairingCode, expiresAt: Date.now() + 10 * 60_000 }), {
				headers: { "content-type": "application/json", "cache-control": "no-store" },
			});
		}
		const revokeDevice = /^\/devices\/([^/]+)$/.exec(route);
		if (revokeDevice && method === "DELETE") {
			const id = decodeURIComponent(revokeDevice[1]!);
			const index = devices.findIndex(device => device.id === id);
			if (index < 0) return fail(404, "not-found", "Device not found.");
			devices.splice(index, 1);
			const loggedOut = id === currentDeviceId;
			if (loggedOut) {
				paired = false;
				currentDeviceId = "";
			}
			return new Response(JSON.stringify({ revoked: id, loggedOut }), {
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
					...(loggedOut ? { "set-cookie": "omc_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" } : {}),
				},
			});
		}
		if (route === "/config") {
			if (method === "GET") {
				const response: DaemonConfigResponse = {
					file: structuredClone(configFile),
					effective: structuredClone(capabilities),
					features: mockFeatureStatuses(configFile, capabilities),
					restart: { supported: true },
				};
				return json(response);
			}
			if (method === "PUT") {
				const input: unknown = await req.json().catch(() => null);
				if (!isRecord(input)) return fail(400, "bad-request", "config must be an object");
				configFile = input as unknown as DaemonConfigFile;
				return json({ restartRequired: true });
			}
		}
		if (route === "/daemon/restart" && method === "POST") {
			applyConfiguredFeatures();
			restartUnavailableUntil = Date.now() + 500;
			return json({ restarting: true }, 202);
		}
		if (route === "/capabilities" && method === "GET") {
			if (Date.now() < restartUnavailableUntil) return json({ error: "mock daemon restarting", code: "server" }, 503);
			return json(capabilities);
		}
		if (route === "/quick-ask" && !capabilities.features.quickAsk) return fail(404, "not-found", "unknown endpoint");
		if (route === "/peers" && method === "GET") return capabilities.features.peers ? json(MOCK_PEERS) : fail(404, "not-found", "unknown endpoint");
		if (route === "/settings/sleep") {
			if (method === "GET") {
				const response: SleepSettingsResponse = { minutes: sleepMinutes };
				return json(response);
			}
			if (method === "PUT") {
				const input: unknown = await req.json().catch(() => null);
				const minutes =
					typeof input === "object" && input !== null && !Array.isArray(input) && "minutes" in input
						? input.minutes
						: undefined;
				if (
					typeof minutes !== "number" ||
					!Number.isSafeInteger(minutes) ||
					minutes < 0 ||
					minutes > Math.floor(Number.MAX_SAFE_INTEGER / 60_000)
				) {
					return fail(400, "bad-request", "minutes must be a non-negative safe integer");
				}
				const request: SleepSettingsRequest = { minutes };
				sleepMinutes = request.minutes;
				const response: SleepSettingsResponse = { minutes: sleepMinutes };
				return json(response);
			}
		}
		if (route === "/health" && method === "GET") return json(health());
		if (route === "/keybindings" && method === "GET") return json(MOCK_KEYBINDINGS);
		if (route === "/sessions" && method === "GET") {
			const body: ListSessionsResponse = {
				live: [...live.values()].map(summaryOf),
				recent: [...recent].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
			};
			return json(body);
		}
		if (route === "/sessions" && method === "POST") {
			let body: CreateSessionRequest;
			try {
				body = (await req.json()) as CreateSessionRequest;
			} catch {
				return fail(400, "bad-request", "invalid JSON body");
			}
			return createSession(body);
		}
		const overnightSessionRoute = /^\/sessions\/([^/]+)\/overnight$/.exec(route);
		if (overnightSessionRoute) {
			const sessionId = decodeURIComponent(overnightSessionRoute[1]!);
			if (method === "GET") {
				const state = overnightStates.get(sessionId);
				return state ? json(state) : fail(404, "not-found", "session has never been overnight");
			}
			if (method === "POST") {
				const session = live.get(sessionId);
				if (!session) return fail(404, "not-found", "no such live session");
				const status = session.room.status();
				if (status.streaming || status.asking) return fail(409, "conflict", "session is busy; finish or stop the current turn first");
				const input: unknown = await req.json().catch(() => null);
				const request = parseStartOvernightRequest(input, overnightTemplate);
				if (request === null) return fail(400, "bad-request", "overnight task or policy is invalid");
				const current = overnightStates.get(sessionId);
				if (current && !["complete", "deadline", "blocked", "stopped"].includes(current.phase)) {
					return fail(409, "conflict", "An Overnight run is already active for this session.");
				}
				return json(beginOvernight(sessionId, request));
			}
			if (method === "DELETE") {
				if (!overnightStates.has(sessionId)) return fail(404, "not-found", "This session has no Overnight run history.");
				overnightProgress.delete(sessionId);
				const state = changeOvernightPhase(sessionId, "stopped", "stopped", "The user stopped the Overnight run; the session remains available.");
				return state === null ? fail(404, "not-found", "This session has no Overnight run history.") : json(state);
			}
		}
		const abortSession = /^\/sessions\/([^/]+)\/abort$/.exec(route);
		if (abortSession && method === "POST") {
			const session = live.get(decodeURIComponent(abortSession[1]!));
			if (!session) return fail(404, "not-found", "no such live session");
			if (!session.room.abortTurn()) return fail(409, "conflict", "no turn is running");
			const response: AbortSessionResponse = { aborted: true };
			return json(response, 202);
		}

		if (sessionOpsMock.owns(req, route)) return sessionOpsMock.handle(req, route);
		const workspaceResponse = await workspacesMock?.handle(req, route);
		if (workspaceResponse) return workspaceResponse;
		const composerResponse = await composerMock.handle(req, route, id => live.has(id));
		if (composerResponse) return composerResponse;
		const panesResponse = await handlePanesMock(req, route, { hasSession: id => live.has(id) });
		if (panesResponse) return panesResponse;
		if (route === "/models" && method === "GET") return json(config.models());
		if (route === "/profiles" && method === "GET") return json(config.profiles());
		const profileRoute = /^\/profiles\/([^/]+)\/model$/.exec(route);
		if (profileRoute && method === "PUT") {
			const name = decodeURIComponent(profileRoute[1]!);
			if (!config.hasProfile(name)) return fail(404, "not-found", `no profile ${name}`);
			const body = (await req.json().catch(() => null)) as Partial<SetProfileModelRequest> | null;
			if (body === null || (body.selector !== null && typeof body.selector !== "string")) {
				return fail(400, "bad-request", "selector must be a string or null");
			}
			if (body.selector === null || body.selector === undefined) {
				config.setProfileOverride(name, null);
				return new Response(null, { status: 204 });
			}
			const resolved = config.resolve(body.selector);
			if (!resolved.ok) return fail(400, "bad-request", resolved.message);
			config.setProfileOverride(name, resolved.model);
			return new Response(null, { status: 204 });
		}
		const roleRoute = /^\/model-roles\/([^/]+)$/.exec(route);
		if (roleRoute && method === "PUT") {
			const role = decodeURIComponent(roleRoute[1]!);
			if (!config.hasRole(role)) return fail(404, "not-found", `no model role ${role}`);
			const body = (await req.json().catch(() => null)) as Partial<SetModelRoleRequest> | null;
			if (typeof body?.selector !== "string") return fail(400, "bad-request", "selector is required");
			const resolved = config.resolve(body.selector);
			if (!resolved.ok) return fail(400, "bad-request", resolved.message);
			config.setRole(role, resolved.model);
			return new Response(null, { status: 204 });
		}
		const agentModel = /^\/sessions\/([^/]+)\/agents\/([^/]+)\/model$/.exec(route);
		if (agentModel && method === "POST") {
			const session = live.get(decodeURIComponent(agentModel[1]!));
			if (!session) return fail(404, "not-found", "no such live session");
			const body: unknown = await req.json().catch(() => null);
			return agentModelRoute(session, decodeURIComponent(agentModel[2]!), body);
		}
		const controls = await handleControlsMock(req, route, { hasSession: id => live.has(id), config });
		if (controls) return controls;
		const panels = await panelsMock(req, route, { hasSession: id => live.has(id), liveIds: () => [...live.keys()] });
		if (panels) return panels;
		if (route === "/push/subscribe" && method === "POST") return json({});
		const restartRoute = /^\/sessions\/([^/]+)\/restart$/.exec(route);
		if (restartRoute && method === "POST") {
			const session = live.get(decodeURIComponent(restartRoute[1]!));
			if (!session) return fail(404, "not-found", "no such live session");
			let restartAnyway = false;
			if (req.body !== null) {
				const body: unknown = await req.json().catch(() => null);
				if (!isRecord(body) || (body.restartAnyway !== undefined && typeof body.restartAnyway !== "boolean")) {
					return fail(400, "bad-request", "restartAnyway must be a boolean");
				}
				restartAnyway = body.restartAnyway === true;
			}
			const status = session.room.status();
			if ((status.streaming || status.asking) && !restartAnyway) {
				return fail(409, "conflict", "session is busy; confirm restartAnyway to abort the active turn");
			}
			if (status.streaming || status.asking) session.room.abortTurn();
			return json(summaryOf(session));
		}
		const sessionRoute = /^\/sessions\/([^/]+)(\/room)?$/.exec(route);
		if (sessionRoute) {
			const session = live.get(decodeURIComponent(sessionRoute[1]!));
			if (!session) return fail(404, "not-found", "no such live session");
			if (sessionRoute[2] === "/room" && method === "POST") {
				let permission: "full" | "view" = "view";
				if (req.body !== null) {
					const request: unknown = await req.json().catch(() => null);
					if (!isRecord(request) || (request.permission !== undefined && request.permission !== "full" && request.permission !== "view")) {
						return fail(400, "bad-request", 'permission must be "full" or "view"');
					}
					if (request.permission !== undefined) permission = request.permission;
				}
				const body: RoomLinkResponse = {
					roomId: session.room.roomId,
					link: session.room.linkFor(publicRelayUrl(req), permission),
					permission,
				};
				return json(body);
			}
			if (!sessionRoute[2] && method === "DELETE") {
				live.delete(session.summary.id);
				recent.unshift({ ...summaryOf(session), state: "stopped", roomId: undefined, agentCount: 0 });
				await session.room.stop("session stopped");
				return new Response(null, { status: 204 });
			}
		}
		const newSessionRoute =
			route === "/new-session/suggestions" ||
			route === "/new-session/paths" ||
			route === "/new-session/browse";
		if (newSessionRoute) {
			const response = await librarianMock.handle(req, route);
			if (response) return response;
		}
		const librarianRoute =
			route === "/cards" ||
			route === "/cards/refresh" ||
			route.startsWith("/cards/") ||
			route === "/brief";
		const agendaRoute = route.startsWith("/agenda/");
		if ((capabilities.features.librarian && librarianRoute) || (capabilities.features.agenda && agendaRoute)) {
			const librarianResponse = await librarianMock.handle(req, route);
			if (librarianResponse) return librarianResponse;
		}
		return (await graphMock.handle(req, route)) ?? fail(404, "not-found", "unknown endpoint");
	}

	function serveStatic(url: URL): Response {
		const root = options.dist ? path.resolve(options.dist) : null;
		if (!root) return new Response("not found", { status: 404 });
		const requested = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
		const inside = requested === root || requested.startsWith(root + path.sep);
		const file =
			inside && fs.existsSync(requested) && fs.statSync(requested).isFile()
				? requested
				: path.join(root, "index.html");
		const body = Bun.file(file);
		return new Response(body, { headers: { "content-type": body.type } });
	}

	const server = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		async fetch(req, srv) {
			const url = new URL(req.url);
			const liveRoute = /^\/live\/([^/]+)$/.exec(url.pathname);
			if (liveRoute) {
				if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
				let sessionId: string;
				try {
					sessionId = decodeURIComponent(liveRoute[1]!);
				} catch {
					return fail(400, "bad-request", "live session id is invalid");
				}
				if (!sessionId || !live.has(sessionId)) return fail(404, "not-found", "no such live session");
				const data = { roomId: "live", role: "guest" as const, peerId: 0, liveSessionId: sessionId } as SocketData;
				return srv.upgrade(req, { data }) ? undefined : new Response("websocket upgrade required", { status: 426 });
			}
			if (url.pathname.startsWith("/r/")) return relay.fetch(req, srv);
			if (url.pathname.startsWith("/api/")) return handleApi(req, url);
			const ask = /^\/mock\/ask\/([^/]+)$/.exec(url.pathname);
			if (ask && req.method === "POST") {
				const session = live.get(ask[1]!);
				if (!session) return fail(404, "not-found", "no such live session");
				session.room.ask(DOCS_SWEEP_ASK);
				return json({ asking: true });
			}
			const todo = /^\/mock\/todo\/([^/]+)$/.exec(url.pathname);
			if (todo && req.method === "POST") {
				const session = live.get(todo[1]!);
				if (!session) return fail(404, "not-found", "no such live session");
				session.room.append(makeTodoAdvanceEntry(session.room.lastEntryId()));
				return json({ appended: true });
			}
			const stall = /^\/mock\/stall\/([^/]+)$/.exec(url.pathname);
			if (stall && req.method === "POST") {
				const session = live.get(stall[1]!);
				if (!session) return fail(404, "not-found", "no such live session");
				session.stalled = !session.stalled;
				return json({ stalled: session.stalled });
			}
			return serveStatic(url);
		},
		websocket: {
			...relay.websocket,
			open(ws) {
				const sessionId = mockLiveSocketId(ws);
				if (sessionId === undefined) {
					relay.websocket.open?.(ws);
					return;
				}
				const previous = liveSockets.get(sessionId);
				if (previous && previous.readyState === WebSocket.OPEN) {
					ws.close(4009, "live session already has an owner stream");
					return;
				}
				liveSockets.set(sessionId, ws);
				liveFrameBudget.set(ws, { tokens: 10, at: performance.now(), levelAt: 0 });
				const session = live.get(sessionId);
				ws.send(JSON.stringify({ t: "state", liveMode: session?.summary.liveMode ?? { active: false, phase: "idle" } }));
			},
			message(ws, message) {
				const sessionId = mockLiveSocketId(ws);
				if (sessionId === undefined) {
					relay.websocket.message?.(ws, message);
					return;
				}
				const maxChars = Math.ceil(LIVE_INPUT_MAX_FRAME_BYTES / 3) * 4;
				if (typeof message !== "string" || Buffer.byteLength(message) > maxChars + 32) {
					ws.close(1009, "live audio frame too large");
					return;
				}
				let frame: unknown;
				try {
					frame = JSON.parse(message);
				} catch {
					ws.close(1003, "live audio messages must be JSON");
					return;
				}
				if (!isRecord(frame) || frame.t !== "audio" || typeof frame.data !== "string" || frame.data.length === 0 ||
					frame.data.length > maxChars || frame.data.length % 4 !== 0 ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
					ws.close(1008, "invalid live audio frame");
					return;
				}
				const now = performance.now();
				const budget = liveFrameBudget.get(ws) ?? { tokens: 10, at: now, levelAt: 0 };
				budget.tokens = Math.min(10, budget.tokens + ((now - budget.at) * 50) / 1000);
				budget.at = now;
				if (budget.tokens < 1) {
					ws.close(1008, "live audio frame rate exceeded");
					return;
				}
				budget.tokens -= 1;
				liveFrameBudget.set(ws, budget);
				const pcm = Buffer.from(frame.data, "base64");
				if (pcm.length === 0 || pcm.length > LIVE_INPUT_MAX_FRAME_BYTES || pcm.length % 4 !== 0 || pcm.length / 4 > 640) {
					ws.close(1008, "invalid live PCM frame size");
					return;
				}
				let sumSquares = 0;
				for (let offset = 0; offset < pcm.length; offset += 4) {
					const sample = pcm.readFloatLE(offset);
					if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
						ws.close(1008, "invalid live PCM sample");
						return;
					}
					sumSquares += sample * sample;
				}
				if (now - budget.levelAt >= 100) {
					budget.levelAt = now;
					ws.send(JSON.stringify({ t: "levels", input: Math.min(1, Math.sqrt(sumSquares / (pcm.length / 4))), output: 0 }));
				}
			},
			close(ws, code, reason) {
				const sessionId = mockLiveSocketId(ws);
				if (sessionId === undefined) {
					relay.websocket.close?.(ws, code, reason);
					return;
				}
				if (liveSockets.get(sessionId) === ws) liveSockets.delete(sessionId);
				const session = live.get(sessionId);
				if (session?.summary.liveMode?.active) {
					const status: LiveModeStatus = { active: false, phase: "idle" };
					session.summary.liveMode = status;
				}
			},
		},
	});
	internalUrl = `ws://127.0.0.1:${server.port}`;

	if (options.seed ?? true) {
		await startSession(
			"/Users/dev/relay",
			"Refactor relay backoff",
			"claude-opus-5-5",
			undefined,
			{ awaitingAnswer: false, goalActive: true },
			{ entries: [...fixtureEntries, ...makeGoalAndTodoEntries(fixtureEntries[fixtureEntries.length - 1]?.id ?? null)] },
		);
		await startSession(
			"/Users/dev/docs",
			"Docs sweep",
			undefined,
			undefined,
			{ awaitingAnswer: false, goalActive: false },
			{ ask: DOCS_SWEEP_ASK },
		);
		recent.push(
			recentSummary("/Users/dev/relay", "Collab reconnect investigation", 3_600_000),
			recentSummary("/Users/dev/site", "Landing page copy", 86_400_000),
			recentSummary("/Users/dev/api", "Rate limiter spike", 3 * 86_400_000),
		);
	}

	if (workspacesMock) await workspacesMock.seed();

	if (options.agentTree) {
		await startSession(
			"/Users/dev/relay",
			"Agent graph: relay reconnect",
			"claude-opus-5-5",
			undefined,
			{ awaitingAnswer: false, goalActive: false },
			{ id: AGENT_TREE_SESSION_ID, entries: fixtureEntries, agentTree: true },
		);
		await graphMock.seed(startSession); // B8: the `graph` room (todo board + IRC traffic) next to `agent-tree`
	}

	if (options.fixtures) {
		await startSession(
			"/Users/dev/bench",
			"bench: 50k-line transcript",
			undefined,
			undefined,
			{ awaitingAnswer: false, goalActive: false },
			{ id: BENCH_TRANSCRIPT_SESSION_ID, entries: makeTranscript({ lines: DEFAULT_TRANSCRIPT_LINES }) },
		);
		await startSession(
			"/Users/dev/bench",
			"bench: 100 tokens/s stream",
			undefined,
			undefined,
			{ awaitingAnswer: false, goalActive: false },
			{
				id: BENCH_STREAM_SESSION_ID,
				entries: makeTranscript({ lines: 3_000 }),
				stream: { tokensPerSecond: 100, durationMs: 20_000 },
			},
		);
	}

	if (options.panes) {
		for (const pane of paneFixtures()) {
			await startSession(pane.cwd, pane.title, undefined, undefined, { awaitingAnswer: false, goalActive: false }, { id: pane.id, ...pane.fixture });
		}
	}

	return {
		url: `http://127.0.0.1:${server.port}`,
		liveIds: () => [...live.keys()],
		async stop(): Promise<void> {
			if (overnightTicker !== undefined) clearInterval(overnightTicker);
			overnightTicker = undefined;
			overnightProgress.clear();
			await Promise.all([...live.values()].map(s => s.room.stop()));
			live.clear();
			relay.stop();
			server.stop(true);
		},
	};
}

function argValue(argv: readonly string[], name: string): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === name) return argv[i + 1];
		if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
	}
	return undefined;
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const rawPort = argValue(argv, "--port");
	const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		console.error(`mock-daemon: invalid --port ${rawPort}`);
		process.exit(1);
	}
	const rawFeatures = argValue(argv, "--features");
	let features: MockDaemonOptions["features"];
	if (rawFeatures === "all") features = "all";
	else if (rawFeatures !== undefined) {
		const selected = rawFeatures.split(",");
		if (selected.some(name => !MOCK_FEATURES.includes(name as MockFeature))) {
			console.error(`mock-daemon: invalid --features ${rawFeatures}; expected all or a comma-separated feature list`);
			process.exit(1);
		}
		features = selected as MockFeature[];
	}
	const daemon = await startMockDaemon({
		port,
		features,
		dist: argValue(argv, "--dist"),
		deny: argv.includes("--deny"),
		paired: argv.includes("--unpaired") ? false : undefined,
		pairRateLimited: argv.includes("--pair-rate-limited"),
		agentTree: argv.includes("--agent-tree"),
		workspaces: argv.includes("--workspaces"),
		panes: argv.includes("--panes"),
		log: message => console.log(`mock-daemon: ${message}`),
	});
	console.log(
		`mock omp console daemon listening on ${daemon.url} (${daemon.liveIds().length} live sessions); Ctrl+C stops it`,
	);
	const shutdown = (): void => {
		void daemon.stop().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
