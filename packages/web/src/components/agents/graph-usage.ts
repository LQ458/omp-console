/** Journal calls of the graph features (spec 0.5). Only fixed identifiers and short non-content tags are recorded. */
import type { JournalEvent } from "@omp-console/protocol";
import { recordUsage } from "../../lib/journal";

export type GraphFeature = "4.2.edges" | "4.3.plan-graph" | "4.4.instruct" | "4.5.draft" | "4.6.template";

export function trackGraph(
	feature: GraphFeature,
	action: string,
	options: { outcome?: JournalEvent["outcome"]; detail?: string; sessionId?: string; latencyMs?: number } = {},
): void {
	recordUsage({
		feature,
		action,
		outcome: options.outcome ?? "ok",
		via: "graph",
		screen: "agents-sheet",
		detail: options.detail,
		sessionId: options.sessionId,
		latencyMs: options.latencyMs,
	});
}
