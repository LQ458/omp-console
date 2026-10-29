/**
 * Fake session-host for daemon tests. Speaks the worker contract from @omp-console/protocol:
 * status JSON lines on stdout, commands on stdin, secrets on a launch-secrets stdin line. Behaviour is chosen by flags that the
 * tests put into the worker command before the contract flags (`--cwd --relay --room [--resume ...]`).
 *
 *   --ignore-stop            keep running after the `stop` command and stdin EOF
 *   --ignore-term            swallow SIGTERM (only SIGKILL ends the process)
 *   --spawn-child <pidfile>  start a child process in the worker's process tree and append its pid (one line per launch)
 *   --dump <file>            append {argv, key, token} for each launch as one JSON line
 *   --dump-device-token <file>  write the launch-only device token to a private test file
 *   --crash-after <ms>       exit 1 this long after ready
 *   --crash-once <marker>    like --crash-after 50, but only when <marker> does not exist yet (creates it)
 *   --no-ready               never report ready
 *   --ready-delay-ms <n>     wait this long before reporting ready (a slow start)
 *   --stall-restart <marker> first launch (marker absent: creates it) works and exits 1 after 100 ms; every later
 *                            launch never reports ready, so a restarted worker stays in `starting`
 *   --fatal <message>        report fatal and exit 1 instead of ready
 *   --script <json>          [{at: ms after ready, emit: <status object>}] timeline; lastEventAt "now" is stamped at emit time
 *   --streaming-forever      after ready: state streaming once, lastEventAt = now, then silence
 *   --dump-requests <file>   append every command line received on stdin (after the launch line) to <file>
 *   --ignore-requests        never answer `catalog`, `run-command`, `spawn-agent` or any wave-2 request (timeout paths)
 *   --keypoints-fail         answer `summarize` with a conflict request-error
 *   --card-title/--card-goal/--card-decisions <text>   fields of the key-points card `summarize` returns (decisions split on `|`)
 *   --compact-delay-ms <n>   delay before the `session-op` compact reply (default 100)
 *   --fail-send-prompt     reject send-prompt requests with an internal error
 *
 * Request commands: `catalog` answers a fixed catalog; `run-command` text starting `/busy`, `/tui`, `/boom` answers
 * request-error conflict, bad-request, internal, anything else `accepted`; `spawn-agent` profile `missing`, `refused`
 * answers bad-request, conflict, any other profile `spawned` (the requested name, else agent-N) followed by an
 * `agent` started line and, 30 ms later, a completed line; `set-agent-thinking` agent `missing`, `advisor` answers
 * model-error, any other agent model-set echoing the level.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { WorkerLaunchSecrets } from "@omp-console/protocol";

const argv = process.argv.slice(2);

function flag(name: string): boolean {
	return argv.includes(name);
}

function value(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

function emit(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

const stdinReader = Bun.stdin.stream().getReader();
const stdinDecoder = new TextDecoder();
let stdinBuffer = "";
let stdinDone = false;

async function readInputLine(): Promise<string | undefined> {
	for (;;) {
		const newline = stdinBuffer.indexOf("\n");
		if (newline >= 0) {
			const line = stdinBuffer.slice(0, newline);
			stdinBuffer = stdinBuffer.slice(newline + 1);
			return line;
		}
		if (stdinDone) {
			if (!stdinBuffer) return undefined;
			const line = stdinBuffer;
			stdinBuffer = "";
			return line;
		}
		const chunk = await stdinReader.read();
		if (chunk.done) {
			stdinBuffer += stdinDecoder.decode();
			stdinDone = true;
		} else {
			stdinBuffer += stdinDecoder.decode(chunk.value, { stream: true });
		}
	}
}



if (flag("--ignore-term")) process.on("SIGTERM", () => {});

const fatal = value("--fatal");
if (fatal !== undefined) {
	emit({ t: "fatal", message: fatal });
	process.exit(1);
}
const launchLine = await readInputLine();
if (launchLine === undefined) {
	emit({ t: "fatal", message: "missing launch-secrets stdin line" });
	process.exit(1);
}
let parsedLaunch: unknown;
try {
	parsedLaunch = JSON.parse(launchLine);
} catch {
	emit({ t: "fatal", message: "invalid launch-secrets stdin line" });
	process.exit(1);
}
if (typeof parsedLaunch !== "object" || parsedLaunch === null || Array.isArray(parsedLaunch)) {
	emit({ t: "fatal", message: "invalid launch-secrets stdin line" });
	process.exit(1);
}
const secretRecord = parsedLaunch as Record<string, unknown>;
if (secretRecord.t !== "launch" || typeof secretRecord.roomKey !== "string" ||
	typeof secretRecord.writeToken !== "string" || typeof secretRecord.deviceToken !== "string") {
	emit({ t: "fatal", message: "invalid launch-secrets stdin line" });
	process.exit(1);
}
const launchSecrets: WorkerLaunchSecrets = {
	t: "launch",
	roomKey: secretRecord.roomKey,
	writeToken: secretRecord.writeToken,
	deviceToken: secretRecord.deviceToken,
};
const dump = value("--dump");
if (dump) {
	appendFileSync(
		dump,
		`${JSON.stringify({
			argv,
			key: launchSecrets.roomKey,
			token: launchSecrets.writeToken,
			hasRoomKeyEnv: process.env.OMP_CONSOLE_ROOM_KEY !== undefined,
			hasWriteTokenEnv: process.env.OMP_CONSOLE_WRITE_TOKEN !== undefined,
			hasDeviceTokenEnv: process.env.OMP_CONSOLE_DEVICE_TOKEN !== undefined,
		})}\n`,
	);
}
const deviceTokenDump = value("--dump-device-token");
if (deviceTokenDump) {
	writeFileSync(deviceTokenDump, `${launchSecrets.deviceToken}\n`, { mode: 0o600 });
}


const childPidFile = value("--spawn-child");
if (childPidFile) {
	const child = Bun.spawn(
		process.platform === "win32" ? [process.execPath, "-e", "setInterval(() => {}, 1000)"] : ["sleep", "300"],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: process.platform === "win32" },
	);
	appendFileSync(childPidFile, `${child.pid}\n`);
}

const cwd = value("--cwd") ?? process.cwd();
const resume = value("--resume");
const fork = value("--fork");
const sessionId = resume ? path.basename(resume, ".jsonl") : `sess-${crypto.randomUUID().slice(0, 8)}`;
const sessionFile = resume ?? path.join(cwd, `${sessionId}.jsonl`);
const room = value("--room") ?? "no-room";

let stalled = flag("--no-ready");
const stallRestart = value("--stall-restart");
if (stallRestart) {
	if (existsSync(stallRestart)) stalled = true;
	else {
		writeFileSync(stallRestart, "launched");
		setTimeout(() => process.exit(1), 100);
	}
}

const readyDelayMs = Number(value("--ready-delay-ms") ?? 0);
if (readyDelayMs > 0) await Bun.sleep(readyDelayMs);

let streaming = false;
const pendingQuestion = flag("--asking") ? "Which option?" : flag("--asking-approval") ? "Approve this action?" : undefined;
if (!stalled) {
	emit({ t: "ready", sessionId, sessionFile, rootAgentId: `root-${sessionId}`, roomId: room });
	streaming = pendingQuestion !== undefined;
	emit({
		t: "state",
		state: pendingQuestion === undefined ? "idle" : "asking",
		model: value("--model") ?? "fake/model",
		thinkingLevel: "medium",
		awaitingAnswer: pendingQuestion !== undefined,
		...(pendingQuestion === undefined ? {} : { pendingQuestion, pendingKind: flag("--asking-approval") ? "approval" : "ask" }),
		goalActive: false,
		agentCount: fork ? 2 : 1,
		lastEventAt: Date.now(),
		title: `fake ${sessionId}`,
	});
}
const reannounceFile = value("--reannounce-file");
if (resume && reannounceFile) {
	const timer = setInterval(() => {
		if (!existsSync(reannounceFile)) return;
		clearInterval(timer);
		const targetId = readFileSync(reannounceFile, "utf8").trim();
		emit({ t: "ready", sessionId: targetId, sessionFile, rootAgentId: `root-${targetId}`, roomId: room });
	}, 5);
}

if (flag("--unknown-output")) {
	emit({ t: "future-worker-event", sequence: 1 });
	process.stdout.write("unstructured future worker output\n");
}

const crashAfter = value("--crash-after");
if (crashAfter) setTimeout(() => process.exit(1), Number(crashAfter));
const crashOnce = value("--crash-once");
if (crashOnce && !existsSync(crashOnce)) {
	writeFileSync(crashOnce, "crashed");
	setTimeout(() => process.exit(1), 50);
}

const script = value("--script");
if (script) {
	for (const step of JSON.parse(script) as Array<{ at: number; emit: unknown }>) {
		setTimeout(() => {
			const message = step.emit as Record<string, unknown>;
			if (message.lastEventAt === "now") message.lastEventAt = Date.now();
			emit(message);
		}, step.at);
	}
}
const clearPendingAfter = Number(value("--clear-pending-after"));
if (pendingQuestion !== undefined && clearPendingAfter > 0) {
	setTimeout(() => {
		streaming = false;
		emit({ t: "state", state: "idle", awaitingAnswer: false, goalActive: false, agentCount: 1, lastEventAt: Date.now() });
	}, clearPendingAfter);
}

if (flag("--streaming-forever")) {
	streaming = true;
	emit({
		t: "state",
		state: "streaming",
		awaitingAnswer: false,
		goalActive: false,
		agentCount: 1,
		lastEventAt: Date.now(),
	});
}

// Keep the event loop alive until told to stop.
const keepAlive = setInterval(() => {}, 1_000);
const ignoreStop = flag("--ignore-stop");

function shutdown(): void {
	if (ignoreStop) return;
	clearInterval(keepAlive);
	process.exit(0);
}
let modelRequestCount = 0;
let spawnCount = 0;
const requestDump = value("--dump-requests");
const fakeCatalog = {
	commands: [
		{ name: "compact", description: "Compact the conversation", source: "builtin", usage: "[soft]", remote: true },
		{ name: "tree", description: "Session tree", source: "builtin", remote: false, deckControl: "tree" },
	],
	tools: [{ name: "bash", description: "Run a shell command" }],
	profiles: [{ name: "task", source: "bundled", definitionModels: [] }],
	skills: [],
	roles: { default: "fake/model" },
	mcp: [],
	generatedAt: 1,
};
for (;;) {
	const line = await readInputLine();
	if (line === undefined) break;
	if (!line.trim()) continue;
	const command = JSON.parse(line) as {
		t: string;
		id?: string;
		agentId?: string;
		selector?: string;
		text?: string;
		level?: string;
		op?: { op: string; objective?: string };
		pluginId?: string;
		request?: { profile: string; task: string; name?: string; isolated?: boolean; files?: string[] };
	};
	if (requestDump) appendFileSync(requestDump, `${line}\n`);
	if (command.t === "stop") shutdown();
	else if (command.t === "ping") emit({ t: "pong", id: command.id });
	else if (flag("--ignore-requests") && ["catalog", "run-command", "spawn-agent", "session-op", "usage", "summarize", "refine-title", "plugins", "plugin-toggle"].includes(command.t)) continue;
	else if (command.t === "catalog") {
		emit({ t: "catalog", id: command.id, catalog: fakeCatalog });
	} else if (command.t === "session-op") {
		const op = command.op ?? { op: "" };
		if (op.op === "goal" && op.objective === "refuse") {
			emit({ t: "request-error", id: command.id, code: "bad-request", message: "Goal mode is disabled (goal.enabled)." });
		} else if (op.op === "stats") {
			emit({
				t: "session-op",
				id: command.id,
				result: { ok: true, stats: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.25, contextTokens: 900, contextWindow: 128000, byAgent: [{ agentId: `root-${sessionId}`, tokens: 15, cost: 0.25 }] } },
			});
		} else if (op.op === "tree") {
			emit({ t: "session-op", id: command.id, result: { ok: true, tree: [{ entryId: "e1", parentId: null, role: "user", preview: "hello", at: 1, onCurrentBranch: true }] } });
		} else if (op.op === "compact") {
			setTimeout(() => emit({ t: "session-op", id: command.id, result: { ok: true } }), Number(value("--compact-delay-ms") ?? 100));
		} else {
			emit({ t: "session-op", id: command.id, result: { ok: true } });
		}
	} else if (command.t === "usage") {
		emit({ t: "usage", id: command.id, reports: [{ provider: "fake", limits: [] }] });
	} else if (command.t === "summarize") {
		if (flag("--keypoints-fail")) {
			emit({ t: "request-error", id: command.id, code: "conflict", message: "the session has no conversation to summarise yet" });
		} else {
			emit({
				t: "key-points",
				id: command.id,
				keyPoints: {
					sessionId,
					title: value("--card-title") ?? `Card for ${sessionId}`,
					goal: value("--card-goal") ?? "Fake goal",
					decisions: (value("--card-decisions") ?? "Use the fake worker").split("|"),
					files: ["src/fake.ts"],
					outcome: "Done",
					openQuestions: [],
					generatedAt: Date.now(),
				},
			});
		}
	} else if (command.t === "refine-title") {
		emit({ t: "accepted", id: command.id });
		setTimeout(() => emit({ t: "title", title: `Refined ${sessionId}` }), 20);
	} else if (command.t === "plugins") {
		emit({
			t: "plugins",
			id: command.id,
			plugins: [
				{ id: "skill:fake-skill", kind: "skill", name: "fake-skill", enabled: true },
				{ id: "mcp:fake-server", kind: "mcp", name: "fake-server", enabled: false, source: "native (user)" },
			],
		});
	} else if (command.t === "plugin-toggle") {
		if (command.pluginId === "missing") emit({ t: "request-error", id: command.id, code: "not-found", message: "no such plugin missing" });
		else emit({ t: "accepted", id: command.id });
	} else if (command.t === "run-command") {
		const text = command.text ?? "";
		if (text.startsWith("/busy")) {
			emit({ t: "request-error", id: command.id, code: "conflict", message: "session is busy; this command needs an idle session" });
		} else if (text.startsWith("/tui")) {
			emit({ t: "request-error", id: command.id, code: "bad-request", message: "/tui is only available in the terminal UI" });
		} else if (text.startsWith("/boom")) {
			emit({ t: "request-error", id: command.id, code: "internal", message: "boom" });
		} else {
			emit({ t: "accepted", id: command.id });
		}
	} else if (command.t === "spawn-agent" && command.request) {
		const { profile, name } = command.request;
		if (profile === "missing") {
			emit({ t: "request-error", id: command.id, code: "bad-request", message: `unknown profile ${profile}` });
		} else if (profile === "refused") {
			emit({ t: "request-error", id: command.id, code: "conflict", message: "spawn policy refused the profile" });
		} else {
			const agentId = name ?? `agent-${++spawnCount}`;
			emit({ t: "spawned", id: command.id, agentId });
			emit({ t: "agent", agentId, parentId: `root-${sessionId}`, profile, status: "started" });
			setTimeout(
				() => emit({ t: "agent", agentId, parentId: `root-${sessionId}`, profile, status: "completed", summary: "fake result" }),
				30,
			);
		}
	} else if (command.t === "overnight-options") {
		emit({ t: "accepted", id: command.id });
	} else if (command.t === "send-prompt" && typeof command.text === "string") {
		if (flag("--fail-send-prompt")) emit({ t: "request-error", id: command.id, code: "internal", message: "prompt refused" });
		else emit({ t: "accepted", id: command.id });
	} else if (command.t === "set-agent-thinking" && typeof command.agentId === "string" && typeof command.level === "string") {
		if (command.agentId === "missing") {
			emit({ t: "model-error", id: command.id, agentId: command.agentId, message: `unknown agent ${command.agentId}` });
		} else if (command.agentId === "advisor") {
			emit({ t: "model-error", id: command.id, agentId: command.agentId, message: `agent ${command.agentId} is an advisor and cannot be given a thinking level` });
		} else {
			emit({ t: "model-set", id: command.id, agentId: command.agentId, model: "fake/model", thinkingLevel: command.level });
		}
	}
	else if (command.t === "abort") {
		const aborted = streaming;
		streaming = false;
		if (aborted) {
			emit({
				t: "state",
				state: "idle",
				awaitingAnswer: false,
				goalActive: false,
				agentCount: 1,
				lastEventAt: Date.now(),
			});
		}
		emit({ t: "aborted", id: command.id, aborted });
	}
	else if (command.t === "set-agent-model" && typeof command.agentId === "string" && typeof command.selector === "string") {
		if (flag("--ignore-model")) continue;
		if (flag("--model-unmatched-first")) {
			emit({ t: "model-set", id: command.id, agentId: `${command.agentId}-other`, model: "ignored/model" });
		}
		const respond = (): void => {
			if (command.agentId === "missing") {
				emit({ t: "model-error", id: command.id, agentId: command.agentId, message: `unknown agent ${command.agentId}` });
			} else if (command.agentId === "inactive") {
				emit({ t: "model-error", id: command.id, agentId: command.agentId, message: `agent ${command.agentId} is idle and has no live session` });
			} else if (command.selector === "bad-model") {
				emit({ t: "model-error", id: command.id, agentId: command.agentId, message: `no model matches "${command.selector}"` });
			} else {
				emit({
					t: "model-set",
					id: command.id,
					agentId: command.agentId,
					model: flag("--model-result-selector") ? command.selector : "google/gemini-2.5-pro",
					thinkingLevel: "high",
				});
			}
		};
		const sequence = value("--model-delay-sequence")?.split(",").map(Number);
		const requestIndex = modelRequestCount++;
		const delay = sequence?.[requestIndex] ?? Number(value("--model-delay-ms") ?? 0);
		if (delay > 0) setTimeout(respond, delay);
		else respond();
	}
}
// stdin EOF means stop.
shutdown();
