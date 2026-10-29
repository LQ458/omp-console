/**
 * Extension that registers a scripted model provider, so a real worker process runs a real agent loop with
 * no network and no credentials. The reply is chosen by the last user message:
 *
 *   ASK:<text>   -> `ask` tool call (one question, options alpha/beta); then "asked-result:<tool result>"
 *   WAIT:<ms>:<text> -> replies after a finite delay, for pause/queue boundary tests
 *   TASK:<text>  -> `task` tool call that spawns a subagent (its prompt contains SUBWORK, answered after a delay)
 *   VIBE:<text>   -> `vibe_spawn` starts a slow worker for registry/teardown probes
 *   SLEEP:<n>    -> spawns a Bun child that remains alive for worker-shutdown probes
 *   SUBWORK...   -> the subagent's reply, after SUBAGENT_DELAY_MS
 *   NEST:<text>  -> `task` tool call spawning the `deck-nest` profile; that child (prompt contains SUBNEST) waits
 *                   NEST_DELAY_MS, then spawns a grandchild with `task` (SUBWORK)
 *   system prompt of omp's title generator   -> `<title>$STUB_TITLE or "Refined Stub Title"</title>`
 *   system prompt of deck's key-points card  -> $STUB_KEYPOINTS, else a valid card
 *   otherwise    -> "echo:<prompt>"
 */
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";

const PROVIDER = "stub";
const MODEL = "stub-model";
const API = "stub-api";
const SUBAGENT_DELAY_MS = 1500;
const NEST_DELAY_MS = 1500;
let quickReplyCalls = 0;
let overnightCalls = 0;
/** What the stub's usage endpoint "returns": real quota fields next to things that must never leave the worker. */
export const STUB_FAKE_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJzdHViLXVzZXIifQ", "c3R1Yi1zaWduYXR1cmU"].join(".");
const STUB_USAGE_REPORT: UsageReport = {
	provider: PROVIDER,
	fetchedAt: 1_700_000_000_000,
	limits: [
		{
			id: "5h",
			label: "5 Hour",
			scope: { provider: PROVIDER, accountId: "stub-account", windowId: "5h" },
			window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_700_000_900_000 },
			amount: { used: 61, limit: 100, usedFraction: 0.61, unit: "percent" },
			status: "ok",
		},
	],
	metadata: { email: "stub@example.com", endpoint: `https://usage.example.com/v1?access_token=${STUB_FAKE_JWT}` },
	raw: { access_token: STUB_FAKE_JWT },
};
const stubUsageProvider: UsageProvider = { id: PROVIDER, fetchUsage: async () => STUB_USAGE_REPORT };

const DEFAULT_KEYPOINTS = JSON.stringify({
	title: "Stub session card",
	goal: "Exercise the stub provider",
	decisions: ["Use the stub model"],
	files: ["src/stub.ts"],
	outcome: "Done",
	openQuestions: [],
});

function baseMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: API,
		provider: PROVIDER,
		model: MODEL,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}
function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role !== "user") continue;
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
		// The harness prepends `<system-reminder>` context, and a guest prompt rides behind a `<system-notice>`
		// interjection wrapper; only the typed prompt selects a script.
		return raw.replace(/<(system-reminder|system-notice)>[\s\S]*?<\/\1>/g, "").trim();
	}
	return "";
}

function lastToolResultText(context: Context): string | undefined {
	const last = context.messages[context.messages.length - 1];
	if (last?.role !== "toolResult") return undefined;
	return last.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** Tool results since the last user message: where a multi-step scripted turn is. */
function toolResultsThisTurn(context: Context): number {
	let count = 0;
	for (let i = context.messages.length - 1; i >= 0 && context.messages[i]?.role !== "user"; i--) {
		if (context.messages[i]?.role === "toolResult") count++;
	}
	return count;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	const done = Promise.withResolvers<void>();
	const timer = setTimeout(done.resolve, ms);
	signal?.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			done.resolve();
		},
		{ once: true },
	);
	return done.promise;
}

function replyText(stream: AssistantMessageEventStream, text: string, stopReason: "stop" | "length" = "stop"): void {
	const start = baseMessage([], stopReason);
	stream.push({ type: "start", partial: start });
	stream.push({ type: "text_start", contentIndex: 0, partial: baseMessage([{ type: "text", text: "" }], stopReason) });
	for (const chunk of text.match(/.{1,16}/gs) ?? [""]) {
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: chunk,
			partial: baseMessage([{ type: "text", text: chunk }], stopReason),
		});
	}
	const message = baseMessage([{ type: "text", text }], stopReason);
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
	stream.push({ type: "done", reason: stopReason, message });
}


function replyToolCall(stream: AssistantMessageEventStream, toolCall: ToolCall): void {
	const message = baseMessage([toolCall], "toolUse");
	stream.push({ type: "start", partial: message });
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
	stream.push({ type: "done", reason: "toolUse", message });
}

async function respond(stream: AssistantMessageEventStream, context: Context, signal: AbortSignal | undefined) {
	const system = (context.systemPrompt ?? []).join("\n");
	const prompt = lastUserText(context);
	if (prompt === "STREAM_BYTES:") {
		const byteCount = Number(process.env.STUB_STREAM_BYTES);
		if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
			replyText(stream, "invalid stream length");
			return;
		}
		const text = Array.from(
			{ length: Math.ceil(byteCount / 23) },
			(_, index) => `guest packet ${index.toString(16).padStart(4, "0")} data\n`,
		)
			.join("")
			.slice(0, byteCount);
		replyText(stream, text);
		return;
	}
	if (system.includes("You name coding-agent sessions")) {
		replyText(stream, `<title>${process.env.STUB_TITLE ?? "Refined Stub Title"}</title>`);
		return;
	}
	if (system.includes("briefing card for a coding-agent session")) {
		replyText(stream, process.env.STUB_KEYPOINTS ?? DEFAULT_KEYPOINTS);
		return;
	}
	if (system.includes("You generate quick replies for a coding-agent session.")) {
		const reply = quickReplyCalls++ === 0 ? process.env.STUB_QUICK_REPLIES ?? '["Please continue"]' : "cache miss";
		const stopReason = process.env.STUB_QUICK_REPLY_STOP_REASON === "length" ? "length" : "stop";
		replyText(stream, reply, stopReason);
		return;
	}
	// Scripted overnight replies count only the run's own turns. Side requests (session titles, title cards) also reach
	// this provider when auto-titling is on, and must not use up the script.
	const overnightTurn =
		process.env.OMP_CONSOLE_OVERNIGHT === "1" &&
		/^(Overnight run\.|Continue the overnight run\.|The overnight deadline has passed\.)/.test(prompt.trimStart());
	if (overnightTurn && process.env.STUB_OVERNIGHT_SCRIPT === "continue-twice") {
		overnightCalls++;
		replyText(stream, overnightCalls < 3 ? `intermediate overnight result ${overnightCalls}` : "All checks passed. OVERNIGHT-COMPLETE");
		return;
	}
	if (overnightTurn && process.env.STUB_OVERNIGHT_SCRIPT === "network-once") {
		overnightCalls++;
		if (overnightCalls === 1) {
			stream.push({
				type: "error",
				reason: "error",
				error: { ...baseMessage([{ type: "text", text: "temporary network failure" }], "error"), errorMessage: "503 temporary network failure" },
			});
			return;
		}
		replyText(stream, "Recovered from the temporary network failure. OVERNIGHT-COMPLETE");
		return;
	}
	if (overnightTurn && process.env.STUB_OVERNIGHT_SCRIPT === "rate-limit-once") {
		overnightCalls++;
		if (overnightCalls === 1) {
			stream.push({
				type: "error",
				reason: "error",
				error: { ...baseMessage([{ type: "text", text: "temporary rate limit" }], "error"), errorMessage: "429 rate limit; reset in 0s" },
			});
			return;
		}
		replyText(stream, "Recovered from the temporary rate limit. OVERNIGHT-COMPLETE");
		return;
	}
	const toolResult = lastToolResultText(context);
	if (prompt.startsWith("COMPUTER_PRELUDE:")) {
		replyText(stream, `computer-prelude:${system.includes("The \`computer\` eval prelude is enabled.") ? "present" : "absent"}`);
		return;
	}
	if (prompt.includes("Identify project command(s) surfacing exactly these diagnostics")) {
		const delayMs = Number(process.env.STUB_CLEANSE_DELAY_MS ?? 0);
		if (delayMs > 0) await sleep(delayMs, signal);
		if (signal?.aborted) {
			stream.push({
				type: "error",
				reason: "aborted",
				error: baseMessage([{ type: "text", text: "Cleanse discovery cancelled" }], "aborted"),
			});
			return;
		}
		const checkerExecutable = "bun";
		const checkerProcessMarker = "omp-console-cleanse-checker-process";
		const checkerChildMarker = "omp-console-cleanse-checker-child";
		const checkerScript =
			process.env.STUB_CLEANSE_CHECKER_SLEEP === "true"
				? `const child = Bun.spawn([process.execPath, "-e", "setTimeout(()=>{}, 1e9)", "${checkerChildMarker}"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true }); await child.exited;`
				: `process.stdout.write("src/a.ts:1: error: fixture diagnostic\\n");`;
		replyToolCall(stream, {
			type: "toolCall",
			id: `call-cleanse-discovery-${Date.now()}`,
			name: "yield",
			arguments: {
				data: {
					checkers: [
						{
							label: "fixture diagnostics",
							language: "Shell",
							cwd: ".",
							command: [checkerExecutable, "-e", checkerScript, checkerProcessMarker],
							parser: "generic",
						},
					],
				},
			},
		});
		return;
	}
	if (prompt.startsWith("VIBE:") && toolResult === undefined) {
		replyToolCall(stream, {
			type: "toolCall",
			id: "call-vibe-spawn",
			name: "vibe_spawn",
			arguments: {
				cli: "fast",
				name: "Vibe probe",
				prompt: "SLOW: this worker must stop when Vibe mode exits",
			},
		});
		return;
	}
	if (prompt.includes("Repair worker ")) {
		const delayMs = Number(process.env.STUB_CLEANSE_REPAIR_DELAY_MS ?? 0);
		if (delayMs > 0) await sleep(delayMs, signal);
		if (signal?.aborted) {
			stream.push({
				type: "error",
				reason: "aborted",
				error: baseMessage([{ type: "text", text: "Cleanse repair cancelled" }], "aborted"),
			});
			return;
		}
		replyToolCall(stream, {
			type: "toolCall",
			id: `call-cleanse-repair-${Date.now()}`,
			name: "yield",
			arguments: { data: { result: "fixture repair attempt" } },
		});
		return;
	}
	if (prompt.includes("<omfg>")) {
		const delayMs = Number(process.env.STUB_OMFG_DELAY_MS ?? 0);
		if (delayMs > 0) await sleep(delayMs, signal);
		if (signal?.aborted) {
			stream.push({
				type: "error",
				reason: "aborted",
				error: baseMessage([{ type: "text", text: "OMFG generation cancelled" }], "aborted"),
			});
			return;
		}
		replyText(
			stream,
			process.env.STUB_OMFG_RULE ??
				'{\"name\":\"echo-rule\",\"description\":\"Match echo output\",\"condition\":\"echo:\",\"scope\":\"text\",\"body\":\"Keep output grounded in the request.\"}',
		);
		return;
	}
	if (prompt.startsWith("PLAN:")) {
		const step = toolResultsThisTurn(context);
		if (step === 0) {
			replyToolCall(stream, {
				type: "toolCall",
				id: `call-plan-${Date.now()}`,
				name: "write",
				arguments: { path: "local://deck-plan.md", content: `# Deck plan\n\n- ${prompt.slice("PLAN:".length).trim() || "step one"}\n` },
			});
		} else if (step === 1) {
			replyToolCall(stream, {
				type: "toolCall",
				id: `call-propose-${Date.now()}`,
				name: "write",
				arguments: { path: "xd://propose", content: "deck" },
			});
		} else {
			replyText(stream, `planned:${toolResult ?? ""}`);
		}
		return;
	}
	if (toolResult !== undefined) {
		const kind = /ASK:/.test(prompt) ? "asked-result" : /SLEEP:/.test(prompt) ? "slept" : "tool-done";
		replyText(stream, `${kind}:${toolResult}`);
		return;
	}
	if (prompt.includes("SUBNEST")) {
		await sleep(NEST_DELAY_MS, signal);
		replyToolCall(stream, {
			type: "toolCall",
			id: "call-grandchild",
			name: "task",
			arguments: { agent: "task", name: "Grand", task: "SUBWORK: grandchild" },
		});
		return;
	}
	if (prompt.startsWith("NEST:")) {
		replyToolCall(stream, {
			type: "toolCall",
			id: "call-nest",
			name: "task",
			arguments: { agent: "deck-nest", name: "Nest", task: "SUBNEST: spawn a grandchild" },
		});
		return;
	}
	if (prompt.includes("SUBWORK")) {
		await sleep(SUBAGENT_DELAY_MS, signal);
		replyText(stream, "sub-done");
		return;
	}
	if (prompt.startsWith("ASK:")) {
		const question = prompt.slice("ASK:".length).trim() || "Which one?";
		replyToolCall(stream, {
			type: "toolCall",
			id: "call-ask",
			name: "ask",
			arguments: {
				questions: [
					{ id: "q1", question, options: [{ label: "alpha" }, { label: "beta" }], recommended: 0 },
				],
			},
		});
		return;
	}
	if (prompt.startsWith("TASK:")) {
		replyToolCall(stream, {
			type: "toolCall",
			id: "call-task",
			name: "task",
			arguments: { agent: "task", name: "Probe", task: "SUBWORK: report done" },
		});
		return;
	}
	const sleepSeconds = /^SLEEP:(\d+)/.exec(prompt)?.[1];
	if (sleepSeconds) {
		const marker = `omp-console-worker-child-${sleepSeconds}`;
		const executable = JSON.stringify(Bun.which("bun") ?? process.execPath);
		const script = JSON.stringify(`setTimeout(()=>{}, ${Number(sleepSeconds)} * 1000)`);
		replyToolCall(stream, {
			type: "toolCall",
			id: "call-sleep",
			name: "bash",
			arguments: { command: `${executable} -e ${script} ${marker}` },
		});
		return;
	}
	if (prompt.startsWith("ENVPROBE:")) {
		replyToolCall(stream, {
			type: "toolCall",
			id: "call-env",
			name: "bash",
			// Counts how many room secrets are visible to a shell the agent runs; the worker must have scrubbed them.
			arguments: { command: "echo PROBE_COUNT=$(env | grep -E -c '^(OMP_CONSOLE_ROOM_KEY|OMP_CONSOLE_WRITE_TOKEN)=' || true)" },
		});
		return;
	}
	if (prompt.startsWith("WAIT:")) {
		const [, delayText, text] = /^WAIT:(\d+):(.*)$/s.exec(prompt) ?? [];
		const delay = Number(delayText);
		if (!Number.isSafeInteger(delay) || delay < 0 || text === undefined) {
			replyText(stream, "invalid wait request");
			return;
		}
		await sleep(delay, signal);
		if (signal?.aborted) {
			stream.push({
				type: "error",
				reason: "aborted",
				error: baseMessage([{ type: "text", text: "wait aborted" }], "aborted"),
			});
			return;
		}
		replyText(stream, `echo:${text}`);
		return;
	}
	if (prompt.startsWith("SLOW:")) {
		const start = baseMessage([], "stop");
		stream.push({ type: "start", partial: start });
		stream.push({ type: "text_start", contentIndex: 0, partial: baseMessage([{ type: "text", text: "" }], "stop") });
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "working",
			partial: baseMessage([{ type: "text", text: "working" }], "stop"),
		});
		await sleep(60_000, signal);
		stream.push({
			type: "error",
			reason: "aborted",
			error: baseMessage([{ type: "text", text: "working" }], "aborted"),
		});
		return;
	}
	replyText(stream, `echo:${prompt}`);
}

const extension: ExtensionFactory = pi => {
	pi.registerProvider(PROVIDER, {
		baseUrl: "http://127.0.0.1:9/never-called",
		apiKey: "STUB_KEY",
		api: API,
		usage: stubUsageProvider,
		streamSimple: (_model, context, options) => {
			const stream = createAssistantMessageEventStream();
			void respond(stream, context, options?.signal).catch(error => {
				stream.push({
					type: "error",
					reason: "error",
					error: baseMessage([{ type: "text", text: String(error) }], "error"),
				});
			});
			return stream;
		},
		models: [
			{
				id: MODEL,
				name: "Stub Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				id: `${MODEL}-2`,
				name: "Stub Model 2",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64000,
				maxTokens: 4096,
			},
			{
				// The only model that accepts a thinking level (thinking-level tests).
				id: `${MODEL}-r`,
				name: "Stub Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
};

export default extension;
