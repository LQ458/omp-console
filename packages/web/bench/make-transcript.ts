/**
 * Deterministic fixtures for the `?bench` scenarios (rubric #4 scroll smoothness, #5 token-to-pixel).
 *
 * - `makeTranscript`: a long session of realistic turns (user prompt, thinking, markdown with code
 *   blocks, tool calls with their results). The same seed always yields byte-identical entries.
 * - `makeStreamTokens`: the token sequence of one streaming assistant message, for the 100 tokens/s
 *   fixture room.
 *
 * "Line" means one line of text a reader would see in a row: user text, assistant text and code,
 * thinking, tool command and tool output.
 */
import type { AssistantMessage, SessionEntry, ToolCallContent, ToolResultMessage, WireUsage } from "@oh-my-pi/pi-wire";

export const DEFAULT_TRANSCRIPT_LINES = 50_000;
export const DEFAULT_SEED = 0x5eed;
/** Fixed epoch so timestamps do not depend on when the fixture is generated. */
const BASE_TIME_MS = Date.UTC(2026, 9, 1, 9, 0, 0);
const MODEL_ID = "claude-sonnet-5-5";

const WORDS = (
	"the relay socket reconnect backoff window frame session entry guest host snapshot cursor resume " +
	"duplicate stream token render scroll anchor window height measure cache cold warm queue abort " +
	"timeout retry fatal close code buffer chunk decode seal open key room peer agent tool result " +
	"thinking prompt answer ask select editor goal model profile worker daemon health stalled"
).split(" ");

const IDENTS = ["relay", "guest", "frame", "entry", "cursor", "backoff", "chunk", "window", "anchor", "token"];
const CALLS = ["connect", "decode", "resync", "append", "measure", "flush", "dedupe", "observe"];

/** mulberry32: small, fast, and stable across runtimes. */
export function createRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

type Rng = () => number;

function int(rng: Rng, min: number, max: number): number {
	return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, list: readonly T[]): T {
	return list[Math.floor(rng() * list.length)]!;
}

function sentence(rng: Rng): string {
	const count = int(rng, 6, 18);
	const words = Array.from({ length: count }, () => pick(rng, WORDS));
	return `${words.join(" ").replace(/^./, c => c.toUpperCase())}.`;
}

function paragraph(rng: Rng): string {
	return Array.from({ length: int(rng, 1, 3) }, () => sentence(rng)).join(" ");
}

function codeLine(rng: Rng, depth: number): string {
	const pad = "\t".repeat(depth);
	switch (int(rng, 0, 4)) {
		case 0:
			return `${pad}const ${pick(rng, IDENTS)} = ${pick(rng, CALLS)}(${pick(rng, IDENTS)}, ${int(rng, 1, 5000)});`;
		case 1:
			return `${pad}if (${pick(rng, IDENTS)}.${pick(rng, CALLS)}()) return ${int(rng, 0, 9)};`;
		case 2:
			return `${pad}await ${pick(rng, IDENTS)}.${pick(rng, CALLS)}({ ${pick(rng, IDENTS)}: ${int(rng, 1, 99)} });`;
		case 3:
			return `${pad}// ${sentence(rng)}`;
		default:
			return `${pad}this.#${pick(rng, IDENTS)} = ${pick(rng, IDENTS)}.${pick(rng, CALLS)}();`;
	}
}

function codeBlock(rng: Rng): string {
	const lines = [`function ${pick(rng, CALLS)}${int(rng, 1, 99)}(${pick(rng, IDENTS)}: unknown): void {`];
	const body = int(rng, 4, 38);
	for (let i = 0; i < body; i++) lines.push(codeLine(rng, 1));
	lines.push("}");
	return `\`\`\`ts\n${lines.join("\n")}\n\`\`\``;
}

function bullets(rng: Rng): string {
	return Array.from({ length: int(rng, 2, 6) }, () => `- ${sentence(rng)}`).join("\n");
}

function assistantText(rng: Rng, long: boolean): string {
	const parts: string[] = [];
	if (long) parts.push(`## ${sentence(rng).replace(/\.$/, "")}`);
	parts.push(paragraph(rng));
	if (rng() < 0.45) parts.push(bullets(rng));
	if (rng() < (long ? 0.7 : 0.35)) parts.push(codeBlock(rng));
	if (rng() < 0.5) parts.push(paragraph(rng));
	return parts.join("\n\n");
}

function thinking(rng: Rng): string {
	return Array.from({ length: int(rng, 2, 8) }, () => sentence(rng)).join("\n");
}

function grepOutput(rng: Rng): string {
	return Array.from(
		{ length: int(rng, 3, 60) },
		() => `packages/coding-agent/src/collab/${pick(rng, IDENTS)}.ts:${int(rng, 1, 900)}:${codeLine(rng, 0).trim()}`,
	).join("\n");
}

function readOutput(rng: Rng): string {
	const start = int(rng, 1, 400);
	return Array.from({ length: int(rng, 20, 80) }, (_, i) => `${start + i}:${codeLine(rng, int(rng, 0, 3))}`).join("\n");
}

function usage(rng: Rng): WireUsage {
	const input = int(rng, 1_000, 9_000);
	const output = int(rng, 40, 900);
	return {
		input,
		output,
		cacheRead: int(rng, 10_000, 90_000),
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0.01 },
	};
}

function lineCount(text: string): number {
	return text === "" ? 0 : text.split("\n").length;
}

/** Lines a reader sees for one entry (the unit `makeTranscript` stops on). */
export function entryLines(entry: SessionEntry): number {
	if (entry.type === "custom_message") {
		return typeof entry.content === "string" ? lineCount(entry.content) : 0;
	}
	if (entry.type !== "message") return 0;
	const message = entry.message;
	if (message.role === "user") return typeof message.content === "string" ? lineCount(message.content) : 0;
	if (message.role === "toolResult") {
		return message.content.reduce((sum, block) => sum + (block.type === "text" ? lineCount(block.text) : 0), 0);
	}
	if (message.role !== "assistant") return 0;
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") total += lineCount(block.text);
		else if (block.type === "thinking") total += lineCount(block.thinking);
		else if (block.type === "toolCall") total += 1;
	}
	return total;
}

export function countLines(entries: readonly SessionEntry[]): number {
	return entries.reduce((sum, entry) => sum + entryLines(entry), 0);
}

export interface TranscriptOptions {
	/** Stop once at least this many lines exist (default 50,000). */
	lines?: number;
	seed?: number;
}

/** Whole turns (user, thinking, text, tool calls, results, closing text) until `lines` is reached. */
export function makeTranscript(options: TranscriptOptions = {}): SessionEntry[] {
	const target = options.lines ?? DEFAULT_TRANSCRIPT_LINES;
	const rng = createRng(options.seed ?? DEFAULT_SEED);
	const entries: SessionEntry[] = [];
	let lines = 0;
	let parentId: string | null = null;

	const stamp = (): { timestamp: string; ms: number } => {
		const ms = BASE_TIME_MS + entries.length * 2_000;
		return { timestamp: new Date(ms).toISOString(), ms };
	};
	const push = (build: (id: string, parent: string | null, time: { timestamp: string; ms: number }) => SessionEntry): void => {
		const id = `b${entries.length.toString(36).padStart(5, "0")}`;
		const entry = build(id, parentId, stamp());
		entries.push(entry);
		parentId = id;
		lines += entryLines(entry);
	};

	for (let turn = 0; lines < target; turn++) {
		const prompt = Array.from({ length: int(rng, 1, 3) }, () => sentence(rng)).join("\n");
		push((id, parent, time) => ({
			type: "message",
			id,
			parentId: parent,
			timestamp: time.timestamp,
			message: { role: "user", content: prompt, timestamp: time.ms },
		}));

		const callCount = int(rng, 0, 2);
		const calls: ToolCallContent[] = [];
		const results: { call: ToolCallContent; output: string }[] = [];
		for (let c = 0; c < callCount; c++) {
			const kind = pick(rng, ["bash", "read", "grep"] as const);
			const callId = `call-${turn}-${c}`;
			const call: ToolCallContent =
				kind === "bash"
					? {
							type: "toolCall",
							id: callId,
							name: "bash",
							arguments: { command: `bun test packages/coding-agent/test/${pick(rng, IDENTS)} --filter ${pick(rng, CALLS)}` },
							intent: "Running the suite",
						}
					: kind === "read"
						? {
								type: "toolCall",
								id: callId,
								name: "read",
								arguments: { path: `packages/coding-agent/src/collab/${pick(rng, IDENTS)}.ts`, offset: int(rng, 1, 400), limit: 60 },
								intent: "Reading the handler",
							}
						: {
								type: "toolCall",
								id: callId,
								name: "grep",
								arguments: { pattern: pick(rng, WORDS), path: "packages/coding-agent/src" },
								intent: "Searching for call sites",
							};
			calls.push(call);
			results.push({ call, output: kind === "read" ? readOutput(rng) : grepOutput(rng) });
		}

		const content: AssistantMessage["content"] = [];
		if (rng() < 0.7) content.push({ type: "thinking", thinking: thinking(rng) });
		content.push({ type: "text", text: assistantText(rng, calls.length === 0) });
		content.push(...calls);
		const first: AssistantMessage = {
			role: "assistant",
			content,
			model: MODEL_ID,
			usage: usage(rng),
			stopReason: calls.length > 0 ? "toolUse" : "stop",
			timestamp: 0,
		};
		push((id, parent, time) => ({
			type: "message",
			id,
			parentId: parent,
			timestamp: time.timestamp,
			message: { ...first, timestamp: time.ms },
		}));

		for (const { call, output } of results) {
			push((id, parent, time) => {
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: output }],
					isError: false,
					timestamp: time.ms,
				};
				return { type: "message", id, parentId: parent, timestamp: time.timestamp, message };
			});
		}

		if (calls.length > 0) {
			const closing: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: assistantText(rng, false) }],
				model: MODEL_ID,
				usage: usage(rng),
				stopReason: "stop",
				timestamp: 0,
			};
			push((id, parent, time) => ({
				type: "message",
				id,
				parentId: parent,
				timestamp: time.timestamp,
				message: { ...closing, timestamp: time.ms },
			}));
		}
	}
	return entries;
}

/**
 * Tokens of one streaming assistant message: whole words with their trailing space, paragraph breaks
 * every ~45 tokens and a fenced block every ~220, so the growing row exercises prose, lists and code.
 */
export function makeStreamTokens(count: number, seed = DEFAULT_SEED): string[] {
	const rng = createRng(seed ^ 0x57ea);
	const tokens: string[] = [];
	let inFence = false;
	for (let i = 1; i <= count; i++) {
		if (i % 220 === 0) {
			tokens.push(inFence ? "\n```\n\n" : "\n\n```ts\n");
			inFence = !inFence;
		} else if (inFence && i % 9 === 0) {
			tokens.push(`\n${codeLine(rng, 1)}\n`);
		} else if (!inFence && i % 45 === 0) {
			tokens.push("\n\n");
		} else {
			tokens.push(`${pick(rng, WORDS)} `);
		}
	}
	if (inFence) tokens.push("\n```\n");
	return tokens;
}
