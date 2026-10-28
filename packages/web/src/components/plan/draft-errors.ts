import { DeckApiError } from "../../lib/api";

/** One sentence for a failed draft call (run, cancel, template save or load). */
export function describeDraftError(err: unknown): string {
	if (!(err instanceof DeckApiError)) return err instanceof Error ? err.message : "unexpected error";
	switch (err.kind) {
		case "auth":
			return "The daemon refused this device.";
		case "network":
			return "The daemon is unreachable. Nothing was started.";
		case "not-found":
			return "That session, run or template is gone.";
		case "conflict":
			return `The daemon cannot do that now: ${err.message}`;
		case "bad-request":
			return `The daemon did not accept this draft: ${err.message}`;
		case "server":
			return `The daemon failed: ${err.message}`;
	}
}
