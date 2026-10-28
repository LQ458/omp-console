import type { DecisionAnswer, DecisionModel, DecisionQuestion, DecisionRequest } from "./types";
import { hasExactKeys, isRecord, parseDecisionAnswer } from "./answers";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.14";
const TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 250;
const MAX_ATTEMPTS = 2;

export type DecisionFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface JevDecisionModelOptions {
	apiKey: string;
	fetch?: DecisionFetch;
	/** Test seam; production calls use the fixed 10-second timeout. */
	timeoutMs?: number;
}

function toJevQuestion(question: DecisionQuestion): Record<string, unknown> {
	switch (question.type) {
		case "choice":
			return {
				type: "choice",
				instructions: question.instructions,
				criteria: Object.fromEntries(question.options.map(option => [option, option])),
			};
		case "noul":
			return { type: "noul", instructions: question.instructions };
		case "score":
			return { type: "score", instructions: question.instructions, criteria: question.levels };
	}
}

function toJevQuestions(questions: DecisionRequest["questions"]): Record<string, unknown> {
	const result: Record<string, unknown> = Object.create(null);
	for (const [id, question] of Object.entries(questions)) result[id] = toJevQuestion(question);
	return result;
}

function mapJevAnswers(request: DecisionRequest, value: unknown): Record<string, DecisionAnswer> {
	if (!isRecord(value) || !isRecord(value.answers)) throw new Error("OpenRouter returned invalid decision answers");
	const questionIds = Object.keys(request.questions);
	if (!hasExactKeys(value.answers, questionIds)) throw new Error("OpenRouter returned invalid decision answers");

	const answers: Record<string, DecisionAnswer> = Object.create(null);
	for (const id of questionIds) {
		const raw = value.answers[id];
		const question = request.questions[id];
		if (!question || !isRecord(raw)) throw new Error("OpenRouter returned invalid decision answers");

		let normalized: Record<string, unknown>;
		switch (question.type) {
			case "choice":
				if (raw.type !== "choice") throw new Error("OpenRouter returned invalid decision answers");
				normalized = {
					type: "choice",
					selected: raw.choice,
					probabilities: raw.probabilities,
					confidence: raw.confidence,
				};
				break;
			case "noul":
				if (raw.type !== "noul") throw new Error("OpenRouter returned invalid decision answers");
				normalized = { type: "noul", probability: raw.noul };
				break;
			case "score":
				if (raw.type !== "score") throw new Error("OpenRouter returned invalid decision answers");
				normalized = {
					type: "score",
					value: raw.score,
					probabilities: raw.probabilities,
					confidence: raw.confidence,
				};
				break;
		}

		const answer = parseDecisionAnswer(question, normalized);
		if (!answer) throw new Error("OpenRouter returned invalid decision answers");
		answers[id] = answer;
	}
	return answers;
}

function buildRequestBody(request: DecisionRequest): string {
	const questions = toJevQuestions(request.questions);
	return JSON.stringify({ model: MODEL, state: request.state, questions });
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

export function createJevDecisionModel(options: JevDecisionModelOptions): DecisionModel {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	return {
		backend: "jev",
		async decide(request) {
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
			const body = buildRequestBody(request);
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
				let response: Response;
				try {
					response = await fetchImpl(DECISIONS_URL, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${options.apiKey}`,
							"Content-Type": "application/json",
						},
						body,
						signal,
					});
				} catch {
					if (request.signal?.aborted) throw new Error("OpenRouter decision request aborted");
					if (timeoutSignal.aborted) throw new Error("OpenRouter decision request timed out");
					throw new Error("OpenRouter decision request failed");
				}

				if (response.ok) {
					let payload: unknown;
					try {
						payload = await response.json();
					} catch {
						if (request.signal?.aborted) throw new Error("OpenRouter decision request aborted");
						if (timeoutSignal.aborted) throw new Error("OpenRouter decision request timed out");
						throw new Error("OpenRouter returned invalid JSON");
					}
					return mapJevAnswers(request, payload);
				}

				if (attempt === 0 && isRetryableStatus(response.status)) {
					await response.body?.cancel().catch(() => {});
					await Bun.sleep(RETRY_BACKOFF_MS);
					if (request.signal?.aborted) throw new Error("OpenRouter decision request aborted");
					if (timeoutSignal.aborted) throw new Error("OpenRouter decision request timed out");
					continue;
				}
				throw new Error(`OpenRouter decision request failed (HTTP ${response.status})`);
			}
			throw new Error("OpenRouter decision request failed");
		},
	};
}
