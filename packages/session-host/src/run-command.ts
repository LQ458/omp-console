/**
 * `run-command`: run one remote-invokable slash command in the session exactly as omp's RPC mode runs a typed
 * prompt that starts with `/` (modes/rpc/rpc-mode.ts, `dispatchOrderedUserInput`):
 *
 *   1. `/skill:<name>`  -> `runRpcSkillCommand` (skill prompt message through the full prompt pipeline);
 *   2. built-in with a text-mode `handle` -> `executeAcpBuiltinSlashCommand`; a residual `{prompt}` is then sent
 *      through `session.prompt`;
 *   3. otherwise (extension, custom/MCP, file command, prompt template) -> `session.prompt(text)`, whose own
 *      pipeline runs or expands them.
 *
 * No command is reimplemented here. What differs from RPC is only what must differ without a client: built-in
 * output becomes a session `notice` event (UI-only, never reaches the model) instead of an RPC `command_output`
 * frame, and unknown or TUI-only names are refused instead of being sent to the model as plain text.
 *
 * Busy sessions: extension commands run immediately even mid-turn (omp's own rule). Every other kind (built-ins,
 * skills, file/custom/MCP commands, prompt templates) needs an idle session and is refused with `conflict` while a
 * turn streams or a compaction runs, because omp would otherwise queue it as steering text or reject it.
 *
 * The reply (`accepted`) is sent once omp admitted the command, not when the model finished its turn.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { resolveRpcSkillInvocation, runRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ACP_BUILTIN_RESERVED_NAMES, executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RequestError } from "./request-error";
import { sanitizeUsageReports } from "./usage-report";

const MAX_COMMAND_LENGTH = 16 * 1024;
const NOTICE_SOURCE_PREFIX = "deck-command:";

type CommandKind = "skill" | "builtin" | "extension" | "prompt";

/** Name of a non-built-in command: omp splits it at the first literal space (`plugin:command` stays whole). */
function plainName(text: string): string {
	const body = text.slice(1);
	const space = body.indexOf(" ");
	return space === -1 ? body : body.slice(0, space);
}

function classify(session: AgentSession, text: string): CommandKind {
	if (resolveRpcSkillInvocation(session, text)) return "skill";

	const parsed = parseSlashCommand(text);
	if (!parsed) throw new RequestError("bad-request", "text must be a slash command such as /compact");
	const builtin = lookupBuiltinSlashCommand(parsed.name);
	if (builtin) {
		if (builtin.handle) return "builtin";
		throw new RequestError("bad-request", `/${builtin.name} is only available in the terminal UI; it cannot run remotely`);
	}

	const name = plainName(text);
	if (name.startsWith("skill:")) {
		throw new RequestError("bad-request", `unknown skill ${name.slice("skill:".length)}, or skill commands are disabled in settings`);
	}
	if (session.extensionRunner?.getRegisteredCommands(ACP_BUILTIN_RESERVED_NAMES).some(command => command.name === name)) {
		return "extension";
	}
	const known =
		session.customCommands.some(command => command.command.name === name) ||
		session.slashCommands.some(command => command.name === name) ||
		session.promptTemplates.some(template => template.name === name);
	if (!known) throw new RequestError("bad-request", `unknown command /${name}`);
	return "prompt";
}

function toRequestError(error: unknown): RequestError {
	if (error instanceof RequestError) return error;
	return new RequestError("conflict", error instanceof Error ? error.message : String(error));
}

/**
 * Start `start` and resolve once omp admitted it (or it settled without ever being admitted, which an extension
 * command that only does local work does). A failure before admission rejects; a failure after it is logged only,
 * since the reply was already sent.
 */
function untilAdmitted(label: string, start: (onAdmitted: () => void) => Promise<unknown>): Promise<void> {
	const admitted = Promise.withResolvers<void>();
	start(() => admitted.resolve()).then(
		() => admitted.resolve(),
		error => {
			logger.warn("command failed after admission", { command: label, error: String(error) });
			admitted.reject(toRequestError(error));
		},
	);
	return admitted.promise;
}

export interface CommandRunnerOptions {
	session: AgentSession;
	mcpManager?: MCPManager;
}

export class CommandRunner {
	readonly #session: AgentSession;
	readonly #mcpManager: MCPManager | undefined;
	readonly #background = new Set<Promise<void>>();
	readonly #aborts = new Set<AbortController>();

	constructor(options: CommandRunnerOptions) {
		this.#session = options.session;
		this.#mcpManager = options.mcpManager;
	}

	/** Abort commands whose work outlives their reply (for example `/compact`), at worker shutdown. */
	abortBackground(reason: string): void {
		for (const controller of this.#aborts) controller.abort(reason);
		this.#aborts.clear();
	}

	/** Resolves when every command still running in the background has settled. */
	async settle(): Promise<void> {
		await Promise.allSettled([...this.#background]);
	}

	async run(rawText: string): Promise<void> {
		const text = rawText.trim();
		const session = this.#session;
		if (!text.startsWith("/")) {
			throw new RequestError("bad-request", `text must be a slash command of at most ${MAX_COMMAND_LENGTH} characters`);
		}
		const name = parseSlashCommand(text)?.name ?? "command";
		if (text.length > MAX_COMMAND_LENGTH) {
			const error = new RequestError("bad-request", `text must be a slash command of at most ${MAX_COMMAND_LENGTH} characters`);
			session.emitNotice("error", error.message, `${NOTICE_SOURCE_PREFIX}${name}`);
			throw error;
		}
		try {
			const kind = classify(session, text);
			if (kind !== "extension" && (session.isStreaming || session.isCompacting)) {
				throw new RequestError("conflict", "session is busy; this command needs an idle session");
			}
			if (kind === "skill") await this.#runSkill(text);
			else if (kind === "builtin") await this.#runBuiltin(text);
			else await untilAdmitted(text, onAdmitted => session.prompt(text, { onPromptAdmitted: onAdmitted, streamingBehavior: "followUp" }));
		} catch (error) {
			const requestError = toRequestError(error);
			session.emitNotice("error", requestError.message, `${NOTICE_SOURCE_PREFIX}${name}`);
			throw requestError;
		}
	}

	async #runSkill(text: string): Promise<void> {
		const session = this.#session;
		const invocation = resolveRpcSkillInvocation(session, text);
		if (!invocation) throw new RequestError("bad-request", "skill is no longer available");
		await untilAdmitted(text, onAdmitted => runRpcSkillCommand(session, invocation, "steer", undefined, onAdmitted));
	}

	async #runBuiltin(text: string): Promise<void> {
		const session = this.#session;
		const output: string[] = [];
		const abort = new AbortController();
		this.#aborts.add(abort);
		let backgrounded = false;
		let publishedOutputCount = 0;
		const name = parseSlashCommand(text)?.name ?? "command";
		const source = `${NOTICE_SOURCE_PREFIX}${name}`;
		const usageShow = name === "usage" && /^\/usage(?:\s+show)?$/i.test(text);
		const publishOutput = (): void => {
			while (publishedOutputCount < output.length) {
				session.emitNotice("info", output[publishedOutputCount]!, source);
				publishedOutputCount++;
			}
		};
		try {
			const result = await executeAcpBuiltinSlashCommand(text, {
				session,
				sessionManager: session.sessionManager,
				settings: session.settings,
				cwd: session.sessionManager.getCwd(),
				signal: abort.signal,
				mcpManager: this.#mcpManager,
				output: commandOutput => {
					output.push(commandOutput);
					if (backgrounded) publishOutput();
				},
				refreshCommands: async () => {},
				reloadPlugins: async () => {
					const projectPath = await resolveActiveProjectRegistryPath(session.sessionManager.getCwd());
					clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
					await session.refreshSkillsAndCommands();
				},
				runCommandInBackground: task => {
					backgrounded = true;
					publishOutput();
					const running = task()
						.catch(error => {
							logger.warn("background command failed", { command: text, error: String(error) });
							session.emitNotice("error", error instanceof Error ? error.message : String(error), source);
						})
						.finally(() => {
							this.#background.delete(running);
							this.#aborts.delete(abort);
						});
					this.#background.add(running);
				},
			});
			if (result === false) throw new RequestError("bad-request", `/${name} is not available remotely`);
			if ("prompt" in result) {
				publishOutput();
				const residual = result.prompt;
				await untilAdmitted(residual, onAdmitted => session.prompt(residual, { onPromptAdmitted: onAdmitted }));
				return;
			}
			if (result.failed === true) {
				throw new RequestError("bad-request", output.join("\n").trim() || `/${name} failed`);
			}
			if (!backgrounded) {
				if (usageShow && output.some(message => message.startsWith("```"))) {
					const usageReports = sanitizeUsageReports(session.cachedUsageReports ?? null);
					if (usageReports.length > 0) {
						session.emitNotice(
							"info",
							JSON.stringify({ type: "deck-command-result", text: output.join("\n\n"), usageReports }),
							source,
						);
					} else {
						publishOutput();
					}
				} else {
					publishOutput();
				}
			}
		} finally {
			if (!backgrounded) this.#aborts.delete(abort);
		}
	}
}
