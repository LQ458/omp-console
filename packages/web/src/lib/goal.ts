/**
 * Goal state as far as collab frames expose it. The host replicates no `mode_change` entry and
 * no `goal_updated` event, so the only trace of a goal in the frames is the result of the `goal`
 * tool (`details.goal`). Goals started or changed outside the tool are visible only through the
 * daemon's `SessionSummary.goalActive`.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";

export interface DerivedGoal {
	objective: string;
	status: string;
	/** Same predicate as the host's goal runtime: accounting continues while active or budget-limited. */
	active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Latest `goal` tool result in the entries; null when none exists or the last one dropped the goal. */
export function deriveGoal(entries: readonly SessionEntry[]): DerivedGoal | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "goal")
			continue;
		const details = entry.message.details;
		if (!isRecord(details) || !("goal" in details)) continue;
		const goal = details.goal;
		if (!isRecord(goal)) return null;
		const objective = typeof goal.objective === "string" ? goal.objective : "";
		const status = typeof goal.status === "string" ? goal.status : "";
		if (status === "") continue;
		return { objective, status, active: status === "active" || status === "budget-limited" };
	}
	return null;
}
