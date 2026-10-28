import type {
	ApiError,
	CleanseCheckerDescriptor,
	CleanseRunSnapshot,
	ContextBreakdownView,
	DebugAdapterOption,
	DebugDiagnosticAction,
	DebugSessionOp,
	DebugSessionSummary,
	DebugStackFrame,
	DebugThread,
	DebugVariable,
	FeedbackEntry,
	GitChangedFile,
	GitCommitSummary,
	GitFileDiff,
	GitStatusSnapshot,
	ImprovementReport,
	InstalledSkill,
	JournalEvent,
	JournalResponse,
	LiveModeStatus,
	LoopModeStatus,
	OmfgCandidate,
	PendingUiRequest,
	RewindPoint,
	SessionOp,
	SessionOpResult,
	SessionOpV3,
	SessionOpV3Result,
	DebugDiagnosticsOp,
	SessionStatsView,
	SessionSummary,
	SessionTreeNode,
	SkillSearchResult,
	VibeModeStatus,
} from "@omp-console/protocol";
import type { CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";
import { splitQueuedMessages } from "@oh-my-pi/pi-tui/prompt/queue-input";
import type { MockRoom } from "./mock-room";

export interface MockSessionOpsSession {
	summary: SessionSummary;
	room: Pick<MockRoom, "roomId" | "participants" | "status" | "append" | "lastEntryId" | "transcriptEntries" | "rewindTo" | "pendingUiRequest" | "answerUiRequest" | "ask">;
	setGoal(active: boolean, objective: string | undefined): void;
	setLoopMode(status: LoopModeStatus): void;
	setVibeMode(status: VibeModeStatus): void;
}

export interface MockSessionOpsPorts {
	getSession(sessionId: string): MockSessionOpsSession | undefined;
	onLiveMode?(sessionId: string, status: LiveModeStatus): void;
}

export interface MockSessionOps {
	owns(req: Request, route: string): boolean;
	handle(req: Request, route: string): Promise<Response>;
}

interface GoalState {
	objective: string;
	status: "active" | "paused" | "dropped";
	tokensUsed: number;
	tokenBudget: number | null;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

export function createSessionOpsMock(ports: MockSessionOpsPorts): MockSessionOps {
	const events: JournalEvent[] = [];
	const feedback: FeedbackEntry[] = [];
	const goals = new Map<string, GoalState>();
	const planModes = new Map<string, boolean>();
	const approvalModes = new Map<string, Extract<SessionOp, { op: "approval-mode" }>["mode"]>();
	const omfgCandidates = new Map<string, OmfgCandidate>();
	const omfgOverwriteConfirmations = new Map<string, { path: string; fileContent: string }>();
	const cleanseSnapshots = new Map<string, CleanseRunSnapshot>();
	const cleanseChecker: CleanseCheckerDescriptor = {
		id: "typescript:.",
		label: "TypeScript",
		language: "TypeScript",
		cwd: ".",
		command: "tsgo --noEmit",
	};
	const skillsBySession = new Map<string, InstalledSkill[]>();
	const gitBySession = new Map<string, GitStatusSnapshot>();
	const debugState: MockDebugState = { sessions: new Map(), activeSessionIds: new Map(), sequence: 0 };
	let diagnosticPollSequence = 0;
	const skillApprovals = new Map<string, (value: string | null) => void>();
	let report: ImprovementReport | null = null;
	let entrySequence = 0;
	const appendToolResult = (session: MockSessionOpsSession, toolName: string, details: unknown): void => {
		const now = Date.now();
		const id = `mock-op-${now}-${++entrySequence}`;
		const entry: SessionEntry = {
			type: "message",
			id,
			parentId: session.room.lastEntryId(),
			timestamp: new Date(now).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: `${id}:call`,
				toolName,
				content: [{ type: "text", text: "Updated by mock session operation." }],
				details,
				isError: false,
				timestamp: now,
			},
		};
		session.room.append(entry);
	};

	const owns = (req: Request, route: string): boolean => {
		if (route === "/report") return req.method === "GET" || req.method === "POST";
		if (route === "/journal") return req.method === "GET" || req.method === "POST" || req.method === "DELETE";
		if (route === "/feedback") return req.method === "POST";
		return req.method === "POST" && /^\/sessions\/[^/]+\/ops$/.test(route);
	};

	const handle = async (req: Request, route: string): Promise<Response> => {
		if (route === "/report") {
			if (req.method === "GET") return json(report);
			if (req.method === "POST") {
				report = {
					generatedAt: Date.now(),
					path: "mock/state/report.md",
					markdown: "# Improvement report\n\nGenerated from the mock usage journal and feedback. No transcript or model call was used.\n",
				};
				return json({ accepted: true }, 202);
			}
		}
		if (route === "/journal") {
			if (req.method === "GET") {
				const rawLimit = new URL(req.url).searchParams.get("limit");
				const limit = rawLimit === null ? 500 : Number(rawLimit);
				if (!Number.isInteger(limit) || limit < 0) return fail(400, "bad-request", "limit must be a non-negative integer");
				const response: JournalResponse = { events: events.slice(-limit), feedback: feedback.slice(-limit) };
				return json(response);
			}
			if (req.method === "POST") {
				const body: unknown = await req.json().catch(() => null);
				if (!isRecord(body) || !Array.isArray(body.events) || body.events.length > 200 || !body.events.every(isJournalEvent)) {
					return fail(400, "bad-request", "events must contain at most 200 valid journal events");
				}
				events.push(...body.events);
				return new Response(null, { status: 204 });
			}
			if (req.method === "DELETE") {
				events.length = 0;
				feedback.length = 0;
				return new Response(null, { status: 204 });
			}
		}
		if (route === "/feedback" && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			if (!isFeedbackEntry(body)) return fail(400, "bad-request", "feedback entry is invalid");
			feedback.push(body);
			return new Response(null, { status: 204 });
		}
		const match = /^\/sessions\/([^/]+)\/ops$/.exec(route);
		if (!match) return fail(404, "not-found", "unknown endpoint");
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(match[1]!);
		} catch {
			return fail(400, "bad-request", "session id is invalid");
		}
		const session = ports.getSession(sessionId);
		if (!session) return fail(404, "not-found", "no such live session");
		const body: unknown = await req.json().catch(() => null);
		if (isLiveModeOperation(body)) {
			const liveMode = body.action === "status"
				? session.summary.liveMode ?? { active: false, phase: "idle" as const }
				: body.action === "start"
					? { active: true, phase: "listening" as const }
					: { active: false, phase: "idle" as const };
			session.summary.liveMode = liveMode;
			ports.onLiveMode?.(sessionId, liveMode);
			const browserAnswer = body.action === "start"
				? body.offer.replaceAll("a=setup:actpass", "a=setup:active").replaceAll("a=sendrecv", "a=recvonly")
				: undefined;
			return resultResponse({ ok: true, liveMode, ...(browserAnswer === undefined ? {} : { browserAnswer }) });
		}
		if (isDebugDiagnosticsOperation(body)) return applyDebugDiagnosticsOperation(body, ++diagnosticPollSequence);
		if (isDebugOperation(body)) return applyDebugOperation(sessionId, session, body, debugState);
		if (isTerminalCommandOperation(body)) {
			return applyTerminalCommandOperation(sessionId, body, { omfgCandidates, omfgOverwriteConfirmations, cleanseSnapshots, cleanseChecker });
		}
		if (isRewindOperation(body)) return applyRewindOperation(session, body);
		if (isToolOperation(body)) return applyToolOperation(sessionId, session, body, { skillsBySession, gitBySession, skillApprovals }, req.signal);
		if (isUiRequestOperation(body)) return applyUiRequestOperation(sessionId, session, body, skillApprovals);
		if (isControlOperation(body)) return applyControlOperation(session, body);
		if (isModeOperation(body)) return applyModeOperation(session, body);
		if (!isSessionOp(body)) return fail(400, "bad-request", "session operation is invalid");
		return applySessionOp(sessionId, session, body, { goals, planModes, approvalModes, appendToolResult });
	};

	return { owns, handle };
}

function applyTerminalCommandOperation(
	sessionId: string,
	op: Extract<SessionOpV3, { op: "tan-start" | "omfg-generate" | "omfg-save" | "omfg-cancel" | "cleanse-discover" | "cleanse-start" | "cleanse-cancel" | "cleanse-state" }>,
	state: {
		omfgCandidates: Map<string, OmfgCandidate>;
		omfgOverwriteConfirmations: Map<string, { path: string; fileContent: string }>;
		cleanseSnapshots: Map<string, CleanseRunSnapshot>;
		cleanseChecker: CleanseCheckerDescriptor;
	},
): Response {
	if (op.op === "tan-start") {
		return json({ ok: true, jobId: "mock-tan-job", agentId: "mock-tan-agent" } satisfies SessionOpV3Result);
	}
	if (op.op === "omfg-generate") {
		const candidate: OmfgCandidate = {
			requestId: op.requestId,
			name: "mock-rule",
			fileContent: [
				"---",
				"name: mock-rule",
				"description: Remember the reviewed behavior",
				"scope: text",
				"condition: mock",
				"---",
				"",
				"Keep the result grounded in the conversation.",
				"",
			].join("\n"),
			validated: true,
		};
		state.omfgCandidates.set(`${sessionId}/${op.requestId}`, candidate);
		return json({ ok: true, candidate } satisfies SessionOpV3Result);
	}
	if (op.op === "omfg-cancel") {
		state.omfgCandidates.delete(`${sessionId}/${op.requestId}`);
		state.omfgOverwriteConfirmations.delete(`${sessionId}/${op.requestId}`);
		return json({ ok: true } satisfies SessionOpV3Result);
	}
	if (op.op === "omfg-save") {
		const key = `${sessionId}/${op.requestId}`;
		const candidate = state.omfgCandidates.get(key);
		if (!candidate) return fail(404, "not-found", "OMFG candidate is no longer available");
		const root = op.scope === "project" ? "/mock/project/.omp/rules" : "~/.omp/rules";
		const targetPath = `${root}/${candidate.name}.md`;
		const confirmation = state.omfgOverwriteConfirmations.get(key);
		if (!op.overwrite || confirmation?.path !== targetPath || confirmation.fileContent !== op.fileContent) {
			state.omfgOverwriteConfirmations.set(key, { path: targetPath, fileContent: op.fileContent });
			return json({ ok: true, save: { kind: "confirm-overwrite", path: targetPath } } satisfies SessionOpV3Result);
		}
		if (!candidate.validated && !op.acceptUnvalidated) {
			return json({
				ok: true,
				save: { kind: "confirm-unvalidated", message: "The rule did not match recent history." },
			} satisfies SessionOpV3Result);
		}
		state.omfgCandidates.delete(key);
		state.omfgOverwriteConfirmations.delete(key);
		return json({ ok: true, save: { kind: "saved", path: targetPath } } satisfies SessionOpV3Result);
	}
	if (op.op === "cleanse-discover") {
		return json({ ok: true, checkers: [state.cleanseChecker], skipped: [] } satisfies SessionOpV3Result);
	}
	if (op.op === "cleanse-start") {
		const current = state.cleanseSnapshots.get(sessionId);
		if (current?.status === "running") return fail(409, "conflict", "A cleanse run is already active");
		if (op.scope.kind === "checker" && op.scope.id !== state.cleanseChecker.id) {
			return fail(400, "bad-request", `Unknown cleanse checker id: ${op.scope.id}`);
		}
		const checker = {
			id: state.cleanseChecker.id,
			label: state.cleanseChecker.label,
			language: state.cleanseChecker.language,
			cwd: state.cleanseChecker.cwd,
			command: state.cleanseChecker.command,
		};
		state.cleanseSnapshots.set(sessionId, {
			runId: op.runId,
			status: "running",
			phase: "Checking project files",
			checkers: [{ checker, status: "running" }],
			agents: [{
				name: "CleanseA1",
				status: "running",
				files: ["src/app.ts"],
				weight: 1,
				progress: { lastIntent: "Reviewing the reported diagnostic", recentOutput: ["Found one actionable issue"], toolCount: 1 },
			}],
			logs: ["Cleanse run started.", `Running ${state.cleanseChecker.command}`],
		});
		return json({ ok: true, runId: op.runId } satisfies SessionOpV3Result);
	}
	if (op.op === "cleanse-cancel") {
		const snapshot = state.cleanseSnapshots.get(sessionId);
		if (!snapshot || snapshot.status !== "running" || snapshot.runId !== op.runId) {
			return fail(409, "conflict", "That cleanse run is no longer active");
		}
		snapshot.status = "cancelled";
		delete snapshot.phase;
		snapshot.logs.push("Cleanse cancelled.");
		for (const agent of snapshot.agents) if (agent.status === "running") agent.status = "aborted";
		return json({ ok: true } satisfies SessionOpV3Result);
	}
	return json({ ok: true, state: state.cleanseSnapshots.get(sessionId) ?? null } satisfies SessionOpV3Result);
}

function isTerminalCommandOperation(
	value: unknown,
): value is Extract<SessionOpV3, { op: "tan-start" | "omfg-generate" | "omfg-save" | "omfg-cancel" | "cleanse-discover" | "cleanse-start" | "cleanse-cancel" | "cleanse-state" }> {
	if (!isRecord(value) || typeof value.op !== "string") return false;
	switch (value.op) {
		case "tan-start":
			return typeof value.work === "string";
		case "omfg-generate":
		case "omfg-cancel":
			return typeof value.requestId === "string" && (value.op === "omfg-cancel" || typeof value.complaint === "string");
		case "omfg-save":
			return (
				typeof value.requestId === "string" &&
				typeof value.fileContent === "string" &&
				(value.scope === "project" || value.scope === "user") &&
				typeof value.overwrite === "boolean" &&
				typeof value.acceptUnvalidated === "boolean"
			);
		case "cleanse-discover":
			return typeof value.includeTests === "boolean";
		case "cleanse-start":
			return (
				typeof value.runId === "string" &&
				typeof value.includeTests === "boolean" &&
				(value.maxAgents === undefined || (typeof value.maxAgents === "number" && Number.isInteger(value.maxAgents) && value.maxAgents > 0)) &&
				(value.model === undefined || typeof value.model === "string") &&
				isCleanseScope(value.scope)
			);
		case "cleanse-cancel":
			return typeof value.runId === "string";
		case "cleanse-state":
			return true;
		default:
			return false;
	}
}

type ToolOperation = Extract<SessionOpV3, { op: "skills-search" | "skills-installed" | "skills-install" | "skills-update" | "git-view" | "git-diff" | "git-stage" | "git-hunk" | "git-commit" }>;

interface ToolOperationState {
	skillsBySession: Map<string, InstalledSkill[]>;
	gitBySession: Map<string, GitStatusSnapshot>;
	skillApprovals: Map<string, (value: string | null) => void>;
}

const REVISION_FILES: GitChangedFile[] = [{ path: "README.md", kind: "modified", area: "commit", additions: 2, deletions: 1 }];
const MOCK_PATCH_HASH = "d".repeat(64);

function initialGitSnapshot(): GitStatusSnapshot {
	return {
		branch: "main",
		clean: false,
		readOnly: false,
		unstaged: [{ path: "README.md", kind: "modified", area: "unstaged", additions: 2, deletions: 1 }],
		staged: [],
		commitFiles: [],
		headCommit: {
			sha: "0123456789abcdef0123456789abcdef01234567",
			shortSha: "0123456",
			subject: "Mock repository baseline",
			body: "",
			authorName: "omp console mock",
			authorDate: new Date(0).toISOString(),
			parents: [],
		},
	};
}

function isToolOperation(value: unknown): value is ToolOperation {
	if (!isRecord(value)) return false;
	switch (value.op) {
		case "skills-search":
			return typeof value.query === "string";
		case "skills-installed":
			return true;
		case "skills-install":
			return Array.isArray(value.specs) && value.specs.length > 0 && value.specs.every(spec => typeof spec === "string") && typeof value.global === "boolean";
		case "skills-update":
			return Array.isArray(value.names) && value.names.every(name => typeof name === "string") && typeof value.global === "boolean";
		case "git-view":
			return value.revision === undefined || typeof value.revision === "string";
		case "git-diff":
			return typeof value.path === "string" && (value.area === "unstaged" || value.area === "staged" || value.area === "commit") && (value.revision === undefined || typeof value.revision === "string");
		case "git-stage":
			return (value.action === "stage" || value.action === "unstage") && Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every(path => typeof path === "string");
		case "git-hunk":
			return (value.action === "stage" && value.area === "unstaged" || value.action === "unstage" && value.area === "staged") &&
				typeof value.path === "string" && typeof value.hunkIndex === "number" && Number.isInteger(value.hunkIndex) &&
				typeof value.patchHash === "string" && /^[0-9a-f]{64}$/.test(value.patchHash);
		case "git-commit":
			return typeof value.message === "string";
		default:
			return false;
	}
}

function isCleanseScope(value: unknown): value is Extract<SessionOpV3, { op: "cleanse-start" }>["scope"] {
	if (!isRecord(value)) return false;
	if (value.kind === "all") return true;
	if (value.kind === "checker") return typeof value.id === "string";
	return value.kind === "request" && typeof value.request === "string";
}

function skillId(spec: string): string {
	if (!spec.startsWith("@")) return `@mock/${spec}`;
	const separator = spec.indexOf("/", 1);
	const end = spec.lastIndexOf("@");
	return separator < 0 ? spec : spec.slice(0, end > separator ? end : undefined);
}

async function confirmMockSkillScripts(
	sessionId: string,
	session: MockSessionOpsSession,
	state: ToolOperationState,
	specs: string[],
	approvalId: string | undefined,
	signal: AbortSignal,
): Promise<Response | null> {
	if (!specs.some(spec => skillId(spec) === "@omp-console/review")) return null;
	if (signal.aborted) return fail(409, "conflict", "script installation was declined");
	if (state.skillApprovals.has(sessionId)) return fail(409, "conflict", "a script approval is already pending");
	const approval = Promise.withResolvers<string | null>();
	state.skillApprovals.set(sessionId, approval.resolve);
	const marker = approvalId === undefined ? "" : `\n\n[omp-console-skill-approval:${approvalId}]`;
	session.room.ask({
		kind: "select",
		title: `Install skill with scripts?\n@omp-console/review@1.0.0 scripts:\n- postinstall: add a local review command to this project.${marker}`,
		options: ["Yes", "No"],
		initialIndex: 0,
	});
	const pendingReqId = session.room.pendingUiRequest()?.reqId;
	const onAbort = (): void => {
		if (state.skillApprovals.get(sessionId) === approval.resolve) state.skillApprovals.delete(sessionId);
		if (pendingReqId !== undefined) session.room.answerUiRequest(pendingReqId, "No");
		approval.resolve(null);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		if (await approval.promise !== "Yes") return fail(409, "conflict", "script installation was declined");
		return null;
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (state.skillApprovals.get(sessionId) === approval.resolve) state.skillApprovals.delete(sessionId);
	}
}

async function applyToolOperation(sessionId: string, session: MockSessionOpsSession, op: ToolOperation, state: ToolOperationState, signal: AbortSignal): Promise<Response> {
	if (op.op === "skills-search") {
		const skillSearch: SkillSearchResult = {
			hits: [{
				scope: "deck",
				name: "review",
				version: "1.0.0",
				description: "A mock skill for exercising the omp console panel.",
				weeklyDownloads: 42,
				updatedAt: Date.UTC(2026, 9, 26),
				publisher: { username: "deck-mock" },
				keywords: ["mock", "review"],
			}],
			page: 1,
			perPage: 20,
			total: 1,
		};
		return resultResponse({ ok: true, skillSearch });
	}
	if (op.op === "skills-installed") return resultResponse({ ok: true, installedSkills: state.skillsBySession.get(sessionId) ?? [] });
	if (op.op === "skills-install" || op.op === "skills-update") {
		const specs = op.op === "skills-install"
			? op.specs
			: op.names.length > 0
				? op.names
				: (state.skillsBySession.get(sessionId) ?? []).map(skill => skill.id);
		const approvalError = await confirmMockSkillScripts(sessionId, session, state, specs, op.approvalId, signal);
		if (approvalError) return approvalError;
	}
	if (op.op === "skills-install") {
		const installed = [...(state.skillsBySession.get(sessionId) ?? [])];
		const changes = op.specs.map(spec => {
			const id = skillId(spec);
			const previous = installed.find(skill => skill.id === id);
			const version = "1.0.0";
			if (previous) {
				installed[installed.indexOf(previous)] = { ...previous, version, range: "^1.0.0", stored: true };
				return { id, ...(previous.version === undefined ? {} : { from: previous.version }), to: version, range: "^1.0.0", restored: false };
			}
			installed.push({ id, version, range: "^1.0.0", scope: op.global ? "user" : "project", stored: true });
			return { id, to: version, range: "^1.0.0", restored: false };
		});
		state.skillsBySession.set(sessionId, installed);
		return resultResponse({ ok: true, skillChanges: changes, warnings: [], installedSkills: installed });
	}
	if (op.op === "skills-update") {
		const installed = [...(state.skillsBySession.get(sessionId) ?? [])];
		const selected = installed.filter(skill => op.names.length === 0 || op.names.includes(skill.id));
		const changes = selected.map(skill => {
			const version = "1.1.0";
			installed[installed.indexOf(skill)] = { ...skill, version, stored: true };
			return { id: skill.id, ...(skill.version === undefined ? {} : { from: skill.version }), to: version, range: skill.range ?? "^1.0.0", restored: false };
		});
		state.skillsBySession.set(sessionId, installed);
		return resultResponse({ ok: true, skillChanges: changes, warnings: [], installedSkills: installed });
	}

	if (op.op === "git-view") {
		const current = state.gitBySession.get(sessionId) ?? initialGitSnapshot();
		state.gitBySession.set(sessionId, current);
		const git: GitStatusSnapshot = op.revision
			? { ...current, branch: null, readOnly: true, revision: op.revision, unstaged: [], staged: [], commitFiles: REVISION_FILES }
			: { ...current, readOnly: false };
		return resultResponse({ ok: true, git });
	}
	if (op.op === "git-diff") {
		const current = state.gitBySession.get(sessionId) ?? initialGitSnapshot();
		const files = op.revision ? REVISION_FILES : op.area === "unstaged" ? current.unstaged : op.area === "staged" ? current.staged : current.commitFiles;
		if (!files.some(file => file.path === op.path)) return fail(404, "not-found", `no ${op.area} change for ${op.path}`);
		const gitDiff: GitFileDiff = {
			kind: "text",
			hunks: [{
				header: "@@ -1,1 +1,1 @@",
				patchHash: MOCK_PATCH_HASH,
				lines: [{ kind: "del", text: `${op.path} before` }, { kind: "add", text: `${op.path} after` }],
			}],
			canPatch: true,
		};
		return resultResponse({ ok: true, gitDiff });
	}
	if (op.op === "git-stage") {
		const current = state.gitBySession.get(sessionId) ?? initialGitSnapshot();
		const from = op.action === "stage" ? current.unstaged : current.staged;
		const moved = from.filter(file => op.paths.includes(file.path));
		if (moved.length !== new Set(op.paths).size) return fail(404, "not-found", "one or more selected files are not changed in that area");
		const remaining = from.filter(file => !op.paths.includes(file.path));
		const converted = moved.map(file => ({ ...file, area: op.action === "stage" ? "staged" as const : "unstaged" as const }));
		const git: GitStatusSnapshot = {
			...current,
			unstaged: op.action === "stage" ? remaining : [...current.unstaged, ...converted],
			staged: op.action === "stage" ? [...current.staged, ...converted] : remaining,
			clean: false,
		};
		state.gitBySession.set(sessionId, git);
		return resultResponse({ ok: true, git });
	}
	if (op.op === "git-hunk") {
		if (op.patchHash !== MOCK_PATCH_HASH) return fail(409, "conflict", "the file changed; reload its diff before applying a hunk");
		return applyToolOperation(sessionId, session, { op: "git-stage", action: op.action, paths: [op.path] }, state, signal);
	}
	if (op.op === "git-commit") {
		const current = state.gitBySession.get(sessionId) ?? initialGitSnapshot();
		if (current.staged.length === 0) return fail(409, "conflict", "stage at least one file before committing");
		const sha = `${Date.now().toString(16).padStart(8, "0")}${"c".repeat(32)}`;
		const [subject = "", ...bodyLines] = op.message.split(/\r?\n/);
		const headCommit: GitCommitSummary = {
			sha,
			shortSha: sha.slice(0, 7),
			subject,
			body: bodyLines.join("\n"),
			authorName: "omp console mock",
			authorDate: new Date().toISOString(),
			parents: current.headCommit ? [current.headCommit.sha] : [],
		};
		const commitFiles = current.staged.map(file => ({ ...file, area: "commit" as const }));
		const git: GitStatusSnapshot = { ...current, clean: current.unstaged.length === 0, staged: [], commitFiles, headCommit };
		state.gitBySession.set(sessionId, git);
		return resultResponse({ ok: true, git });
	}
	return fail(400, "bad-request", "unsupported tool operation");
}

function resultResponse(value: SessionOpV3Result): Response {
	return json(value);
}

function applyUiRequestOperation(
	sessionId: string,
	session: MockSessionOpsSession,
	op: Extract<SessionOpV3, { op: "ui-requests" | "ui-answer" | "quick-replies" }>,
	skillApprovals: Map<string, (value: string | null) => void>,
): Response {
	if (op.op === "ui-requests") {
		const pending = session.room.pendingUiRequest();
		return json({ ok: true, uiRequests: pending === null ? [] : [toPendingUiRequest(pending)] });
	}
	if (op.op === "ui-answer") {
		const reqId = Number(op.reqId);
		if (!Number.isSafeInteger(reqId) || String(reqId) !== op.reqId) return fail(400, "bad-request", "request id is invalid");
		if (!session.room.answerUiRequest(reqId, op.value)) return fail(409, "conflict", "question is no longer pending");
		const resolve = skillApprovals.get(sessionId);
		if (resolve) {
			skillApprovals.delete(sessionId);
			resolve(op.value);
		}
		return json({ ok: true });
	}
	const replies = latestAssistantEntryId(session) === op.entryId
		? [
				"Continue the current task.",
				"Approve this approach and proceed.",
				"What changed, and why?",
				"Explain the risky part.",
				"Run the focused tests.",
				"Run the package checks.",
				"Verify the phone layout.",
				"Which edge cases need coverage?",
				"Summarize the result and blockers.",
				"Handle the next related task.",
			]
		: [];
	return json({ ok: true, replies });
}

function toPendingUiRequest(request: CollabUiRequest): PendingUiRequest {
	const base = { reqId: String(request.reqId), title: request.title, at: Date.now() };
	if (request.kind === "editor") {
		return { ...base, kind: "editor", ...(request.prefill === undefined ? {} : { prefill: request.prefill }) };
	}
	return {
		...base,
		kind: "select",
		options: request.options.map(option => typeof option === "string" ? { label: option } : option),
		...(request.initialIndex === undefined ? {} : { initialIndex: request.initialIndex }),
		...(request.checkedIndices === undefined ? {} : { checkedIndices: request.checkedIndices }),
		...(request.markableCount === undefined ? {} : { markableCount: request.markableCount }),
		...(request.helpText === undefined ? {} : { helpText: request.helpText }),
	};
}

function latestAssistantEntryId(session: MockSessionOpsSession): string | null {
	const entries = session.room.transcriptEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		if (entry.message.role === "user") return null;
		if (entry.message.role === "assistant") return userMessageText(entry.message.content).trim() === "" ? null : entry.id;
	}
	return null;
}

function isUiRequestOperation(value: unknown): value is Extract<SessionOpV3, { op: "ui-requests" | "ui-answer" | "quick-replies" }> {
	if (!isRecord(value)) return false;
	if (value.op === "ui-requests") return true;
	if (value.op === "ui-answer") return typeof value.reqId === "string" && (value.value === null || typeof value.value === "string");
	if (value.op === "quick-replies") return typeof value.entryId === "string";
	return false;
}

function applyRewindOperation(
	session: MockSessionOpsSession,
	op: Extract<SessionOpV3, { op: "rewind" | "rewind-points" }>,
): Response {
	if (op.op === "rewind-points") {
		const entriesById = new Map<string, SessionEntry>();
		for (const entry of session.room.transcriptEntries()) entriesById.set(entry.id, entry);
		const points: RewindPoint[] = [];
		let currentId = session.room.lastEntryId();
		while (currentId !== null) {
			const entry = entriesById.get(currentId);
			if (!entry) break;
			if (entry.type === "message" && entry.message.role === "user") {
				const text = userMessageText(entry.message.content);
				const hasImage = typeof entry.message.content !== "string" && entry.message.content.some(block => block.type === "image");
				points.push({
					entryId: entry.id,
					kind: "user",
					preview: text.trim() || (hasImage ? "[image]" : ""),
					at: Date.parse(entry.timestamp),
				});
			}
			currentId = entry.parentId;
		}
		return json({ ok: true, points });
	}

	const entry = session.room.rewindTo(op.entryId);
	if (entry?.type !== "message" || entry.message.role !== "user") {
		return fail(400, "bad-request", "entry is not a current-branch user message");
	}
	return json({ ok: true, text: userMessageText(entry.message.content) });
}

function userMessageText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap(block => block.type === "text" ? [block.text ?? ""] : []).join(" ");
}

type ControlOperation = Extract<SessionOpV3, { op: "pause" | "queue" | "collab-status" }>;
type QueueImage = NonNullable<Extract<SessionOpV3, { op: "queue" }>["images"]>[number];

function isQueueImage(value: unknown): value is QueueImage {
	return isRecord(value) && value.type === "image" && typeof value.data === "string" && value.data !== "" &&
		typeof value.mimeType === "string" && value.mimeType.startsWith("image/");
}

function isControlOperation(value: unknown): value is ControlOperation {
	if (!isRecord(value)) return false;
	switch (value.op) {
		case "pause":
			return value.action === "pause" || value.action === "resume" || value.action === "toggle";
		case "queue":
			return typeof value.text === "string" &&
				(value.images === undefined || (Array.isArray(value.images) && value.images.every(isQueueImage)));
		case "collab-status":
			return true;
		default:
			return false;
	}
}

function applyControlOperation(session: MockSessionOpsSession, op: ControlOperation): Response {
	switch (op.op) {
		case "pause": {
			const wasPaused = session.summary.paused === true;
			const paused = op.action === "pause" || (op.action === "toggle" && !wasPaused);
			if (paused) {
				const pausedAt = session.summary.pausedAt ?? Date.now();
				session.summary.paused = true;
				session.summary.pausedAt = pausedAt;
				return json({ ok: true, paused, pausedAt });
			}
			session.summary.paused = false;
			delete session.summary.pausedAt;
			return json({ ok: true, paused });
		}
		case "queue": {
			const messages = splitQueuedMessages(op.text);
			if (messages.length === 0 && (op.images?.length ?? 0) === 0) {
				return fail(400, "bad-request", "queue needs a message or at least one image");
			}
			return json({ ok: true, queued: Math.max(1, messages.length) });
		}
		case "collab-status":
			return json({ ok: true, roomId: session.room.roomId, participants: session.room.participants() });
	}
}

function applyModeOperation(
	session: MockSessionOpsSession,
	op: Extract<SessionOpV3, { op: "loop-mode" | "vibe-mode" }>,
): Response {
	if (op.op === "loop-mode") {
		const current = session.summary.loopMode ?? { active: false, iteration: 0, waitingForPrompt: false };
		if (op.action === "status") return result({ ok: true, loopMode: current });
		const active = op.action === "toggle" && !current.active;
		const next: LoopModeStatus = active
			? { active: true, iteration: 0, waitingForPrompt: op.args?.trim() === "" || op.args === undefined }
			: { active: false, iteration: current.iteration, waitingForPrompt: false, message: "Loop mode disabled." };
		session.setLoopMode(next);
		return result({ ok: true, loopMode: next });
	}
	const current = session.summary.vibeMode ?? { active: false, workers: [] };
	if (op.action === "status") return result({ ok: true, vibeMode: current });
	const next: VibeModeStatus =
		op.action === "toggle"
			? { active: !current.active, workers: current.active ? [] : current.workers }
			: { active: false, workers: [] };
	session.setVibeMode(next);
	return result({ ok: true, vibeMode: next });
}

function applySessionOp(
	sessionId: string,
	session: MockSessionOpsSession,
	op: SessionOp,
	state: {
		goals: Map<string, GoalState>;
		planModes: Map<string, boolean>;
		approvalModes: Map<string, Extract<SessionOp, { op: "approval-mode" }>["mode"]>;
		appendToolResult(session: MockSessionOpsSession, toolName: string, details: unknown): void;
	},
): Response {
	if (op.op === "plan-mode") {
		state.planModes.set(sessionId, op.enabled);
		return result({ ok: true });
	}
	if (op.op === "approval-mode") {
		state.approvalModes.set(sessionId, op.mode);
		return result({ ok: true });
	}
	if (op.op === "goal") {
		const current = state.goals.get(sessionId) ?? {
			objective: session.summary.goalObjective ?? "",
			status: session.summary.goalActive ? "active" : "dropped",
			tokensUsed: 0,
			tokenBudget: null,
		};
		let next: GoalState;
		switch (op.action) {
			case "set":
				next = { objective: op.objective, status: "active", tokensUsed: 0, tokenBudget: op.tokenBudget ?? null };
				break;
			case "pause":
				if (current.status !== "active") return fail(409, "conflict", "no active goal to pause");
				next = { ...current, status: "paused" };
				break;
			case "resume":
				if (current.status !== "paused") return fail(409, "conflict", "no paused goal to resume");
				next = { ...current, status: "active" };
				break;
			case "drop":
				next = { ...current, status: "dropped" };
				break;
			case "budget":
				if (current.status === "dropped") return fail(409, "conflict", "no active goal to update");
				next = { ...current, tokenBudget: op.tokenBudget };
				break;
		}
		state.goals.set(sessionId, next);
		session.setGoal(next.status === "active", next.status === "dropped" ? undefined : next.objective);
		state.appendToolResult(session, "goal", { goal: next.status === "dropped" ? null : next });
		return result({ ok: true });
	}
	if (op.op === "todos") {
		state.appendToolResult(session, "todo", { phases: op.phases });
		return result({ ok: true });
	}
	if (op.op === "stats") {
		const stats: SessionStatsView = {
			tokens: { input: 41_200, output: 8_400, cacheRead: 12_000, cacheWrite: 2_100, reasoning: 1_900 },
			cost: 0.1842,
			contextTokens: 49_600,
			contextWindow: 128_000,
			byAgent: [{ agentId: "Main", tokens: 49_600, cost: 0.1842 }],
		};
		return result({ ok: true, stats });
	}
	if (op.op === "tree") {
		const timestamp = Date.now();
		const tree: SessionTreeNode[] = [
			{ entryId: "mock-root", parentId: null, role: "user", preview: "Investigate the session behavior", at: timestamp - 120_000, onCurrentBranch: true },
			{ entryId: "mock-current", parentId: "mock-root", role: "assistant", preview: "Current branch: implementation and verification", at: timestamp - 60_000, onCurrentBranch: true },
			{ entryId: "mock-branch", parentId: "mock-root", role: "assistant", preview: "Alternate branch: compare the API behavior", at: timestamp - 30_000, onCurrentBranch: false },
		];
		return result({ ok: true, tree });
	}
	if (op.op === "context") {
		const context: ContextBreakdownView = {
			total: 49_600,
			window: 128_000,
			parts: [{ label: "System", tokens: 12_400 }, { label: "Messages", tokens: 30_100 }, { label: "Tools", tokens: 5_300 }, { label: "Reserved", tokens: 1_800 }],
		};
		return result({ ok: true, context });
	}
	return result({ ok: true });
}

function result(value: SessionOpResult | SessionOpV3Result): Response {
	return json(value);
}



function isRewindOperation(value: unknown): value is Extract<SessionOpV3, { op: "rewind" | "rewind-points" }> {
	if (!isRecord(value)) return false;
	return value.op === "rewind-points" || (value.op === "rewind" && typeof value.entryId === "string");
}
function isModeOperation(value: unknown): value is Extract<SessionOpV3, { op: "loop-mode" | "vibe-mode" }> {
	if (!isRecord(value) || (value.op !== "loop-mode" && value.op !== "vibe-mode")) return false;
	if (value.action === "status" || value.action === "disable") return true;
	return value.action === "toggle" && (value.args === undefined || (typeof value.args === "string" && value.args.length <= 4000));
}
function isSessionOp(value: unknown): value is SessionOp {
	if (!isRecord(value) || typeof value.op !== "string") return false;
	switch (value.op) {
		case "plan-mode":
			return typeof value.enabled === "boolean";
		case "goal":
			if (value.action === "set") return typeof value.objective === "string" && (value.tokenBudget === undefined || isPositiveInteger(value.tokenBudget));
			if (value.action === "budget") return isPositiveInteger(value.tokenBudget);
			return value.action === "pause" || value.action === "resume" || value.action === "drop";
		case "todos":
			return Array.isArray(value.phases) && value.phases.every(isTodoPhase);
		case "compact":
			return value.mode === undefined || value.mode === "soft" || value.mode === "remote" || value.mode === "snap";
		case "approval-mode":
			return value.mode === "always-ask" || value.mode === "always-ask-cached" || value.mode === "write" || value.mode === "yolo";
		case "dequeue":
			return value.index === undefined || (Number.isInteger(value.index) && Number(value.index) >= 0);
		case "stats":
		case "tree":
		case "context":
			return true;
		default:
			return false;
	}
}

function isTodoPhase(value: unknown): value is Extract<SessionOp, { op: "todos" }>["phases"][number] {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(task => isRecord(task) && typeof task.content === "string" && (task.status === "pending" || task.status === "in_progress" || task.status === "completed" || task.status === "abandoned" || task.status === "blocked"));
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isJournalEvent(value: unknown): value is JournalEvent {
	return isRecord(value) && typeof value.at === "number" && typeof value.feature === "string" && typeof value.action === "string" && (value.outcome === "ok" || value.outcome === "error" || value.outcome === "abandoned");
}

function isFeedbackEntry(value: unknown): value is FeedbackEntry {
	return isRecord(value) && typeof value.at === "number" && typeof value.screen === "string" && typeof value.text === "string" && (value.feature === undefined || typeof value.feature === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface MockDebugState {
	sessions: Map<string, DebugSessionSummary[]>;
	activeSessionIds: Map<string, string>;
	sequence: number;
}

const MOCK_DEBUG_ADAPTERS: DebugAdapterOption[] = [
	{ name: "mock-dap", command: "in-memory fixture", available: true, languages: ["javascript"], fileTypes: [".js"] },
	{ name: "missing-dap", command: "missing-dap", available: false, reason: "Command 'missing-dap' is not available.", languages: [], fileTypes: [] },
];

function isLiveModeOperation(value: unknown): value is Extract<SessionOpV3, { op: "live-mode" }> {
	if (!isRecord(value) || value.op !== "live-mode") return false;
	if (value.action === "start") return typeof value.offer === "string" && value.offer.length > 0 && value.offer.length <= 64 * 1024;
	return value.action === "stop" || value.action === "status";
}

function isDebugDiagnosticsOperation(value: unknown): value is DebugDiagnosticsOp {
	const actions: readonly DebugDiagnosticAction[] = [
		"artifacts",
		"performance-start",
		"performance-stop",
		"work",
		"dump",
		"memory",
		"logs",
		"raw-sse",
		"remote-debugger",
		"system",
		"terminal",
		"protocols",
		"transcript",
		"clear-cache",
	];
	return isRecord(value) && value.op === "debug-diagnostics" && typeof value.action === "string" &&
		actions.includes(value.action as DebugDiagnosticAction) &&
		(value.confirmed === undefined || value.confirmed === true);
}

function applyDebugDiagnosticsOperation(op: DebugDiagnosticsOp, poll: number): Response {
	if (op.action === "clear-cache" && op.confirmed !== true) {
		return resultResponse({
			ok: true,
			debugDiagnostic: {
				action: op.action,
				confirmationRequired: true,
				text: "Mock artifact cache contains 3 files (768 bytes). Confirm removal of files older than 30 days.",
				cache: { fileCount: 3, totalBytes: 768 },
			},
		});
	}
	if (op.action === "clear-cache") {
		return resultResponse({ ok: true, debugDiagnostic: { action: op.action, text: "Mock cache cleared.", cache: { fileCount: 3, totalBytes: 768 } } });
	}
	if (op.action === "remote-debugger" && op.confirmed !== true) {
		return resultResponse({
			ok: true,
			debugDiagnostic: {
				action: op.action,
				confirmationRequired: true,
				text: "The JavaScriptCore inspector is unauthenticated on 127.0.0.1. Any local process can attach and execute code inside this session worker with the worker's privileges. The runtime exposes no stop API, so the listener remains active until this worker exits. Confirm only if you trust all local processes.",
			},
		});
	}
	if (op.action === "remote-debugger") {
		return resultResponse({
			ok: true,
			debugDiagnostic: {
				action: op.action,
				text: "Mock inspector endpoint at ws://127.0.0.1:9229. It is unauthenticated; any local process can attach and execute code inside this session worker with the worker's privileges. The upstream runtime exposes no stop API; the listener remains active until this process exits.",
				remoteDebugger: { host: "127.0.0.1", port: 9229, stopSupported: false },
			},
		});
	}
	if (op.action === "logs" || op.action === "raw-sse") {
		return resultResponse({ ok: true, debugDiagnostic: { action: op.action, text: `Mock ${op.action} update ${poll}\nNo provider or daemon traffic is generated.` } });
	}
	if (op.action === "terminal") {
		return resultResponse({ ok: true, debugDiagnostic: { action: op.action, text: "Mock daemon session state. The omp console client supplies browser capabilities separately." } });
	}
	if (op.action === "protocols") {
		return resultResponse({ ok: true, debugDiagnostic: { action: op.action, text: "Terminal protocol checks do not apply to the omp console browser client." } });
	}
	if (op.action === "system") {
		return resultResponse({ ok: true, debugDiagnostic: { action: op.action, text: `Mock ${op.action} information.` } });
	}
	if (op.action === "performance-start") {
		return resultResponse({ ok: true, debugDiagnostic: { action: op.action, text: "Mock CPU profiling started." } });
	}
	const filename = op.action === "work" ? "mock-work.svg"
		: op.action === "transcript" ? "mock-transcript.jsonl"
			: `${op.action}-mock.tar.gz`;
	const mimeType = op.action === "work" ? "image/svg+xml"
		: op.action === "transcript" ? "application/x-ndjson"
			: "application/gzip";
	const payload = op.action === "work" ? '<svg xmlns="http://www.w3.org/2000/svg"><text>Mock profile</text></svg>'
		: `Mock ${op.action} artifact. No file was written by the mock daemon.`;
	return resultResponse({
		ok: true,
		debugDiagnostic: {
			action: op.action,
			text: `Mock ${op.action} result. No file was written by the mock daemon.`,
			download: {
				filename,
				mimeType,
				byteLength: new TextEncoder().encode(payload).byteLength,
				path: `mock://reports/${filename}`,
				base64: btoa(payload),
			},
		},
	});
}

function isDebugOperation(value: unknown): value is DebugSessionOp {
	if (!isRecord(value) || value.op !== "debug" || typeof value.action !== "string") return false;
	switch (value.action) {
		case "adapters":
		case "sessions":
		case "threads":
		case "stack":
		case "continue":
		case "step-over":
		case "step-in":
		case "step-out":
		case "pause":
		case "terminate":
		case "output":
			return true;
		case "select":
			return typeof value.sessionId === "string";
		case "launch":
			return value.confirmed === true && typeof value.program === "string" && value.program.trim() !== "" &&
				(value.args === undefined || (Array.isArray(value.args) && value.args.every(arg => typeof arg === "string"))) &&
				(value.adapter === undefined || typeof value.adapter === "string");
		case "attach":
			return value.confirmed === true &&
				(value.pid === undefined || (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0)) &&
				(value.port === undefined || (typeof value.port === "number" && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65_535)) &&
				(value.pid !== undefined || value.port !== undefined) &&
				(value.host === undefined || typeof value.host === "string") &&
				(value.adapter === undefined || typeof value.adapter === "string");
		case "scopes":
			return value.frameId === undefined || (typeof value.frameId === "number" && Number.isSafeInteger(value.frameId) && value.frameId >= 0);
		case "variables":
			return typeof value.reference === "number" && Number.isSafeInteger(value.reference) && value.reference >= 0;
		case "evaluate":
			return typeof value.expression === "string" && value.expression.trim() !== "" &&
				(value.context === undefined || value.context === "watch" || value.context === "repl" || value.context === "hover") &&
				(value.frameId === undefined || (typeof value.frameId === "number" && Number.isSafeInteger(value.frameId) && value.frameId >= 0));
		default:
			return false;
	}
}

function mockDebugSession(id: string, adapter: string, cwd: string, program?: string): DebugSessionSummary {
	const now = new Date().toISOString();
	return {
		id,
		adapter,
		cwd,
		...(program === undefined ? {} : { program }),
		status: "stopped",
		launchedAt: now,
		lastUsedAt: now,
		threadId: 1,
		frameId: 1,
		stopReason: "entry",
		frameName: "main",
		source: { path: `${cwd}/fixtures/sample.js`, name: "sample.js" },
		line: 1,
		breakpointCount: 0,
	};
}

function applyDebugOperation(
	sessionId: string,
	session: MockSessionOpsSession,
	op: DebugSessionOp,
	state: MockDebugState,
): Response {
	if (op.action === "adapters") return resultResponse({ ok: true, debugAdapters: MOCK_DEBUG_ADAPTERS });
	let sessions = state.sessions.get(sessionId);
	if (!sessions) {
		const fixture = mockDebugSession("mock-debug-fixture", "mock-dap", session.summary.cwd, "fixtures/sample.js");
		sessions = [fixture];
		state.sessions.set(sessionId, sessions);
		state.activeSessionIds.set(sessionId, fixture.id);
	}
	if (op.action === "sessions") {
		const activeSessionId = state.activeSessionIds.get(sessionId);
		return resultResponse({
			ok: true,
			debugSessions: sessions,
			...(activeSessionId === undefined ? {} : { activeSessionId }),
		});
	}
	if (op.action === "launch" || op.action === "attach") {
		const adapter = op.adapter ?? "mock-dap";
		if (!MOCK_DEBUG_ADAPTERS.some(candidate => candidate.name === adapter && candidate.available)) {
			return fail(400, "bad-request", `DAP adapter '${adapter}' is unavailable.`);
		}
		const id = `mock-debug-${++state.sequence}`;
		const program = op.action === "launch" ? op.program : op.pid === undefined ? `127.0.0.1:${op.port}` : `pid:${op.pid}`;
		const created = mockDebugSession(id, adapter, session.summary.cwd, program);
		sessions = [created, ...sessions];
		state.sessions.set(sessionId, sessions);
		state.activeSessionIds.set(sessionId, created.id);
		return resultResponse({ ok: true, debugSession: created });
	}
	if (op.action === "select") {
		const selected = sessions.find(candidate => candidate.id === op.sessionId);
		if (!selected) return fail(404, "not-found", "no such mock debug session");
		state.activeSessionIds.set(sessionId, selected.id);
		return resultResponse({ ok: true, debugSession: selected });
	}
	const selectedId = state.activeSessionIds.get(sessionId);
	const selected = sessions.find(candidate => candidate.id === selectedId);
	if (!selected) return fail(409, "conflict", "no mock debug session is selected");
	if (op.action === "terminate") {
		sessions = sessions.filter(candidate => candidate.id !== selected.id);
		state.sessions.set(sessionId, sessions);
		const next = sessions[0];
		if (next) state.activeSessionIds.set(sessionId, next.id);
		else state.activeSessionIds.delete(sessionId);
		return resultResponse({ ok: true, debugSessions: sessions, ...(next ? { activeSessionId: next.id } : {}) });
	}
	if (op.action === "threads") {
		const debugThreads: DebugThread[] = [{ id: 1, name: "main thread" }];
		return resultResponse({ ok: true, debugSession: selected, debugThreads });
	}
	if (op.action === "stack") {
		const debugStack: DebugStackFrame[] = [{
			id: 1,
			name: "main",
			line: selected.line ?? 1,
			column: 1,
			...(selected.source === undefined ? {} : { source: selected.source }),
		}];
		return resultResponse({ ok: true, debugSession: selected, debugStack });
	}
	if (op.action === "scopes") {
		return resultResponse({
			ok: true,
			debugSession: selected,
			debugScopes: [{ name: "Locals", variablesReference: 10 }],
		});
	}
	if (op.action === "variables") {
		const debugVariables: DebugVariable[] = [{ name: "value", value: "42", type: "number", variablesReference: 0 }];
		return resultResponse({ ok: true, debugSession: selected, debugVariables });
	}
	if (op.action === "evaluate") {
		return resultResponse({ ok: true, debugSession: selected, debugValue: "42" });
	}
	if (op.action === "output") {
		return resultResponse({ ok: true, debugSession: selected, debugOutput: "mock adapter output\\n" });
	}
	const status = op.action === "continue" ? "running" as const : "stopped" as const;
	const updated: DebugSessionSummary = {
		...selected,
		status,
		lastUsedAt: new Date().toISOString(),
		...(status === "stopped" ? { line: (selected.line ?? 0) + 1, stopReason: op.action === "pause" ? "pause" : "step" } : {}),
	};
	sessions = sessions.map(candidate => candidate.id === updated.id ? updated : candidate);
	state.sessions.set(sessionId, sessions);
	return resultResponse({ ok: true, debugSession: updated });
}
