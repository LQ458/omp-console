import { describe, expect, it } from "bun:test";
import { createTextDecisionModel } from "../src/models/text-decision";
import type { DecisionQuestion, TextModel } from "../src/models/types";

describe("text decision fallback smoke", () => {
	it("chooses the waiting session from a fake TextModel response", async () => {
		const questions: Record<string, DecisionQuestion> = {
			priority: { type: "choice", instructions: "Which item should surface first?", options: ["waiting", "unfinished"] },
		};
		const text: TextModel = {
			async complete() {
				return JSON.stringify({
					priority: {
						type: "choice",
						selected: "waiting",
						probabilities: { waiting: 0.9, unfinished: 0.1 },
						confidence: 0.9,
					},
				});
			},
		};

		const answers = await createTextDecisionModel(text).decide({
			state: ["Session A is waiting for a reply."],
			questions,
		});
		expect(answers.priority).toEqual({
			type: "choice",
			selected: "waiting",
			probabilities: { waiting: 0.9, unfinished: 0.1 },
			confidence: 0.9,
		});
	});
});
