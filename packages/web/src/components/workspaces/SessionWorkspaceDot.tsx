import type { ReactNode } from "react";
import { WorkspaceDot } from "./WorkspaceChip";
import { useWorkspaceLook } from "./WorkspaceProvider";

/** The coloured dot for the workspace a session's working directory is in; nothing outside every workspace. */
export function SessionWorkspaceDot({ cwd }: { cwd: string }): ReactNode {
	const look = useWorkspaceLook(cwd);
	return look === null ? null : <WorkspaceDot workspace={look.workspace} color={look.color} />;
}
