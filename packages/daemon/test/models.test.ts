import { describe, expect, it } from "bun:test";
import { createDecisionModel } from "../src/models/decision-model";
import { createJevDecisionModel } from "../src/models/jev";
import { createTextDecisionModel } from "../src/models/text-decision";
import type { DecisionRequest, TextModel } from "../src/models/types";

const request: DecisionRequest = {
	state: ["Session A is waiting for an answer.", "Session B has unfinished work."],
	questions: {
		priority: { type: "choice", instructions: "Which session should surface first?", options: ["waiting", "unfinished"] },
		needsReply: { type: "noul", instructions: "Is a session waiting for the user?" },
		age: { type: "score", instructions: "How old is the newest session?", levels: ["new", "recent", "old"] },
	},
};

const jevAnswers = {
	priority: {
		type: "choice",
		choice: "waiting",
		probabilities: { waiting: 0.8, unfinished: 0.2 },
		confidence: 0.8,
	},
	needsReply: { type: "noul", noul: 0.92 },
	age: { type: "score", score: 1.5, probabilities: { "0": 0.25, "1": 0.5, "2": 0.25 }, confidence: 0.7 },
};

const fallbackAnswers = {
	priority: {
		type: "choice",
		selected: "waiting",
		probabilities: { waiting: 0.8, unfinished: 0.2 },
		confidence: 0.8,
	},
	needsReply: { type: "noul", probability: 0.92 },
	age: { type: "score", value: 1.5, probabilities: { "0": 0.25, "1": 0.5, "2": 0.25 }, confidence: 0.7 },
};

function textModel(output: string): TextModel {
	return { async complete() { return output; } };
}

describe("Jev decision model", () => {
	it("sends the Decisions schema and maps Choice, Noul, and Score answers", async () => {
		let url = "";
		let init: RequestInit | undefined;
		const model = createJevDecisionModel({
			apiKey: "test-openrouter-key",
			fetch: async (input, requestInit) => {
				url = String(input);
				init = requestInit;
				return Response.json({ answers: jevAnswers });
			},
		});

		const answers = await model.decide(request);
		expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-openrouter-key");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "typesafe/jev-1.14",
			state: request.state,
			questions: {
				priority: {
					type: "choice",
					instructions: "Which session should surface first?",
					criteria: { waiting: "waiting", unfinished: "unfinished" },
				},
				needsReply: { type: "noul", instructions: "Is a session waiting for the user?" },
				age: {
					type: "score",
					instructions: "How old is the newest session?",
					criteria: ["new", "recent", "old"],
				},
			},
		});
		expect(answers).toEqual({
			priority: { type: "choice", selected: "waiting", probabilities: { waiting: 0.8, unfinished: 0.2 }, confidence: 0.8 },
			needsReply: { type: "noul", probability: 0.92 },
			age: { type: "score", value: 1.5, probabilities: { "0": 0.25, "1": 0.5, "2": 0.25 }, confidence: 0.7 },
		});
	});

	it("retries once after either 429 or 5xx and does not retry a client error", async () => {
		for (const status of [429, 503]) {
			let calls = 0;
			const model = createJevDecisionModel({
				apiKey: "test-key",
				fetch: async () => {
					calls++;
					return calls === 1 ? new Response(null, { status }) : Response.json({ answers: jevAnswers });
				},
			});
			await model.decide(request);
			expect(calls).toBe(2);
		}

		let calls = 0;
		const clientError = createJevDecisionModel({
			apiKey: "test-key",
			fetch: async () => {
				calls++;
				return new Response(null, { status: 400 });
			},
		});
		await expect(clientError.decide(request)).rejects.toThrow("HTTP 400");
		expect(calls).toBe(1);
	});

	it("aborts a stalled request at the configured ten-second timeout", async () => {
		const model = createJevDecisionModel({
			apiKey: "test-key",
			timeoutMs: 5,
			fetch: async (_input, init) => {
				const signal = init?.signal;
				if (!signal) throw new Error("missing abort signal");
				if (signal.aborted) throw new Error("already aborted");
				return await new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			},
		});
		await expect(model.decide(request)).rejects.toThrow("timed out");
	});

	it("replaces fetch failures with credential-free errors", async () => {
		const secret = "sk-or-test-value";
		const model = createJevDecisionModel({
			apiKey: secret,
			fetch: async () => {
				throw new Error(`transport failure included ${secret}`);
			},
		});
		let message = "";
		try {
			await model.decide(request);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("OpenRouter decision request failed");
		expect(message).not.toContain(secret);
	});

	it("rejects an answer that cannot satisfy the DecisionAnswer port", async () => {
		const incomplete = createJevDecisionModel({
			apiKey: "test-key",
			fetch: async () => Response.json({ answers: { priority: { type: "choice", choice: "waiting" }, needsReply: jevAnswers.needsReply, age: jevAnswers.age } }),
		});
		await expect(incomplete.decide(request)).rejects.toThrow("invalid decision answers");
	});
});

describe("text decision fallback", () => {
	it("parses the strict JSON shape for every primitive", async () => {
		const answers = await createTextDecisionModel(textModel(JSON.stringify(fallbackAnswers))).decide(request);
		expect(answers).toEqual({
			priority: { type: "choice", selected: "waiting", probabilities: { waiting: 0.8, unfinished: 0.2 }, confidence: 0.8 },
			needsReply: { type: "noul", probability: 0.92 },
			age: { type: "score", value: 1.5, probabilities: { "0": 0.25, "1": 0.5, "2": 0.25 }, confidence: 0.7 },
		});
	});

	it("rejects fenced JSON, missing answers, and out-of-range probability distributions", async () => {
		const invalidOutputs = [
			"```json\n{}\n```",
			JSON.stringify({ priority: fallbackAnswers.priority }),
			JSON.stringify({
				...fallbackAnswers,
				priority: { ...fallbackAnswers.priority, probabilities: { waiting: 0.2, unfinished: 0.2 } },
			}),
			JSON.stringify({
				...fallbackAnswers,
				age: { ...fallbackAnswers.age, value: 3 },
			}),
			JSON.stringify({
				...fallbackAnswers,
				priority: { ...fallbackAnswers.priority, explanation: "extra field is outside the strict answer shape" },
			}),
		];
		for (const output of invalidOutputs) {
			await expect(createTextDecisionModel(textModel(output)).decide(request)).rejects.toThrow();
		}
	});

	it("selects the Luna fallback when no Keychain key is available", async () => {
		const model = await createDecisionModel({ text: textModel(JSON.stringify(fallbackAnswers)), keyLoader: async () => undefined });
		expect(model.backend).toBe("luna");
		const answers = await model.decide(request);
		expect(answers.needsReply).toEqual({ type: "noul", probability: 0.92 });
	});

	it("selects Jev when the key loader returns a key", async () => {
		const model = await createDecisionModel({
			text: textModel("{}"),
			keyLoader: async () => "test-key",
			fetch: async () => Response.json({ answers: jevAnswers }),
		});
		expect(model.backend).toBe("jev");
		await model.decide(request);
	});
});
