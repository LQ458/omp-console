/**
 * `summarize`: the key-points card of a session (goal, decisions, files touched, outcome, open questions), written by
 * the `smol` model role from a bounded excerpt of the transcript.
 *
 *  - Input is the current branch: the first user request (what the session is for) followed by as many of the most
 *    recent entries as fit `TRANSCRIPT_CHAR_BUDGET`; tool results are dropped, tool calls keep their name and target
 *    path so the model can list files from facts.
 *  - The model is resolved like omp's other background one-shots (`skill-descriptions`): the configured `smol` role,
 *    then the bundled smol defaults, then `tiny`. No smol-class model available is a refusal, never a silent upgrade
 *    to the session's (expensive) model.
 *  - The reply must be one JSON object of the shape in `prompts/key-points.md`; anything else is an error.
 */
import type { KeyPoints } from "@omp-console/protocol";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent, parseJsonPayload } from "@oh-my-pi/pi-coding-agent/commit/utils";
import { getModelMatchPreferences, parseModelPattern, resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import requestTemplate from "./prompts/key-points-request.md" with { type: "text" };
import systemPrompt from "./prompts/key-points.md" with { type: "text" };
import { RequestError } from "./request-error";

/** Roughly 10k tokens of excerpt: a card needs the gist, not the whole transcript. */
export const TRANSCRIPT_CHAR_BUDGET = 40_000;
const ENTRY_CHAR_LIMIT = 1500;
const FIRST_REQUEST_CHAR_LIMIT = 3000;
const MAX_ITEMS = 10;
const MAX_ITEM_CHARS = 400;
const MAX_TITLE_CHARS = 120;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 1500;
const TARGET_KEYS = ["path", "file_path", "filePath", "file", "filename", "target"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, limit: number): string {
	const flat = text.replace(/[ \t]+\n/g, "\n").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function toolTarget(args: unknown): string {
	if (!isObject(args)) return "";
	for (const key of TARGET_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return clip(value, 200);
	}
	return "";
}

/** One transcript line (or block) for an entry, or `undefined` for entries a card does not need. */
function entryLine(entry: SessionEntry): string | undefined {
	if (entry.type === "compaction") return `Earlier summary: ${clip(entry.summary, ENTRY_CHAR_LIMIT)}`;
	if (entry.type === "branch_summary") return `Branch summary: ${clip(entry.summary, ENTRY_CHAR_LIMIT)}`;
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "user") {
		const text = messageText(message.content);
		return text.trim() === "" ? undefined : `User: ${clip(text, ENTRY_CHAR_LIMIT)}`;
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const lines: string[] = [];
	const text = messageText(message.content);
	if (text.trim() !== "") lines.push(`Assistant: ${clip(text, ENTRY_CHAR_LIMIT)}`);
	for (const block of message.content) {
		if (isObject(block) && block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`Tool: ${block.name} ${toolTarget(block.arguments)}`.trimEnd());
		}
	}
	return lines.length === 0 ? undefined : lines.join("\n");
}

/** The bounded transcript excerpt for `entries` (oldest first). Empty when there is nothing to summarise. */
export function buildTranscriptExcerpt(entries: readonly SessionEntry[], budget = TRANSCRIPT_CHAR_BUDGET): string {
	const lines = entries.map(entryLine);
	const firstUser = entries.findIndex(
		(entry, index) => entry.type === "message" && entry.message.role === "user" && lines[index] !== undefined,
	);
	const head = firstUser >= 0 ? `First request:\n${clip(lines[firstUser]!.replace(/^User: /, ""), FIRST_REQUEST_CHAR_LIMIT)}` : undefined;
	let remaining = budget - (head?.length ?? 0);
	const tail: string[] = [];
	let omitted = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (line === undefined || index === firstUser) continue;
		if (line.length + 1 > remaining) {
			omitted = true;
			break;
		}
		remaining -= line.length + 1;
		tail.push(line);
	}
	tail.reverse();
	const parts: string[] = [];
	if (head) parts.push(head);
	if (omitted) parts.push("[earlier turns omitted]");
	parts.push(...tail);
	return head === undefined && tail.length === 0 ? "" : parts.join("\n\n");
}

/** The model for key points: configured `smol`, the bundled smol defaults, then `tiny`; `undefined` when none is available. */
export function selectSmolModel(session: AgentSession): Model<Api> | undefined {
	const registry = session.modelRegistry;
	const settings = session.settings;
	const available = registry.getAvailable();
	const configured = resolveRoleSelection(["smol"], settings, available);
	if (configured) return configured.model;
	const preferences = getModelMatchPreferences(settings);
	for (const pattern of roleDefaultModels().smol) {
		const preferred = parseModelPattern(pattern, available, preferences).model;
		if (preferred) return preferred;
	}
	return resolveRoleSelection(["tiny"], settings, available)?.model;
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new RequestError("internal", `the model returned invalid key points: ${field} must be an array of strings`);
	}
	return (value as string[]).map(item => clip(item, MAX_ITEM_CHARS)).filter(item => item !== "").slice(0, MAX_ITEMS);
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new RequestError("internal", `the model returned invalid key points: ${field} must be a string`);
	const text = clip(value, MAX_ITEM_CHARS * 2);
	return text === "" ? undefined : text;
}

/** Validate the model's reply text as the key-points JSON object. */
export function parseKeyPoints(sessionId: string, reply: string, now: number): KeyPoints {
	let parsed: unknown;
	try {
		parsed = parseJsonPayload(reply);
	} catch (error) {
		throw new RequestError("internal", `the model did not return JSON key points: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(parsed)) throw new RequestError("internal", "the model returned invalid key points: not a JSON object");
	if (typeof parsed.title !== "string" || parsed.title.trim() === "") {
		throw new RequestError("internal", "the model returned invalid key points: title must be a non-empty string");
	}
	const keyPoints: KeyPoints = {
		sessionId,
		title: clip(parsed.title, MAX_TITLE_CHARS),
		decisions: stringArray(parsed.decisions, "decisions"),
		files: stringArray(parsed.files, "files"),
		openQuestions: stringArray(parsed.openQuestions, "openQuestions"),
		generatedAt: now,
	};
	const goal = optionalString(parsed.goal, "goal");
	if (goal !== undefined) keyPoints.goal = goal;
	const outcome = optionalString(parsed.outcome, "outcome");
	if (outcome !== undefined) keyPoints.outcome = outcome;
	return keyPoints;
}

export interface KeyPointsOptions {
	/** Aborts the model request (worker stop). */
	signal?: AbortSignal;
	now?: () => number;
}

/** Generate the key points of `session`'s current branch. */
export async function summarizeSession(session: AgentSession, options: KeyPointsOptions = {}): Promise<KeyPoints> {
	const manager = session.sessionManager;
	const transcript = buildTranscriptExcerpt(manager.getBranch());
	if (transcript === "") throw new RequestError("conflict", "the session has no conversation to summarise yet");
	const model = selectSmolModel(session);
	if (!model) throw new RequestError("conflict", "no smol model is available for key points; configure modelRoles.smol");
	const sessionId = manager.getSessionId();
	const registry = session.modelRegistry;
	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) throw new RequestError("conflict", `no credential for ${model.provider}/${model.id}`);
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await instrumentedCompleteSimple(
		model,
		{
			systemPrompt: [systemPrompt],
			messages: [{ role: "user", content: prompt.render(requestTemplate, { transcript }), timestamp: Date.now() }],
		},
		{
			apiKey: registry.resolver(model, sessionId),
			sessionId,
			maxTokens: MAX_OUTPUT_TOKENS,
			disableReasoning: true,
			temperature: 0,
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		},
		{ telemetry: resolveTelemetry(session.agent.telemetry, sessionId), oneshotKind: "deck_key_points" },
	);
	if (response.stopReason !== "stop") {
		throw new RequestError("internal", `key points request ended with ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`);
	}
	return parseKeyPoints(sessionId, extractTextContent(response), (options.now ?? Date.now)());
}
