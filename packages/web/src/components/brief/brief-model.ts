import type { BriefLine } from "@omp-console/protocol";
import { relTime } from "../../lib/format";

export interface BriefGroup {
	kind: BriefLine["kind"];
	heading: string;
	lines: BriefLine[];
}

const GROUP_ORDER: ReadonlyArray<Pick<BriefGroup, "kind" | "heading">> = [
	{ kind: "needs-you", heading: "Needs you" },
	{ kind: "finished", heading: "Finished" },
	{ kind: "unfinished", heading: "Stopped before finishing" },
];

export function briefGroups(lines: readonly BriefLine[]): BriefGroup[] {
	return GROUP_ORDER.flatMap(({ kind, heading }) => {
		const groupLines = lines.filter(line => line.kind === kind).sort((a, b) => b.changedAt - a.changedAt);
		return groupLines.length === 0 ? [] : [{ kind, heading, lines: groupLines }];
	});
}

export function orderedBriefLines(lines: readonly BriefLine[]): BriefLine[] {
	return briefGroups(lines).flatMap(group => group.lines);
}

export function visibleBriefLines(lines: readonly BriefLine[], expanded: boolean, limit: number): BriefLine[] {
	return expanded ? [...lines] : lines.slice(0, limit);
}

export function remainingBriefCount(lines: readonly BriefLine[], expanded: boolean, limit: number): number {
	return expanded ? 0 : Math.max(0, lines.length - limit);
}

export function emptyBriefText(since: number): string {
	return `Nothing changed since ${relTime(since)}`;
}
