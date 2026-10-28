/**
 * Process entry of a session-host worker. Launch contract and wire format: `packages/protocol/src/worker.ts`.
 *
 *   bun packages/session-host/src/main.ts --cwd <dir> --relay <url> --room <id> \
 *       [--resume <file>] [--fork <file>[:<entryId>]] [--model <selector>]
 *   stdin first line: WorkerLaunchSecrets; subsequent lines are worker commands.
 *
 * stdout carries status JSON lines only (everything else a dependency prints is rerouted to stderr);
 * EOF after the launch line means stop (exit 0). SIGTERM/SIGINT stop through the shared postmortem handler.
 * A stop completes within 5 s; startup or room failure emits `fatal` and exits 1.
 */
import * as fs from "node:fs";
import type { WorkerCommand, WorkerLaunchSecrets, WorkerRequestResult } from "@omp-console/protocol";
import { logger } from "@oh-my-pi/pi-utils";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { setFocusedAgentModel, setFocusedAgentThinking } from "./agent-model";
import { decodeCommand, malformedRequest } from "./decode";
import { LaunchError, parseLaunch, parseLaunchSecrets, type WorkerLaunch } from "./launch";
import { RequestError } from "./request-error";
import { killDescendantsNow } from "./process-tree";
import type { StatusLine, StatusSink } from "./status";
import { SessionHostWorker } from "./worker";

/** The stop contract: the process is gone this long after a stop trigger, whatever a dependency is doing. */
const EXIT_DEADLINE_MS = 4500;
const LAUNCH_SECRETS_TIMEOUT_MS = 10_000;

/** Synchronous write to fd 1: nothing is lost when the process exits right after a status line. */
function createStdoutSink(): StatusSink {
	let broken = false;
	return {
		emit(line: StatusLine): void {
			if (broken) return;
			const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
			let offset = 0;
			while (offset < bytes.length) {
				try {
					offset += fs.writeSync(1, bytes, offset);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "EAGAIN") {
						Bun.sleepSync(2);
						continue;
					}
					broken = true; // EPIPE: the daemon is gone; stdin EOF will stop us
					return;
				}
			}
		},
	};
}

/** Keep fd 1 reserved for status lines: anything else a dependency prints goes to stderr. */
function reserveStdout(): void {
	const toStderr = (...args: unknown[]): void => {
		process.stderr.write(`${args.map(arg => (typeof arg === "string" ? arg : Bun.inspect(arg))).join(" ")}\n`);
	};
	console.log = toStderr;
	console.info = toStderr;
	console.debug = toStderr;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean =>
		(process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
}

interface WorkerInput {
	reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	decoder: TextDecoder;
	pending: string;
	done: boolean;
}

function createWorkerInput(): WorkerInput {
	return { reader: Bun.stdin.stream().getReader(), decoder: new TextDecoder(), pending: "", done: false };
}

async function readLaunchSecrets(input: WorkerInput): Promise<WorkerLaunchSecrets> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => timeout.reject(new LaunchError(`timed out waiting for launch secrets after ${LAUNCH_SECRETS_TIMEOUT_MS} ms`)),
		LAUNCH_SECRETS_TIMEOUT_MS,
	);
	try {
		for (;;) {
			const newline = input.pending.indexOf("\n");
			if (newline >= 0) {
				const line = input.pending.slice(0, newline).trim();
				input.pending = input.pending.slice(newline + 1);
				return parseLaunchSecrets(line);
			}
			if (input.done) {
				const line = input.pending.trim();
				input.pending = "";
				if (line) return parseLaunchSecrets(line);
				throw new LaunchError("worker launch secrets are missing from stdin");
			}
			const chunk = await Promise.race([input.reader.read(), timeout.promise]);
			if (chunk.done) {
				input.pending += input.decoder.decode();
				input.done = true;
			} else if (chunk.value) {
				input.pending += input.decoder.decode(chunk.value, { stream: true });
			}
		}
	} finally {
		clearTimeout(timer);
	}
}

async function readCommands(
	input: WorkerInput,
	onCommand: (command: WorkerCommand) => void,
	onMalformed: (id: string, command: string) => void,
	onEof: () => void,
): Promise<void> {
	try {
		for (;;) {
			for (let newline = input.pending.indexOf("\n"); newline >= 0; newline = input.pending.indexOf("\n")) {
				const line = input.pending.slice(0, newline).trim();
				input.pending = input.pending.slice(newline + 1);
				if (!line) continue;
				const command = decodeCommand(line);
				if (command) {
					onCommand(command);
					continue;
				}
				logger.warn("ignoring unrecognised worker command", { line: line.slice(0, 200) });
				const request = malformedRequest(line);
				if (request) onMalformed(request.id, request.t);
			}
			if (input.done) break;
			const chunk = await input.reader.read();
			if (chunk.done) {
				input.pending += input.decoder.decode();
				input.done = true;
			} else if (chunk.value) {
				input.pending += input.decoder.decode(chunk.value, { stream: true });
			}
		}
	} catch (error) {
		logger.warn("stdin read failed", { error: String(error) });
	}
	onEof();
}

export async function main(argv: string[]): Promise<void> {
	reserveStdout();
	delete process.env.OMP_CONSOLE_ROOM_KEY;
	delete process.env.OMP_CONSOLE_WRITE_TOKEN;
	const sink = createStdoutSink();
	const input = createWorkerInput();
	let launch: WorkerLaunch;
	try {
		launch = parseLaunch(argv, await readLaunchSecrets(input));
	} catch (error) {
		sink.emit({ t: "fatal", message: error instanceof LaunchError ? error.message : String(error) });
		process.exit(1);
	}
	// Desktop notification escapes would land on stdout; the daemon owns notification policy.
	process.env.PI_NOTIFICATIONS = "off";
	let starting: Promise<SessionHostWorker | undefined> = Promise.resolve(undefined);
	const sessionOpAborts = new Map<string, AbortController>();
	let teardown: Promise<void> | undefined;

	/** Single-flight teardown: every trigger (stop, EOF, signal, fatal) joins the first one. */
	const stopEverything = (reason: string): Promise<void> => {
		teardown ??= (async () => {
			for (const controller of sessionOpAborts.values()) controller.abort(new Error(reason));
			sessionOpAborts.clear();
			const deadline = setTimeout(() => {
				killDescendantsNow(process.pid);
				process.exit(1);
			}, EXIT_DEADLINE_MS);
			deadline.unref();
			// A stop that lands mid-startup waits for the half-built session so it can be torn down properly.
			const worker = await starting;
			await worker?.stop(reason);
		})();
		return teardown;
	};
	const exitWith = async (code: number, reason: string): Promise<void> => {
		await stopEverything(reason);
		process.exit(code);
	};
	const fail = (message: string): void => {
		if (teardown) return;
		sink.emit({ t: "fatal", message });
		void exitWith(1, message);
	};

	const applyModelChange = async (
		command: Extract<WorkerCommand, { t: "set-agent-model" | "set-agent-thinking" }>,
	): Promise<void> => {
		const worker = await starting;
		if (!worker) {
			sink.emit({ t: "model-error", id: command.id, agentId: command.agentId, message: "session is not running" });
			return;
		}
		try {
			const result =
				command.t === "set-agent-model"
					? await setFocusedAgentModel(worker.registry, command.agentId, command.selector)
					: setFocusedAgentThinking(worker.registry, command.agentId, command.level);
			worker.refreshState();
			sink.emit({
				t: "model-set",
				id: command.id,
				agentId: result.agentId,
				model: result.model,
				...(result.thinkingLevel === undefined ? {} : { thinkingLevel: result.thinkingLevel }),
			});
		} catch (error) {
			sink.emit({
				t: "model-error",
				id: command.id,
				agentId: command.agentId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};

	/** Run one request-style command and reply `{t:"request-error"}` for any refusal or failure. */
	const answerRequest = async (
		id: string,
		work: (worker: SessionHostWorker) => Promise<WorkerRequestResult>,
	): Promise<void> => {
		let reply: WorkerRequestResult;
		try {
			const worker = await starting;
			reply = worker
				? await work(worker)
				: { t: "request-error", id, code: "conflict", message: "session is not running" };
		} catch (error) {
			if (error instanceof RequestError) reply = { t: "request-error", id, code: error.code, message: error.message };
			else {
				logger.error("worker request failed", { id, error: String(error) });
				reply = { t: "request-error", id, code: "internal", message: error instanceof Error ? error.message : String(error) };
			}
		}
		sink.emit(reply);
	};

	const applyAbort = async (command: Extract<WorkerCommand, { t: "abort" }>): Promise<void> => {
		const worker = await starting;
		if (!worker) {
			sink.emit({ t: "aborted", id: command.id, aborted: false });
			return;
		}
		try {
			sink.emit({ t: "aborted", id: command.id, aborted: await worker.abort() });
		} catch (error) {
			logger.warn("session abort failed", { error: String(error) });
			sink.emit({ t: "aborted", id: command.id, aborted: false });
		}
	};


	// SIGTERM/SIGINT belong to the shared postmortem handler (it exits 143/130 after its cleanups); our
	// teardown is one of them, so it runs to completion instead of racing a competing handler.
	postmortem.register("session-host", reason => stopEverything(`signal ${reason}`));
	process.on("uncaughtException", error => {
		logger.error("uncaught exception", { error: String(error), stack: error.stack });
		fail(`uncaught exception: ${error.message}`);
	});
	process.on("unhandledRejection", reason => {
		logger.error("unhandled rejection", { reason: String(reason) });
	});

	void readCommands(
		input,
		command => {
			switch (command.t) {
				case "ping":
					sink.emit({ t: "pong", id: command.id });
					break;
				case "abort":
					void applyAbort(command);
					break;
				case "set-agent-model":
				case "set-agent-thinking":
					void applyModelChange(command);
					break;
				case "catalog":
					void answerRequest(command.id, async worker => ({
						t: "catalog",
						id: command.id,
						catalog: await worker.catalog(),
					}));
					break;
				case "run-command":
					void answerRequest(command.id, async worker => {
						await worker.runCommand(command.text);
						return { t: "accepted", id: command.id };
					});
					break;
				case "spawn-agent":
					void answerRequest(command.id, async worker => ({
						t: "spawned",
						id: command.id,
						agentId: await worker.spawnAgent(command.request),
					}));
					break;
				case "cancel-agent":
					void answerRequest(command.id, async worker => {
						await worker.cancelAgent(command.agentId);
						return { t: "accepted", id: command.id };
					});
					break;
				case "send-prompt":
					void answerRequest(command.id, async worker => {
						await worker.sendPrompt(command.text);
						return { t: "accepted", id: command.id };
					});
					break;
				case "overnight-options":
					void answerRequest(command.id, async worker => {
						worker.setOvernightOptions(command.options);
						return { t: "accepted", id: command.id };
					});
					break;
				case "freeze":
					void answerRequest(command.id, async worker => {
						await worker.freeze(command.frozen);
						return { t: "accepted", id: command.id };
					});
					break;
				case "cancel-session-op": {
					const controller = sessionOpAborts.get(command.id);
					if (controller) {
						sessionOpAborts.delete(command.id);
						controller.abort(new Error("session operation was abandoned"));
					}
					break;
				}
				case "session-op": {
					const controller = new AbortController();
					sessionOpAborts.set(command.id, controller);
					void answerRequest(command.id, async worker => ({
						t: "session-op",
						id: command.id,
						result: await worker.sessionOp(command.op, controller.signal),
					})).finally(() => {
						if (sessionOpAborts.get(command.id) === controller) sessionOpAborts.delete(command.id);
					});
					break;
				}
				case "live-audio":
					void starting
						.then(worker => worker?.pushLiveAudio(command.data))
						.catch(error => logger.warn("live audio frame rejected", { error: error instanceof Error ? error.message : "unknown error" }));
					break;
				case "usage":
					void answerRequest(command.id, async worker => ({ t: "usage", id: command.id, reports: await worker.usage() }));
					break;
				case "summarize":
					void answerRequest(command.id, async worker => ({
						t: "key-points",
						id: command.id,
						keyPoints: await worker.summarize(),
					}));
					break;
				case "refine-title":
					void answerRequest(command.id, async worker => {
						worker.refineTitle();
						return { t: "accepted", id: command.id };
					});
					break;
				case "plugins":
					void answerRequest(command.id, async worker => ({ t: "plugins", id: command.id, plugins: await worker.plugins() }));
					break;
				case "plugin-toggle":
					void answerRequest(command.id, async worker => {
						await worker.togglePlugin(command.pluginId, command.enabled);
						return { t: "accepted", id: command.id };
					});
					break;
				case "quota-policy":
					// No reply. A policy that arrives before the session is up applies as soon as it is.
					void starting.then(worker => worker?.setQuotaPolicy(command.providers));
					break;
				case "stop":
					void exitWith(0, "stop requested");
					break;
			}
		},
		(id, command) =>
			sink.emit({ t: "request-error", id, code: "bad-request", message: `malformed ${command} command` }),
		() => void exitWith(0, "stdin closed"),
	);

	starting = SessionHostWorker.start(launch, sink, { onFatal: fail }).then(
		started => started,
		error => {
			fail(error instanceof Error ? error.message : String(error));
			return undefined;
		},
	);
	await starting;
}

if (import.meta.main) {
	void main(process.argv.slice(2));
}
