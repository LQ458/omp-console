/**
 * Background model ports for the librarian (wave 3). Owned by main; implemented in `packages/daemon/src/models/`.
 *
 *  - `TextModel` writes short text (titles, "stopped at", "next step", the return brief). Backed by omp's `smol` role
 *    (GPT-6 Luna through the Codex subscription), using omp's own model registry and auth.
 *  - `DecisionModel` answers typed questions with probabilities. Backed by Jev (`typesafe/jev-1.14`) through the
 *    OpenRouter Decisions API when the Keychain holds `omp-console-openrouter` (account `omp-console`); otherwise by the
 *    `TextModel` asked for the same typed answer. `backend` reports which one is in use.
 *
 * Both reject on failure (no silent defaults); callers retry on a later pass. Inputs are already trimmed to a budget
 * by the caller; implementations never log prompt text or credentials.
 */

export interface TextRequest {
	/** System instruction. */
	system: string;
	/** User content. */
	prompt: string;
	/** Hard cap on generated tokens. */
	maxTokens: number;
	signal?: AbortSignal;
}

export interface TextModel {
	complete(request: TextRequest): Promise<string>;
}

/** Jev primitives: Choice (one of `options`), Noul (probability the condition holds), Score (position on `levels`). */
export type DecisionQuestion =
	| { type: "choice"; instructions: string; options: string[] }
	| { type: "noul"; instructions: string }
	| { type: "score"; instructions: string; levels: string[] };

export type DecisionAnswer =
	| { type: "choice"; selected: string; probabilities: Record<string, number>; confidence: number }
	| { type: "noul"; probability: number }
	| { type: "score"; value: number; probabilities: Record<string, number>; confidence: number };

export interface DecisionRequest {
	/** Application state the questions refer to (plain text sections). */
	state: string[];
	questions: Record<string, DecisionQuestion>;
	signal?: AbortSignal;
}

export interface DecisionModel {
	readonly backend: "jev" | "luna";
	decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>>;
}
