export interface TextMatch {
	start: number;
	end: number;
}

/** Finds the first case-insensitive match using offsets from the original string. */
export function findCaseInsensitiveMatch(text: string, query: string): TextMatch | null {
	if (query === "") return null;
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(escaped, "iu").exec(text);
	if (match === null || match.index === undefined) return null;
	return { start: match.index, end: match.index + match[0].length };
}
