/**
 * Pins, saved session recipes, and transcript search (wave 4). These are additive control-API contracts.
 */
type RecipeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export interface ListPinnedSessionsResponse {
	sessionIds: string[];
}

export interface SetSessionPinnedRequest {
	pinned: boolean;
}

export interface PinSessionResponse {
	pinned: boolean;
}

/** A reusable one-tap start; recipes belong to the daemon whose machineId is recorded here. */
export interface SessionRecipe {
	id: string;
	name: string;
	cwd: string;
	machineId: string;
	prompt: string;
	model?: string;
	thinkingLevel?: RecipeThinkingLevel;
	createdAt: number;
	updatedAt: number;
}

export interface SessionRecipeInput {
	name: string;
	cwd: string;
	machineId: string;
	prompt: string;
	model?: string;
	thinkingLevel?: RecipeThinkingLevel;
}

export interface ListSessionRecipesResponse {
	recipes: SessionRecipe[];
}

/** `GET /api/recipes/source/:sessionId`: the source session's first user prompt and start settings. */
export interface SessionRecipeSource {
	name: string;
	cwd: string;
	prompt: string;
	model?: string;
	thinkingLevel?: RecipeThinkingLevel;
}

/** One transcript message match from `GET /api/search?q=`. */
export interface TranscriptSearchHit {
	sessionId: string;
	title: string;
	snippet: string;
	matchStart: number;
	matchEnd: number;
	at: number;
	entryId?: string;
}

export interface TranscriptSearchResponse {
	results: TranscriptSearchHit[];
	truncated: boolean;
	scannedSessions: number;
}
