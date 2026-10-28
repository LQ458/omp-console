export interface ShellInputMode {
	kind: "bash" | "python";
	code: string;
	excludeFromContext: boolean;
}

function hasWhitespace(value: string | undefined): boolean {
	return value === " " || value === "\t" || value === "\n" || value === "\r";
}

/** Mirrors omp's prefix rules: !/!! select bash; $/$$ select Python only after whitespace. */
export function detectShellMode(text: string): ShellInputMode | null {
	const value = text.trimStart();
	if (value.startsWith("!")) {
		const excludeFromContext = value.startsWith("!!");
		return {
			kind: "bash",
			code: value.slice(excludeFromContext ? 2 : 1).trim(),
			excludeFromContext,
		};
	}
	if (!value.startsWith("$")) return null;
	const excludeFromContext = value.startsWith("$$");
	const prefixLength = excludeFromContext ? 2 : 1;
	if (!hasWhitespace(value[prefixLength])) return null;
	return {
		kind: "python",
		code: value.slice(prefixLength).trim(),
		excludeFromContext,
	};
}

/** Returns only executable commands; a prefix by itself remains ordinary composer text. */
export function parseShellInput(text: string): ShellInputMode | null {
	const mode = detectShellMode(text);
	return mode !== null && mode.code !== "" ? mode : null;
}

export interface GitHubReference {
	number: number;
	start: number;
	end: number;
}

/** Find a complete #N token immediately before the caret; zero and unsafe integers are not refs. */
export function findGitHubReference(text: string, caret: number): GitHubReference | null {
	const end = Math.max(0, Math.min(caret, text.length));
	if (/[\p{L}\p{N}_]/u.test(text[end] ?? "")) return null;
	const before = text.slice(0, end);
	const match = /(?:^|\s)#(\d+)$/.exec(before);
	if (match === null) return null;
	const number = Number(match[1]);
	if (!Number.isSafeInteger(number) || number < 1) return null;
	return { number, start: end - match[1]!.length - 1, end };
}

/** OMP's internal-URL formats resolve a number against the calling session's GitHub repository. */
export function githubReferenceUri(kind: "issue" | "pr", number: number): string {
	return `${kind}://${number}`;
}

export function parseBtwCommand(text: string): { question: string } | null {
	const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return match === null ? null : { question: match[1]?.trim() ?? "" };
}
