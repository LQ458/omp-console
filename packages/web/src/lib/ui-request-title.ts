const SKILL_APPROVAL_MARKER = /\n\n\[omp-console-skill-approval:[\w-]{1,256}\]$/;

export function visibleUiRequestTitle(title: string): string {
	return title.replace(SKILL_APPROVAL_MARKER, "");
}
