import type { Workspace } from "@omp-console/protocol";
import { Smartphone, Target, Zap } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { BadgeIcon, ModeBadge } from "../../lib/mode-badges";
import { type WorkspaceColor, workspaceVars } from "../../lib/workspace-color";

/** CSS custom properties as an inline style (React types do not know `--ws-*`). */
export function colorStyle(color: WorkspaceColor): CSSProperties {
	return workspaceVars(color) as CSSProperties;
}

export interface WorkspaceDotProps {
	workspace: Workspace;
	color: WorkspaceColor;
}

/** Session-row dot: where this session lives. */
export function WorkspaceDot({ workspace, color }: WorkspaceDotProps): ReactNode {
	return (
		<span
			className="ws-dot"
			style={colorStyle(color)}
			title={`${workspace.name} (${workspace.kind})`}
			role="img"
			aria-label={`workspace ${workspace.name}`}
		/>
	);
}

export interface WorkspaceChipProps {
	workspace: Workspace;
	color: WorkspaceColor;
	/** Amber ring while a goal runs. */
	goalRing?: boolean;
	onOpen?(): void;
}

/** Header chip: workspace name on its own tint; a button when `onOpen` is given. */
export function WorkspaceChip({ workspace, color, goalRing = false, onOpen }: WorkspaceChipProps): ReactNode {
	const body = (
		<>
			<span className="ws-chip-dot" />
			<span className="ws-chip-name">{workspace.name}</span>
		</>
	);
	const common = {
		className: "ws-chip",
		style: colorStyle(color),
		"data-ring": goalRing ? "goal" : undefined,
		"data-kind": workspace.kind,
		title: `${workspace.name} · ${workspace.root}`,
	};
	return onOpen ? (
		<button type="button" {...common} onClick={onOpen} aria-label={`workspace ${workspace.name}, open workspaces`}>
			{body}
		</button>
	) : (
		<span {...common}>{body}</span>
	);
}

/** PLAN is a text badge; it has no icon. */
const ICONS: Partial<Record<BadgeIcon, typeof Target>> = {
	target: Target,
	zap: Zap,
	phone: Smartphone,
};

export interface ModeBadgesProps {
	badges: readonly ModeBadge[];
}

/** Stacked mode badges: goal (amber, with progress), PLAN (violet), vibe, phone. */
export function ModeBadges({ badges }: ModeBadgesProps): ReactNode {
	if (badges.length === 0) return null;
	return (
		<span className="ws-badges" role="list" aria-label="session modes">
			{badges.map(badge => {
				const Icon = ICONS[badge.icon];
				return (
					<span key={badge.id} className="ws-badge" data-tone={badge.tone} data-badge={badge.id} role="listitem" title={badge.title}>
						{Icon && <Icon size={11} />}
						<span className="ws-badge-label">{badge.label}</span>
						{badge.progress !== undefined && badge.progress !== null && (
							<span className="ws-badge-bar" aria-hidden="true">
								<span style={{ width: `${Math.round(badge.progress * 100)}%` }} />
							</span>
						)}
					</span>
				);
			})}
		</span>
	);
}
