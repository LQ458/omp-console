import type {
	DebugAdapterOption,
	DebugScope,
	DebugSessionOp,
	DebugSessionOpResult,
	DebugSessionSummary,
	DebugSource,
	DebugStackFrame,
	DebugThread,
	DebugVariable,
} from "@omp-console/protocol";
import { getAdapterConfigs, getAvailableAdapters, resolveLaunchOverrides, selectAttachAdapter, selectLaunchAdapter } from "@oh-my-pi/pi-coding-agent/dap/config";
import type { LaunchAdapterSelection } from "@oh-my-pi/pi-coding-agent/dap/config";
import { DapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import type { DapResolvedAdapter, DapSessionSummary } from "@oh-my-pi/pi-coding-agent/dap/types";
import { classifyLaunchProgram, validateLaunchProgram } from "@oh-my-pi/pi-coding-agent/tools/debug";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { RequestError } from "./request-error";

const STACK_FRAME_LIMIT = 50;
const OUTPUT_LIMIT_BYTES = 32 * 1024;
const DEBUG_OPERATION_TIMEOUT_MS = 30_000;
const DEBUG_CLOSE_TIMEOUT_MS = 1_000;


function sourceView(source: DapSessionSummary["source"]): DebugSource | undefined {
	if (!source) return undefined;
	return {
		...(source.name === undefined ? {} : { name: source.name }),
		...(source.path === undefined ? {} : { path: source.path }),
	};
}

function sessionView(session: DapSessionSummary): DebugSessionSummary {
	const source = sourceView(session.source);
	return {
		id: session.id,
		adapter: session.adapter,
		cwd: session.cwd,
		...(session.program === undefined ? {} : { program: session.program }),
		status: session.status,
		launchedAt: session.launchedAt,
		lastUsedAt: session.lastUsedAt,
		...(session.threadId === undefined ? {} : { threadId: session.threadId }),
		...(session.frameId === undefined ? {} : { frameId: session.frameId }),
		...(session.stopReason === undefined ? {} : { stopReason: session.stopReason }),
		...(session.stopDescription === undefined ? {} : { stopDescription: session.stopDescription }),
		...(session.frameName === undefined ? {} : { frameName: session.frameName }),
		...(source === undefined ? {} : { source }),
		...(session.line === undefined ? {} : { line: session.line }),
		...(session.column === undefined ? {} : { column: session.column }),
		breakpointCount: session.breakpointCount,
		...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
		...(session.childSessionIds === undefined ? {} : { childSessionIds: session.childSessionIds }),
	};
}


function adapterOptions(cwd: string): DebugAdapterOption[] {
	const configs = getAdapterConfigs(cwd);
	const available = new Set(getAvailableAdapters(cwd).map(adapter => adapter.name));
	return Object.entries(configs).map(([name, config]) => ({
		name,
		command: config.command,
		available: available.has(name),
		...(available.has(name) ? {} : { reason: `Command '${config.command}' is not available.` }),
		languages: config.languages ?? [],
		fileTypes: config.fileTypes ?? [],
	}));
}

function requireAdapter(selection: LaunchAdapterSelection): DapResolvedAdapter {
	if (selection.kind === "adapter") return selection.adapter;
	if (selection.kind === "unavailable") {
		throw new RequestError("bad-request", `DAP adapter '${selection.adapterName}' is unavailable (command '${selection.command}').`);
	}
	throw new RequestError("bad-request", "No configured DAP adapter matches this program.");
}

/** Exposes an isolated omp DAP manager and adapter selection to headless omp console clients. */
export class DebugModeService {
	readonly #session: AgentSession;
	readonly #manager = new DapSessionManager();

	constructor(session: AgentSession) {
		this.#session = session;
	}

	async run(op: DebugSessionOp, signal?: AbortSignal): Promise<DebugSessionOpResult> {
		signal?.throwIfAborted();
		const cwd = this.#session.sessionManager.getCwd();
		switch (op.action) {
			case "adapters":
				return { ok: true, debugAdapters: adapterOptions(cwd) };
			case "sessions": {
				const active = this.#manager.getActiveSession();
				return {
					ok: true,
					debugSessions: this.#manager.listSessions().map(sessionView),
					...(active ? { activeSessionId: active.id } : {}),
				};
			}
			case "select":
				return { ok: true, debugSession: sessionView(this.#manager.selectSession(op.sessionId)) };
			case "launch": {
				if (op.confirmed !== true) throw new RequestError("bad-request", "Confirm launching a debug process before starting it.");
				const program = resolveToCwd(op.program, cwd);
				const kind = await classifyLaunchProgram(program);
				const adapter = requireAdapter(selectLaunchAdapter(program, cwd, op.adapter, kind));
				validateLaunchProgram(program, cwd, kind, adapter);
				const debugSession = await this.#manager.launch({
					adapter,
					program,
					...(op.args === undefined ? {} : { args: op.args }),
					cwd,
					extraLaunchArguments: resolveLaunchOverrides(adapter, program, kind),
				}, signal, DEBUG_OPERATION_TIMEOUT_MS);
				return { ok: true, debugSession: sessionView(debugSession) };
			}
			case "attach": {
				if (op.confirmed !== true) throw new RequestError("bad-request", "Confirm attaching a debugger before starting its adapter.");
				const adapter = selectAttachAdapter(cwd, op.adapter, op.port);
				if (!adapter) {
					const configured = op.adapter ? getAdapterConfigs(cwd)[op.adapter] : undefined;
					if (configured) {
						throw new RequestError("bad-request", `DAP adapter '${op.adapter}' is unavailable (command '${configured.command}').`);
					}
					throw new RequestError("bad-request", "No available DAP adapter can attach to this target.");
				}
				const debugSession = await this.#manager.attach({
					adapter,
					cwd,
					...(op.pid === undefined ? {} : { pid: op.pid }),
					...(op.port === undefined ? {} : { port: op.port }),
					...(op.host === undefined ? {} : { host: op.host }),
				}, signal, DEBUG_OPERATION_TIMEOUT_MS);
				return { ok: true, debugSession: sessionView(debugSession) };
			}
			case "threads": {
				const result = await this.#manager.threads(signal, DEBUG_OPERATION_TIMEOUT_MS);
				const debugThreads: DebugThread[] = result.threads.map(thread => ({ id: thread.id, name: thread.name }));
				return { ok: true, debugSession: sessionView(result.snapshot), debugThreads };
			}
			case "stack": {
				const result = await this.#manager.stackTrace(STACK_FRAME_LIMIT, signal, DEBUG_OPERATION_TIMEOUT_MS);
				const debugStack: DebugStackFrame[] = result.stackFrames.map(frame => {
					const source = sourceView(frame.source);
					return {
						id: frame.id,
						name: frame.name,
						...(frame.line === undefined ? {} : { line: frame.line }),
						...(frame.column === undefined ? {} : { column: frame.column }),
						...(source === undefined ? {} : { source }),
					};
				});
				return { ok: true, debugSession: sessionView(result.snapshot), debugStack };
			}
			case "scopes": {
				const result = await this.#manager.scopes(op.frameId, signal, DEBUG_OPERATION_TIMEOUT_MS);
				const debugScopes: DebugScope[] = result.scopes.map(scope => ({
					name: scope.name,
					variablesReference: scope.variablesReference,
					...(scope.expensive === undefined ? {} : { expensive: scope.expensive }),
				}));
				return { ok: true, debugSession: sessionView(result.snapshot), debugScopes };
			}
			case "variables": {
				const result = await this.#manager.variables(op.reference, signal, DEBUG_OPERATION_TIMEOUT_MS);
				const debugVariables: DebugVariable[] = result.variables.map(variable => ({
					name: variable.name,
					value: variable.value,
					...(variable.type === undefined ? {} : { type: variable.type }),
					variablesReference: variable.variablesReference,
				}));
				return { ok: true, debugSession: sessionView(result.snapshot), debugVariables };
			}
			case "evaluate": {
				const result = await this.#manager.evaluate(op.expression, op.context, op.frameId, signal, DEBUG_OPERATION_TIMEOUT_MS);
				if (!result.evaluation) throw new RequestError("internal", "The DAP adapter returned no evaluation result.");
				return { ok: true, debugSession: sessionView(result.snapshot), debugValue: result.evaluation.result };
			}
			case "continue": {
				const result = await this.#manager.continue(signal, DEBUG_OPERATION_TIMEOUT_MS);
				return { ok: true, debugSession: sessionView(result.snapshot) };
			}
			case "step-over": {
				const result = await this.#manager.stepOver(signal, DEBUG_OPERATION_TIMEOUT_MS);
				return { ok: true, debugSession: sessionView(result.snapshot) };
			}
			case "step-in": {
				const result = await this.#manager.stepIn(signal, DEBUG_OPERATION_TIMEOUT_MS);
				return { ok: true, debugSession: sessionView(result.snapshot) };
			}
			case "step-out": {
				const result = await this.#manager.stepOut(signal, DEBUG_OPERATION_TIMEOUT_MS);
				return { ok: true, debugSession: sessionView(result.snapshot) };
			}
			case "pause": {
				const result = await this.#manager.pause(signal, DEBUG_OPERATION_TIMEOUT_MS);
				return { ok: true, debugSession: sessionView(result) };
			}
			case "terminate": {
				const result = await this.#manager.terminate(signal, DEBUG_OPERATION_TIMEOUT_MS);
				if (result) return { ok: true, debugSession: sessionView(result) };
				return { ok: true, debugSessions: this.#manager.listSessions().map(sessionView) };
			}
			case "output": {
				const result = this.#manager.getOutput(OUTPUT_LIMIT_BYTES);
				return { ok: true, debugSession: sessionView(result.snapshot), debugOutput: result.output };
			}
		}
	}

	async close(): Promise<void> {
		const roots = this.#manager.listSessions().filter(session => session.parentSessionId === undefined);
		const signal = AbortSignal.timeout(DEBUG_CLOSE_TIMEOUT_MS);
		await Promise.all(roots.map(async session => {
			try {
				await this.#manager.terminateSession(session.id, signal, DEBUG_CLOSE_TIMEOUT_MS);
			} catch {
				// DAP termination is best-effort; the manager disposes adapters even when shutdown requests fail.
			}
		}));
	}
}
