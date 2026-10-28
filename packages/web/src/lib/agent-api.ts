/** User-facing error wording for model and profile controls. */
import { DeckApiError } from "./api";

/** What a write was for; picks the wording of a failure the person can act on. */
export type ControlAction = "agent-model" | "profile-model" | "model-role" | "load";

/** One sentence for the inline error under a model picker or a profile row. */
export function describeControlError(err: unknown, action: ControlAction): string {
	if (!(err instanceof DeckApiError)) return err instanceof Error ? err.message : "unexpected error";
	switch (err.kind) {
		case "auth":
			return "The daemon refused this device.";
		case "network":
			return "The daemon is unreachable. Nothing was changed.";
		case "not-found":
			return action === "agent-model"
				? "That session or agent is gone, so nothing was changed."
				: action === "load"
					? "The daemon does not offer this list."
					: "The daemon does not know that name.";
		case "conflict":
			return action === "agent-model"
				? "That agent has no live session right now (it finished or parked). Revive it first."
				: "The daemon is busy; try again.";
		case "bad-request":
			return `The daemon did not accept that model: ${err.message}`;
		case "server":
			return `The daemon failed: ${err.message}`;
	}
}
