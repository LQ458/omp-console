/**
 * In-place feedback (spec 0.6): "this was confusing / I wanted X" from any panel. The entry carries the screen and
 * feature id it refers to; the journal event that accompanies it carries only those ids, never the text.
 */
import type { FeedbackEntry } from "@omp-console/protocol";
import type { DeckApi } from "./api";
import { recordUsage } from "./journal";

export const FEEDBACK_MAX_CHARS = 2_000;

type FeedbackApi = Pick<DeckApi, "recordFeedback">;

let boundApi: FeedbackApi | null = null;

/** The API panels fall back to when they do not pass one (the shell binds it once; null unbinds). */
export function bindFeedback(api: FeedbackApi | null): void {
	boundApi = api;
}

export function feedbackApi(): FeedbackApi | null {
	return boundApi;
}

export interface FeedbackInput {
	screen: string;
	feature?: string;
	text: string;
}

/** Trims and bounds the text; null when nothing is left to send. */
export function buildFeedback(input: FeedbackInput, at: number): FeedbackEntry | null {
	const text = input.text.trim().slice(0, FEEDBACK_MAX_CHARS);
	if (text === "") return null;
	const entry: FeedbackEntry = { at, screen: input.screen, text };
	if (input.feature !== undefined && input.feature !== "") entry.feature = input.feature;
	return entry;
}

/** Posts one entry. Resolves false for empty text; rethrows a daemon failure after journaling it. */
export async function submitFeedback(api: FeedbackApi, input: FeedbackInput, now: () => number = Date.now): Promise<boolean> {
	const entry = buildFeedback(input, now());
	if (entry === null) return false;
	const started = now();
	try {
		await api.recordFeedback(entry);
	} catch (err) {
		recordUsage({
			feature: "0.6.feedback",
			action: "submit",
			outcome: "error",
			latencyMs: now() - started,
			via: "direct",
			screen: input.screen,
			detail: input.feature,
		});
		throw err;
	}
	recordUsage({
		feature: "0.6.feedback",
		action: "submit",
		outcome: "ok",
		latencyMs: now() - started,
		via: "direct",
		screen: input.screen,
		detail: input.feature,
	});
	return true;
}
