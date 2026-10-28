import type { DecisionAnswer, DecisionModel, DecisionQuestion, DecisionRequest, TextModel } from "./types";
import { hasExactKeys, isRecord, parseDecisionAnswer } from "./answers";
import fallbackInstructions from "./decision-fallback.md" with { type: "text" };

const MAX_TOKENS = 2048;

function parseAnswers(request: DecisionRequest, output: string): Record<string, DecisionAnswer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error("Text decision model returned invalid JSON");
	}
	if (!isRecord(parsed)) throw new Error("Text decision model returned invalid answers");
	const questionIds = Object.keys(request.questions);
	if (!hasExactKeys(parsed, questionIds)) throw new Error("Text decision model returned invalid answers");

	const answers: Record<string, DecisionAnswer> = Object.create(null);
	for (const id of questionIds) {
		const question: DecisionQuestion | undefined = request.questions[id];
		if (!question) throw new Error("Text decision model returned invalid answers");
		const answer = parseDecisionAnswer(question, parsed[id]);
		if (!answer) throw new Error("Text decision model returned invalid answers");
		answers[id] = answer;
	}
	return answers;
}

export function createTextDecisionModel(text: TextModel): DecisionModel {
	return {
		backend: "luna",
		async decide(request) {
			const output = await text.complete({
				system: fallbackInstructions,
				prompt: JSON.stringify({ state: request.state, questions: request.questions }),
				maxTokens: MAX_TOKENS,
				signal: request.signal,
			});
			return parseAnswers(request, output);
		},
	};
}
