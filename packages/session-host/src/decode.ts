import { LIVE_INPUT_MAX_FRAME_BYTES } from "@omp-console/protocol";

import type { SessionOp, SessionOpV3, SpawnAgentRequest, WorkerCommand, WorkerOvernightOptions } from "@omp-console/protocol";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
type QueueImage = NonNullable<Extract<SessionOpV3, { op: "queue" }>["images"]>[number];

function decodeQueueImages(value: unknown): QueueImage[] | null | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return null;
	const images: QueueImage[] = [];
	for (const image of value) {
		if (!isObject(image) || image.type !== "image" || typeof image.data !== "string" || image.data === "" ||
			typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) return null;
		images.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	return images;
}

const TODO_STATUSES = ["pending", "in_progress", "completed", "abandoned", "blocked"];
const APPROVAL_MODES = ["always-ask", "always-ask-cached", "write", "yolo"];
const COMPACT_MODES = ["soft", "remote", "snap"];
const MAX_TEXT = 4000;
const MAX_ENTRY_ID = 256;
const MAX_LIVE_SDP = 64 * 1024;
const MAX_LIVE_AUDIO_BASE64 = Math.ceil(LIVE_INPUT_MAX_FRAME_BYTES / 3) * 4;
const LIVE_AUDIO_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isLiveSdpOffer(value: unknown): value is string {
	return typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= MAX_LIVE_SDP &&
		/^v=0(?:\r?\n|$)/.test(value) &&
		/^m=audio(?:[ \t]|$)/m.test(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}


/** A well-formed `SessionOp` or `SessionOpV3`; `undefined` for an unknown op or a field of the wrong type. */
export function decodeSessionOp(value: unknown): SessionOp | SessionOpV3 | undefined {
	if (!isObject(value)) return undefined;
	switch (value.op) {
		case "pause":
			return value.action === "pause" || value.action === "resume" || value.action === "toggle"
				? { op: "pause", action: value.action }
				: undefined;
		case "collab-status":
			return { op: "collab-status" };
		case "queue": {
			if (typeof value.text !== "string" || value.text.length > MAX_TEXT) return undefined;
			const images = decodeQueueImages(value.images);
			if (images === null) return undefined;
			return images === undefined ? { op: "queue", text: value.text } : { op: "queue", text: value.text, images };
		}
		case "rewind-points":
			return { op: "rewind-points" };
		case "rewind":
			return typeof value.entryId === "string" && value.entryId !== "" ? { op: "rewind", entryId: value.entryId } : undefined;
		case "shell":
			return (value.kind === "bash" || value.kind === "python") &&
				typeof value.code === "string" &&
				value.code.trim() !== "" &&
				typeof value.excludeFromContext === "boolean"
				? { op: "shell", kind: value.kind, code: value.code, excludeFromContext: value.excludeFromContext }
				: undefined;
		case "btw":
			if (typeof value.question !== "string" || value.question.trim() === "") return undefined;
			if (value.recordId === undefined) return { op: "btw", question: value.question };
			return typeof value.recordId === "string" && value.recordId !== "" ? { op: "btw", question: value.question, recordId: value.recordId } : undefined;
		case "ui-requests":
			return { op: "ui-requests" };
		case "ui-answer":
			return typeof value.reqId === "string" &&
				value.reqId.trim() !== "" &&
				value.reqId.length <= MAX_ENTRY_ID &&
				(value.value === null || (typeof value.value === "string" && value.value.length <= MAX_TEXT))
				? { op: "ui-answer", reqId: value.reqId, value: value.value }
				: undefined;
		case "quick-replies":
			return typeof value.entryId === "string" &&
				value.entryId.trim() !== "" &&
				value.entryId.length <= MAX_ENTRY_ID
				? { op: "quick-replies", entryId: value.entryId }
				: undefined;
		case "skills-search":
			return typeof value.query === "string" && value.query.trim() !== "" && value.query.length <= MAX_TEXT
				? { op: "skills-search", query: value.query.trim() }
				: undefined;
		case "skills-installed":
			return { op: "skills-installed" };
		case "skills-install": {
			const approvalId =
				value.approvalId === undefined
					? undefined
					: typeof value.approvalId === "string" && value.approvalId.trim() !== "" && value.approvalId.length <= MAX_ENTRY_ID
						? value.approvalId
						: null;
			return Array.isArray(value.specs) &&
				value.specs.length > 0 &&
				value.specs.length <= 100 &&
				value.specs.every(spec => typeof spec === "string" && spec.trim() !== "" && spec.length <= 300) &&
				typeof value.global === "boolean" &&
				approvalId !== null
				? { op: "skills-install", specs: value.specs as string[], global: value.global, ...(approvalId === undefined ? {} : { approvalId }) }
				: undefined;
		}
		case "skills-update": {
			const approvalId =
				value.approvalId === undefined
					? undefined
					: typeof value.approvalId === "string" && value.approvalId.trim() !== "" && value.approvalId.length <= MAX_ENTRY_ID
						? value.approvalId
						: null;
			return Array.isArray(value.names) &&
				value.names.length <= 100 &&
				value.names.every(name => typeof name === "string" && name.trim() !== "" && name.length <= 300) &&
				typeof value.global === "boolean" &&
				approvalId !== null
				? { op: "skills-update", names: value.names as string[], global: value.global, ...(approvalId === undefined ? {} : { approvalId }) }
				: undefined;
		}
		case "git-view":
			if (value.revision === undefined) return { op: "git-view" };
			return typeof value.revision === "string" && value.revision.trim() !== "" && value.revision.length <= MAX_ENTRY_ID
				? { op: "git-view", revision: value.revision.trim() }
				: undefined;
		case "git-diff":
			return typeof value.path === "string" &&
				value.path.trim() !== "" &&
				value.path.length <= 4096 &&
				(value.area === "unstaged" || value.area === "staged" || value.area === "commit") &&
				(value.revision === undefined ||
					(typeof value.revision === "string" && value.revision.trim() !== "" && value.revision.length <= MAX_ENTRY_ID))
				? value.revision === undefined
					? { op: "git-diff", path: value.path, area: value.area }
					: { op: "git-diff", path: value.path, area: value.area, revision: value.revision.trim() }
				: undefined;
		case "git-stage":
			return (value.action === "stage" || value.action === "unstage") &&
				Array.isArray(value.paths) &&
				value.paths.length > 0 &&
				value.paths.length <= 1000 &&
				value.paths.every(filePath => typeof filePath === "string" && filePath.trim() !== "" && filePath.length <= 4096)
				? { op: "git-stage", action: value.action, paths: value.paths as string[] }
				: undefined;
		case "git-hunk":
			return (value.action === "stage" || value.action === "unstage") &&
				(value.area === "unstaged" || value.area === "staged") &&
				((value.action === "stage" && value.area === "unstaged") || (value.action === "unstage" && value.area === "staged")) &&
				typeof value.path === "string" &&
				value.path.trim() !== "" &&
				value.path.length <= 4096 &&
				typeof value.hunkIndex === "number" &&
				Number.isInteger(value.hunkIndex) &&
				value.hunkIndex >= 0 &&
				value.hunkIndex <= 100_000 &&
				typeof value.patchHash === "string" &&
				/^[0-9a-f]{64}$/.test(value.patchHash)
				? {
						op: "git-hunk",
						action: value.action,
						path: value.path,
						area: value.area,
						hunkIndex: value.hunkIndex,
						patchHash: value.patchHash,
					}
				: undefined;
		case "git-commit":
			return typeof value.message === "string" && value.message.trim() !== "" && value.message.length <= MAX_TEXT
				? { op: "git-commit", message: value.message }
				: undefined;
		case "handoff":
			return typeof value.focus === "string" ? { op: "handoff", focus: value.focus } : undefined;
		case "loop-mode":
			if (value.action === "status" || value.action === "disable") return { op: "loop-mode", action: value.action };
			if (value.action !== "toggle") return undefined;
			if (value.args === undefined) return { op: "loop-mode", action: "toggle" };
			return typeof value.args === "string" && value.args.length <= MAX_TEXT
				? { op: "loop-mode", action: "toggle", args: value.args }
				: undefined;
		case "vibe-mode":
			if (value.action === "status" || value.action === "disable") return { op: "vibe-mode", action: value.action };
			if (value.action !== "toggle") return undefined;
			if (value.args === undefined) return { op: "vibe-mode", action: "toggle" };
			return typeof value.args === "string" && value.args.length <= MAX_TEXT
				? { op: "vibe-mode", action: "toggle", args: value.args }
				: undefined;
		case "plan-mode":
			return typeof value.enabled === "boolean" ? { op: "plan-mode", enabled: value.enabled } : undefined;
		case "goal":
			switch (value.action) {
				case "set":
					if (typeof value.objective !== "string" || value.objective.trim() === "") return undefined;
					if (value.tokenBudget !== undefined && !isPositiveInteger(value.tokenBudget)) return undefined;
					return value.tokenBudget === undefined
						? { op: "goal", action: "set", objective: value.objective }
						: { op: "goal", action: "set", objective: value.objective, tokenBudget: value.tokenBudget };
				case "pause":
				case "resume":
				case "drop":
					return { op: "goal", action: value.action };
				case "budget":
					return isPositiveInteger(value.tokenBudget) ? { op: "goal", action: "budget", tokenBudget: value.tokenBudget } : undefined;
				default:
					return undefined;
			}
		case "todos": {
			if (!Array.isArray(value.phases)) return undefined;
			const phases: Extract<SessionOp, { op: "todos" }>["phases"] = [];
			for (const phase of value.phases) {
				if (!isObject(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return undefined;
				const tasks: Array<{ content: string; status: Extract<SessionOp, { op: "todos" }>["phases"][number]["tasks"][number]["status"] }> = [];
				for (const task of phase.tasks) {
					if (!isObject(task) || typeof task.content !== "string" || typeof task.status !== "string" || !TODO_STATUSES.includes(task.status)) return undefined;
					tasks.push({ content: task.content, status: task.status as (typeof tasks)[number]["status"] });
				}
				phases.push({ name: phase.name, tasks });
			}
			return { op: "todos", phases };
		}
		case "compact":
			if (value.mode === undefined) return { op: "compact" };
			return typeof value.mode === "string" && COMPACT_MODES.includes(value.mode)
				? { op: "compact", mode: value.mode as "soft" | "remote" | "snap" }
				: undefined;
		case "approval-mode":
			return typeof value.mode === "string" && APPROVAL_MODES.includes(value.mode)
				? { op: "approval-mode", mode: value.mode as Extract<SessionOp, { op: "approval-mode" }>["mode"] }
				: undefined;
		case "dequeue":
			if (value.index === undefined) return { op: "dequeue" };
			return typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0
				? { op: "dequeue", index: value.index }
				: undefined;
		case "live-mode":
			if (value.action === "start") {
				return isLiveSdpOffer(value.offer)
					? { op: "live-mode", action: "start", offer: value.offer }
					: undefined;
			}
			return value.action === "stop" || value.action === "status" ? { op: "live-mode", action: value.action } : undefined;
		case "debug": {
			if (value.action === "adapters" || value.action === "sessions") return { op: "debug", action: value.action };
			if (typeof value.action !== "string") return undefined;
			if (value.action === "select") {
				return typeof value.sessionId === "string" && value.sessionId.trim() !== "" && value.sessionId.length <= MAX_ENTRY_ID
					? { op: "debug", action: "select", sessionId: value.sessionId }
					: undefined;
			}
			if (value.action === "launch") {
				if (value.confirmed !== true || typeof value.program !== "string" || value.program.trim() === "" || value.program.length > 4096) {
					return undefined;
				}
				if (value.adapter !== undefined && (typeof value.adapter !== "string" || value.adapter.length > 128)) return undefined;
				if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 128 ||
					value.args.some(arg => typeof arg !== "string" || arg.length > 4096))) return undefined;
				return {
					op: "debug",
					action: "launch",
					program: value.program,
					...(value.args === undefined ? {} : { args: value.args as string[] }),
					...(value.adapter === undefined ? {} : { adapter: value.adapter }),
					confirmed: true,
				};
			}
			if (value.action === "attach") {
				if (value.confirmed !== true ||
					(value.pid !== undefined && !isPositiveInteger(value.pid)) ||
					(value.port !== undefined && (!isPositiveInteger(value.port) || value.port > 65_535)) ||
					(value.host !== undefined && (typeof value.host !== "string" || value.host.length > 255)) ||
					(value.adapter !== undefined && (typeof value.adapter !== "string" || value.adapter.length > 128)) ||
					(value.pid === undefined && value.port === undefined)) return undefined;
				return {
					op: "debug",
					action: "attach",
					...(value.pid === undefined ? {} : { pid: value.pid }),
					...(value.port === undefined ? {} : { port: value.port }),
					...(value.host === undefined ? {} : { host: value.host }),
					...(value.adapter === undefined ? {} : { adapter: value.adapter }),
					confirmed: true,
				};
			}
			if (value.action === "scopes") {
				return value.frameId === undefined || isNonNegativeInteger(value.frameId)
					? { op: "debug", action: "scopes", ...(value.frameId === undefined ? {} : { frameId: value.frameId }) }
					: undefined;
			}
			if (value.action === "variables") {
				return isNonNegativeInteger(value.reference) && value.reference > 0
					? { op: "debug", action: "variables", reference: value.reference }
					: undefined;
			}
			if (value.action === "evaluate") {
				return typeof value.expression === "string" && value.expression.trim() !== "" && value.expression.length <= MAX_TEXT &&
					(value.context === undefined || value.context === "watch" || value.context === "repl" || value.context === "hover") &&
					(value.frameId === undefined || isNonNegativeInteger(value.frameId))
					? {
							op: "debug",
							action: "evaluate",
							expression: value.expression,
							...(value.context === undefined ? {} : { context: value.context }),
							...(value.frameId === undefined ? {} : { frameId: value.frameId }),
						}
					: undefined;
			}
			return ["threads", "stack", "continue", "step-over", "step-in", "step-out", "pause", "terminate", "output"].includes(value.action)
				? { op: "debug", action: value.action as "threads" | "stack" | "continue" | "step-over" | "step-in" | "step-out" | "pause" | "terminate" | "output" }
				: undefined;
		}
		case "debug-diagnostics": {
			const actions = [
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
			if (typeof value.action !== "string" || !actions.includes(value.action) ||
				(value.confirmed !== undefined && value.confirmed !== true)) return undefined;
			return {
				op: "debug-diagnostics",
				action: value.action as Extract<SessionOpV3, { op: "debug-diagnostics" }>["action"],
				...(value.confirmed === true ? { confirmed: true } : {}),
			};
		}
		case "stats":
		case "tree":
		case "context":
			return { op: value.op };
		case "tan-start":
			return typeof value.work === "string" && value.work.trim() !== "" && value.work.length <= MAX_TEXT
				? { op: "tan-start", work: value.work }
				: undefined;
		case "omfg-generate":
			return typeof value.requestId === "string" &&
				value.requestId.trim() !== "" &&
				value.requestId.length <= MAX_ENTRY_ID &&
				typeof value.complaint === "string" &&
				value.complaint.trim() !== "" &&
				value.complaint.length <= MAX_TEXT
				? { op: "omfg-generate", requestId: value.requestId, complaint: value.complaint }
				: undefined;
		case "omfg-save":
			return typeof value.requestId === "string" &&
				value.requestId.trim() !== "" &&
				value.requestId.length <= MAX_ENTRY_ID &&
				typeof value.fileContent === "string" &&
				value.fileContent.trim() !== "" &&
				value.fileContent.length <= 64_000 &&
				(value.scope === "project" || value.scope === "user") &&
				typeof value.overwrite === "boolean" &&
				typeof value.acceptUnvalidated === "boolean"
				? {
						op: "omfg-save",
						requestId: value.requestId,
						fileContent: value.fileContent,
						scope: value.scope,
						overwrite: value.overwrite,
						acceptUnvalidated: value.acceptUnvalidated,
					}
				: undefined;
		case "omfg-cancel":
			return typeof value.requestId === "string" && value.requestId.trim() !== "" && value.requestId.length <= MAX_ENTRY_ID
				? { op: "omfg-cancel", requestId: value.requestId }
				: undefined;
		case "cleanse-discover":
			return typeof value.includeTests === "boolean" ? { op: "cleanse-discover", includeTests: value.includeTests } : undefined;
		case "cleanse-start": {
			if (
				typeof value.runId !== "string" ||
				value.runId.trim() === "" ||
				value.runId.length > MAX_ENTRY_ID ||
				typeof value.includeTests !== "boolean" ||
				!isObject(value.scope)
			) {
				return undefined;
			}
			let scope: Extract<SessionOpV3, { op: "cleanse-start" }>["scope"];
			if (value.scope.kind === "all") {
				scope = { kind: "all" };
			} else if (value.scope.kind === "checker" && typeof value.scope.id === "string" && value.scope.id.trim() !== "" && value.scope.id.length <= MAX_ENTRY_ID) {
				scope = { kind: "checker", id: value.scope.id };
			} else if (value.scope.kind === "request" && typeof value.scope.request === "string" && value.scope.request.trim() !== "" && value.scope.request.length <= MAX_TEXT) {
				scope = { kind: "request", request: value.scope.request };
			} else {
				return undefined;
			}
			const maxAgents = value.maxAgents;
			if (maxAgents !== undefined && !isPositiveInteger(maxAgents)) return undefined;
			const model = value.model;
			if (model !== undefined && (typeof model !== "string" || model.trim() === "" || model.length > MAX_TEXT)) return undefined;
			return {
				op: "cleanse-start",
				runId: value.runId,
				scope,
				includeTests: value.includeTests,
				...(maxAgents === undefined ? {} : { maxAgents }),
				...(model === undefined ? {} : { model }),
			};
		}
		case "cleanse-cancel":
			return typeof value.runId === "string" && value.runId.trim() !== "" && value.runId.length <= MAX_ENTRY_ID
				? { op: "cleanse-cancel", runId: value.runId }
				: undefined;
		case "cleanse-state":
			return { op: "cleanse-state" };
		default:
			return undefined;
	}
}

function decodeQuotaPolicy(value: unknown): Extract<WorkerCommand, { t: "quota-policy" }> | undefined {
	if (!Array.isArray(value)) return undefined;
	const providers: Extract<WorkerCommand, { t: "quota-policy" }>["providers"] = [];
	for (const entry of value) {
		if (!isObject(entry) || typeof entry.provider !== "string" || typeof entry.admitSpawns !== "boolean" || typeof entry.holdPrompts !== "boolean") {
			return undefined;
		}
		if (entry.reason !== undefined && typeof entry.reason !== "string") return undefined;
		providers.push(
			entry.reason === undefined
				? { provider: entry.provider, admitSpawns: entry.admitSpawns, holdPrompts: entry.holdPrompts }
				: { provider: entry.provider, admitSpawns: entry.admitSpawns, holdPrompts: entry.holdPrompts, reason: entry.reason },
		);
	}
	return { t: "quota-policy", providers };
}

function decodeSpawnRequest(value: unknown): SpawnAgentRequest | undefined {
	if (!isObject(value) || typeof value.profile !== "string" || typeof value.task !== "string") return undefined;
	const request: SpawnAgentRequest = { profile: value.profile, task: value.task };
	if (value.name !== undefined) {
		if (typeof value.name !== "string") return undefined;
		request.name = value.name;
	}
	if (value.isolated !== undefined) {
		if (typeof value.isolated !== "boolean") return undefined;
		request.isolated = value.isolated;
	}
	if (value.files !== undefined) {
		if (!Array.isArray(value.files) || value.files.some(file => typeof file !== "string")) return undefined;
		request.files = value.files as string[];
	}
	return request;
}

function decodeOvernightOptions(value: unknown): WorkerOvernightOptions | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const options = value as Record<string, unknown>;
	if (
		typeof options.askTimeoutSec !== "number" ||
		!Number.isSafeInteger(options.askTimeoutSec) ||
		options.askTimeoutSec < 1 ||
		options.askTimeoutSec > 86_400 ||
		(options.quiet !== "normal" && options.quiet !== "quiet" && options.quiet !== "silent")
	) {
		return undefined;
	}
	return { askTimeoutSec: options.askTimeoutSec, quiet: options.quiet };
}

/** One stdin line to a worker command; `undefined` for anything unknown or malformed (the caller logs and ignores it). */
export function decodeCommand(line: string): WorkerCommand | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) return undefined;
	const { t, id } = parsed;
	if (t === "stop") return { t: "stop" };
	// Quota policy and bounded live-audio frames are the only commands without replies or ids.
	if (t === "quota-policy") return decodeQuotaPolicy(parsed.providers);
	if (t === "live-audio") {
		return typeof parsed.data === "string" &&
			parsed.data.length > 0 &&
			parsed.data.length <= MAX_LIVE_AUDIO_BASE64 &&
			parsed.data.length % 4 === 0 &&
			LIVE_AUDIO_BASE64.test(parsed.data)
			? { t: "live-audio", data: parsed.data }
			: undefined;
	}
	if (typeof id !== "string") return undefined;
	switch (t) {
		case "abort":
			return { t: "abort", id };
		case "cancel-session-op":
			return { t: "cancel-session-op", id };
		case "ping":
			return { t: "ping", id };
		case "catalog":
			return { t: "catalog", id };
		case "set-agent-model":
			if (typeof parsed.agentId === "string" && typeof parsed.selector === "string") {
				return { t: "set-agent-model", id, agentId: parsed.agentId, selector: parsed.selector };
			}
			return undefined;
		case "set-agent-thinking":
			if (typeof parsed.agentId === "string" && typeof parsed.level === "string") {
				return {
					t: "set-agent-thinking",
					id,
					agentId: parsed.agentId,
					level: parsed.level as Extract<WorkerCommand, { t: "set-agent-thinking" }>["level"],
				};
			}
			return undefined;
		case "run-command":
			return typeof parsed.text === "string" ? { t: "run-command", id, text: parsed.text } : undefined;
		case "spawn-agent": {
			const request = decodeSpawnRequest(parsed.request);
			return request ? { t: "spawn-agent", id, request } : undefined;
		}
		case "cancel-agent":
			return typeof parsed.agentId === "string" ? { t: "cancel-agent", id, agentId: parsed.agentId } : undefined;
		case "send-prompt":
			return typeof parsed.text === "string" && parsed.text.trim().length > 0 ? { t: "send-prompt", id, text: parsed.text } : undefined;
		case "overnight-options": {
			if (parsed.options === null) return { t: "overnight-options", id, options: null };
			const options = decodeOvernightOptions(parsed.options);
			return options ? { t: "overnight-options", id, options } : undefined;
		}
		case "freeze":
			return typeof parsed.frozen === "boolean" ? { t: "freeze", id, frozen: parsed.frozen } : undefined;
		case "session-op": {
			const op = decodeSessionOp(parsed.op);
			return op ? { t: "session-op", id, op } : undefined;
		}
		case "usage":
			return { t: "usage", id };
		case "summarize":
			return { t: "summarize", id };
		case "refine-title":
			return { t: "refine-title", id };
		case "plugins":
			return { t: "plugins", id };
		case "plugin-toggle":
			return typeof parsed.pluginId === "string" && typeof parsed.enabled === "boolean"
				? { t: "plugin-toggle", id, pluginId: parsed.pluginId, enabled: parsed.enabled }
				: undefined;
		default:
			return undefined;
	}
}

const REQUEST_COMMANDS: ReadonlySet<string> = new Set([
	"catalog",
	"run-command",
	"spawn-agent",
	"cancel-agent",
	"session-op",
	"usage",
	"summarize",
	"refine-title",
	"plugins",
	"plugin-toggle",
]);

/** The id and kind of a line `decodeCommand` rejected, when it was a request-style command (so the caller still gets an answer). */
export function malformedRequest(line: string): { id: string; t: string } | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (isObject(parsed) && typeof parsed.id === "string" && typeof parsed.t === "string" && REQUEST_COMMANDS.has(parsed.t)) {
			return { id: parsed.id, t: parsed.t };
		}
	} catch {
		// not JSON: nothing to answer
	}
	return undefined;
}
