import type { SessionSummary, WorkspaceKind } from "@omp-console/protocol";
import type { SessionEntry, SessionState } from "@oh-my-pi/pi-wire";
import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";
import { deriveGoal } from "../../lib/goal";
import { composerLook, deriveModeState, type ModeBadge, type ModeSignals, modeBadges } from "../../lib/mode-badges";
import { deriveTodos } from "../../lib/todos";
import { openWorkspaces } from "./events";
import { colorStyle, ModeBadges, WorkspaceChip } from "./WorkspaceChip";
import { useWorkspaceLook } from "./WorkspaceProvider";

export interface SessionLookInput {
	summary: (SessionSummary & ModeSignals) | undefined;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	/** Phone layout: chips go to a strip in the panel instead of the header. */
	phone: boolean;
}

export interface SessionLook {
	/** Spread on the session root: the `--ws-*` variables and the `data-ws` / `data-plan` switches for the CSS. */
	rootProps: { style?: CSSProperties; "data-ws"?: WorkspaceKind; "data-plan"?: "true" };
	/** 3 px accent bar (first child of the session root); null outside every workspace. */
	bar: ReactNode;
	/** Workspace chip and badges for the header (tablet and desktop). */
	headerSlot: ReactNode;
	/** The same, for the top of the panel on a phone. */
	strip: ReactNode;
	/** Workspace kind of this session, for components that only apply to one kind (drift). */
	kind: WorkspaceKind | undefined;
	badges: readonly ModeBadge[];
}

/** Everything a session view needs for grand-list 7: colour variables, accent bar, chip, mode badges. */
export function useSessionLook({ summary, entries, state, phone }: SessionLookInput): SessionLook {
	const cwd = summary?.cwd ?? state?.cwd;
	const found = useWorkspaceLook(cwd);
	const derivedGoal = useMemo(() => deriveGoal(entries), [entries]);
	const board = useMemo(() => deriveTodos(entries), [entries]);
	const participants = state?.participants;
	const badges = useMemo(
		() => modeBadges(deriveModeState({ summary, derivedGoal, board, participants: participants ?? [] })),
		[summary, derivedGoal, board, participants],
	);
	const goalRing = badges.some(badge => badge.id === "goal");
	const plan = composerLook(badges).dashed;

	return useMemo(() => {
		const chip =
			found === null ? null : (
				<WorkspaceChip
					workspace={found.workspace}
					color={found.color}
					goalRing={goalRing}
					onOpen={() => openWorkspaces({ workspaceId: found.workspace.id })}
				/>
			);
		const badgeStack = badges.length === 0 ? null : <ModeBadges badges={badges} />;
		const rootProps: SessionLook["rootProps"] = {};
		if (found !== null) {
			rootProps.style = colorStyle(found.color);
			rootProps["data-ws"] = found.workspace.kind;
		}
		if (plan) rootProps["data-plan"] = "true";
		return {
			rootProps,
			bar: found === null ? null : <div className="ws-accent-bar" aria-hidden="true" />,
			// The header has no room for badges next to the model controls: tablet and desktop keep the chip there and
			// stack the badges in a strip at the top of the panel; a phone puts both in the strip.
			headerSlot: phone ? null : chip,
			strip:
				(phone ? chip : null) === null && badgeStack === null ? null : (
					<div className="ws-strip">
						{phone ? chip : null}
						{badgeStack}
					</div>
				),
			kind: found?.workspace.kind,
			badges,
		};
	}, [found, goalRing, plan, badges, phone]);
}
