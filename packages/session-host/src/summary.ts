/** The first lines of a result, bounded in both lines and characters, with an ellipsis when anything was cut. */
export function firstLines(text: string | undefined, maxLines: number, maxChars: number): string | undefined {
	if (text === undefined) return undefined;
	const lines = text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map(line => line.trimEnd());
	while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
	if (lines.length === 0) return undefined;
	let joined = lines.slice(0, maxLines).join("\n");
	let cut = lines.length > maxLines;
	if (joined.length > maxChars) {
		joined = joined.slice(0, maxChars - 1);
		cut = true;
	}
	return cut ? `${joined.trimEnd()}…` : joined;
}

/**
 * The part of a task result a person reads. The task tool wraps a settled run in a model-facing
 * `<task-result ...>` envelope (prompts/tools/task-summary.md); this keeps its error, abort reason and output or
 * preview, and drops the attributes and the follow-up hint. Text without an envelope is returned unchanged.
 */
export function unwrapTaskResult(text: string | undefined): string | undefined {
	if (text === undefined || !text.includes("<task-result")) return text;
	const inner = (tag: string): string | undefined => {
		const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(text);
		return match?.[1]?.trim() || undefined;
	};
	const abort = inner("abort-reason")?.split(" — ")[0];
	const parts = [inner("error"), abort, inner("output") ?? inner("preview")].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join("\n") : text;
}
