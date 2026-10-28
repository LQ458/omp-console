/**
 * Mode badges (grand-list 7): what the session is doing, independent of which workspace it is in. Modes stack:
 * goal (target + amber ring + progress), plan (violet PLAN badge + dashed composer border), vibe (lightning),
 * phone (a phone client is driving).
 *
 * Signals that exist today: `goalActive`/`goalObjective` on the summary, the todo board for progress, and guest
 * participant names. Plan mode, vibe and "driven by a phone" have no field in the wire frames or `SessionSummary`
 * yet (see REQUESTS.md); `ModeSignals` is the optional shape the daemon is asked to add, read here without a cast
 * at the call sites.
 */
import type { SessionSummary } from "@omp-console/protocol";
import type { Participant } from "@oh-my-pi/pi-wire";
import type { DerivedGoal } from "./goal";
import type { TodoBoard } from "./todos";

export type BadgeId = "goal" | "plan" | "vibe" | "phone";
export type BadgeIcon = "target" | "plan" | "zap" | "phone";
export type BadgeTone = "amber" | "violet" | "accent" | "muted";

export interface ModeBadge {
	id: BadgeId;
	icon: BadgeIcon;
	tone: BadgeTone;
	/** Short visible text (hidden on narrow screens, icon stays). */
	label: string;
	/** Tooltip / accessible description. */
	title: string;
	/** 0..1 for the goal badge; null when the goal has no measurable progress yet. */
	progress?: number | null;
}

export interface ModeState {
	goal?: { active: boolean; objective?: string; progress?: number | null };
	plan?: boolean;
	vibe?: boolean;
	phone?: boolean;
}

/** Fields the daemon is asked to add to `SessionSummary` (REQUESTS.md); absent today. */
export interface ModeSignals {
	planMode?: boolean;
	vibe?: boolean;
	/** `phone` when the most recent prompt came from a phone client. */
	drivenBy?: "mac" | "phone";
}

const BADGE_ORDER: readonly BadgeId[] = ["goal", "plan", "vibe", "phone"];

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** Stacked badges in a fixed order (goal, plan, vibe, phone); an empty array means a plain session. */
export function modeBadges(state: ModeState): ModeBadge[] {
	const out = new Map<BadgeId, ModeBadge>();
	if (state.goal?.active) {
		const progress = state.goal.progress === undefined || state.goal.progress === null ? null : clamp01(state.goal.progress);
		const objective = state.goal.objective?.trim();
		out.set("goal", {
			id: "goal",
			icon: "target",
			tone: "amber",
			label: progress === null ? "goal" : `goal ${Math.round(progress * 100)}%`,
			title: objective ? `goal: ${objective}` : "goal active",
			progress,
		});
	}
	if (state.plan) {
		out.set("plan", {
			id: "plan",
			icon: "plan",
			tone: "violet",
			label: "PLAN",
			title: "plan mode: the agent proposes before it edits",
		});
	}
	if (state.vibe) {
		out.set("vibe", { id: "vibe", icon: "zap", tone: "accent", label: "Explore", title: "Explore mode" });
	}
	if (state.phone) {
		out.set("phone", {
			id: "phone",
			icon: "phone",
			tone: "muted",
			label: "phone",
			title: "driven from a phone client",
		});
	}
	return BADGE_ORDER.flatMap(id => {
		const badge = out.get(id);
		return badge === undefined ? [] : [badge];
	});
}

/** Look of the composer for the current badges: plan mode draws a dashed border, a goal shows an amber ring on the chip. */
export function composerLook(badges: readonly ModeBadge[]): { dashed: boolean; goalRing: boolean } {
	return { dashed: badges.some(b => b.id === "plan"), goalRing: badges.some(b => b.id === "goal") };
}

const PHONE_NAME = /\b(iphone|ipad|android|phone|mobile)\b/i;

/** A writing guest whose display name names a phone. Heuristic until the daemon reports `drivenBy`. */
export function isPhoneParticipant(participant: Participant): boolean {
	return participant.role === "guest" && participant.readOnly !== true && PHONE_NAME.test(participant.name);
}

export interface ModeInputs {
	summary: (SessionSummary & ModeSignals) | undefined;
	/** `deriveGoal(entries)`, used when the daemon has no summary (a manually joined link). */
	derivedGoal: DerivedGoal | null;
	board: TodoBoard | null;
	participants: readonly Participant[];
}

/** Daemon facts first, replicated entries as fallback; progress is the share of finished todos while a goal runs. */
export function deriveModeState({ summary, derivedGoal, board, participants }: ModeInputs): ModeState {
	const goalActive = summary?.goalActive ?? derivedGoal?.active ?? false;
	const objective = summary?.goalObjective ?? derivedGoal?.objective;
	const progress = board !== null && board.total > 0 ? board.completed / board.total : null;
	return {
		goal: goalActive ? { active: true, objective, progress } : undefined,
		plan: summary?.planMode === true,
		vibe: summary?.vibe === true,
		phone: summary?.drivenBy === "phone" || participants.some(isPhoneParticipant),
	};
}
