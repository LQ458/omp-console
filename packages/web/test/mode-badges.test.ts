import { describe, expect, it } from "bun:test";
import type { SessionSummary } from "@omp-console/protocol";
import type { Participant } from "@oh-my-pi/pi-wire";
import { composerLook, deriveModeState, isPhoneParticipant, type ModeSignals, modeBadges } from "../src/lib/mode-badges";
import type { TodoBoard } from "../src/lib/todos";

function summary(extra: Partial<SessionSummary> & ModeSignals = {}): SessionSummary & ModeSignals {
	return {
		id: "s1",
		cwd: "/w",
		state: "idle",
		createdAt: 1,
		lastActivityAt: 2,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

function board(completed: number, total: number): TodoBoard {
	return { phases: [], total, completed, inProgress: 0, current: null };
}

describe("modeBadges", () => {
	it("is empty for a plain session and stacks every active mode in a fixed order", () => {
		expect(modeBadges({})).toEqual([]);
		const all = modeBadges({ phone: true, vibe: true, plan: true, goal: { active: true, objective: "ship it", progress: 0.4 } });
		expect(all.map(b => b.id)).toEqual(["goal", "plan", "vibe", "phone"]);
		expect(all[0]).toMatchObject({ tone: "amber", label: "goal 40%", progress: 0.4, title: "goal: ship it" });
		expect(all[1]).toMatchObject({ tone: "violet", label: "PLAN" });
		expect(all[2]).toMatchObject({ label: "Explore", title: "Explore mode" });
	});

	it("shows an unmeasured goal without a percentage and clamps a progress that overshoots", () => {
		expect(modeBadges({ goal: { active: true } })[0]).toMatchObject({ label: "goal", progress: null });
		expect(modeBadges({ goal: { active: true, progress: 1.7 } })[0]).toMatchObject({ label: "goal 100%", progress: 1 });
		expect(modeBadges({ goal: { active: false, progress: 0.5 } })).toEqual([]);
	});

	it("dashes the composer only for plan mode and rings the chip only for a goal", () => {
		expect(composerLook(modeBadges({ plan: true }))).toEqual({ dashed: true, goalRing: false });
		expect(composerLook(modeBadges({ goal: { active: true }, vibe: true }))).toEqual({ dashed: false, goalRing: true });
		expect(composerLook([])).toEqual({ dashed: false, goalRing: false });
	});
});

describe("deriveModeState", () => {
	it("trusts the daemon summary over the replicated goal and measures progress from the todo board", () => {
		const state = deriveModeState({
			summary: summary({ goalActive: true, goalObjective: "daemon objective" }),
			derivedGoal: { objective: "from entries", status: "paused", active: false },
			board: board(3, 4),
			participants: [],
		});
		expect(state.goal).toEqual({ active: true, objective: "daemon objective", progress: 0.75 });
		const fallback = deriveModeState({
			summary: undefined,
			derivedGoal: { objective: "from entries", status: "active", active: true },
			board: null,
			participants: [],
		});
		expect(fallback.goal).toEqual({ active: true, objective: "from entries", progress: null });
	});

	it("reads plan, vibe and phone from the summary signals and from a writing phone guest, not from a viewer", () => {
		const phoneGuest: Participant = { name: "Example phone", role: "guest" };
		const viewer: Participant = { name: "Example phone", role: "guest", readOnly: true };
		const host: Participant = { name: "phone-farm", role: "host" };
		expect(isPhoneParticipant(phoneGuest)).toBe(true);
		expect(isPhoneParticipant(viewer)).toBe(false);
		expect(isPhoneParticipant(host)).toBe(false);
		const base = { derivedGoal: null, board: null };
		expect(deriveModeState({ ...base, summary: summary({ planMode: true, vibe: true, drivenBy: "phone" }), participants: [] })).toMatchObject({
			plan: true,
			vibe: true,
			phone: true,
		});
		expect(deriveModeState({ ...base, summary: summary(), participants: [phoneGuest] }).phone).toBe(true);
		expect(deriveModeState({ ...base, summary: summary(), participants: [viewer, host] }).phone).toBe(false);
	});
});
