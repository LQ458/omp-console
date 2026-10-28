import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "@oh-my-pi/pi-coding-agent/commit/utils";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { selectSmolModel } from "./key-points";
import { RequestError } from "./request-error";
import requestTemplate from "./prompts/quick-replies-request.md" with { type: "text" };
import systemPrompt from "./prompts/quick-replies.md" with { type: "text" };

const MAX_REPLIES = 10;
const MAX_REPLY_CHARS = 80;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 2048;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQuickReplies(reply: string, truncated = false): string[] {
	const replies: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidatesFrom(reply, truncated)) {
		if (typeof candidate !== "string") continue;
		const text = cleanReply(candidate);
		const key = text.normalize("NFKC").replace(/\s+/gu, " ").trim().replace(/[.!?…。！？,，;；:：]+$/u, "").toLowerCase();
		if (text === "" || key === "" || seen.has(key)) continue;
		seen.add(key);
		replies.push(text);
		if (replies.length === MAX_REPLIES) break;
	}
	return replies;
}


function completeJsonStringCandidates(text: string): string[] {
	const isArray = text.startsWith("[");
	const property = isArray ? -1 : text.indexOf('"replies"');
	if (!isArray && property < 0) return [];
	const arrayStart = isArray ? 0 : text.indexOf("[", property);
	if (arrayStart < 0) return [];
	const candidates: string[] = [];
	let stringStart = -1;
	let escaped = false;
	let depth = 0;
	for (let index = arrayStart; index < text.length; index++) {
		const character = text[index];
		if (stringStart >= 0) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character !== '"') continue;
			let nextIndex = index + 1;
			while (nextIndex < text.length && /\s/u.test(text[nextIndex]!)) nextIndex++;
			if (text[nextIndex] !== ":") {
				try {
					const parsed: unknown = JSON.parse(text.slice(stringStart, index + 1));
					if (typeof parsed === "string") candidates.push(parsed);
				} catch {
					// Ignore malformed completed strings in a truncated response.
				}
			}
			stringStart = -1;
			continue;
		}
		if (character === '"') {
			stringStart = index;
			continue;
		}
		if (character === "[") depth++;
		else if (character === "]" && --depth === 0) break;
	}
	return candidates;
}

function candidatesFrom(reply: string, truncated: boolean): unknown[] {
	const normalized = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	try {
		const parsed: unknown = JSON.parse(normalized);
		if (Array.isArray(parsed)) return parsed;
		if (isObject(parsed)) return Array.isArray(parsed.replies) ? parsed.replies : [];
	} catch {
		// Compatible small models may return plain numbered lines instead of JSON.
	}
	if (truncated && /^[\[{]/u.test(normalized)) return completeJsonStringCandidates(normalized);
	const lines = normalized.split(/\r?\n/);
	return truncated && !/\r?\n\s*$/.test(reply) ? lines.slice(0, -1) : lines;
}

function cleanReply(value: string): string {
	let text = value
		.trim()
		.replace(/^(?:(?:\d{1,3}[.)]|[-*•])\s+)+/u, "")
		.trim();
	if (text.length >= 2) {
		const first = text[0];
		const last = text.at(-1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "“" && last === "”")) {
			text = text.slice(1, -1).trim();
		}
	}
	const chars = Array.from(text);
	return chars.length > MAX_REPLY_CHARS ? `${chars.slice(0, MAX_REPLY_CHARS - 1).join("")}…` : text;
}


/** Generate up to ten distinct short next messages with the configured smol role. */
export async function generateQuickReplies(session: AgentSession, userRequest: string, answer: string): Promise<string[]> {
	const model = selectSmolModel(session);
	if (!model) throw new RequestError("conflict", "no smol model is available for quick replies; configure modelRoles.smol");
	const sessionId = session.sessionManager.getSessionId();
	const registry = session.modelRegistry;
	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) throw new RequestError("conflict", `no credential for ${model.provider}/${model.id}`);
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await instrumentedCompleteSimple(
		model,
		{
			systemPrompt: [systemPrompt],
			messages: [{ role: "user", content: prompt.render(requestTemplate, { userRequest, answer }), timestamp: Date.now() }],
		},
		{
			apiKey: registry.resolver(model, sessionId),
			sessionId,
			maxTokens: MAX_OUTPUT_TOKENS,
			disableReasoning: true,
			temperature: 0,
			signal: timeout,
		},
		{ telemetry: resolveTelemetry(session.agent.telemetry, sessionId), oneshotKind: "deck_quick_replies" },
	);
	if (response.stopReason === "length") {
		return parseQuickReplies(extractTextContent(response), true);
	}
	if (response.stopReason !== "stop") {
		throw new RequestError("internal", `quick replies request ended with ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`);
	}
	return parseQuickReplies(extractTextContent(response));
}
