import type { DecisionAnswer, DecisionQuestion } from "./types";

const PROBABILITY_SUM_TOLERANCE = 0.01;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === expected.length && expected.every(key => Object.hasOwn(record, key));
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseProbabilities(value: unknown, expected: string[]): Record<string, number> | undefined {
	if (!isRecord(value) || new Set(expected).size !== expected.length || !hasExactKeys(value, expected)) return undefined;
	const probabilities: Record<string, number> = Object.create(null);
	let sum = 0;
	for (const key of expected) {
		const probability = value[key];
		if (!isProbability(probability)) return undefined;
		probabilities[key] = probability;
		sum += probability;
	}
	if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return undefined;
	return probabilities;
}

function isConfidence(value: unknown): value is number {
	return isProbability(value);
}

/** Convert one strict fallback answer to the public decision contract. */
export function parseDecisionAnswer(question: DecisionQuestion, value: unknown): DecisionAnswer | undefined {
	if (!isRecord(value)) return undefined;
	switch (question.type) {
		case "choice": {
			if (
				!hasExactKeys(value, ["type", "selected", "probabilities", "confidence"]) ||
				value.type !== "choice" ||
				typeof value.selected !== "string" ||
				!question.options.includes(value.selected)
			) {
				return undefined;
			}
			const probabilities = parseProbabilities(value.probabilities, question.options);
			if (!probabilities || !isConfidence(value.confidence)) return undefined;
			return { type: "choice", selected: value.selected, probabilities, confidence: value.confidence };
		}
		case "noul":
			if (!hasExactKeys(value, ["type", "probability"]) || value.type !== "noul" || !isProbability(value.probability)) {
				return undefined;
			}
			return { type: "noul", probability: value.probability };
		case "score": {
			if (
				!hasExactKeys(value, ["type", "value", "probabilities", "confidence"]) ||
				value.type !== "score" ||
				typeof value.value !== "number" ||
				!Number.isFinite(value.value) ||
				value.value < 0 ||
				value.value > question.levels.length - 1
			) {
				return undefined;
			}
			const levels = question.levels.map((_level, index) => String(index));
			const probabilities = parseProbabilities(value.probabilities, levels);
			if (!probabilities || !isConfidence(value.confidence)) return undefined;
			return { type: "score", value: value.value, probabilities, confidence: value.confidence };
		}
	}
}
