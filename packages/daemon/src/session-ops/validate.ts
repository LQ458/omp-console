import type { DebugSessionOp, SessionOp, SessionOpV3 } from "@omp-console/protocol";
import { RouteError } from "./http";

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "abandoned", "blocked"]);
const APPROVAL_MODES: ReadonlySet<string> = new Set(["always-ask", "always-ask-cached", "write", "yolo"]);
const COMPACT_MODES: ReadonlySet<string> = new Set(["soft", "remote", "snap"]);
const MAX_TEXT = 4000;
const MAX_SHELL_CODE = 16_384;
const MAX_ENTRY_ID = 256;
const MAX_PHASES = 100;
const MAX_TASKS = 500;
const MAX_LIVE_SDP = 64 * 1024;
type QueueImage = NonNullable<Extract<SessionOpV3, { op: "queue" }>["images"]>[number];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiveSdpOffer(value: unknown): value is string {
	return typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= MAX_LIVE_SDP &&
		/^v=0(?:\r?\n|$)/.test(value) &&
		/^m=audio(?:[ \t]|$)/m.test(value);
}

function bad(message: string): never {
	throw new RouteError("bad-request", message);
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) bad(`${field} must be a positive integer`);
	return value;
}
function optionalApprovalId(body: Record<string, unknown>): string | undefined {
	const value = body.approvalId;
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "" || value.length > MAX_ENTRY_ID) {
		bad("skills operation `approvalId` must be a non-empty string of at most 256 characters");
	}
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) bad(`${field} must be a non-negative integer`);
	return value;
}

/** A well-formed operation from an untrusted request body; throws a `bad-request` `RouteError` otherwise. */
export function parseSessionOp(body: unknown): SessionOp | SessionOpV3 {
	if (!isObject(body) || typeof body.op !== "string") bad("body must be a session operation with an `op` field");
	switch (body.op) {
		case "pause":
			if (body.action !== "pause" && body.action !== "resume" && body.action !== "toggle") {
				bad("pause `action` must be pause, resume or toggle");
			}
			return { op: "pause", action: body.action };
		case "collab-status":
			return { op: "collab-status" };
		case "queue": {
			if (typeof body.text !== "string") bad("queue needs string `text`");
			if (body.text.length > MAX_TEXT) bad("queue `text` is too long");
			let images: QueueImage[] | undefined;
			if (body.images !== undefined) {
				if (!Array.isArray(body.images)) bad("queue `images` must be an array");
				images = [];
				for (const image of body.images) {
					if (!isObject(image) || image.type !== "image" || typeof image.data !== "string" || image.data === "" ||
						typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
						bad("queue images must contain image data and an image MIME type");
					}
					images.push({ type: "image", data: image.data, mimeType: image.mimeType });
				}
			}
			return images === undefined ? { op: "queue", text: body.text } : { op: "queue", text: body.text, images };
		}
		case "rewind-points":
			return { op: "rewind-points" };
		case "rewind":
			if (typeof body.entryId !== "string" || body.entryId.trim() === "") bad("rewind needs a non-empty `entryId`");
			if (body.entryId.length > MAX_ENTRY_ID) bad("rewind `entryId` is too long");
			return { op: "rewind", entryId: body.entryId };
		case "shell":
			if (body.kind !== "bash" && body.kind !== "python") bad("shell `kind` must be bash or python");
			if (typeof body.code !== "string" || body.code.trim() === "") bad("shell needs non-empty `code`");
			if (body.code.length > MAX_SHELL_CODE) bad("shell `code` is too long");
			if (typeof body.excludeFromContext !== "boolean") bad("shell needs a boolean `excludeFromContext`");
			return { op: "shell", kind: body.kind, code: body.code, excludeFromContext: body.excludeFromContext };
		case "btw":
			if (typeof body.question !== "string" || body.question.trim() === "") bad("btw needs a non-empty `question`");
			if (body.question.length > MAX_TEXT) bad("btw `question` is too long");
			if (body.recordId !== undefined && (typeof body.recordId !== "string" || body.recordId === "" || body.recordId.length > 200)) bad("btw `recordId` must be a non-empty string");
			return body.recordId === undefined ? { op: "btw", question: body.question } : { op: "btw", question: body.question, recordId: body.recordId };
		case "ui-requests":
			return { op: "ui-requests" };
		case "ui-answer":
			if (typeof body.reqId !== "string" || body.reqId.trim() === "") bad("ui-answer needs a non-empty `reqId`");
			if (body.reqId.length > MAX_ENTRY_ID) bad("ui-answer `reqId` is too long");
			if (body.value !== null && typeof body.value !== "string") bad("ui-answer `value` must be a string or null");
			if (typeof body.value === "string" && body.value.length > MAX_TEXT) bad("ui-answer `value` is too long");
			return { op: "ui-answer", reqId: body.reqId, value: body.value };
		case "quick-replies":
			if (typeof body.entryId !== "string" || body.entryId.trim() === "") bad("quick-replies needs a non-empty `entryId`");
			if (body.entryId.length > MAX_ENTRY_ID) bad("quick-replies `entryId` is too long");
			return { op: "quick-replies", entryId: body.entryId };
		case "skills-search":
			if (typeof body.query !== "string" || body.query.trim() === "") bad("skills-search needs a non-empty `query`");
			if (body.query.length > MAX_TEXT) bad("skills-search `query` is too long");
			return { op: "skills-search", query: body.query.trim() };
		case "skills-installed":
			return { op: "skills-installed" };
		case "skills-install": {
			const approvalId = optionalApprovalId(body);
			if (!Array.isArray(body.specs) || body.specs.length === 0 || body.specs.length > 100) bad("skills-install needs 1-100 `specs`");
			if (!body.specs.every(spec => typeof spec === "string" && spec.trim() !== "" && spec.length <= 300)) {
				bad("skills-install `specs` must be non-empty strings of at most 300 characters");
			}
			if (typeof body.global !== "boolean") bad("skills-install needs a boolean `global`");
			return { op: "skills-install", specs: body.specs as string[], global: body.global, ...(approvalId === undefined ? {} : { approvalId }) };
		}
		case "skills-update": {
			const approvalId = optionalApprovalId(body);
			if (!Array.isArray(body.names) || body.names.length > 100) bad("skills-update `names` must be an array of at most 100 names");
			if (!body.names.every(name => typeof name === "string" && name.trim() !== "" && name.length <= 300)) {
				bad("skills-update `names` must be non-empty strings of at most 300 characters");
			}
			if (typeof body.global !== "boolean") bad("skills-update needs a boolean `global`");
			return { op: "skills-update", names: body.names as string[], global: body.global, ...(approvalId === undefined ? {} : { approvalId }) };
		}
		case "git-view":
			if (body.revision === undefined) return { op: "git-view" };
			if (typeof body.revision !== "string" || body.revision.trim() === "" || body.revision.length > MAX_ENTRY_ID) {
				bad("git-view `revision` must be a non-empty string of at most 256 characters");
			}
			return { op: "git-view", revision: body.revision.trim() };
		case "git-diff":
			if (typeof body.path !== "string" || body.path.trim() === "" || body.path.length > 4096) bad("git-diff needs a repository `path`");
			if (body.area !== "unstaged" && body.area !== "staged" && body.area !== "commit") bad("git-diff `area` must be unstaged, staged or commit");
			if (body.revision !== undefined && (typeof body.revision !== "string" || body.revision.trim() === "" || body.revision.length > MAX_ENTRY_ID)) {
				bad("git-diff `revision` must be a non-empty string of at most 256 characters");
			}
			return body.revision === undefined
				? { op: "git-diff", path: body.path, area: body.area }
				: { op: "git-diff", path: body.path, area: body.area, revision: body.revision.trim() };
		case "git-stage":
			if (body.action !== "stage" && body.action !== "unstage") bad("git-stage `action` must be stage or unstage");
			if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > 1000) bad("git-stage needs 1-1000 `paths`");
			if (!body.paths.every(filePath => typeof filePath === "string" && filePath.trim() !== "" && filePath.length <= 4096)) {
				bad("git-stage `paths` must be non-empty strings of at most 4096 characters");
			}
			return { op: "git-stage", action: body.action, paths: body.paths as string[] };
		case "git-hunk":
			if (body.action !== "stage" && body.action !== "unstage") bad("git-hunk `action` must be stage or unstage");
			if (body.area !== "unstaged" && body.area !== "staged") bad("git-hunk `area` must be unstaged or staged");
			if ((body.action === "stage" && body.area !== "unstaged") || (body.action === "unstage" && body.area !== "staged")) {
				bad("git-hunk stage targets unstaged hunks and unstage targets staged hunks");
			}
			if (typeof body.path !== "string" || body.path.trim() === "" || body.path.length > 4096) bad("git-hunk needs a repository `path`");
			if (typeof body.hunkIndex !== "number" || !Number.isInteger(body.hunkIndex) || body.hunkIndex < 0 || body.hunkIndex > 100_000) {
				bad("git-hunk `hunkIndex` must be an integer from 0 to 100000");
			}
			if (typeof body.patchHash !== "string" || !/^[0-9a-f]{64}$/.test(body.patchHash)) bad("git-hunk `patchHash` must be a SHA-256 hex digest");
			return {
				op: "git-hunk",
				action: body.action,
				path: body.path,
				area: body.area,
				hunkIndex: body.hunkIndex,
				patchHash: body.patchHash,
			};
		case "git-commit":
			if (typeof body.message !== "string" || body.message.trim() === "") bad("git-commit needs a non-empty `message`");
			if (body.message.length > MAX_TEXT) bad("git-commit `message` is too long");
			return { op: "git-commit", message: body.message };
		case "tan-start":
			if (typeof body.work !== "string" || body.work.trim() === "" || body.work.length > MAX_TEXT) {
				bad(`tan-start \`work\` must be a non-empty string of at most ${MAX_TEXT} characters`);
			}
			return { op: "tan-start", work: body.work };
		case "omfg-generate":
			if (typeof body.requestId !== "string" || body.requestId.trim() === "" || body.requestId.length > MAX_ENTRY_ID) {
				bad("omfg-generate \`requestId\` must be a non-empty string of at most 256 characters");
			}
			if (typeof body.complaint !== "string" || body.complaint.trim() === "" || body.complaint.length > MAX_TEXT) {
				bad(`omfg-generate \`complaint\` must be a non-empty string of at most ${MAX_TEXT} characters`);
			}
			return { op: "omfg-generate", requestId: body.requestId, complaint: body.complaint };
		case "omfg-save":
			if (typeof body.requestId !== "string" || body.requestId.trim() === "" || body.requestId.length > MAX_ENTRY_ID) {
				bad("omfg-save \`requestId\` must be a non-empty string of at most 256 characters");
			}
			if (typeof body.fileContent !== "string" || body.fileContent.trim() === "" || body.fileContent.length > 64_000) {
				bad("omfg-save \`fileContent\` must be a non-empty string of at most 64000 characters");
			}
			if (body.scope !== "project" && body.scope !== "user") bad("omfg-save \`scope\` must be project or user");
			if (typeof body.overwrite !== "boolean" || typeof body.acceptUnvalidated !== "boolean") {
				bad("omfg-save needs boolean \`overwrite\` and \`acceptUnvalidated\` fields");
			}
			return {
				op: "omfg-save",
				requestId: body.requestId,
				fileContent: body.fileContent,
				scope: body.scope,
				overwrite: body.overwrite,
				acceptUnvalidated: body.acceptUnvalidated,
			};
		case "omfg-cancel":
			if (typeof body.requestId !== "string" || body.requestId.trim() === "" || body.requestId.length > MAX_ENTRY_ID) {
				bad("omfg-cancel \`requestId\` must be a non-empty string of at most 256 characters");
			}
			return { op: "omfg-cancel", requestId: body.requestId };
		case "cleanse-discover":
			if (typeof body.includeTests !== "boolean") bad("cleanse-discover needs a boolean \`includeTests\`");
			return { op: "cleanse-discover", includeTests: body.includeTests };
		case "cleanse-start": {
			if (typeof body.runId !== "string" || body.runId.trim() === "" || body.runId.length > MAX_ENTRY_ID) {
				bad("cleanse-start \`runId\` must be a non-empty string of at most 256 characters");
			}
			if (typeof body.includeTests !== "boolean") bad("cleanse-start needs a boolean \`includeTests\`");
			if (!isObject(body.scope)) bad("cleanse-start needs a valid \`scope\`");
			let scope: Extract<SessionOpV3, { op: "cleanse-start" }>["scope"];
			if (body.scope.kind === "all") {
				scope = { kind: "all" };
			} else if (
				body.scope.kind === "checker" &&
				typeof body.scope.id === "string" &&
				body.scope.id.trim() !== "" &&
				body.scope.id.length <= MAX_ENTRY_ID
			) {
				scope = { kind: "checker", id: body.scope.id };
			} else if (
				body.scope.kind === "request" &&
				typeof body.scope.request === "string" &&
				body.scope.request.trim() !== "" &&
				body.scope.request.length <= MAX_TEXT
			) {
				scope = { kind: "request", request: body.scope.request };
			} else {
				bad("cleanse-start \`scope\` must be all, a named checker or a non-empty request");
			}
			if (body.maxAgents !== undefined) positiveInteger(body.maxAgents, "maxAgents");
			if (
				body.model !== undefined &&
				(typeof body.model !== "string" || body.model.trim() === "" || body.model.length > MAX_TEXT)
			) {
				bad(`cleanse-start \`model\` must be a non-empty string of at most ${MAX_TEXT} characters`);
			}
			return {
				op: "cleanse-start",
				runId: body.runId,
				scope,
				includeTests: body.includeTests,
				...(body.maxAgents === undefined ? {} : { maxAgents: body.maxAgents as number }),
				...(body.model === undefined ? {} : { model: body.model as string }),
			};
		}
		case "cleanse-cancel":
			if (typeof body.runId !== "string" || body.runId.trim() === "" || body.runId.length > MAX_ENTRY_ID) {
				bad("cleanse-cancel \`runId\` must be a non-empty string of at most 256 characters");
			}
			return { op: "cleanse-cancel", runId: body.runId };
		case "cleanse-state":
			return { op: "cleanse-state" };
		case "loop-mode":
			if (body.action === "status" || body.action === "disable") return { op: "loop-mode", action: body.action };
			if (body.action !== "toggle") bad("loop-mode action must be toggle, disable or status");
			if (body.args === undefined) return { op: "loop-mode", action: "toggle" };
			if (typeof body.args !== "string" || body.args.length > MAX_TEXT) bad(`loop-mode args must be a string no longer than ${MAX_TEXT} characters`);
			return { op: "loop-mode", action: "toggle", args: body.args };
		case "vibe-mode":
			if (body.action === "status" || body.action === "disable") return { op: "vibe-mode", action: body.action };
			if (body.action !== "toggle") bad("vibe-mode action must be toggle, disable or status");
			if (body.args === undefined) return { op: "vibe-mode", action: "toggle" };
			if (typeof body.args !== "string" || body.args.length > MAX_TEXT) bad(`vibe-mode args must be a string no longer than ${MAX_TEXT} characters`);
			return { op: "vibe-mode", action: "toggle", args: body.args };
		case "live-mode":
			if (body.action === "start") {
				if (!isLiveSdpOffer(body.offer)) {
					bad("live-mode start needs an SDP offer starting with v=0, containing an m=audio line, and no longer than 65536 characters");
				}
				return { op: "live-mode", action: "start", offer: body.offer };
			}
			if (body.action !== "stop" && body.action !== "status") bad("live-mode `action` must be start, stop or status");
			return { op: "live-mode", action: body.action };
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
			] as const;
			if (typeof body.action !== "string" || !actions.includes(body.action as (typeof actions)[number])) {
				bad("unknown debug diagnostics action");
			}
			if (body.confirmed !== undefined && body.confirmed !== true) bad("debug diagnostics confirmation must be true when present");
			return {
				op: "debug-diagnostics",
				action: body.action as (typeof actions)[number],
				...(body.confirmed === true ? { confirmed: true } : {}),
			};
		}
		case "debug": {
			if (body.action === "adapters" || body.action === "sessions") return { op: "debug", action: body.action };
			if (body.action === "select") {
				if (typeof body.sessionId !== "string" || body.sessionId.trim() === "" || body.sessionId.length > MAX_ENTRY_ID) {
					bad("debug select needs a session id of at most 256 characters");
				}
				return { op: "debug", action: "select", sessionId: body.sessionId };
			}
			if (body.action === "launch") {
				if (body.confirmed !== true) bad("debug launch requires explicit confirmation");
				if (typeof body.program !== "string" || body.program.trim() === "" || body.program.length > 4096) bad("debug launch needs a program path of at most 4096 characters");
				if (body.adapter !== undefined && (typeof body.adapter !== "string" || body.adapter.length > 128)) bad("debug launch adapter must be at most 128 characters");
				if (body.args !== undefined && (!Array.isArray(body.args) || body.args.length > 128 ||
					!body.args.every(arg => typeof arg === "string" && arg.length <= 4096))) bad("debug launch args must contain at most 128 strings of at most 4096 characters");
				const args = body.args as string[] | undefined;
				const adapter = body.adapter as string | undefined;
				return {
					op: "debug",
					action: "launch",
					program: body.program,
					...(args === undefined ? {} : { args }),
					...(adapter === undefined ? {} : { adapter }),
					confirmed: true,
				};
			}
			if (body.action === "attach") {
				if (body.confirmed !== true) bad("debug attach requires explicit confirmation");
				if (body.pid !== undefined) positiveInteger(body.pid, "debug attach pid");
				if (body.port !== undefined && (positiveInteger(body.port, "debug attach port") > 65_535)) bad("debug attach port must be at most 65535");
				if (body.host !== undefined && (typeof body.host !== "string" || body.host.length > 255)) bad("debug attach host must be at most 255 characters");
				if (body.adapter !== undefined && (typeof body.adapter !== "string" || body.adapter.length > 128)) bad("debug attach adapter must be at most 128 characters");
				if (body.pid === undefined && body.port === undefined) bad("debug attach needs a pid or port");
				return {
					op: "debug",
					action: "attach",
					...(body.pid === undefined ? {} : { pid: body.pid as number }),
					...(body.port === undefined ? {} : { port: body.port as number }),
					...(body.host === undefined ? {} : { host: body.host as string }),
					...(body.adapter === undefined ? {} : { adapter: body.adapter as string }),
					confirmed: true,
				};
			}
			if (body.action === "scopes") {
				const frameId = body.frameId === undefined ? undefined : nonNegativeInteger(body.frameId, "debug scopes frameId");
				return { op: "debug", action: "scopes", ...(frameId === undefined ? {} : { frameId }) };
			}
			if (body.action === "variables") {
				const reference = positiveInteger(body.reference, "debug variables reference");
				return { op: "debug", action: "variables", reference };
			}
			if (body.action === "evaluate") {
				if (typeof body.expression !== "string" || body.expression.trim() === "" || body.expression.length > MAX_TEXT) bad("debug evaluate needs a non-empty expression of at most 4000 characters");
				if (body.context !== undefined && body.context !== "watch" && body.context !== "repl" && body.context !== "hover") bad("debug evaluate context must be watch, repl or hover");
				const frameId = body.frameId === undefined ? undefined : nonNegativeInteger(body.frameId, "debug evaluate frameId");
				return {
					op: "debug",
					action: "evaluate",
					expression: body.expression,
					...(body.context === undefined ? {} : { context: body.context }),
					...(frameId === undefined ? {} : { frameId }),
				};
			}
			const actions = ["threads", "stack", "continue", "step-over", "step-in", "step-out", "pause", "terminate", "output"] as const;
			if (typeof body.action !== "string" || !actions.includes(body.action as (typeof actions)[number])) {
				bad("unknown debug session action");
			}
			return { op: "debug", action: body.action as (typeof actions)[number] };
		}
		case "plan-mode":
			if (typeof body.enabled !== "boolean") bad("plan-mode needs a boolean `enabled`");
			return { op: "plan-mode", enabled: body.enabled };
		case "goal":
			switch (body.action) {
				case "set": {
					if (typeof body.objective !== "string" || body.objective.trim() === "") bad("goal set needs a non-empty `objective`");
					if (body.objective.length > MAX_TEXT) bad("goal objective is too long");
					if (body.tokenBudget === undefined) return { op: "goal", action: "set", objective: body.objective };
					return { op: "goal", action: "set", objective: body.objective, tokenBudget: positiveInteger(body.tokenBudget, "tokenBudget") };
				}
				case "pause":
				case "resume":
				case "drop":
					return { op: "goal", action: body.action };
				case "budget":
					return { op: "goal", action: "budget", tokenBudget: positiveInteger(body.tokenBudget, "tokenBudget") };
				default:
					return bad("goal `action` must be set, pause, resume, drop or budget");
			}
		case "todos": {
			if (!Array.isArray(body.phases)) bad("todos needs a `phases` array");
			if (body.phases.length > MAX_PHASES) bad(`at most ${MAX_PHASES} phases`);
			const phases: Extract<SessionOp, { op: "todos" }>["phases"] = [];
			for (const phase of body.phases) {
				if (!isObject(phase) || typeof phase.name !== "string" || phase.name.trim() === "" || !Array.isArray(phase.tasks)) {
					bad("each phase needs a non-empty `name` and a `tasks` array");
				}
				if (phase.name.length > MAX_TEXT || phase.tasks.length > MAX_TASKS) bad("a phase is too large");
				const tasks: Array<{ content: string; status: (typeof phases)[number]["tasks"][number]["status"] }> = [];
				for (const task of phase.tasks) {
					if (!isObject(task) || typeof task.content !== "string" || task.content.trim() === "" || task.content.length > MAX_TEXT) {
						bad(`phase ${phase.name}: each task needs non-empty \`content\``);
					}
					if (typeof task.status !== "string" || !TODO_STATUSES.has(task.status)) {
						bad(`phase ${phase.name}: task status must be pending, in_progress, completed, abandoned or blocked`);
					}
					tasks.push({ content: task.content, status: task.status as (typeof tasks)[number]["status"] });
				}
				phases.push({ name: phase.name, tasks });
			}
			return { op: "todos", phases };
		}
		case "compact":
			if (body.mode === undefined) return { op: "compact" };
			if (typeof body.mode !== "string" || !COMPACT_MODES.has(body.mode)) bad("compact `mode` must be soft, remote or snap");
			return { op: "compact", mode: body.mode as "soft" | "remote" | "snap" };
		case "approval-mode":
			if (typeof body.mode !== "string" || !APPROVAL_MODES.has(body.mode)) {
				bad("approval-mode `mode` must be always-ask, always-ask-cached, write or yolo");
			}
			return { op: "approval-mode", mode: body.mode as Extract<SessionOp, { op: "approval-mode" }>["mode"] };
		case "dequeue":
			if (body.index === undefined) return { op: "dequeue" };
			if (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0) bad("dequeue `index` must be a non-negative integer");
			return { op: "dequeue", index: body.index };
		case "stats":
		case "tree":
		case "context":
			return { op: body.op };
		default:
			return bad(`unknown session operation ${JSON.stringify(body.op)}`);
	}
}
